// Spotify audio-analysis fetch + persistent cache (IndexedDB + memory)
// Produces trimmed TrackAnalysis for scheduling beats/bars/sections.

import { getAccessToken } from '../auth/token'
import { kvGet, kvSet } from '../utils/kvidb'

export type SpotifyBeat = { start: number, duration: number, confidence: number }
export type SpotifyBar = { start: number, duration: number, confidence: number }
export type SpotifySection = { start: number, duration: number, loudness: number, tempo: number, key: number, mode: number }

export type TrackAnalysis = {
  beats: SpotifyBeat[]
  bars: SpotifyBar[]
  sections: SpotifySection[]
  tempo?: number
  key?: number
  fetchedAt: number
  trackId: string
  v: 1
}

const memCache = new Map<string, TrackAnalysis>()
const TTL_MS = 1000 * 60 * 60 * 24 * 14 // 14 days
const KEY = (id: string) => `analysis:v1:${id}`

export async function getTrackAnalysis(trackId: string): Promise<TrackAnalysis | null> {
  if (!trackId) return null
  const m = memCache.get(trackId)
  if (m && Date.now() - m.fetchedAt < TTL_MS) return m

  const cached = await kvGet<TrackAnalysis>(KEY(trackId), TTL_MS)
  if (cached) {
    memCache.set(trackId, cached)
    return cached
  }

  const token = await getAccessToken()
  if (!token) return null

  const res = await fetch(`https://api.spotify.com/v1/audio-analysis/${trackId}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) return null
  const data = await res.json()

  const beats: SpotifyBeat[] = (data.beats || []).map((b: any) => ({ start: b.start, duration: b.duration, confidence: b.confidence }))
  const bars: SpotifyBar[] = (data.bars || []).map((b: any) => ({ start: b.start, duration: b.duration, confidence: b.confidence }))
  const sections: SpotifySection[] = (data.sections || []).map((s: any) => ({
    start: s.start, duration: s.duration, loudness: s.loudness, tempo: s.tempo, key: s.key, mode: s.mode
  }))

  const analysis: TrackAnalysis = {
    beats, bars, sections,
    tempo: data.track?.tempo,
    key: data.track?.key,
    fetchedAt: Date.now(),
    trackId,
    v: 1
  }

  memCache.set(trackId, analysis)
  kvSet(KEY(trackId), analysis).catch(() => {})
  return analysis
}
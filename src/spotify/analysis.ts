// Add beats/bars/sections caching (no segments to keep payload small)
import { getAccessToken } from '../auth/token'
import { kvGet, kvSet } from '../utils/kvidb'

export type SpotifyBeat = { start: number, duration: number, confidence: number }
export type SpotifyBar = { start: number, duration: number, confidence: number }
export type SpotifySection = { start: number, duration: number, loudness: number, tempo: number, key: number, mode: number }

export type TrackAnalysis = {
  trackId: string
  beats: SpotifyBeat[]
  bars: SpotifyBar[]
  sections: SpotifySection[]
  tempo?: number
  key?: number
  fetchedAt: number
  v: 1
}

const mem = new Map<string, TrackAnalysis>()
const TTL_MS = 1000 * 60 * 60 * 24 * 14
const KEY = (id: string) => `analysis:v1:${id}`

export async function getTrackAnalysis(trackId: string): Promise<TrackAnalysis | null> {
  if (!trackId) return null
  const m = mem.get(trackId)
  if (m && Date.now() - m.fetchedAt < TTL_MS) return m

  const cached = await kvGet<TrackAnalysis>(KEY(trackId), TTL_MS)
  if (cached) { mem.set(trackId, cached); return cached }

  const token = await getAccessToken()
  if (!token) return null

  const r = await fetch(`https://api.spotify.com/v1/audio-analysis/${trackId}`, { headers: { Authorization: `Bearer ${token}` }})
  if (!r.ok) return null
  const d = await r.json()

  const beats: SpotifyBeat[] = (d.beats || []).map((b: any) => ({ start: b.start, duration: b.duration, confidence: b.confidence }))
  const bars: SpotifyBar[] = (d.bars || []).map((b: any) => ({ start: b.start, duration: b.duration, confidence: b.confidence }))
  const sections: SpotifySection[] = (d.sections || []).map((s: any) => ({
    start: s.start, duration: s.duration, loudness: s.loudness, tempo: s.tempo, key: s.key, mode: s.mode
  }))

  const analysis: TrackAnalysis = {
    trackId, beats, bars, sections,
    tempo: d.track?.tempo, key: d.track?.key,
    fetchedAt: Date.now(), v: 1
  }
  mem.set(trackId, analysis)
  kvSet(KEY(trackId), analysis).catch(() => {})
  return analysis
}
import { getAccessToken } from '../auth/token'

export type SpotifyBeat = { start: number, duration: number, confidence: number }
export type SpotifyBar = { start: number, duration: number, confidence: number }
export type SpotifySection = { start: number, duration: number, loudness: number, tempo: number, key: number, mode: number }

export type TrackAnalysis = {
  beats: SpotifyBeat[]
  bars: SpotifyBar[]
  sections: SpotifySection[]
  tempo?: number
  key?: number
}

const cache = new Map<string, TrackAnalysis>()

export async function getTrackAnalysis(trackId: string): Promise<TrackAnalysis | null> {
  if (cache.has(trackId)) return cache.get(trackId)!
  const token = await getAccessToken()
  if (!token) return null
  const res = await fetch(`https://api.spotify.com/v1/audio-analysis/${trackId}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) return null
  const data = await res.json()
  const analysis: TrackAnalysis = {
    beats: data.beats?.map((b: any) => ({ start: b.start, duration: b.duration, confidence: b.confidence })) || [],
    bars: data.bars?.map((b: any) => ({ start: b.start, duration: b.duration, confidence: b.confidence })) || [],
    sections: data.sections?.map((s: any) => ({
      start: s.start, duration: s.duration, loudness: s.loudness, tempo: s.tempo, key: s.key, mode: s.mode
    })) || [],
    tempo: data.track?.tempo,
    key: data.track?.key
  }
  cache.set(trackId, analysis)
  return analysis
}
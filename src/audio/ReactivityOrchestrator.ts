// Synthesizes frames from Spotify analysis when WebAudio can't be used.
// Also emits precise bar/section events and smooth phases.
import { getPlaybackState } from '../spotify/api'
import { getTrackAnalysis, type TrackAnalysis } from '../spotify/analysis'
import { reactivityBus, type ReactiveFrame } from './ReactivityBus'

export function startReactivityOrchestrator(): () => void {
  let stopped = false
  let currTrack: string | null = null
  let analysis: TrackAnalysis | null = null

  // Playback clock derived from Web API (progress_ms + elapsed)
  let basePosMs = 0
  let baseAt = performance.now()
  let paused = false

  // Beat tracking
  let nextBeatIdx = 0
  let lastBeatIdxEmitted = -1

  const clockSec = () => {
    if (paused) return basePosMs / 1000
    const now = performance.now()
    return (basePosMs + (now - baseAt)) / 1000
  }

  async function pollPlayback() {
    if (stopped) return
    try {
      const s = await getPlaybackState()
      const trackId: string | null = s?.item?.id || null

      if (typeof s?.progress_ms === 'number') {
        basePosMs = s.progress_ms
        baseAt = performance.now()
      }
      paused = !s?.is_playing

      if (trackId && trackId !== currTrack) {
        currTrack = trackId
        analysis = await getTrackAnalysis(trackId)
        nextBeatIdx = 0
        lastBeatIdxEmitted = -1
      }
    } catch {
      // ignore
    }
  }

  const pollInterval = window.setInterval(pollPlayback, 1000)
  pollPlayback()

  // rAF: synthesize frames only if no recent frame from WebAudio
  let raf = 0
  const loop = () => {
    if (stopped) return
    const now = performance.now()
    const last = reactivityBus.latestFrame
    const stale = !last || (now - last.t) > 180 // ms

    if (stale && analysis) {
      const pos = clockSec()
      // Beat crossing
      let beat = false
      if (analysis.beats.length) {
        while (nextBeatIdx < analysis.beats.length && analysis.beats[nextBeatIdx].start < pos - 0.02) nextBeatIdx++
        if (nextBeatIdx < analysis.beats.length) {
          const dt = analysis.beats[nextBeatIdx].start - pos
          if (dt <= 0.016 && nextBeatIdx !== lastBeatIdxEmitted) {
            beat = true
            lastBeatIdxEmitted = nextBeatIdx
            nextBeatIdx++
          }
        }
      }

      // Phases
      const barPhase = phaseAt(analysis.bars, pos)
      const secIdx = indexAt(analysis.sections, pos)
      const sec = analysis.sections[secIdx]
      const secPhase = sec ? (pos - sec.start) / Math.max(0.001, sec.duration) : 0

      // Loudness normalize: map [-35..-5] LUFS to [0..1]
      const secLoud = sec ? (sec.loudness ?? -20) : -20
      const loud = clamp01((secLoud + 35) / 30)

      // Bands (approx): low follows loud, high follows inverse + bar wiggle, mid centered
      const low = clamp01(loud * 0.85 + 0.15 * Math.sin(barPhase * Math.PI * 2))
      const high = clamp01(0.35 + (1 - loud) * 0.65 + 0.1 * Math.cos(barPhase * Math.PI * 4))
      const mid = clamp01((low + high) * 0.5)

      const f: ReactiveFrame = {
        t: now,
        posMs: pos * 1000,
        loudness: loud,
        bands: { low, mid, high },
        brightness: high,
        transient: Math.abs(Math.cos(barPhase * Math.PI * 2)) * 0.6,
        beat,
        beatStrength: beat ? 0.9 : 0,
        tempo: analysis.tempo,
        phases: { beat: 0, bar: barPhase, section: clamp01(secPhase) }
      }
      reactivityBus.emitFrame(f)
    }

    raf = requestAnimationFrame(loop)
  }
  raf = requestAnimationFrame(loop)

  return () => {
    stopped = true
    clearInterval(pollInterval)
    if (raf) cancelAnimationFrame(raf)
  }
}

function indexAt(items: { start: number; duration: number }[], t: number) {
  if (!items.length) return 0
  let low = 0, high = items.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const it = items[mid]
    if (t < it.start) high = mid - 1
    else if (t > it.start + it.duration) low = mid + 1
    else return mid
  }
  return Math.max(0, Math.min(items.length - 1, low))
}
function phaseAt(items: { start: number; duration: number }[], t: number) {
  const i = indexAt(items, t)
  const it = items[i]
  return clamp01((t - it.start) / Math.max(0.001, it.duration))
}
function clamp01(x: number) { return Math.max(0, Math.min(1, x)) }
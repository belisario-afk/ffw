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

  // Beat tracking (when analysis is available)
  let nextBeatIdx = 0
  let lastBeatIdxEmitted = -1

  // LFO fallback when analysis is unavailable
  let tempoGuess = 120 // bpm
  let lastBeatPulseAt = 0

  const clockSec = () => {
    if (paused) return basePosMs / 1000
    const now = performance.now()
    return (basePosMs + (now - baseAt)) / 1000
  }

  async function pollPlayback() {
    if (stopped) return
    try {
      const s = await getPlaybackState()
      const trackId: string | null = (s?.item as any)?.id || null

      if (typeof s?.progress_ms === 'number') {
        basePosMs = s.progress_ms
        baseAt = performance.now()
      }
      paused = !s?.is_playing

      if (trackId && trackId !== currTrack) {
        currTrack = trackId
        nextBeatIdx = 0
        lastBeatIdxEmitted = -1
        analysis = null
        try {
          const a = await getTrackAnalysis(trackId)
          if (a) {
            analysis = a
            // prefer track tempo if present
            if (a.tempo && a.tempo > 30 && a.tempo < 240) tempoGuess = a.tempo
          }
        } catch {
          // ignore analysis failures; we will synthesize
          analysis = null
        }
      }
    } catch {
      // ignore transient failures
    }
  }

  const pollInterval = window.setInterval(pollPlayback, 1000)
  pollPlayback()

  // rAF: synthesize frames when stale
  let raf = 0
  const loop = () => {
    if (stopped) return
    const now = performance.now()
    const last = reactivityBus.latestFrame
    const stale = !last || (now - last.t) > 180 // ms

    if (stale) {
      const pos = clockSec()
      let beat = false
      let barPhase = 0
      let sectionPhase = 0
      let loud = 0.25
      let low = 0.2, mid = 0.2, high = 0.25
      let tempo: number | undefined = undefined

      if (analysis && analysis.beats?.length) {
        // Analysis-driven
        while (nextBeatIdx < analysis.beats.length && analysis.beats[nextBeatIdx].start < pos - 0.02) nextBeatIdx++
        if (nextBeatIdx < analysis.beats.length) {
          const dt = analysis.beats[nextBeatIdx].start - pos
          if (dt <= 0.016 && nextBeatIdx !== lastBeatIdxEmitted) {
            beat = true
            lastBeatIdxEmitted = nextBeatIdx
            nextBeatIdx++
          }
        }
        barPhase = phaseAt(analysis.bars, pos)
        const secIdx = indexAt(analysis.sections, pos)
        const sec = analysis.sections[secIdx]
        sectionPhase = sec ? (pos - sec.start) / Math.max(0.001, sec.duration) : 0
        const secLoud = sec ? (sec.loudness ?? -20) : -20
        loud = clamp01((secLoud + 35) / 30)
        // quick param bands
        low = clamp01(loud * 0.85 + 0.15 * Math.sin(barPhase * Math.PI * 2))
        high = clamp01(0.35 + (1 - loud) * 0.65 + 0.1 * Math.cos(barPhase * Math.PI * 4))
        mid = clamp01((low + high) * 0.5)
        tempo = analysis.tempo
      } else {
        // LFO fallback (no analysis or forbidden 403)
        const beatPeriod = 60 / tempoGuess
        const beatPhase = (pos % beatPeriod) / beatPeriod
        if (beatPhase < 0.02 && now - lastBeatPulseAt > 120) {
          beat = true
          lastBeatPulseAt = now
        }
        const barPeriod = beatPeriod * 4
        barPhase = (pos % barPeriod) / barPeriod
        sectionPhase = ((pos / (beatPeriod * 32)) % 1)
        loud = 0.35 + 0.25 * Math.sin(barPhase * Math.PI * 2 + 0.4)
        low = clamp01(0.25 + 0.25 * Math.sin(pos * 1.8))
        mid = clamp01(0.25 + 0.25 * Math.sin(pos * 2.3 + 0.9))
        high = clamp01(0.25 + 0.25 * Math.sin(pos * 3.1 + 1.7))
        tempo = tempoGuess
      }

      const frame: ReactiveFrame = {
        t: now,
        posMs: pos * 1000,
        loudness: loud,
        bands: { low, mid, high },
        brightness: high,
        transient: Math.abs(Math.cos(barPhase * Math.PI * 2)) * 0.6,
        beat,
        beatStrength: beat ? 0.9 : 0,
        tempo,
        phases: { beat: 0, bar: clamp01(barPhase), section: clamp01(sectionPhase) }
      }
      reactivityBus.emitFrame(frame)
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
// Orchestrates analysis caching + precise scheduling based on current playback
// position. Polls Spotify playback state, loads analysis on track change,
// starts/stops FeatureScheduler and updates phases continuously.

import { getPlaybackState } from '../spotify/api'
import { getTrackAnalysis } from '../spotify/analysis'
import { startAnalysisScheduler, type SchedulerHandle } from './FeatureScheduler'

export function startReactivityOrchestrator(): () => void {
  let stopped = false
  let currTrack: string | null = null
  let handle: SchedulerHandle | null = null

  // Playback clock derived from last polled web API (progress_ms + elapsed)
  let basePosMs = 0
  let baseAt = performance.now()
  let paused = false

  const clockSec = () => {
    if (paused) return basePosMs / 1000
    const now = performance.now()
    return (basePosMs + (now - baseAt)) / 1000
  }

  async function tick() {
    if (stopped) return
    try {
      const s = await getPlaybackState()
      const trackId: string | null = s?.item?.id || null

      // Update clock base
      if (typeof s?.progress_ms === 'number') {
        basePosMs = s.progress_ms
        baseAt = performance.now()
      }
      paused = !s?.is_playing

      if (trackId && trackId !== currTrack) {
        currTrack = trackId
        // Stop old scheduler
        if (handle) { handle.stop(); handle = null }

        const analysis = await getTrackAnalysis(trackId)
        if (analysis) {
          handle = startAnalysisScheduler(analysis, clockSec)
        }
      }
    } catch {
      // ignore transient errors
    }
  }

  const interval = window.setInterval(tick, 1000)
  // quick initial
  tick()

  return () => {
    stopped = true
    clearInterval(interval)
    if (handle) handle.stop()
  }
}
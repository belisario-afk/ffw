/* eslint-disable no-console */
import { reactivityBus } from './ReactivityBus'
import {
  isUnanalyzable,
  markUnanalyzable,
  shouldRetryNow,
  scheduleBackoff,
  clearBackoff,
  onTrackChangeReset
} from './AnalysisBackoff'

// Optional analysis fetcher injection to avoid hard import path issues.
// Call setAudioAnalysisFetcher(fn) from wherever your real fetcher lives (e.g., src/audio/analysis.ts).
type AnalysisFetcher = (trackId: string) => Promise<any>
let analysisFetcher: AnalysisFetcher | null = null
export function setAudioAnalysisFetcher(fn: AnalysisFetcher) {
  analysisFetcher = fn
}

// Simple in-memory cache to avoid refetching the same track's analysis repeatedly
const analysisCache = new Map<string, any>()

export function startReactivityOrchestrator() {
  let disposed = false
  let lastTrackId: string | null = null

  const tick = async () => {
    if (disposed) return
    try {
      // Obtain playback state however you already do (kept as a safe stub)
      const s = await safeGetPlaybackState()
      const trackId = (s?.item?.id as string) || null

      // Reset backoff bookkeeping when track changes
      if (trackId !== lastTrackId) {
        onTrackChangeReset(lastTrackId)
        lastTrackId = trackId
      }

      // NOTE: Your existing frame emit should remain here
      // reactivityBus.emit('frame', { ...bands, loudness, beat, t: performance.now() })

      // Analysis acquisition (guarded + cached)
      if (trackId && !isUnanalyzable(trackId)) {
        // Serve from cache if available
        const cached = analysisCache.get(trackId)
        if (cached) {
          // Already have analysis; ensure any prior backoff is cleared
          clearBackoff(trackId)
          // If you have consumers for analysis, notify them here
          // reactivityBus.emit('analysis', cached)
        } else if (shouldRetryNow(trackId)) {
          try {
            const analysis = await guardedFetchAnalysis(trackId)
            if (analysis) {
              analysisCache.set(trackId, analysis)
              clearBackoff(trackId)
              // If you have consumers for analysis, notify them here
              // reactivityBus.emit('analysis', analysis)
            } else {
              // No analysis available right now; back off gently to avoid spam
              scheduleBackoff(trackId, 4000, 60000)
            }
          } catch (err: any) {
            const status =
              (err?.status as number | undefined) ??
              (err?.response?.status as number | undefined) ??
              (err?.cause?.status as number | undefined)

            if (status === 403) {
              // Mark and skip for the rest of this track (prevents repeated 403s)
              markUnanalyzable(trackId, '403')
            } else {
              // Transient error: schedule exponential backoff
              scheduleBackoff(trackId, 2000, 60000)
            }
          }
        } // else: still backing off; skip fetch this tick
      }
    } catch (e) {
      // Keep the loop resilient
      console.warn('[ReactivityOrchestrator] tick error:', e)
    }
  }

  // Drive the orchestrator; keep your existing cadence
  const iv = setInterval(tick, 1000)

  return () => {
    disposed = true
    clearInterval(iv)
  }
}

/**
 * Replace this stub with your actual playback state call if desired.
 * Left as-is to avoid coupling; it returns whatever your app populates at window.__ffw__lastPlaybackState
 */
async function safeGetPlaybackState(): Promise<any> {
  try {
    // If you have a direct API util, prefer: return await getPlaybackState()
    return (window as any).__ffw__lastPlaybackState || null
  } catch {
    return null
  }
}

/**
 * Calls the injected analysis fetcher (if provided).
 * This avoids hard-coded imports that broke your build.
 * Inject it from your real module like:
 *   import { setAudioAnalysisFetcher } from './ReactivityOrchestrator'
 *   import { fetchAudioAnalysis } from './analysis'
 *   setAudioAnalysisFetcher(fetchAudioAnalysis)
 */
async function guardedFetchAnalysis(trackId: string): Promise<any> {
  if (!analysisFetcher) return null
  return await analysisFetcher(trackId)
}
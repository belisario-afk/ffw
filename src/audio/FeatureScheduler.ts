import { reactivityBus, type ReactiveFrame } from './ReactivityBus'
import type { TrackAnalysis } from '../spotify/analysis'

/**
 * Given playback position in seconds and Spotify track analysis,
 * schedule bar/beat/section events with slight lookahead.
 */
export function scheduleFromAnalysis(analysis: TrackAnalysis, nowSec: number, lookaheadSec = 0.12) {
  // You would call this periodically (e.g., every 250ms) with current position.
  const schedule = (items: { start: number, duration: number }[], type: 'beat' | 'bar' | 'section') => {
    const soon = items.find(i => i.start >= nowSec && i.start < nowSec + lookaheadSec)
    if (!soon) return
    const delay = Math.max(0, (soon.start - nowSec) * 1000)
    setTimeout(() => {
      const f = reactivityBus.latestFrame
      if (!f) return
      if (type === 'bar') reactivityBus.emitBar(f)
      // sections would carry name/idx, omitted for brevity
    }, delay)
  }
  schedule(analysis.bars, 'bar')
  schedule(analysis.beats, 'beat') // emitting 'beat' is optional; realtime beats usually come from flux
}
// Scheduler that uses Spotify TrackAnalysis to emit precise bar/section events
// and continuously updates bar/section phases on the ReactivityBus.

import { reactivityBus } from './ReactivityBus'
import type { TrackAnalysis } from '../spotify/analysis'

export type SchedulerHandle = { stop: () => void }

export function startAnalysisScheduler(
  analysis: TrackAnalysis,
  getPosSec: () => number,           // function returning current playback position in seconds
  opts?: { lookaheadSec?: number; tickMs?: number }
): SchedulerHandle {
  const lookaheadSec = opts?.lookaheadSec ?? 0.18
  const tickMs = opts?.tickMs ?? 120

  // Maintain next indices to schedule
  let barIdx = findIndexAtTime(analysis.bars, getPosSec())
  let sectionIdx = findIndexAtTime(analysis.sections, getPosSec())

  const timers = new Set<number>()
  const interval = window.setInterval(() => {
    const now = getPosSec()

    // Schedule upcoming bar within lookahead
    for (let i = barIdx; i < analysis.bars.length; i++) {
      const b = analysis.bars[i]
      if (b.start < now) { barIdx = i + 1; continue }
      const dt = b.start - now
      if (dt > lookaheadSec) break
      schedule(() => {
        const f = reactivityBus.latestFrame
        if (f) reactivityBus.emitBar(f)
      }, dt)
      barIdx = i + 1
    }

    // Schedule upcoming section within lookahead
    for (let i = sectionIdx; i < analysis.sections.length; i++) {
      const s = analysis.sections[i]
      if (s.start < now) { sectionIdx = i + 1; continue }
      const dt = s.start - now
      if (dt > lookaheadSec) break
      schedule(() => {
        const f = reactivityBus.latestFrame
        if (f) reactivityBus.emitSection(`section:${i}`, f)
      }, dt)
      sectionIdx = i + 1
    }
  }, tickMs)

  function schedule(fn: () => void, dtSec: number) {
    const t = window.setTimeout(() => { timers.delete(t); fn() }, Math.max(0, dtSec * 1000))
    timers.add(t)
  }

  // Smooth phases via rAF
  let raf = 0
  const rafLoop = () => {
    const pos = getPosSec()

    // Bar phase
    const bi = clampIndex(analysis.bars, pos)
    const b = analysis.bars[bi]
    const barPhase = clamp01((pos - b.start) / Math.max(0.001, b.duration))

    // Section phase
    const si = clampIndex(analysis.sections, pos)
    const s = analysis.sections[si]
    const secPhase = clamp01((pos - s.start) / Math.max(0.001, s.duration))

    reactivityBus.setPhases({ bar: barPhase, section: secPhase })
    raf = requestAnimationFrame(rafLoop)
  }
  raf = requestAnimationFrame(rafLoop)

  return {
    stop() {
      clearInterval(interval)
      for (const t of timers) clearTimeout(t)
      if (raf) cancelAnimationFrame(raf)
      timers.clear()
    }
  }
}

function findIndexAtTime(items: { start: number }[], t: number): number {
  let i = 0
  while (i < items.length && items[i].start < t) i++
  return i
}
function clampIndex(items: { start: number; duration: number }[], t: number): number {
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
function clamp01(x: number) { return Math.max(0, Math.min(1, x)) }
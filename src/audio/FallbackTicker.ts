import { reactivityBus, type ReactiveFrame } from './ReactivityBus'

/**
 * Emits gentle synthetic frames when the bus is stale, so scenes always render.
 * It never overrides fresh frames (it only emits if the latest frame is older than maxStaleMs).
 */
export function startFallbackTicker(opts?: { maxStaleMs?: number; fps?: number }) {
  const maxStaleMs = opts?.maxStaleMs ?? 250
  const fps = Math.max(5, Math.min(60, opts?.fps ?? 60))
  const intervalMs = 1000 / fps

  let stopped = false
  let t0 = performance.now()
  let lastEmit = 0

  function loop() {
    if (stopped) return
    const now = performance.now()
    const last = reactivityBus.latestFrame
    const stale = !last || (now - last.t) > maxStaleMs

    if (stale && now - lastEmit >= intervalMs) {
      const t = (now - t0) / 1000
      // Simple musical feel at ~120BPM
      const bpm = 120
      const beatPeriod = 60 / bpm
      const beatPhase = (t % beatPeriod) / beatPeriod
      const beat = beatPhase < 0.02 // short pulse window

      const low = 0.2 + 0.1 * (Math.sin(t * 2.0) + 1) * 0.5
      const mid = 0.2 + 0.1 * (Math.sin(t * 2.6 + 1.3) + 1) * 0.5
      const high = 0.2 + 0.12 * (Math.sin(t * 3.2 + 2.1) + 1) * 0.5

      const f: ReactiveFrame = {
        t: now,
        posMs: undefined,
        loudness: 0.25 + 0.15 * Math.sin(t * 0.6 + 0.5),
        bands: { low, mid, high },
        brightness: high,
        transient: Math.abs(Math.sin(t * 6.0)) * 0.4,
        beat,
        beatStrength: beat ? 0.8 : 0,
        tempo: bpm,
        phases: { beat: beatPhase, bar: (t / (beatPeriod * 4)) % 1, section: (t / (beatPeriod * 32)) % 1 }
      }
      reactivityBus.emitFrame(f)
      lastEmit = now
    }

    requestAnimationFrame(loop)
  }

  requestAnimationFrame(loop)

  return () => { stopped = true }
}
// Browser-safe ReactivityBus (no Node 'events' import)

export type Bands = { low: number; mid: number; high: number }
export type Phases = { beat: number; bar: number; section: number }

export type ReactiveFrame = {
  // Clocking
  t: number // performance.now()
  posMs?: number // playback position ms if known

  // Audio features (0..1 normalized unless noted)
  loudness: number
  bands: Bands
  brightness: number // spectral centroid 0..1
  transient: number // spectral flux 0..1

  // Rhythm
  beat: boolean
  beatStrength: number // 0..1
  tempo?: number

  // Phases in [0..1) if known/estimated
  phases: Phases

  // Optional pitch/color hints
  key?: number
  chroma?: Float32Array

  // Raw buckets (optional for scenes that want them)
  fft?: Float32Array
  fftLog?: Float32Array
}

type ReactiveEvents = {
  frame: (f: ReactiveFrame) => void
  beat: (f: ReactiveFrame) => void
  bar: (f: ReactiveFrame) => void
  section: (name: string, f: ReactiveFrame) => void
}

// Tiny typed emitter for browser builds
class TinyEmitter<E extends Record<string, (...args: any[]) => void>> {
  private map = new Map<keyof E, Set<Function>>()

  on<K extends keyof E>(ev: K, cb: E[K]) {
    let set = this.map.get(ev)
    if (!set) { set = new Set(); this.map.set(ev, set) }
    set.add(cb as any)
    return () => this.off(ev, cb)
  }

  off<K extends keyof E>(ev: K, cb: E[K]) {
    const set = this.map.get(ev)
    if (set) set.delete(cb as any)
  }

  emit<K extends keyof E>(ev: K, ...args: Parameters<E[K]>) {
    const set = this.map.get(ev)
    if (!set) return
    // Snapshot to avoid mutation during emit
    for (const cb of Array.from(set)) {
      try { (cb as any)(...args) } catch (e) { console.warn('ReactivityBus listener error', e) }
    }
  }
}

/**
 * ReactivityBus: central pub/sub for music-driven data.
 * Scenes subscribe via on('frame'|'beat'|...) and can read latestFrame.
 */
export class ReactivityBus {
  private emitter = new TinyEmitter<ReactiveEvents>()
  latestFrame: ReactiveFrame | null = null

  on<K extends keyof ReactiveEvents>(ev: K, cb: ReactiveEvents[K]) {
    return this.emitter.on(ev, cb)
  }

  emitFrame(f: ReactiveFrame) {
    this.latestFrame = f
    this.emitter.emit('frame', f)
    if (f.beat) this.emitter.emit('beat', f)
  }

  emitBar(f: ReactiveFrame) {
    this.emitter.emit('bar', f)
  }

  emitSection(name: string, f: ReactiveFrame) {
    this.emitter.emit('section', name, f)
  }
}

export const reactivityBus = new ReactivityBus()
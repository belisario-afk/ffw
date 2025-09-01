// Browser-safe bus (unchanged API), add helper to set phases without emitting beat
export type Bands = { low: number; mid: number; high: number }
export type Phases = { beat: number; bar: number; section: number }

export type ReactiveFrame = {
  t: number
  posMs?: number
  loudness: number
  bands: Bands
  brightness: number
  transient: number
  beat: boolean
  beatStrength: number
  tempo?: number
  phases: Phases
  key?: number
  chroma?: Float32Array
  fft?: Float32Array
  fftLog?: Float32Array
}

type ReactiveEvents = {
  frame: (f: ReactiveFrame) => void
  beat: (f: ReactiveFrame) => void
  bar: (f: ReactiveFrame) => void
  section: (name: string, f: ReactiveFrame) => void
}

class TinyEmitter<E extends Record<string, (...args: any[]) => void>> {
  private map = new Map<keyof E, Set<Function>>()
  on<K extends keyof E>(ev: K, cb: E[K]) { let s = this.map.get(ev); if (!s) { s = new Set(); this.map.set(ev, s) } s.add(cb as any); return () => s!.delete(cb as any) }
  emit<K extends keyof E>(ev: K, ...args: Parameters<E[K]>) { const s = this.map.get(ev); if (!s) return; for (const cb of Array.from(s)) { try { (cb as any)(...args) } catch (e) { console.warn('reactivity listener', e) } } }
}

export class ReactivityBus {
  private em = new TinyEmitter<ReactiveEvents>()
  latestFrame: ReactiveFrame | null = null

  on<K extends keyof ReactiveEvents>(ev: K, cb: ReactiveEvents[K]) { return this.em.on(ev, cb) }

  emitFrame(f: ReactiveFrame) {
    this.latestFrame = f
    this.em.emit('frame', f)
    if (f.beat) this.em.emit('beat', f)
  }
  emitBar(f: ReactiveFrame) { this.em.emit('bar', f) }
  emitSection(name: string, f: ReactiveFrame) { this.em.emit('section', name, f) }

  setPhases(patch: Partial<Phases>) {
    const f = this.latestFrame
    if (!f) return
    f.phases = { ...f.phases, ...patch }
    this.em.emit('frame', f)
  }
}

export const reactivityBus = new ReactivityBus()
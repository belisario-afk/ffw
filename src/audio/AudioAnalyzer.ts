// Patched to emit rich features to the global reactivity bus while preserving the AnalysisFrame API.
import { reactivityBus, type ReactiveFrame } from './ReactivityBus'

export type AnalysisFrame = {
  time: number // seconds
  fft: Float32Array
  fftLog: Float32Array
  chroma: Float32Array
  loudness: number // 0..1
  beat: boolean
  tempo: number
}

export type AudioAnalyzerOptions = {
  fftSize: number
  smoothing: number
  epilepsySafe?: boolean
  reducedMotion?: boolean
}

export class AudioAnalyzer {
  private ctx: AudioContext
  private analyser: AnalyserNode
  private gain: GainNode
  private srcNode?: MediaElementAudioSourceNode | MediaStreamAudioSourceNode
  private dataFreq: Float32Array
  private dataTime: Float32Array
  private dataByte: Uint8Array
  private running = false
  private lastFrameTime = 0

  // beat detection (spectral flux)
  private lastSpectrum?: Float32Array
  private fluxHistory: number[] = []
  private beatPhase = 0 // 0..1
  private tempoBPM = 120
  private lastBeatAt = 0
  private beatCooldownMs = 90 // min gap to avoid doubles
  private emaLoud = 0
  private emaLow = 0
  private emaMid = 0
  private emaHigh = 0
  private emaCentroid = 0
  private posMsApprox = 0
  private startedAt = performance.now()

  onFrame?: (f: AnalysisFrame) => void

  constructor(private opts: AudioAnalyzerOptions) {
    const AC = window.AudioContext || (window as any).webkitAudioContext
    this.ctx = new AC()
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = Math.max(256, Math.pow(2, Math.round(Math.log2(opts.fftSize))))
    this.analyser.smoothingTimeConstant = Math.max(0, Math.min(0.99, opts.smoothing))
    this.gain = this.ctx.createGain()
    this.gain.gain.value = 1
    this.gain.connect(this.analyser)
    this.analyser.connect(this.ctx.destination)

    const bins = this.analyser.frequencyBinCount
    this.dataFreq = new Float32Array(bins)
    this.dataTime = new Float32Array(this.analyser.fftSize)
    this.dataByte = new Uint8Array(bins)
  }

  attachMedia(el: HTMLMediaElement) {
    if (this.srcNode) try { (this.srcNode as any).disconnect() } catch {}
    this.srcNode = this.ctx.createMediaElementSource(el)
    this.srcNode.connect(this.gain)
  }

  attachStream(stream: MediaStream) {
    if (this.srcNode) try { (this.srcNode as any).disconnect() } catch {}
    this.srcNode = this.ctx.createMediaStreamSource(stream)
    this.srcNode.connect(this.gain)
  }

  async resume() {
    if (this.ctx.state !== 'running') {
      await this.ctx.resume()
    }
  }

  run() {
    if (this.running) return
    this.running = true
    this.startedAt = performance.now()
    const loop = () => {
      if (!this.running) return
      this.step()
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  }

  stop() {
    this.running = false
  }

  private step() {
    const now = performance.now()
    const dt = (now - (this.lastFrameTime || now)) / 1000
    this.lastFrameTime = now

    // Collect data
    this.analyser.getFloatFrequencyData(this.dataFreq)
    this.analyser.getByteFrequencyData(this.dataByte)
    this.analyser.getFloatTimeDomainData(this.dataTime)

    // Loudness (RMS of time domain)
    let sumSq = 0
    for (let i = 0; i < this.dataTime.length; i++) {
      const v = this.dataTime[i]
      sumSq += v * v
    }
    const rms = Math.sqrt(sumSq / this.dataTime.length)
    const loud = clamp01((rms - 0.02) / 0.3)
    this.emaLoud = ema(this.emaLoud, loud, 0.3)

    // Log power spectrum 0..1
    const fft = this.dataByte // 0..255
    const fftNorm = new Float32Array(fft.length)
    for (let i = 0; i < fft.length; i++) fftNorm[i] = fft[i] / 255

    const fftLog = downsampleLog(fftNorm, 256)

    // Bands
    const [low, mid, high] = integrateBands(fftLog, [0.0, 0.18, 0.55, 1.0])
    this.emaLow = ema(this.emaLow, low, 0.25)
    this.emaMid = ema(this.emaMid, mid, 0.25)
    this.emaHigh = ema(this.emaHigh, high, 0.25)

    // Spectral centroid (brightness)
    let num = 0, den = 0
    for (let i = 0; i < fftNorm.length; i++) { num += i * fftNorm[i]; den += fftNorm[i] }
    const centroid = clamp01(den > 0 ? num / (den * fftNorm.length) : 0)
    this.emaCentroid = ema(this.emaCentroid, centroid, 0.2)

    // Spectral flux beat detection
    let flux = 0
    if (this.lastSpectrum && this.lastSpectrum.length === fftNorm.length) {
      for (let i = 0; i < fftNorm.length; i++) {
        const diff = fftNorm[i] - this.lastSpectrum[i]
        if (diff > 0) flux += diff
      }
    }
    this.lastSpectrum = fftNorm
    this.fluxHistory.push(flux)
    if (this.fluxHistory.length > 43) this.fluxHistory.shift() // ~0.7s at 60fps

    const avg = average(this.fluxHistory)
    const std = stddev(this.fluxHistory, avg)
    const z = std > 1e-5 ? (flux - avg) / std : 0
    const beatCandidate = z > 2.2 // simple threshold
    let beat = false
    let beatStrength = clamp01((z - 2.2) / 2.5)

    if (beatCandidate && (now - this.lastBeatAt) > this.beatCooldownMs) {
      beat = true
      this.lastBeatAt = now
      // adaptive tempo estimate
      const gap = now - (this.lastBeatAt || now)
      if (gap > 250 && gap < 1500) {
        const bpm = 60_000 / gap
        // clamp to sensible range
        if (bpm > 70 && bpm < 180) this.tempoBPM = this.tempoBPM * 0.8 + bpm * 0.2
      }
      this.beatPhase = 0
    } else {
      const period = 60_000 / this.tempoBPM
      this.beatPhase = (this.beatPhase + (dt * 1000) / period) % 1
      beatStrength *= 0.9
    }

    // Approx playback position (best effort if SDK not queried)
    this.posMsApprox += dt * 1000

    const frame: AnalysisFrame = {
      time: (now - this.startedAt) / 1000,
      fft: fftNorm,
      fftLog,
      chroma: new Float32Array(12), // placeholder
      loudness: this.emaLoud,
      beat,
      tempo: this.tempoBPM
    }

    // Emit to existing per-scene callback
    if (this.onFrame) this.onFrame(frame)

    // Emit to global bus with richer features
    const busFrame: ReactiveFrame = {
      t: now,
      posMs: this.posMsApprox,
      loudness: this.emaLoud,
      bands: { low: this.emaLow, mid: this.emaMid, high: this.emaHigh },
      brightness: this.emaCentroid,
      transient: clamp01((flux - avg) / (std || 1)),
      beat,
      beatStrength,
      tempo: this.tempoBPM,
      phases: { beat: this.beatPhase, bar: 0, section: 0 },
      chroma: undefined,
      fft: fftNorm,
      fftLog
    }
    reactivityBus.emitFrame(busFrame)
  }
}

// ---------- helpers ----------
function ema(prev: number, x: number, k = 0.25) { return prev * (1 - k) + x * k }
function clamp01(x: number) { return Math.max(0, Math.min(1, x)) }
function average(arr: number[]) { if (!arr.length) return 0; return arr.reduce((a, b) => a + b, 0) / arr.length }
function stddev(arr: number[], avg: number) {
  if (!arr.length) return 0
  let s = 0
  for (let i = 0; i < arr.length; i++) { const d = arr[i] - avg; s += d * d }
  return Math.sqrt(s / arr.length)
}

function downsampleLog(src: Float32Array, outLen: number) {
  const out = new Float32Array(outLen)
  const N = src.length
  for (let i = 0; i < outLen; i++) {
    // log mapping: f = exp(ln(min) + t * ln(max/min))
    const t = i / (outLen - 1)
    const idx = Math.min(N - 1, Math.floor(Math.exp(t * Math.log(N))))
    out[i] = src[idx]
  }
  return out
}

function integrateBands(arr: Float32Array, cuts: [number, number, number, number]): [number, number, number] {
  const N = arr.length
  const idx = (t: number) => Math.max(0, Math.min(N, Math.floor(t * N)))
  const [a0, a1, a2, a3] = cuts.map(idx)
  const avg = (i0: number, i1: number) => {
    let s = 0, c = Math.max(1, i1 - i0)
    for (let i = i0; i < i1; i++) s += arr[i]
    return s / c
  }
  return [avg(a0, a1), avg(a1, a2), avg(a2, a3)]
}
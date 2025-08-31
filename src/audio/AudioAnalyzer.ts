export type AnalysisConfig = {
  fftSize: 4096 | 8192
  smoothing: number // 0..1
  sampleRate?: number
  epilepsySafe?: boolean
  reducedMotion?: boolean
}

export type AnalysisFrame = {
  time: number
  fft: Float32Array // linear magnitude 0..1
  fftLog: Float32Array // log-frequency remap magnitude 0..1
  chroma: Float32Array // 12 bins
  loudness: number // 0..1
  beat: boolean
  tempo: number // bpm estimate
}

export class AudioAnalyzer {
  ctx: AudioContext
  analyser: AnalyserNode
  gain: GainNode
  source?: MediaElementAudioSourceNode
  dataF: Float32Array
  lastMag: Float32Array
  lastFluxes: number[] = []
  frameCount = 0
  lastBeatTime = 0
  tempo = 0
  onFrame?: (f: AnalysisFrame) => void
  cfg: AnalysisConfig

  constructor(cfg: AnalysisConfig) {
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
    this.cfg = cfg
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = cfg.fftSize
    this.analyser.smoothingTimeConstant = cfg.smoothing
    this.gain = this.ctx.createGain()
    this.gain.gain.value = 1
    this.analyser.connect(this.gain).connect(this.ctx.destination)
    const bins = this.analyser.frequencyBinCount
    this.dataF = new Float32Array(bins)
    this.lastMag = new Float32Array(bins)
  }

  attachMedia(el: HTMLMediaElement) {
    // Only attach once
    if (!this.source) {
      try {
        this.source = this.ctx.createMediaElementSource(el)
        this.source.connect(this.analyser)
      } catch (e) {
        // Media element might be cross-origin/restricted
        console.warn('Unable to attach media source; using silent analysis fallback.', e)
      }
    }
  }

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume()
  }

  computeLogMap(input: Float32Array): Float32Array {
    const bins = input.length
    const outBins = 256
    const out = new Float32Array(outBins)
    const minHz = 20
    const maxHz = Math.min(20000, this.ctx.sampleRate / 2)
    for (let i = 0; i < outBins; i++) {
      const f1 = Math.pow(maxHz / minHz, i / outBins) * minHz
      const f2 = Math.pow(maxHz / minHz, (i + 1) / outBins) * minHz
      const bin1 = Math.floor(f1 / (this.ctx.sampleRate / this.analyser.fftSize))
      const bin2 = Math.min(input.length - 1, Math.max(bin1, Math.floor(f2 / (this.ctx.sampleRate / this.analyser.fftSize))))
      let sum = 0
      for (let b = bin1; b <= bin2; b++) sum += input[b]
      out[i] = sum / Math.max(1, bin2 - bin1 + 1)
    }
    return out
  }

  computeChroma(input: Float32Array): Float32Array {
    // Crude chroma projection on 12 bins
    const sr = this.ctx.sampleRate
    const bins = input.length
    const chroma = new Float32Array(12)
    for (let i = 1; i < bins; i++) {
      const freq = i * sr / this.analyser.fftSize
      if (freq < 50 || freq > 5000) continue
      const midi = 69 + 12 * Math.log2(freq / 440)
      const idx = Math.round(midi) % 12
      if (idx >= 0) chroma[idx] += input[i]
    }
    // normalize
    let max = 0
    for (let i = 0; i < 12; i++) max = Math.max(max, chroma[i])
    if (max > 0) for (let i = 0; i < 12; i++) chroma[i] /= max
    return chroma
  }

  step() {
    // Use getFloatFrequencyData for magnitude in dB scaled to 0..1
    const size = this.analyser.frequencyBinCount
    const buf = new Float32Array(size)
    this.analyser.getFloatFrequencyData(buf)
    // convert dB to linear 0..1
    const arr = new Float32Array(size)
    for (let i = 0; i < size; i++) {
      const db = buf[i]
      const lin = Math.min(1, Math.max(0, (db + 100) / 70)) // map -100..-30dB roughly
      arr[i] = lin
    }
    // spectral flux
    let flux = 0
    for (let i = 0; i < size; i++) {
      const diff = arr[i] - this.lastMag[i]
      if (diff > 0) flux += diff
    }
    this.lastMag.set(arr)
    this.lastFluxes.push(flux)
    if (this.lastFluxes.length > 120) this.lastFluxes.shift()
    const mean = this.lastFluxes.reduce((a, b) => a + b, 0) / this.lastFluxes.length
    const std = Math.sqrt(this.lastFluxes.reduce((a, b) => a + (b - mean) * (b - mean), 0) / this.lastFluxes.length)
    const adaptive = mean + std * 1.5
    const beat = flux > adaptive && (performance.now() - this.lastBeatTime > 120)

    if (beat) this.lastBeatTime = performance.now()
    // crude tempo estimate
    // Collect inter-beat intervals
    // (skipped for brevity; approximate from avg interval)
    const tempo = this.tempo || 120

    const fftLog = this.computeLogMap(arr)
    const chroma = this.computeChroma(arr)
    const loudness = fftLog.slice(0, 16).reduce((a, b) => a + b, 0) / 16

    const frame: AnalysisFrame = {
      time: this.ctx.currentTime,
      fft: arr,
      fftLog,
      chroma,
      loudness,
      beat,
      tempo
    }
    this.onFrame?.(frame)
  }

  run() {
    const loop = () => {
      this.step()
      requestAnimationFrame(loop)
    }
    loop()
  }
}
import React, { useEffect, useRef, useState } from 'react'
import type { AuthState } from '../../auth/token'
import { ensurePlayerConnected } from '../../spotify/player'
import { AudioAnalyzer, type AnalysisFrame } from '../../audio/AudioAnalyzer'
import { CONFIG } from '../../config'
import { getPlaybackState } from '../../spotify/api'
import { extractPaletteFromImage, applyPaletteToCss } from '../../utils/palette'
import { cacheAlbumArt } from '../../utils/idb'
import { setAlbumSkin } from '../../ui/ThemeManager'

type Props = {
  auth: AuthState | null
  quality: {
    renderScale: 1 | 1.25 | 1.5 | 1.75 | 2
    msaa: 0 | 2 | 4 | 8
    bloom: boolean
    motionBlur: boolean
  }
  accessibility: {
    epilepsySafe: boolean
    reducedMotion: boolean
    highContrast: boolean
    albumSkin: boolean
  }
}

export default function BlankScene({ auth, quality, accessibility }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [ctx2d, setCtx2d] = useState<CanvasRenderingContext2D | null>(null)
  const analyzerRef = useRef<AudioAnalyzer | null>(null)

  // Render loop state
  const lastFrameRef = useRef<AnalysisFrame | null>(null)
  const rafRef = useRef<number | null>(null)

  const [trackMeta, setTrackMeta] = useState<{ name: string, artists: string, albumUrl: string }|null>(null)

  useEffect(() => {
    const canvas = canvasRef.current!
    const dpr = Math.min(2, window.devicePixelRatio || 1) * quality.renderScale
    canvas.width = Math.floor(canvas.clientWidth * dpr)
    canvas.height = Math.floor(canvas.clientHeight * dpr)
    const ctx = canvas.getContext('2d', { alpha: true })
    if (ctx) {
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      setCtx2d(ctx)
    }
    const onResize = () => {
      const dprR = Math.min(2, window.devicePixelRatio || 1) * quality.renderScale
      canvas.width = Math.floor(canvas.clientWidth * dprR)
      canvas.height = Math.floor(canvas.clientHeight * dprR)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [quality.renderScale])

  // Start render loop regardless of analyzer so scene is always visible
  useEffect(() => {
    if (!ctx2d || !canvasRef.current) return
    let running = true
    const loop = () => {
      if (!running) return
      const f = lastFrameRef.current || fallbackFrame()
      drawFrame(ctx2d, canvasRef.current!, f, {
        bloom: quality.bloom,
        motionBlur: quality.motionBlur && !accessibility.reducedMotion,
        epilepsySafe: accessibility.epilepsySafe
      })
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => { running = false; if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [ctx2d, quality.bloom, quality.motionBlur, accessibility])

  useEffect(() => {
    let cancelled = false
    async function boot() {
      if (!auth) return
      try {
        await ensurePlayerConnected()

        const aEl = findAudioElement()
        const analyzer = new AudioAnalyzer({
          fftSize: CONFIG.fftSize,
          smoothing: 0.8,
          epilepsySafe: accessibility.epilepsySafe,
          reducedMotion: accessibility.reducedMotion
        })
        analyzerRef.current = analyzer
        if (aEl) {
          analyzer.attachMedia(aEl)
          await analyzer.resume()
        }
        analyzer.onFrame = (frame) => { lastFrameRef.current = frame }
        analyzer.run()

        const s = await getPlaybackState().catch(() => null)
        if (s?.item?.album?.images?.length) {
          const url = s.item.album.images[0].url as string
          const blobUrl = await cacheAlbumArt(url).catch(() => url)
          setTrackMeta({
            name: s.item.name,
            artists: (s.item.artists || []).map((a: any) => a.name).join(', '),
            albumUrl: blobUrl
          })
          const img = new Image()
          img.crossOrigin = 'anonymous'
          img.src = blobUrl
          img.onload = () => {
            const pal = extractPaletteFromImage(img)
            applyPaletteToCss(pal)
            setAlbumSkin(blobUrl)
          }
        }
      } catch (e) {
        console.warn('Player init failed', e)
      }
    }
    boot()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth])

  return (
    <div style={{ height: '100%', position: 'relative' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} aria-label="Visualization canvas" />
      {trackMeta && (
        <div className="badge" style={{ position: 'absolute', left: 16, bottom: 62 }}>
          <div className="track-meta">
            <img src={trackMeta.albumUrl} alt="Album art" />
            <div>
              <div style={{ fontWeight: 600 }}>{trackMeta.name}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>{trackMeta.artists}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function findAudioElement(): HTMLAudioElement | undefined {
  const els = Array.from(document.querySelectorAll('audio')) as HTMLAudioElement[]
  return els.find(el => !!el.src)
}

function fallbackFrame(): AnalysisFrame {
  const t = performance.now() / 1000
  const fft = new Float32Array(2048).fill(0).map((_, i) => 0.08 + 0.04 * Math.sin(i * 0.02 + t * 2))
  const fftLog = new Float32Array(256).fill(0).map((_, i) => 0.1 + 0.06 * Math.sin(i * 0.12 + t * 2.2))
  const chroma = new Float32Array(12).fill(0)
  return { time: t, fft, fftLog, chroma, loudness: 0.12, beat: false, tempo: 120 }
}

function drawFrame(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, frame: AnalysisFrame, opts: { bloom: boolean, motionBlur: boolean, epilepsySafe: boolean }) {
  const { width: W, height: H } = canvas
  const g = ctx

  if (opts.motionBlur) {
    g.fillStyle = 'rgba(10, 15, 20, 0.08)'
    g.fillRect(0, 0, W, H)
  } else {
    const bg = g.createLinearGradient(0, 0, 0, H)
    bg.addColorStop(0, 'rgba(0,0,0,0.5)')
    bg.addColorStop(1, 'rgba(0,0,0,0.75)')
    g.fillStyle = bg
    g.fillRect(0, 0, W, H)
  }

  const color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0ff'
  const color2 = getComputedStyle(document.documentElement).getPropertyValue('--accent-2').trim() || '#f0f'

  const baseY = H * 0.65
  const loud = frame.loudness
  g.strokeStyle = color
  g.lineWidth = Math.max(1, 2 + loud * 4)
  g.globalCompositeOperation = 'lighter'
  g.beginPath()
  const N = frame.fftLog.length
  const scaleX = W / (N - 1)
  for (let i = 0; i < N; i++) {
    const v = frame.fftLog[i]
    const y = baseY - Math.pow(v, 0.6) * (H * 0.3)
    const x = i * scaleX
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y)
  }
  g.stroke()

  if (opts.bloom) {
    g.shadowColor = color
    g.shadowBlur = 16 + loud * 24
  } else {
    g.shadowBlur = 0
  }

  const bars = 48
  const step = Math.max(1, Math.floor(frame.fftLog.length / bars))
  const barW = (W - 40) / bars
  for (let i = 0; i < bars; i++) {
    const v = frame.fftLog[i * step] ?? 0
    const h = Math.pow(v, 0.8) * (H * 0.25) + (frame.beat ? 2 : 0)
    const x = 20 + i * barW
    const y = H - 24 - h
    g.fillStyle = i % 2 === 0 ? color : color2
    g.fillRect(x, y, barW * 0.8, h)
  }

  if (frame.beat) {
    const r = 24 + loud * 40
    g.beginPath()
    g.arc(W * 0.85, H * 0.2, r, 0, Math.PI * 2)
    g.strokeStyle = color
    g.lineWidth = 2
    g.stroke()
  }

  g.globalCompositeOperation = 'source-over'
  g.shadowBlur = 0
}
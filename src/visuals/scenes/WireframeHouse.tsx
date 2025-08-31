import React, { useEffect, useRef, useState } from 'react'
import type { AuthState } from '../../auth/token'
import { initPlayer } from '../../spotify/player'
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
  }
}

type Vec3 = { x: number; y: number; z: number }
type Edge = [number, number]

export default function WireframeHouse({ auth, quality, accessibility }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [ctx2d, setCtx2d] = useState<CanvasRenderingContext2D | null>(null)
  const analyzerRef = useRef<AudioAnalyzer | null>(null)
  const [trackMeta, setTrackMeta] = useState<{ name: string, artists: string, albumUrl: string }|null>(null)

  const vertsRef = useRef<Vec3[]>([])
  const restRef = useRef<Vec3[]>([])
  const velRef = useRef<Vec3[]>([])
  const edgesRef = useRef<Edge[]>([])
  const starsRef = useRef<{ x: number; y: number; z: number; b: number }[]>([])
  const lastBeatAtRef = useRef(0)
  const tRef = useRef(0)

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

  useEffect(() => {
    // geometry
    const base = 1.2, h = 0.8, roofH = 0.9
    const verts: Vec3[] = [
      { x: -base, y: -h, z: -base },
      { x:  base, y: -h, z: -base },
      { x:  base, y: -h, z:  base },
      { x: -base, y: -h, z:  base },
      { x: -base, y:  0,  z: -base },
      { x:  base, y:  0,  z: -base },
      { x:  base, y:  0,  z:  base },
      { x: -base, y:  0,  z:  base },
      { x: 0, y: roofH, z: 0 }
    ]
    const e: Edge[] = [
      [0,1],[1,2],[2,3],[3,0],
      [4,5],[5,6],[6,7],[7,4],
      [0,4],[1,5],[2,6],[3,7],
      [4,8],[5,8],[6,8],[7,8],
      [4,6],[5,7]
    ]
    vertsRef.current = verts.map(v => ({...v}))
    restRef.current = verts.map(v => ({...v}))
    velRef.current = verts.map(() => ({ x: 0, y: 0, z: 0 }))
    edgesRef.current = e

    // stars
    const stars = Array.from({ length: 600 }, () => ({
      x: (Math.random() * 2 - 1) * 2.5,
      y: (Math.random() * 2 - 1) * 2.0,
      z: Math.random() * 3 + 1.5,
      b: Math.random()
    }))
    starsRef.current = stars
  }, [])

  useEffect(() => {
    let cancelled = false
    async function boot() {
      if (!auth) return
      try {
        const player = await initPlayer('FFW Visualizer')
        await player.connect()

        const findAudio = () => {
          const els = Array.from(document.querySelectorAll('audio')) as HTMLAudioElement[]
          return els.find(el => !!el.src)
        }
        const aEl = findAudio()
        const analyzer = new AudioAnalyzer({
          fftSize: CONFIG.fftSize,
          smoothing: 0.82,
          epilepsySafe: accessibility.epilepsySafe,
          reducedMotion: accessibility.reducedMotion
        })
        analyzerRef.current = analyzer
        if (aEl) {
          analyzer.attachMedia(aEl)
          await analyzer.resume()
        }
        analyzer.onFrame = onAnalysisFrame
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
  }, [auth])

  function onAnalysisFrame(frame: AnalysisFrame) {
    const canvas = canvasRef.current
    const ctx = ctx2d
    if (!canvas || !ctx) return
    stepHousePhysics(frame)
    drawScene(ctx, canvas, frame, {
      bloom: quality.bloom,
      motionBlur: quality.motionBlur && !accessibility.reducedMotion,
      epilepsySafe: accessibility.epilepsySafe
    })
  }

  return (
    <div style={{ height: '100%', position: 'relative' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} aria-label="Wireframe House visualization" />
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

  function stepHousePhysics(frame: AnalysisFrame) {
    const verts = vertsRef.current
    const rest = restRef.current
    const vel = velRef.current
    const now = performance.now()
    const minBeatGap = accessibility.epilepsySafe ? 180 : 120

    if (frame.beat && now - lastBeatAtRef.current > minBeatGap) {
      lastBeatAtRef.current = now
      const power = 0.22 + frame.loudness * 0.5
      for (let i = 0; i < verts.length; i++) {
        const d = { x: verts[i].x, y: verts[i].y, z: verts[i].z }
        const len = Math.max(0.001, Math.hypot(d.x, d.y, d.z))
        const dir = { x: d.x / len, y: d.y / len, z: d.z / len }
        vel[i].x += dir.x * power * (0.8 + Math.random() * 0.4)
        vel[i].y += (dir.y * 0.6 + 0.15) * power
        vel[i].z += dir.z * power * (0.8 + Math.random() * 0.4)
      }
    }

    const dt = 1 / 60
    const k = 6.0
    const damp = 0.85
    for (let i = 0; i < verts.length; i++) {
      const toRest = { x: rest[i].x - verts[i].x, y: rest[i].y - verts[i].y, z: rest[i].z - verts[i].z }
      vel[i].x = (vel[i].x + toRest.x * k * dt) * damp
      vel[i].y = (vel[i].y + toRest.y * k * dt) * damp
      vel[i].z = (vel[i].z + toRest.z * k * dt) * damp
      verts[i].x += vel[i].x * dt
      verts[i].y += vel[i].y * dt
      verts[i].z += vel[i].z * dt
    }

    tRef.current += dt
  }

  function drawScene(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, frame: AnalysisFrame, opts: { bloom: boolean, motionBlur: boolean, epilepsySafe: boolean }) {
    const { width: W, height: H } = canvas
    const g = ctx

    if (opts.motionBlur) {
      g.fillStyle = 'rgba(6, 10, 14, 0.08)'
      g.fillRect(0, 0, W, H)
    } else {
      const bg = g.createLinearGradient(0, 0, 0, H)
      bg.addColorStop(0, 'rgba(0,0,0,0.9)')
      bg.addColorStop(1, 'rgba(3,7,10,0.96)')
      g.fillStyle = bg
      g.fillRect(0, 0, W, H)
    }

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0ff'
    const accent2 = getComputedStyle(document.documentElement).getPropertyValue('--accent-2').trim() || '#f0f'

    drawStars(g, W, H, starsRef.current, frame)

    g.globalCompositeOperation = 'lighter'
    g.fillStyle = withAlpha(accent, 0.05 + frame.loudness * 0.06)
    g.beginPath()
    g.ellipse(W*0.5, H*0.82, W*0.6, H*0.12 + frame.loudness * 10, 0, 0, Math.PI*2)
    g.fill()
    g.globalCompositeOperation = 'source-over'

    const camRotY = Math.sin(tRef.current * 0.4) * 0.15
    const camRotX = -0.15 + Math.cos(tRef.current * 0.3) * 0.05
    const camDist = 5.2 + Math.sin(tRef.current * 0.15) * 0.1

    drawHouseWireframe(g, W, H, vertsRef.current, edgesRef.current, { accent, accent2, glow: opts.bloom, rotX: camRotX, rotY: camRotY, dist: camDist, beat: frame.beat && !opts.epilepsySafe ? 1 : 0 })
  }

  function drawStars(g: CanvasRenderingContext2D, W: number, H: number, stars: {x:number;y:number;z:number;b:number}[], frame: AnalysisFrame) {
    const tw = frame.chroma[0] * 0.6 + frame.chroma[7] * 0.4
    const base = 0.6 + frame.loudness * 0.3
    g.fillStyle = 'white'
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i]
      const fx = (s.x / s.z) * 240 + (W / 2)
      const fy = (s.y / s.z) * 240 + (H / 3)
      const size = Math.max(0.6, (1.6 - s.z * 0.3) * (0.7 + s.b * 0.6))
      const a = Math.min(0.8, 0.25 + s.b * 0.5 + base * 0.08 + tw * 0.06)
      g.fillStyle = `rgba(255,255,255,${a})`
      g.fillRect(fx, fy, size, size)
    }
  }

  function drawHouseWireframe(
    g: CanvasRenderingContext2D,
    W: number, H: number,
    verts: Vec3[], edges: Edge[],
    opts: { accent: string; accent2: string; glow: boolean; rotX: number; rotY: number; dist: number; beat: number }
  ) {
    const cosY = Math.cos(opts.rotY), sinY = Math.sin(opts.rotY)
    const cosX = Math.cos(opts.rotX), sinX = Math.sin(opts.rotX)
    const proj: { x: number; y: number; z: number }[] = []
    for (const v of verts) {
      const rx = v.x * cosY - v.z * sinY
      const rz = v.x * sinY + v.z * cosY
      const ry = v.y * cosX - rz * sinX
      const rzz = v.y * sinX + rz * cosX
      const z = rzz + opts.dist
      const f = 240 / z
      proj.push({ x: rx * f + W / 2, y: ry * f + H * 0.62, z })
    }

    const pulse = opts.beat ? 1 : 0
    const width = 1.3 + pulse * 0.6
    g.lineCap = 'round'
    g.lineJoin = 'round'

    if (opts.glow) {
      g.shadowColor = opts.accent
      g.shadowBlur = 12 + pulse * 10
    } else {
      g.shadowBlur = 0
    }

    g.strokeStyle = withAlpha(opts.accent2, 0.35)
    g.lineWidth = width
    g.globalCompositeOperation = 'lighter'
    for (const [a, b] of edges) {
      if (proj[a].z > proj[b].z) {
        g.beginPath()
        g.moveTo(proj[a].x, proj[a].y)
        g.lineTo(proj[b].x, proj[b].y)
        g.stroke()
      }
    }

    g.strokeStyle = withAlpha(opts.accent, 0.9)
    g.lineWidth = width + 0.6
    for (const [a, b] of edges) {
      if (proj[a].z <= proj[b].z) {
        g.beginPath()
        g.moveTo(proj[a].x, proj[a].y)
        g.lineTo(proj[b].x, proj[b].y)
        g.stroke()
      }
    }
    g.globalCompositeOperation = 'source-over'
    g.shadowBlur = 0
  }

  function withAlpha(hexOrCss: string, a: number) {
    if (hexOrCss.startsWith('#')) {
      const h = hexOrCss.replace('#','')
      const r = parseInt(h.slice(0,2),16)
      const g = parseInt(h.slice(2,4),16)
      const b = parseInt(h.slice(4,6),16)
      return `rgba(${r},${g},${b},${a})`
    }
    if (hexOrCss.startsWith('rgb')) {
      return hexOrCss.replace(/rgba?\(([^)]+)\)/, (_m, inner) => {
        const [r,g,b] = inner.split(',').map((s:string)=>s.trim()).slice(0,3)
        return `rgba(${r},${g},${b},${a})`
      })
    }
    return hexOrCss
  }
}
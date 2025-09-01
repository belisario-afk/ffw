import React, { useEffect, useRef, useState } from 'react'
import type { AuthState } from '../../auth/token'
import { ensurePlayerConnected } from '../../spotify/player'
import { AudioAnalyzer, type AnalysisFrame } from '../../audio/AudioAnalyzer'
import { CONFIG } from '../../config'
import { getPlaybackState } from '../../spotify/api'
import { extractPaletteFromImage, applyPaletteToCss } from '../../utils/palette'
import { cacheAlbumArt } from '../../utils/idb'
import { setAlbumSkin } from '../../ui/ThemeManager'
import type { HouseSettings } from '../../ui/HousePanel'

type Props = {
  auth: AuthState | null
  quality: { renderScale: 1 | 1.25 | 1.5 | 1.75 | 2, msaa: 0 | 2 | 4 | 8, bloom: boolean, motionBlur: boolean }
  accessibility: { epilepsySafe: boolean, reducedMotion: boolean, highContrast: boolean }
  settings: HouseSettings
}

type Vec3 = { x: number; y: number; z: number }
type Edge = [number, number]

export default function WireframeHouse({ auth, quality, accessibility, settings }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [ctx2d, setCtx2d] = useState<CanvasRenderingContext2D | null>(null)

  // Geometry
  const vertsRef = useRef<Vec3[]>([])
  const restRef = useRef<Vec3[]>([])
  const velRef = useRef<Vec3[]>([])
  const edgesRef = useRef<Edge[]>([])
  const windowsRef = useRef<Array<{ p: Vec3 }>>([])

  // World
  const starsRef = useRef<{ x: number; y: number; z: number; b: number }[]>([])

  // Dynamics
  const lastBeatAtRef = useRef(0)
  const beatIntensityRef = useRef(0)
  const shakeRef = useRef(0)
  const orbitAngleRef = useRef(0)

  // Analysis/render
  const analyzerRef = useRef<AudioAnalyzer | null>(null)
  const lastFrameRef = useRef<AnalysisFrame | null>(null)
  const rafRef = useRef<number | null>(null)

  // Meta
  const [trackMeta, setTrackMeta] = useState<{ name: string, artists: string, albumUrl: string }|null>(null)

  // Canvas setup
  useEffect(() => {
    const canvas = canvasRef.current!
    const dpr = Math.min(2, window.devicePixelRatio || 1) * quality.renderScale
    canvas.width = Math.floor(canvas.clientWidth * dpr)
    canvas.height = Math.floor(canvas.clientHeight * dpr)
    const ctx = canvas.getContext('2d', { alpha: true })
    if (ctx) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; setCtx2d(ctx) }
    const onResize = () => {
      const dprR = Math.min(2, window.devicePixelRatio || 1) * quality.renderScale
      canvas.width = Math.floor(canvas.clientWidth * dprR)
      canvas.height = Math.floor(canvas.clientHeight * dprR)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [quality.renderScale])

  // Geometry once — upright house on ground (y=0), roof up
  useEffect(() => {
    const base = 1.2        // half-width
    const h = 0.8           // wall height
    const roofH = 0.9       // extra apex height

    // Bottom on ground y=0, top of walls y=h, roof apex y=h+roofH
    const verts: Vec3[] = [
      // floor rectangle (y=0)
      { x: -base, y: 0, z: -base }, { x:  base, y: 0, z: -base },
      { x:  base, y: 0, z:  base }, { x: -base, y: 0, z:  base },
      // top of walls (y=h)
      { x: -base, y:  h, z: -base }, { x:  base, y:  h, z: -base },
      { x:  base, y:  h, z:  base }, { x: -base, y:  h, z:  base },
      // roof apex
      { x: 0, y: h + roofH, z: 0 }
    ]
    const edges: Edge[] = [
      [0,1],[1,2],[2,3],[3,0],  // floor
      [4,5],[5,6],[6,7],[7,4],  // top
      [0,4],[1,5],[2,6],[3,7],  // pillars
      [4,8],[5,8],[6,8],[7,8],  // roof
      [4,6],[5,7]               // diagonals
    ]
    vertsRef.current = verts.map(v => ({...v}))
    restRef.current = verts.map(v => ({...v}))
    velRef.current = verts.map(() => ({ x: 0, y: 0, z: 0 }))
    edgesRef.current = edges

    // Window sample points on front/back faces
    const windows: Array<{ p: Vec3 }> = []
    const rows = 3, cols = 4
    for (let face = -1; face <= 1; face += 2) {
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const x = -base*0.75 + (c/(cols-1)) * (base*1.5)
        const y = h*0.2 + (r/(rows-1)) * (h*0.6)
        const z = face * base
        windows.push({ p: { x, y, z } })
      }
    }
    windowsRef.current = windows
  }, [])

  // Stars (react to settings.stars)
  useEffect(() => {
    const stars = Array.from({ length: settings.stars }, () => ({
      x: (Math.random() * 2 - 1) * 2.5,
      y: (Math.random() * 2 - 1) * 2.0,
      z: Math.random() * 3 + 1.5,
      b: Math.random()
    }))
    starsRef.current = stars
  }, [settings.stars])

  // Render loop (always visible)
  useEffect(() => {
    if (!ctx2d || !canvasRef.current) return
    let running = true
    let lastT = performance.now()
    const loop = () => {
      if (!running) return
      const now = performance.now()
      const dt = Math.min(0.05, (now - lastT) / 1000)
      lastT = now

      const frame = lastFrameRef.current || fallbackFrame(now)
      stepPhysics(frame, dt)
      drawScene(ctx2d, canvasRef.current!, frame)
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => { running = false; if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [ctx2d, quality, accessibility, settings])

  // Attach analyzer + palette
  useEffect(() => {
    let cancelled = false
    async function boot() {
      if (!auth) return
      try {
        await ensurePlayerConnected()
        const aEl = findAudioElement()
        const analyzer = new AudioAnalyzer({
          fftSize: CONFIG.fftSize,
          smoothing: 0.82,
          epilepsySafe: accessibility.epilepsySafe,
          reducedMotion: accessibility.reducedMotion
        })
        analyzerRef.current = analyzer
        if (aEl) { analyzer.attachMedia(aEl); await analyzer.resume() }
        analyzer.onFrame = (f) => { lastFrameRef.current = f }
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
          img.onload = () => { applyPaletteToCss(extractPaletteFromImage(img)); setAlbumSkin(blobUrl) }
        }
      } catch (e) { console.warn('Player init failed', e) }
    }
    boot()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth])

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

  // ====== Helpers ======

  function stepPhysics(frame: AnalysisFrame, dt: number) {
    const [low] = energies(frame)

    // Beat smoothing and camera shake
    const minBeatGap = accessibility.epilepsySafe ? 180 : 120
    const now = performance.now()
    if (frame.beat && now - lastBeatAtRef.current > minBeatGap) {
      lastBeatAtRef.current = now
      beatIntensityRef.current = Math.min(1, beatIntensityRef.current + 0.6 + low * 0.5)
      shakeRef.current = Math.min(1, shakeRef.current + settings.camShake * 0.8)

      // Explode outward slightly
      const power = settings.beatPower * (0.5 + low * 0.9)
      const verts = vertsRef.current, vel = velRef.current
      for (let i = 0; i < verts.length; i++) {
        const d = { x: verts[i].x, y: verts[i].y - 0.6, z: verts[i].z } // slight up bias
        const len = Math.max(0.001, Math.hypot(d.x, d.y, d.z))
        const dir = { x: d.x / len, y: d.y / len, z: d.z / len }
        vel[i].x += dir.x * power * (0.8 + Math.random() * 0.2)
        vel[i].y += (dir.y * 0.6 + 0.12) * power
        vel[i].z += dir.z * power * (0.8 + Math.random() * 0.2)
      }
    }
    beatIntensityRef.current *= 0.9
    shakeRef.current *= 0.88

    // Orbiting camera — speed reacts to bass + beat
    if (settings.orbit) {
      const speed = settings.orbitSpeed + low * 0.8 + beatIntensityRef.current * 1.2
      orbitAngleRef.current += speed * dt
    }

    // Springs
    const verts = vertsRef.current, rest = restRef.current, vel = velRef.current
    const k = settings.stiffness, damp = settings.damping
    for (let i = 0; i < verts.length; i++) {
      const toRest = { x: rest[i].x - verts[i].x, y: rest[i].y - verts[i].y, z: rest[i].z - verts[i].z }
      vel[i].x = (vel[i].x + toRest.x * k * dt) * damp
      vel[i].y = (vel[i].y + toRest.y * k * dt) * damp
      vel[i].z = (vel[i].z + toRest.z * k * dt) * damp
      verts[i].x += vel[i].x * dt
      verts[i].y += vel[i].y * dt
      verts[i].z += vel[i].z * dt
    }
  }

  function drawScene(g: CanvasRenderingContext2D, canvas: HTMLCanvasElement, frame: AnalysisFrame) {
    const { width: W, height: H } = canvas
    const [, mid, high] = energies(frame)

    // Background
    if (quality.motionBlur && !accessibility.reducedMotion) {
      g.fillStyle = 'rgba(6, 10, 14, 0.08)'
      g.fillRect(0, 0, W, H)
    } else {
      const bg = g.createLinearGradient(0, 0, 0, H)
      bg.addColorStop(0, 'rgba(0,0,0,0.9)')
      bg.addColorStop(1, 'rgba(3,7,10,0.96)')
      g.fillStyle = bg
      g.fillRect(0, 0, W, H)
    }

    // Accents (+ optional reactive morph)
    const accentBase = getVar('--accent', '#0ff')
    const accent2Base = getVar('--accent-2', '#f0f')
    const accent = settings.colorMode === 'reactive' ? mixHex(accentBase, accent2Base, clamp01(high * 0.9)) : accentBase
    const accent2 = settings.colorMode === 'reactive' ? mixHex(accent2Base, accentBase, clamp01(mid * 0.6)) : accent2Base

    // Stars
    drawStars(g, W, H, starsRef.current, frame)

    // Ground glow/horizon
    g.globalCompositeOperation = 'lighter'
    g.fillStyle = withAlpha(accent, (0.05 + frame.loudness * 0.06) * settings.glow)
    g.beginPath()
    g.ellipse(W*0.5, H*0.8, W*0.64, H*(0.12 + frame.loudness * 0.02), 0, 0, Math.PI*2)
    g.fill()
    g.globalCompositeOperation = 'source-over'

    // True orbit camera position around the house
    const radius = Math.max(3.5, settings.orbitRadius)
    const angle = orbitAngleRef.current
    const elev = settings.orbitElev
    const cam: Vec3 = {
      x: Math.sin(angle) * radius,
      z: Math.cos(angle) * radius,
      y: Math.sin(elev) * (radius * 0.5) + 1.2 // slight above ground
    }
    const target: Vec3 = { x: 0, y: 0.9, z: 0 } // look slightly above center
    // Shake
    const t = performance.now()/1000
    const shakeAmp = shakeRef.current * 0.06
    cam.x += shakeAmp * Math.sin(t * 27.3)
    cam.y += shakeAmp * Math.cos(t * 31.7)

    // Projection helper using view (look-at) transform, Y‑up
    const proj = (v: Vec3, scale = 1) => projectLookAt(v, cam, target, W, H, scale)

    // Floor grid
    if (settings.grid) {
      drawGrid(g, W, H, proj, { color: withAlpha(accent2, 0.25), beat: beatIntensityRef.current })
    }

    // Party beams
    drawPartyBeams(g, proj, { accent2, high, beat: beatIntensityRef.current })

    // Wireframe (depth sorted) with reactive width/glow and slight scale on beat
    const scale = 1 + beatIntensityRef.current * 0.06
    drawWire(g, vertsRef.current, edgesRef.current, proj, {
      accent, accent2,
      glow: quality.bloom ? settings.glow : 0,
      lineWidth: settings.lineWidth * (1 + beatIntensityRef.current * 0.25),
      scale
    })

    // Windows flicker
    if (settings.windows) drawWindows(g, windowsRef.current, proj, { accent: accent2, high, beat: beatIntensityRef.current })
  }

  function drawStars(g: CanvasRenderingContext2D, W: number, H: number, stars: {x:number;y:number;z:number;b:number}[], frame: AnalysisFrame) {
    const tw = frame.chroma[0] * 0.6 + frame.chroma[7] * 0.4
    const base = 0.6 + frame.loudness * 0.3
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

  function drawGrid(
    g: CanvasRenderingContext2D, W: number, H: number,
    proj: (v: Vec3, scale?: number) => { x: number; y: number; z: number },
    opts: { color: string, beat: number }
  ) {
    const y = 0 // ground plane at y=0
    const span = 8
    const step = 0.6
    const shimmer = (0.7 + opts.beat * 0.6)

    g.strokeStyle = opts.color
    g.lineWidth = 1
    g.globalCompositeOperation = 'lighter'
    g.globalAlpha = 0.45 * shimmer
    for (let z = -span; z <= span; z += step) {
      const p1 = proj({ x: -span, y, z })
      const p2 = proj({ x:  span, y, z })
      g.beginPath(); g.moveTo(p1.x, p1.y); g.lineTo(p2.x, p2.y); g.stroke()
    }
    g.globalAlpha = 0.4 * shimmer
    for (let x = -span; x <= span; x += step) {
      const p1 = proj({ x, y, z: -span })
      const p2 = proj({ x, y, z:  span })
      g.beginPath(); g.moveTo(p1.x, p1.y); g.lineTo(p2.x, p2.y); g.stroke()
    }
    g.globalAlpha = 1
    g.globalCompositeOperation = 'source-over'
  }

  function drawPartyBeams(
    g: CanvasRenderingContext2D,
    proj: (v: Vec3, scale?: number) => { x: number; y: number; z: number },
    opts: { accent2: string, high: number, beat: number }
  ) {
    const beams = 8
    const radius = 2.2
    const t = performance.now() / 1000
    const spin = t * (0.6 + opts.beat * 2)
    g.globalCompositeOperation = 'lighter'
    for (let i = 0; i < beams; i++) {
      const a = spin + (i / beams) * Math.PI * 2
      const p0 = proj({ x: Math.cos(a) * radius, y: 0.05, z: Math.sin(a) * radius })
      const p1 = proj({ x: Math.cos(a) * (radius + 2.5), y: 1.2, z: Math.sin(a) * (radius + 2.5) })
      g.strokeStyle = withAlpha(opts.accent2, 0.2 + 0.6 * (opts.high))
      g.lineWidth = 2
      g.beginPath(); g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.stroke()
    }
    g.globalCompositeOperation = 'source-over'
  }

  function drawWire(
    g: CanvasRenderingContext2D,
    verts: Vec3[], edges: Edge[],
    proj: (v: Vec3, scale?: number) => { x: number; y: number; z: number },
    opts: { accent: string, accent2: string, glow: number, lineWidth: number, scale: number }
  ) {
    const P = verts.map(v => proj(v, opts.scale))

    // Depth sort
    const es = edges.map(([a,b]) => ({ a, b, z: (P[a].z + P[b].z) * 0.5 }))
      .sort((e1, e2) => e2.z - e1.z)

    g.globalCompositeOperation = 'lighter'
    if (opts.glow > 0) { g.shadowColor = opts.accent; g.shadowBlur = 10 * opts.glow } else { g.shadowBlur = 0 }

    // Back pass
    g.strokeStyle = withAlpha(opts.accent2, 0.35)
    g.lineWidth = opts.lineWidth
    for (const e of es) { g.beginPath(); g.moveTo(P[e.a].x, P[e.a].y); g.lineTo(P[e.b].x, P[e.b].y); g.stroke() }

    // Front pass brighter
    g.strokeStyle = withAlpha(opts.accent, 0.92)
    g.lineWidth = opts.lineWidth + 0.7
    for (const e of es) { g.beginPath(); g.moveTo(P[e.a].x, P[e.a].y); g.lineTo(P[e.b].x, P[e.b].y); g.stroke() }

    g.globalCompositeOperation = 'source-over'
    g.shadowBlur = 0
  }

  function drawWindows(
    g: CanvasRenderingContext2D,
    windows: Array<{ p: Vec3 }>,
    proj: (v: Vec3, scale?: number) => { x: number; y: number; z: number },
    opts: { accent: string, high: number, beat: number }
  ) {
    const t = performance.now() / 1000
    for (let i = 0; i < windows.length; i++) {
      const q = proj(windows[i].p)
      const size = 7 + opts.beat * 10
      const flicker = 0.35 + 0.65 * Math.abs(Math.sin(t * (6 + (i % 5)) + i * 1.13)) * (0.4 + opts.high * 0.6)
      g.fillStyle = withAlpha(opts.accent, flicker * 0.9)
      g.fillRect(q.x - size*0.5, q.y - size*0.5, size, size * 0.7)
    }
  }

  // Look-at projection, Y-up. Returns screen coords (x,y) and depth zFwd.
  function projectLookAt(v: Vec3, cam: Vec3, target: Vec3, W: number, H: number, scale = 1) {
    const p = { x: v.x * scale - cam.x, y: v.y * scale - cam.y, z: v.z * scale - cam.z }
    const up = { x: 0, y: 1, z: 0 }
    const fwd = norm(sub(target, cam))       // camera forward
    const right = norm(cross(fwd, up))
    const up2 = cross(right, fwd)

    // Camera space
    const cx = dot(right, p)
    const cy = dot(up2, p)
    const cz = dot(fwd, p)                   // forward depth; should be > 0

    const persp = 240 / Math.max(0.001, cz)
    return { x: cx * persp + W / 2, y: -cy * persp + H * 0.65, z: cz }
  }

  // Math helpers
  function sub(a: Vec3, b: Vec3): Vec3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z } }
  function dot(a: Vec3, b: Vec3) { return a.x*b.x + a.y*b.y + a.z*b.z }
  function cross(a: Vec3, b: Vec3): Vec3 {
    return { x: a.y*b.z - a.z*b.y, y: a.z*b.x - a.x*b.z, z: a.x*b.y - a.y*b.x }
  }
  function norm(v: Vec3): Vec3 {
    const l = Math.hypot(v.x, v.y, v.z) || 1
    return { x: v.x / l, y: v.y / l, z: v.z / l }
  }

  function energies(frame: AnalysisFrame): [number, number, number] {
    const arr = frame.fftLog, N = arr.length
    const band = (a: number, b: number) => {
      const i0 = Math.max(0, Math.floor(a * N)), i1 = Math.min(N, Math.floor(b * N))
      let s = 0, c = Math.max(1, i1 - i0)
      for (let i = i0; i < i1; i++) s += arr[i]
      return s / c
    }
    return [band(0.0, 0.18), band(0.18, 0.55), band(0.55, 1.0)]
  }

  function fallbackFrame(now: number): AnalysisFrame {
    const t = now / 1000
    const fft = new Float32Array(2048).fill(0).map((_, i) => 0.08 + 0.04 * Math.sin(i * 0.02 + t * 2))
    const fftLog = new Float32Array(256).fill(0).map((_, i) => 0.1 + 0.06 * Math.sin(i * 0.12 + t * 2.2))
    const chroma = new Float32Array(12).fill(0)
    return { time: t, fft, fftLog, chroma, loudness: 0.12, beat: false, tempo: 120 }
  }

  function findAudioElement(): HTMLAudioElement | undefined {
    const els = Array.from(document.querySelectorAll('audio')) as HTMLAudioElement[]
    return els.find(el => !!el.src)
  }

  function getVar(name: string, fallback: string) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
  }

  function withAlpha(hexOrCss: string, a: number) {
    if (hexOrCss.startsWith('#')) {
      const h = hexOrCss.replace('#','')
      const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16)
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

  function mixHex(a: string, b: string, t: number) {
    const ca = hexToRgb(a), cb = hexToRgb(b)
    const m = (x: number, y: number) => Math.round(x + (y - x) * t)
    return `#${toHex(m(ca[0], cb[0]))}${toHex(m(ca[1], cb[1]))}${toHex(m(ca[2], cb[2]))}`
  }
  function hexToRgb(h: string): [number, number, number] {
    const s = h.replace('#','')
    return [parseInt(s.slice(0,2),16), parseInt(s.slice(2,4),16), parseInt(s.slice(4,6),16)]
  }
  function toHex(n: number) { return n.toString(16).padStart(2,'0') }
  function clamp01(x: number) { return Math.max(0, Math.min(1, x)) }
}
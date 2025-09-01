// Patch: reduce orbit when no reactive frames, add camera bob, stronger visible reactions.
// + Guarded render loop to prevent crashes when canvas/context becomes null mid-frame.

import React, { useEffect, useRef, useState } from 'react'
import type { AuthState } from '../../auth/token'
import { ensurePlayerConnected } from '../../spotify/player'
import { AudioAnalyzer } from '../../audio/AudioAnalyzer'
import { CONFIG } from '../../config'
import { getPlaybackState } from '../../spotify/api'
import { extractPaletteFromImage, applyPaletteToCss } from '../../utils/palette'
import { cacheAlbumArt } from '../../utils/idb'
import { setAlbumSkin } from '../../ui/ThemeManager'
import type { HouseSettings } from '../../ui/HousePanel'
import { reactivityBus, type ReactiveFrame } from '../../audio/ReactivityBus'

type Props = {
  auth: AuthState | null
  quality: { renderScale: 1 | 1.25 | 1.5 | 1.75 | 2, msaa: 0 | 2 | 4 | 8, bloom: boolean, motionBlur: boolean }
  accessibility: { epilepsySafe: boolean, reducedMotion: boolean, highContrast: boolean }
  settings: HouseSettings
}

type Vec3 = { x: number; y: number; z: number }
type Edge = [number, number]
type Ring = { r: number; w: number; a: number }
type Confetti = { p: Vec3; v: Vec3; life: number; hue: number }

export default function WireframeHouse({ auth, quality, accessibility, settings }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [ctx2d, setCtx2d] = useState<CanvasRenderingContext2D | null>(null)

  const vertsRef = useRef<Vec3[]>([])
  const restRef = useRef<Vec3[]>([])
  const velRef = useRef<Vec3[]>([])
  const edgesRef = useRef<Edge[]>([])
  const windowsRef = useRef<Array<{ p: Vec3 }>>([])

  const starsRef = useRef<{ x: number; y: number; z: number; b: number }[]>([])
  const ringsRef = useRef<Ring[]>([])
  const confettiRef = useRef<Confetti[]>([])

  const lastBeatAtRef = useRef(0)
  const beatIntensityRef = useRef(0)
  const shakeRef = useRef(0)
  const orbitAngleRef = useRef(0)

  // Camera presets
  const camRadiusRef = useRef(settings.orbitRadius)
  const camElevRef = useRef(settings.orbitElev)
  const camSpeedMulRef = useRef(1)
  const presetRef = useRef<number>(0)

  const reactiveRef = useRef<ReactiveFrame | null>(null)
  const [trackMeta, setTrackMeta] = useState<{ name: string, artists: string, albumUrl: string }|null>(null)

  useEffect(() => {
    const canvas = canvasRef.current!
    const dpr = Math.min(2, window.devicePixelRatio || 1) * quality.renderScale
    canvas.width = Math.floor(canvas.clientWidth * dpr)
    canvas.height = Math.floor(canvas.clientHeight * dpr)
    const ctx = canvas.getContext('2d', { alpha: true })
    if (ctx) { ctx.imageSmoothingEnabled = true; (ctx as any).imageSmoothingQuality = 'high'; setCtx2d(ctx) }
    const onResize = () => {
      const dprR = Math.min(2, window.devicePixelRatio || 1) * quality.renderScale
      canvas.width = Math.floor(canvas.clientWidth * dprR)
      canvas.height = Math.floor(canvas.clientHeight * dprR)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [quality.renderScale])

  useEffect(() => {
    const base = 1.2, h = 0.9, roofH = 0.95
    const verts: Vec3[] = [
      { x: -base, y: 0, z: -base }, { x:  base, y: 0, z: -base },
      { x:  base, y: 0, z:  base }, { x: -base, y: 0, z:  base },
      { x: -base, y:  h, z: -base }, { x:  base, y:  h, z: -base },
      { x:  base, y:  h, z:  base }, { x: -base, y:  h, z:  base },
      { x: 0, y: h + roofH, z: 0 }
    ]
    const edges: Edge[] = [
      [0,1],[1,2],[2,3],[3,0],
      [4,5],[5,6],[6,7],[7,4],
      [0,4],[1,5],[2,6],[3,7],
      [4,8],[5,8],[6,8],[7,8],
      [4,6],[5,7]
    ]
    vertsRef.current = verts.map(v => ({...v}))
    restRef.current = verts.map(v => ({...v}))
    velRef.current = verts.map(() => ({ x: 0, y: 0, z: 0 }))
    edgesRef.current = edges

    const windows: Array<{ p: Vec3 }> = []
    const rows = 3, cols = 4
    for (let face = -1; face <= 1; face += 2) {
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const x = -base*0.75 + (c/(cols-1)) * (base*1.5)
        const y = h*0.25 + (r/(rows-1)) * (h*0.6)
        const z = face * base
        windows.push({ p: { x, y, z } })
      }
    }
    windowsRef.current = windows
  }, [])

  useEffect(() => {
    const stars = Array.from({ length: settings.stars }, () => ({
      x: (Math.random() * 2 - 1) * 2.5,
      y: (Math.random() * 2 - 1) * 2.0,
      z: Math.random() * 3 + 1.5,
      b: Math.random()
    }))
    starsRef.current = stars
  }, [settings.stars])

  useEffect(() => {
    const off = reactivityBus.on('frame', (f) => { reactiveRef.current = f })
    return () => { off?.() }
  }, [])

  useEffect(() => {
    const offBar = reactivityBus.on('bar', () => {
      beatIntensityRef.current = Math.min(1, beatIntensityRef.current + 0.25)
    })
    const offSec = reactivityBus.on('section', () => {
      presetRef.current = (presetRef.current + 1) % 3
      if (presetRef.current === 0) {
        targetCam(camRadiusRef, 6.2, 0.08); targetElev(camElevRef, -0.08); camSpeedMulRef.current = 0.8
      } else if (presetRef.current === 1) {
        targetCam(camRadiusRef, 4.6, 0.12); targetElev(camElevRef, -0.02); camSpeedMulRef.current = 1.2
      } else {
        targetCam(camRadiusRef, 5.4, 0.1); targetElev(camElevRef, 0.04); camSpeedMulRef.current = 1.0
      }
    })
    return () => { offBar?.(); offSec?.() }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function boot() {
      if (!auth) return
      try {
        await ensurePlayerConnected()
        const analyzer = new AudioAnalyzer({
          fftSize: CONFIG.fftSize,
          smoothing: 0.82,
          epilepsySafe: accessibility.epilepsySafe,
          reducedMotion: accessibility.reducedMotion
        })
        const aEl = findAudioElement()
        if (aEl) { analyzer.attachMedia(aEl); await analyzer.resume() }
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
      } catch (e) { console.warn('Analyzer init failed', e) }
    }
    boot()
    return () => { cancelled = true }
  }, [auth, accessibility.epilepsySafe, accessibility.reducedMotion])

  // Guarded render loop to avoid null canvas/ctx crash
  useEffect(() => {
    if (!ctx2d) return
    let running = true
    let lastT = performance.now()

    const loop = () => {
      if (!running) return
      const now = performance.now()
      const dt = Math.min(0.05, (now - lastT) / 1000)
      lastT = now

      const cv = canvasRef.current
      const ctx = ctx2d
      if (!cv || !ctx) {
        requestAnimationFrame(loop)
        return
      }

      const f = reactiveRef.current
      stepPhysics(f, dt)

      try {
        drawScene(ctx, cv, f)
      } catch (e) {
        // Prevent runaway crash loop if canvas/context became invalid
        console.warn('WireframeHouse draw skipped (ctx/canvas not ready):', e)
      }

      requestAnimationFrame(loop)
    }

    requestAnimationFrame(loop)
    return () => { running = false }
  }, [ctx2d, quality, accessibility, settings])

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

  function stepPhysics(f: ReactiveFrame | null, dt: number) {
    const low = f?.bands.low ?? 0.0
    const beat = !!f?.beat

    const minBeatGap = accessibility.epilepsySafe ? 180 : 120
    const now = performance.now()
    if (beat && now - lastBeatAtRef.current > minBeatGap) {
      lastBeatAtRef.current = now
      beatIntensityRef.current = Math.min(1, beatIntensityRef.current + 0.6 + low * 0.5)
      shakeRef.current = Math.min(1, shakeRef.current + settings.camShake * 0.8)

      const power = settings.beatPower * (0.5 + low * 0.9)
      const verts = vertsRef.current, vel = velRef.current
      for (let i = 0; i < verts.length; i++) {
        const d = { x: verts[i].x, y: verts[i].y - 0.6, z: verts[i].z }
        const len = Math.max(0.001, Math.hypot(d.x, d.y, d.z))
        const dir = { x: d.x / len, y: d.y / len, z: d.z / len }
        vel[i].x += dir.x * power * (0.8 + Math.random() * 0.2)
        vel[i].y += (dir.y * 0.6 + 0.12) * power
        vel[i].z += dir.z * power * (0.8 + Math.random() * 0.2)
      }

      if (settings.partyRings) ringsRef.current.push({ r: 0, w: 0.35, a: 0.6 })
      if (settings.confetti) {
        const count = 80
        for (let i = 0; i < count; i++) {
          confettiRef.current.push({
            p: { x: (Math.random() - 0.5) * 1.0, y: 1.0 + Math.random() * 0.4, z: (Math.random() - 0.5) * 1.0 },
            v: { x: (Math.random() - 0.5) * 1.6, y: 2.8 + Math.random() * 1.2, z: (Math.random() - 0.5) * 1.6 },
            life: 1.0, hue: Math.random() * 360
          })
        }
      }
    }
    beatIntensityRef.current *= 0.9
    shakeRef.current *= 0.88

    // Orbit angle: slow down when no fresh reactive frame (prevents constant spin)
    const stale = !f || (performance.now() - (f.t || 0)) > 250
    if (settings.orbit) {
      const base = (settings.orbitSpeed * camSpeedMulRef.current) * (stale ? 0.15 : 1.0)
      const speed = base + (low * 0.8) + (beatIntensityRef.current * 1.2)
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

    for (const ring of ringsRef.current) { ring.r += (2.6 + low * 3.0) * dt; ring.w += 0.06 * dt; ring.a *= 0.985 }
    ringsRef.current = ringsRef.current.filter(r => r.a > 0.03 && r.r < 10)

    const conf = confettiRef.current
    for (let i = conf.length - 1; i >= 0; i--) {
      const c = conf[i]
      c.v.y -= 3.8 * dt
      c.p.x += c.v.x * dt
      c.p.y += c.v.y * dt
      c.p.z += c.v.z * dt
      c.life -= 0.9 * dt
      if (c.p.y < 0) { c.p.y = 0; c.v.y *= -0.35; c.v.x *= 0.7; c.v.z *= 0.7 }
      if (c.life <= 0) { conf.splice(i, 1) }
    }

    camRadiusRef.current = lerp(camRadiusRef.current, clamp(settings.orbitRadius, 3.5, 8), 0.04)
    camElevRef.current = lerp(camElevRef.current, clamp(settings.orbitElev, -0.4, 0.4), 0.03)
  }

  function drawScene(g: CanvasRenderingContext2D, canvas: HTMLCanvasElement, f: ReactiveFrame | null) {
    if (!canvas) return
    const { width: W, height: H } = canvas
    if (!W || !H) return

    const low = f?.bands.low ?? 0.0
    const mid = f?.bands.mid ?? 0.0
    const high = f?.bands.high ?? 0.0
    const loud = f?.loudness ?? 0.0

    if (quality.motionBlur && !accessibility.reducedMotion) {
      g.fillStyle = 'rgba(6, 10, 14, 0.08)'; g.fillRect(0, 0, W, H)
    } else {
      const bg = g.createLinearGradient(0, 0, 0, H)
      bg.addColorStop(0, 'rgba(0,0,0,0.9)'); bg.addColorStop(1, 'rgba(3,7,10,0.96)')
      g.fillStyle = bg; g.fillRect(0, 0, W, H)
    }

    const accentBase = css('--accent', '#0ff')
    const accent2Base = css('--accent-2', '#f0f')
    const accent = settings.colorMode === 'reactive' ? mixHex(accentBase, accent2Base, clamp01(high * 0.9)) : accentBase
    const accent2 = settings.colorMode === 'reactive' ? mixHex(accent2Base, accentBase, clamp01(mid * 0.6)) : accent2Base

    drawStars(g, W, H, starsRef.current, f)

    g.globalCompositeOperation = 'lighter'
    g.fillStyle = withAlpha(accent, (0.05 + loud * 0.06) * settings.glow)
    g.beginPath(); g.ellipse(W*0.5, H*0.8, W*0.64, H*(0.12 + loud * 0.02), 0, 0, Math.PI*2); g.fill()
    g.globalCompositeOperation = 'source-over'

    const usingFallback = !f || (performance.now() - (f.t || 0)) > 200

    // Camera
    const radius = camRadiusRef.current
    const angle = settings.orbit ? orbitAngleRef.current : 0
    const elev = camElevRef.current
    const cam: Vec3 = {
      x: Math.sin(angle) * radius,
      z: Math.cos(angle) * radius,
      y: Math.sin(elev) * (radius * 0.5) + 1.2
    }
    const target: Vec3 = { x: 0, y: 1.1, z: 0 }
    const t = performance.now()/1000
    const shakeAmp = shakeRef.current * 0.06
    cam.x += shakeAmp * Math.sin(t * 27.3)
    cam.y += shakeAmp * Math.cos(t * 31.7)
    // Reactive camera bob (feels music even when subtle)
    cam.y += (settings.camBob || 0) * (0.15 + low * 0.25) * Math.sin(t * 1.6 + Math.sin(t * 0.5))

    const proj = (v: Vec3, scale = 1) => projectLookAt(v, cam, target, W, H, scale)

    if (settings.grid) drawGrid(g, proj, { color: withAlpha(accent2, 0.25), beat: beatIntensityRef.current })
    if (settings.partyRings) drawRings(g, W, H, ringsRef.current, accent)
    if (settings.beams) drawPartyBeams(g, proj, { accent2, high, beat: beatIntensityRef.current })

    const barPhase = f?.phases.bar ?? 0
    const scale = 1 + beatIntensityRef.current * 0.06 + low * 0.02 + Math.sin(barPhase * Math.PI) * 0.015

    drawWire(g, vertsRef.current, edgesRef.current, proj, {
      accent, accent2,
      glow: quality.bloom ? settings.glow : 0,
      lineWidth: settings.lineWidth * (1 + beatIntensityRef.current * 0.25),
      scale,
      eqEdges: (settings as any).eqEdges ?? false,
      edgeJitter: (settings as any).edgeJitter ?? 0
    }, f)

    if (settings.windows) drawWindows(g, windowsRef.current, proj, {
      accent: accent2, high, beat: beatIntensityRef.current, intensity: (settings as any).windowIntensity ?? 0.75
    })
    if (settings.confetti) drawConfetti(g, proj, confettiRef.current)

    // Optional badge for diagnostics
    if (usingFallback) {
      g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(12, 12, 170, 22)
      g.fillStyle = 'rgba(255,255,255,0.6)'; g.font = '12px system-ui, sans-serif'
      g.fillText('Reactivity: fallback/scheduled', 18, 28)
    }
  }

  // draw helpers + math ...
  function drawStars(g: CanvasRenderingContext2D, W: number, H: number, stars: {x:number;y:number;z:number;b:number}[], f: ReactiveFrame | null) {
    const tw = (f?.chroma?.[0] ?? 0) * 0.6 + (f?.chroma?.[7] ?? 0) * 0.4
    const base = 0.6 + (f?.loudness ?? 0) * 0.3
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i]
      const fx = (s.x / s.z) * 240 + (W / 2)
      const fy = (s.y / s.z) * 240 + (H / 3)
      const size = Math.max(0.6, (1.6 - s.z * 0.3) * (0.7 + s.b * 0.6))
      const a = Math.min(0.8, 0.25 + s.b * 0.5 + base * 0.08 + tw * 0.06)
      g.fillStyle = `rgba(255,255,255,${a})`; g.fillRect(fx, fy, size, size)
    }
  }

  function drawGrid(g: CanvasRenderingContext2D, proj: (v: Vec3, scale?: number) => { x: number; y: number; z: number }, opts: { color: string, beat: number }) {
    const y = 0, span = 8, step = 0.6, shimmer = (0.7 + opts.beat * 0.6)
    g.strokeStyle = opts.color; g.lineWidth = 1; g.globalCompositeOperation = 'lighter'
    g.globalAlpha = 0.45 * shimmer
    for (let z = -span; z <= span; z += step) {
      const p1 = proj({ x: -span, y, z }); const p2 = proj({ x:  span, y, z })
      g.beginPath(); g.moveTo(p1.x, p1.y); g.lineTo(p2.x, p2.y); g.stroke()
    }
    g.globalAlpha = 0.4 * shimmer
    for (let x = -span; x <= span; x += step) {
      const p1 = proj({ x, y, z: -span }); const p2 = proj({ x, y, z:  span })
      g.beginPath(); g.moveTo(p1.x, p1.y); g.lineTo(p2.x, p2.y); g.stroke()
    }
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'
  }

  function drawRings(g: CanvasRenderingContext2D, W: number, H: number, rings: Ring[], accent: string) {
    const cx = W * 0.5, cy = H * 0.82
    for (const r of rings) {
      g.strokeStyle = withAlpha(accent, r.a * 0.9)
      g.lineWidth = Math.max(1, r.w * 14)
      g.beginPath(); g.ellipse(cx, cy, r.r * 120, r.r * 38, 0, 0, Math.PI * 2); g.stroke()
    }
  }

  function drawPartyBeams(g: CanvasRenderingContext2D, proj: (v: Vec3, scale?: number) => { x: number; y: number; z: number }, opts: { accent2: string, high: number, beat: number }) {
    const beams = 8, radius = 2.3, t = performance.now() / 1000
    const spin = t * (0.6 + opts.beat * 2)
    g.globalCompositeOperation = 'lighter'
    for (let i = 0; i < beams; i++) {
      const a = spin + (i / beams) * Math.PI * 2
      const p0 = proj({ x: Math.cos(a) * radius, y: 0.05, z: Math.sin(a) * radius })
      const p1 = proj({ x: Math.cos(a) * (radius + 2.6), y: 1.4, z: Math.sin(a) * (radius + 2.6) })
      g.strokeStyle = withAlpha(opts.accent2, 0.2 + 0.6 * (opts.high)); g.lineWidth = 2
      g.beginPath(); g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.stroke()
    }
    g.globalCompositeOperation = 'source-over'
  }

  function drawWire(g: CanvasRenderingContext2D, verts: Vec3[], edges: Edge[], proj: (v: Vec3, scale?: number) => { x: number; y: number; z: number }, opts: { accent: string, accent2: string, glow: number, lineWidth: number, scale: number, eqEdges: boolean, edgeJitter: number }, f: ReactiveFrame | null) {
    const P = verts.map(v => proj(v, opts.scale))
    const es = edges.map(([a,b], idx) => ({ a, b, z: (P[a].z + P[b].z) * 0.5, idx })).sort((e1, e2) => e2.z - e1.z)
    const jitter = opts.edgeJitter, t = performance.now()/1000
    const jitterPoint = (pt: {x:number;y:number}, seed: number) => {
      if (jitter <= 0.001) return pt
      const j = (Math.sin(seed * 13.37 + t * 9.1) + Math.cos(seed * 7.91 + t * 6.7)) * 0.5
      const amp = 1 + 2.5 * jitter
      return { x: pt.x + j * amp, y: pt.y + j * amp * 0.6 }
    }
    const low = f?.bands.low ?? 0.1, mid = f?.bands.mid ?? 0.1, high = f?.bands.high ?? 0.1
    const bandE = (edgeIdx: number) => { const frac = (edgeIdx % 16) / 16; return frac < 0.33 ? low : frac < 0.66 ? mid : high }

    g.globalCompositeOperation = 'lighter'
    if (opts.glow > 0) { g.shadowColor = opts.accent; g.shadowBlur = 10 * opts.glow } else { g.shadowBlur = 0 }

    g.lineWidth = opts.lineWidth
    for (const e of es) {
      const a = jitterPoint(P[e.a], e.idx + 1), b = jitterPoint(P[e.b], e.idx + 2)
      const w = opts.eqEdges ? bandE(e.idx) : 0.35
      g.strokeStyle = opts.eqEdges ? withAlpha(mixHex(opts.accent2, opts.accent, w), 0.55) : withAlpha(opts.accent2, 0.35)
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke()
    }

    g.lineWidth = opts.lineWidth + 0.7
    for (const e of es) {
      const a = jitterPoint(P[e.a], e.idx + 3), b = jitterPoint(P[e.b], e.idx + 4)
      const w = opts.eqEdges ? bandE(e.idx) : 1
      const col = opts.eqEdges ? mixHex(opts.accent, opts.accent2, 1 - w) : opts.accent
      g.strokeStyle = withAlpha(col, 0.95)
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke()
    }

    g.globalCompositeOperation = 'source-over'
    g.shadowBlur = 0
  }

  function drawWindows(g: CanvasRenderingContext2D, windows: Array<{ p: Vec3 }>, proj: (v: Vec3, scale?: number) => { x: number; y: number; z: number }, opts: { accent: string, high: number, beat: number, intensity: number }) {
    const t = performance.now() / 1000, k = Math.max(0.1, Math.min(1, opts.intensity))
    for (let i = 0; i < windows.length; i++) {
      const q = proj(windows[i].p)
      const size = 7 + opts.beat * 10
      const flicker = (0.25 + 0.75 * Math.abs(Math.sin(t * (6 + (i % 5)) + i * 1.13))) * (0.3 + opts.high * 0.7) * k
      g.fillStyle = withAlpha(opts.accent, flicker)
      g.fillRect(q.x - size*0.5, q.y - size*0.5, size, size * 0.7)
    }
  }

  function drawConfetti(g: CanvasRenderingContext2D, proj: (v: Vec3, scale?: number) => { x: number; y: number; z: number }, conf: Confetti[]) {
    for (const c of conf) {
      const q = proj(c.p)
      const alpha = Math.max(0, Math.min(1, c.life))
      g.fillStyle = `hsla(${c.hue},100%,60%,${alpha})`
      g.fillRect(q.x - 2, q.y - 2, 4, 4)
    }
  }

  function projectLookAt(v: Vec3, cam: Vec3, target: Vec3, W: number, H: number, scale = 1) {
    const p = { x: v.x * scale - cam.x, y: v.y * scale - cam.y, z: v.z * scale - cam.z }
    const up = { x: 0, y: 1, z: 0 }
    const fwd = norm(sub(target, cam))
    const right = norm(cross(fwd, up))
    const up2 = cross(right, fwd)
    const cx = dot(right, p), cy = dot(up2, p), cz = dot(fwd, p)
    const persp = 240 / Math.max(0.001, cz)
    return { x: cx * persp + W / 2, y: -cy * persp + H * 0.68, z: cz }
  }

  function sub(a: Vec3, b: Vec3): Vec3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z } }
  function dot(a: Vec3, b: Vec3) { return a.x*b.x + a.y*b.y + a.z*b.z }
  function cross(a: Vec3, b: Vec3): Vec3 { return { x: a.y*b.z - a.z*b.y, y: a.z*b.x - a.x*b.z, z: a.x*b.y - a.y*b.x } }
  function norm(v: Vec3): Vec3 { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l } }
  function css(name: string, fallback: string) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback }
  function withAlpha(hexOrCss: string, a: number) {
    if (hexOrCss.startsWith('#')) {
      const h = hexOrCss.replace('#',''); const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16)
      return `rgba(${r},${g},${b},${a})`
    }
    if (hexOrCss.startsWith('rgb')) {
      return hexOrCss.replace(/rgba?\(([^)]+)\)/, (_m, inner) => {
        const [r,g,b] = inner.split(',').map((s:string)=>s.trim()).slice(0,3); return `rgba(${r},${g},${b},${a})`
      })
    }
    return hexOrCss
  }
  function mixHex(a: string, b: string, t: number) {
    const ca = hexToRgb(a), cb = hexToRgb(b)
    const m = (x: number, y: number) => Math.round(x + (y - x) * t)
    return `#${toHex(m(ca[0], cb[0]))}${toHex(m(ca[1], cb[1]))}${toHex(m(ca[2], cb[2]))}`
  }
  function hexToRgb(h: string): [number, number, number] { const s = h.replace('#',''); return [parseInt(s.slice(0,2),16), parseInt(s.slice(2,4),16), parseInt(s.slice(4,6),16)] }
  function toHex(n: number) { return n.toString(16).padStart(2,'0') }
  function clamp(x: number, a: number, b: number) { return Math.max(a, Math.min(b, x)) }
  function clamp01(x: number) { return Math.max(0, Math.min(1, x)) }
  function lerp(a: number, b: number, t: number) { return a + (b - a) * t }
}

function findAudioElement(): HTMLAudioElement | undefined {
  const els = Array.from(document.querySelectorAll('audio')) as HTMLAudioElement[]
  return els.find(el => !!el.src)
}
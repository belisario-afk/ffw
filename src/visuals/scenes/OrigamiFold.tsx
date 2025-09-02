import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { createRenderer, createComposer } from '../../three/Renderer'
import { reactivityBus, type ReactiveFrame } from '../../audio/ReactivityBus'
import { getPlaybackState } from '../../spotify/api'

type Props = {
  quality: { renderScale: 1 | 1.25 | 1.5 | 1.75 | 2; bloom: boolean }
  accessibility: { epilepsySafe: boolean; reducedMotion: boolean; highContrast: boolean }
}

type PatternName = 'Quad Base' | 'Fox Head' | 'Crane Simple'

type Cfg = {
  exposure: number
  saturation: number
  gamma: number
  vignette: number
  fresnelStrength: number
  edgeTintStrength: number
  paperGloss: number
  autoPlay: boolean
  foldSpeed: number
  foldPause: number
  tileIntensity: number
  backsideDarken: number
  pattern: PatternName
}

const LS_KEY = 'ffw.origami.v2'
const DEFAULT_CFG: Cfg = {
  exposure: 1.06,
  saturation: 1.08,
  gamma: 0.95,
  vignette: 0.54,
  fresnelStrength: 0.45,
  edgeTintStrength: 0.35,
  paperGloss: 0.15,
  autoPlay: true,
  foldSpeed: 0.9,
  foldPause: 0.7,
  tileIntensity: 0.2,
  backsideDarken: 0.22,
  pattern: 'Fox Head'
}

// Uniform safety helpers
function makeUniformSetters(matRef: React.MutableRefObject<THREE.ShaderMaterial | null>) {
  const getTable = () => {
    const m = matRef.current
    if (!m) return null
    if (!m.uniforms) (m as any).uniforms = {}
    return m.uniforms as Record<string, { value: any }>
  }
  const ensure = (name: string, init: any) => {
    const tbl = getTable()
    if (!tbl) return null
    const u = tbl[name]
    if (!u || typeof u !== 'object' || !('value' in u)) {
      tbl[name] = { value: init }
      return tbl[name]
    }
    return u
  }
  const setF = (name: string, v: number) => { const u = ensure(name, v); if (u) u.value = v }
  const setV3 = (name: string, x: number, y: number, z: number) => {
    const u = ensure(name, new THREE.Vector3(x, y, z)); if (!u) return
    if (u.value?.isVector3) { u.value.set(x, y, z) } else { u.value = new THREE.Vector3(x, y, z) }
  }
  const setColor = (name: string, col: THREE.Color) => {
    const u = ensure(name, col.clone()); if (!u) return
    if (u.value?.isColor) { u.value.copy(col) } else { u.value = col.clone() }
  }
  const setTex = (name: string, tex: THREE.Texture | null) => { const u = ensure(name, tex); if (u) u.value = tex }
  return { setF, setV3, setColor, setTex }
}

// Crease system (CPU)
type Crease = {
  id: string
  // crease line: point p (in plane), unit dir d (in plane)
  p: THREE.Vector2
  d: THREE.Vector2
  // which side folds (1 means side where perp·(pos-p) > 0; -1 the other side)
  side: 1 | -1
  // target angle in radians (positive rotates following right-hand rule around axis (d.x, d.y, 0))
  angle: number
}
type FoldStep = { creaseId: string; duration: number; pauseAfter: number }

type Pattern = {
  name: PatternName
  // square extent (half-size)
  half: number
  creases: Crease[]
  sequence: FoldStep[]
}

// Helpers
const PI = Math.PI
const DEG = (a: number) => (a * PI) / 180

// Prebaked patterns (approximate silhouettes)
function makePatterns(): Pattern[] {
  const half = 0.7 // sheet half-size (plane is 1.4)
  const p: Pattern[] = []

  // Quad base (fold right -> top -> diag)
  p.push({
    name: 'Quad Base',
    half,
    creases: [
      // vertical hinge x=0 (fold right half over)
      { id: 'vert', p: new THREE.Vector2(0, 0), d: new THREE.Vector2(0, 1), side: 1, angle: PI },
      // horizontal hinge y=0 (fold top half down)
      { id: 'horiz', p: new THREE.Vector2(0, 0), d: new THREE.Vector2(1, 0), side: 1, angle: PI },
      // diagonal hinge x+y=0 (fold upper-right)
      {
        id: 'diag',
        p: new THREE.Vector2(0, 0),
        d: new THREE.Vector2(1, 1).normalize(),
        side: 1,
        angle: PI
      }
    ],
    sequence: [
      { creaseId: 'vert', duration: 1.2, pauseAfter: 0.25 },
      { creaseId: 'horiz', duration: 1.0, pauseAfter: 0.25 },
      { creaseId: 'diag', duration: 1.0, pauseAfter: 0.6 }
    ]
  })

  // Fox head (ears + snout). Few folds, strong silhouette.
  p.push({
    name: 'Fox Head',
    half,
    creases: [
      // Fold to triangle: valley along y = x, move side x>y
      { id: 'tri', p: new THREE.Vector2(0, 0), d: new THREE.Vector2(1, 1).normalize(), side: 1, angle: PI },
      // Ears: fold two small side triangles back/out (mountain-ish ~60°)
      // left ear hinge: nearly vertical line near x=-half*0.35
      { id: 'earL', p: new THREE.Vector2(-half * 0.35, 0), d: new THREE.Vector2(0, 1), side: -1, angle: DEG(130) },
      // right ear hinge: near x=+half*0.35
      { id: 'earR', p: new THREE.Vector2(half * 0.35, 0), d: new THREE.Vector2(0, 1), side: 1, angle: DEG(130) },
      // Snout pinch: a small fold along y = -half*0.2, horizontal, fold top down 40°
      { id: 'snout', p: new THREE.Vector2(0, -half * 0.2), d: new THREE.Vector2(1, 0), side: 1, angle: DEG(40) }
    ],
    sequence: [
      { creaseId: 'tri', duration: 1.2, pauseAfter: 0.2 },
      { creaseId: 'earL', duration: 0.9, pauseAfter: 0.1 },
      { creaseId: 'earR', duration: 0.9, pauseAfter: 0.3 },
      { creaseId: 'snout', duration: 0.8, pauseAfter: 0.7 }
    ]
  })

  // Crane simple (approx bird base feel).
  p.push({
    name: 'Crane Simple',
    half,
    creases: [
      // Pre-fold to square base:
      { id: 'diag1', p: new THREE.Vector2(0, 0), d: new THREE.Vector2(1, 1).normalize(), side: 1, angle: PI },
      { id: 'diag2', p: new THREE.Vector2(0, 0), d: new THREE.Vector2(1, -1).normalize(), side: 1, angle: PI },
      // Open sink (approx): fold bottom triangle up 150°
      { id: 'sink', p: new THREE.Vector2(0, -half * 0.15), d: new THREE.Vector2(1, 0), side: 1, angle: DEG(150) },
      // Wings: fold left and right out (mountain) ~110°
      { id: 'wingL', p: new THREE.Vector2(-half * 0.25, 0), d: new THREE.Vector2(0, 1), side: -1, angle: DEG(110) },
      { id: 'wingR', p: new THREE.Vector2(half * 0.25, 0), d: new THREE.Vector2(0, 1), side: 1, angle: DEG(110) },
      // Tail tip: small fold near top to sharpen
      { id: 'tail', p: new THREE.Vector2(0, half * 0.35), d: new THREE.Vector2(1, 0), side: -1, angle: DEG(60) }
    ],
    sequence: [
      { creaseId: 'diag1', duration: 0.9, pauseAfter: 0.1 },
      { creaseId: 'diag2', duration: 0.9, pauseAfter: 0.25 },
      { creaseId: 'sink', duration: 1.2, pauseAfter: 0.25 },
      { creaseId: 'wingL', duration: 0.9, pauseAfter: 0.05 },
      { creaseId: 'wingR', duration: 0.9, pauseAfter: 0.45 },
      { creaseId: 'tail', duration: 0.7, pauseAfter: 0.8 }
    ]
  })

  return p
}

// Math: rotate a point around a 3D line (point q on line, axis unit dir a)
function rotateAroundLine(out: THREE.Vector3, p: THREE.Vector3, q: THREE.Vector3, a: THREE.Vector3, ang: number) {
  // Rodrigues with translation to line frame
  const d = out.subVectors(p, q)
  const c = Math.cos(ang), s = Math.sin(ang)
  const cross = new THREE.Vector3().crossVectors(a, d).multiplyScalar(s)
  const dotp = a.dot(d)
  const par = new THREE.Vector3().copy(a).multiplyScalar(dotp * (1 - c))
  out.copy(d).multiplyScalar(c).add(cross).add(par).add(q)
}

// Classify side of a 2D line: sign(perp(d) · (x - p))
function sideOfLine2D(pos: THREE.Vector2, p: THREE.Vector2, d: THREE.Vector2): number {
  const perp = new THREE.Vector2(-d.y, d.x) // rotate 90°
  return Math.sign(perp.dot(new THREE.Vector2().subVectors(pos, p))) || 0
}

export default function OrigamiFold({ quality, accessibility }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const matRef = useRef<THREE.ShaderMaterial | null>(null)
  const disposedRef = useRef(false)

  // Album cover + palette (swatches)
  const texRef = useRef<THREE.Texture | null>(null)
  const albAvg = useRef(new THREE.Color('#808080'))
  const albC1 = useRef(new THREE.Color('#77d0ff'))
  const albC2 = useRef(new THREE.Color('#b47bff'))
  const albC3 = useRef(new THREE.Color('#ffd077'))

  // HUD
  const [hudVisible, setHudVisible] = useState(true)
  const hudHideTimer = useRef<number | null>(null)
  const [hoverTop, setHoverTop] = useState(false)

  // UI
  const [panelOpen, setPanelOpen] = useState(false)
  const [cfg, setCfg] = useState<Cfg>(() => {
    try { return { ...DEFAULT_CFG, ...(JSON.parse(localStorage.getItem(LS_KEY) || '{}')) } }
    catch { return { ...DEFAULT_CFG } }
  })
  useEffect(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)) } catch {} }, [cfg])

  // Patterns memo
  const patterns = useMemo(() => makePatterns(), [])
  const pattern = useMemo(() => patterns.find(p => p.name === cfg.pattern) || patterns[0], [patterns, cfg.pattern])

  // HUD auto-hide near top-middle
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onMove = (e: MouseEvent) => {
      const r = el.getBoundingClientRect(), y = e.clientY - r.top, x = e.clientX - r.left
      const nearTop = y < 90
      const nearCenterX = Math.abs(x - r.width / 2) < r.width * 0.35
      if (nearTop && nearCenterX) {
        setHudVisible(true); setHoverTop(true)
        if (hudHideTimer.current) { window.clearTimeout(hudHideTimer.current); hudHideTimer.current = null }
      } else {
        setHoverTop(false)
        if (!panelOpen && hudHideTimer.current == null) {
          hudHideTimer.current = window.setTimeout(() => { setHudVisible(false); hudHideTimer.current = null }, 1400)
        }
      }
    }
    const onLeave = () => { setHoverTop(false); if (!panelOpen) setHudVisible(false) }
    el.addEventListener('mousemove', onMove)
    el.addEventListener('mouseleave', onLeave)
    return () => {
      el.removeEventListener('mousemove', onMove)
      el.removeEventListener('mouseleave', onLeave)
      if (hudHideTimer.current) { window.clearTimeout(hudHideTimer.current); hudHideTimer.current = null }
    }
  }, [panelOpen])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    disposedRef.current = false

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#05070b')

    const camera = new THREE.PerspectiveCamera(58, 1, 0.05, 50)
    camera.position.set(0, 0, 2.2)

    const { renderer, dispose: disposeRenderer } = createRenderer(canvas, quality.renderScale)
    const comp = createComposer(renderer, scene, camera, {
      bloom: quality.bloom, bloomStrength: 0.6, bloomRadius: 0.36, bloomThreshold: 0.56,
      fxaa: true, vignette: true, vignetteStrength: cfg.vignette, filmGrain: false, motionBlur: false
    })

    // Audio bus
    let latest: ReactiveFrame | null = null
    const offFrame = reactivityBus.on('frame', (f) => { latest = f })

    const setters = makeUniformSetters(matRef)

    // Load album cover + palette
    async function loadAlbum() {
      try {
        const s = await getPlaybackState().catch(() => null)
        const url = (s?.item?.album?.images?.[0]?.url as string) || ''
        if (!url) return

        // Texture (CORS + fallback)
        const loader = new THREE.TextureLoader()
        loader.setCrossOrigin('anonymous' as any)
        const tex = await new Promise<THREE.Texture>((resolve, reject) => {
          loader.load(url, (t) => resolve(t), undefined, async () => {
            const resp = await fetch(url); const blob = await resp.blob(); const obj = URL.createObjectURL(blob)
            loader.load(obj, (t) => resolve(t), undefined, reject)
          })
        })
        tex.colorSpace = THREE.SRGBColorSpace
        tex.minFilter = THREE.LinearMipmapLinearFilter
        tex.magFilter = THREE.LinearFilter
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
        try { tex.anisotropy = (renderer.capabilities as any).getMaxAnisotropy?.() ?? tex.anisotropy } catch {}

        texRef.current?.dispose()
        texRef.current = tex
        setters.setTex('tAlbum', tex)

        // Palette (fast 40x40 sample)
        const img = new Image()
        await new Promise<void>((res, rej) => { img.crossOrigin = 'anonymous'; img.onload = () => res(); img.onerror = rej; img.src = url })
        const c = document.createElement('canvas'); c.width = 40; c.height = 40
        const g = c.getContext('2d'); if (g) {
          g.drawImage(img, 0, 0, 40, 40)
          const data = g.getImageData(0, 0, 40, 40).data
          quantizeTopN(data, 3)
          setters.setColor('uC0', albAvg.current)
          setters.setColor('uC1', albC1.current)
          setters.setColor('uC2', albC2.current)
          setters.setColor('uC3', albC3.current)
        }
      } catch { /* ignore */ }
    }

    function quantizeTopN(data: Uint8ClampedArray, nPick = 3) {
      const bins = new Map<number, number>()
      const toBin = (r: number, g: number, b: number) => {
        const R = Math.min(5, Math.floor(r / 43))
        const G = Math.min(5, Math.floor(g / 43))
        const B = Math.min(5, Math.floor(b / 43))
        return (R << 10) | (G << 5) | B
      }
      let ar = 0, ag = 0, ab = 0, n = 0
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3]; if (a < 16) continue
        const r = data[i], g = data[i + 1], b = data[i + 2]
        const key = toBin(r, g, b)
        bins.set(key, (bins.get(key) || 0) + 1)
        ar += r; ag += g; ab += b; n++
      }
      albAvg.current.setRGB(ar / Math.max(1, n) / 255, ag / Math.max(1, n) / 255, ab / Math.max(1, n) / 255)
      const sorted = [...bins.entries()].sort((a, b) => b[1] - a[1]).slice(0, nPick)
      const decode = (bin: number) => {
        const R = ((bin >> 10) & 0x1f) * 43 + 21
        const G = ((bin >> 5) & 0x1f) * 43 + 21
        const B = (bin & 0x1f) * 43 + 21
        return new THREE.Color(R / 255, G / 255, B / 255)
      }
      const picks = sorted.map(([bin]) => decode(bin))
      albC1.current.copy(picks[0] || new THREE.Color('#ffffff'))
      albC2.current.copy(picks[1] || albC1.current)
      albC3.current.copy(picks[2] || albC2.current)
    }

    // Geometry (plane) and CPU folding buffers
    const segs = 90
    const size = pattern.half * 2
    const plane = new THREE.PlaneGeometry(size, size, segs, segs)
    plane.rotateX(0) // keep in XY plane
    plane.computeVertexNormals()

    // CPU fold buffers
    const posAttr = plane.getAttribute('position') as THREE.BufferAttribute
    const nrmAttr = plane.getAttribute('normal') as THREE.BufferAttribute
    const uvAttr = plane.getAttribute('uv') as THREE.BufferAttribute
    const vertexCount = posAttr.count

    // Original positions/normals (copy for reset each frame)
    const pos0 = new Float32Array(posAttr.array as ArrayLike<number>)
    const nrm0 = new Float32Array(nrmAttr.array as ArrayLike<number>)

    // Precompute side-masks per crease for original 2D coords
    const masks: Record<string, Uint8Array> = {}
    for (const cDef of pattern.creases) {
      const m = new Uint8Array(vertexCount)
      for (let i = 0; i < vertexCount; i++) {
        const x = pos0[i * 3 + 0], y = pos0[i * 3 + 1]
        const side = sideOfLine2D(new THREE.Vector2(x, y), cDef.p, cDef.d)
        const ok = cDef.side === 1 ? side > 0 : side < 0
        m[i] = ok ? 1 : 0
      }
      masks[cDef.id] = m
    }

    // Shader (fragment does fresnel/palette; vertex just passes through)
    const uniforms: Record<string, { value: any }> = {
      tAlbum: { value: null },
      uC0: { value: albAvg.current.clone() },
      uC1: { value: albC1.current.clone() },
      uC2: { value: albC2.current.clone() },
      uC3: { value: albC3.current.clone() },
      uExposure: { value: cfg.exposure },
      uSaturation: { value: cfg.saturation },
      uGamma: { value: cfg.gamma },
      uVignette: { value: cfg.vignette },
      uFresnel: { value: cfg.fresnelStrength },
      uEdgeTint: { value: cfg.edgeTintStrength },
      uGloss: { value: cfg.paperGloss },
      uBackDark: { value: cfg.backsideDarken },
      uTileMix: { value: 0.0 },
      uTileIntensity: { value: cfg.tileIntensity },
      uAudio: { value: new THREE.Vector3(0.1, 0.1, 0.1) },
      uSafe: { value: (accessibility.epilepsySafe || accessibility.reducedMotion) ? 1.0 : 0.0 }
    }

    const mat = new THREE.ShaderMaterial({
      uniforms,
      side: THREE.DoubleSide,
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vWorldPos;
        void main() {
          vUv = uv;
          vNormal = normalize(normalMatrix * normal);
          vec4 wp = modelMatrix * vec4(position,1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vWorldPos;
        uniform sampler2D tAlbum;
        uniform vec3 uC0, uC1, uC2, uC3;
        uniform float uExposure, uSaturation, uGamma, uVignette;
        uniform float uFresnel, uEdgeTint, uGloss, uBackDark;
        uniform float uTileMix, uTileIntensity;
        uniform vec3 uAudio;
        uniform float uSafe;

        vec3 sat(vec3 c, float s){ float l=dot(c, vec3(0.299,0.587,0.114)); return mix(vec3(l), c, s); }

        void main(){
          vec2 uv = vUv * 0.98 + 0.01;
          vec3 texCol = texture2D(tAlbum, uv).rgb;
          vec2 tuv = fract(vUv * (1.0 + uTileMix * 6.0));
          vec3 tileCol = texture2D(tAlbum, tuv).rgb;
          texCol = mix(texCol, tileCol, clamp(uTileMix * uTileIntensity, 0.0, 1.0));

          if (!gl_FrontFacing) {
            texCol = mix(texCol * (1.0 - uBackDark), texCol * uC0, 0.25);
          }

          vec3 N = normalize(vNormal);
          vec3 V = normalize(cameraPosition - vWorldPos);
          float NdotV = clamp(dot(N, V), 0.0, 1.0);

          float fres = pow(1.0 - NdotV, 3.0);
          float highs = uAudio.z;
          float fresAmt = mix(uFresnel, min(uFresnel, 0.22), uSafe) + highs * 0.25;
          vec3 fresCol = mix(uC2, uC3, 0.5 + 0.4*sin(highs*6.0));
          vec3 shimmer = fresCol * fres * fresAmt;

          float rim = pow(1.0 - NdotV, 1.6);
          float gloss = pow(NdotV, 32.0) * uGloss;
          vec3 edgeCol = mix(uC1, uC2, 0.5 + 0.3*sin(highs*8.0));
          vec3 edge = edgeCol * (rim * uEdgeTint + gloss * 0.6);

          vec3 col = texCol + shimmer;
          col = mix(col, col + edge, 0.6);
          col = sat(col, mix(uSaturation, 1.0, uSafe*0.3));
          col *= uExposure;
          col = col / (1.0 + col);
          col = pow(clamp(col, 0.0, 1.0), vec3(uGamma));
          gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        }
      `
    })
    matRef.current = mat

    const mesh = new THREE.Mesh(plane, mat)
    scene.add(mesh)

    // Resize
    const onResize = () => {
      if (disposedRef.current) return
      const sizeV = renderer.getSize(new THREE.Vector2())
      camera.aspect = sizeV.x / Math.max(1, sizeV.y)
      camera.updateProjectionMatrix()
      comp.onResize()
    }
    window.addEventListener('resize', onResize)
    onResize()

    // Album
    loadAlbum()
    const albumIv = window.setInterval(loadAlbum, 8000)

    // Fold timeline state
    type PhaseState = { idx: number; tIn: number } // current step index and time into it
    let ph: PhaseState = { idx: 0, tIn: 0 }

    // Helpers for fold application
    const vTmp = new THREE.Vector3()
    const q = new THREE.Vector3()
    const a3 = new THREE.Vector3()
    const p3 = new THREE.Vector3()

    function resetToFlat() {
      // copy pos0/nrm0 back
      ;(posAttr.array as Float32Array).set(pos0)
      ;(nrmAttr.array as Float32Array).set(nrm0)
    }

    function applyFold(crease: Crease, angle: number) {
      // rotate vertices on selected side by angle around line (p,d) in 3D
      q.set(crease.p.x, crease.p.y, 0)
      a3.set(crease.d.x, crease.d.y, 0).normalize()
      const mask = masks[crease.id]
      const arr = posAttr.array as Float32Array
      const nrm = nrmAttr.array as Float32Array
      for (let i = 0; i < vertexCount; i++) {
        if (!mask[i]) continue
        const ix = i * 3
        // position
        p3.set(arr[ix], arr[ix + 1], arr[ix + 2])
        rotateAroundLine(vTmp, p3, q, a3, angle)
        arr[ix] = vTmp.x; arr[ix + 1] = vTmp.y; arr[ix + 2] = vTmp.z
        // normal: start from current (already transformed by earlier steps)
        p3.set(nrm[ix], nrm[ix + 1], nrm[ix + 2])
        // normals rotate the same way (around the same axis/anchor; anchor irrelevant for vectors, but using q yields correct Rodrigues)
        rotateAroundLine(vTmp, p3, new THREE.Vector3(0,0,0), a3, angle)
        nrm[ix] = vTmp.x; nrm[ix + 1] = vTmp.y; nrm[ix + 2] = vTmp.z
      }
    }

    // Animate
    const clock = new THREE.Clock()
    let raf = 0

    const animate = () => {
      raf = requestAnimationFrame(animate)
      if (disposedRef.current || !matRef.current) return

      const dt = Math.min(0.05, clock.getDelta())
      const low = latest?.bands?.low ?? 0.06
      const mid = latest?.bands?.mid ?? 0.06
      const high = latest?.bands?.high ?? 0.06
      const loud = latest?.loudness ?? 0.12
      const beat = latest?.beat ? 1.0 : 0.0

      const safe = (accessibility.epilepsySafe || accessibility.reducedMotion) ? 1.0 : 0.0
      setters.setV3('uAudio', low, mid, high)
      setters.setF('uSafe', safe)
      setters.setF('uExposure', cfg.exposure)
      setters.setF('uSaturation', cfg.saturation)
      setters.setF('uGamma', cfg.gamma)
      setters.setF('uVignette', cfg.vignette)
      setters.setF('uFresnel', THREE.MathUtils.lerp(cfg.fresnelStrength, Math.min(cfg.fresnelStrength, 0.22), safe))
      setters.setF('uEdgeTint', cfg.edgeTintStrength)
      setters.setF('uGloss', cfg.paperGloss)
      setters.setF('uBackDark', cfg.backsideDarken)
      setters.setF('uTileIntensity', cfg.tileIntensity)

      // drive tile mix subtly with mid after full fold cycle
      const loopDone = ph.idx >= pattern.sequence.length
      const desiredTile = loopDone ? 1.0 : 0.0
      const uTile = (matRef.current.uniforms.uTileMix.value as number) || 0
      const k = 1 - Math.pow(0.03, dt)
      setters.setF('uTileMix', THREE.MathUtils.lerp(uTile, desiredTile * (0.2 + 0.4 * (mid + high)), k))

      // Fold simulation
      resetToFlat()

      if (cfg.autoPlay) {
        // iterate through steps, applying full angles for completed ones and partial for current
        const spd = THREE.MathUtils.lerp(cfg.foldSpeed, Math.min(cfg.foldSpeed, 0.6), safe)
        ph.tIn += dt * (spd * (1.0 + low * 0.5) + (beat > 0.5 ? 0.15 : 0.0))

        let accIdx = 0
        for (; accIdx < pattern.sequence.length; accIdx++) {
          const step = pattern.sequence[accIdx]
          if (accIdx < ph.idx) {
            // fully applied
            const crease = pattern.creases.find(c => c.id === step.creaseId)!
            applyFold(crease, crease.angle)
            continue
          }
          if (accIdx === ph.idx) {
            const crease = pattern.creases.find(c => c.id === step.creaseId)!
            const t01 = Math.min(1, ph.tIn / Math.max(0.0001, step.duration))
            const eased = t01 * t01 * (3 - 2 * t01) // smoothstep ease
            applyFold(crease, crease.angle * eased)
            // not done yet: break to avoid applying following steps
            break
          }
        }

        // step progression
        const cur = pattern.sequence[ph.idx]
        if (cur && ph.tIn >= cur.duration) {
          // wait pause, then advance
          const over = ph.tIn - cur.duration
          if (over >= cur.pauseAfter) {
            ph.idx++
            ph.tIn = 0
          }
        }
        // loop
        if (ph.idx >= pattern.sequence.length && ph.tIn > 2.5) {
          ph = { idx: 0, tIn: 0 }
        }
      } else {
        // reactive breathing
        const react = Math.min(1, low * 0.9 + mid * 0.3)
        // apply partial of first 2 steps to keep a shape
        for (let i = 0; i < Math.min(2, pattern.sequence.length); i++) {
          const step = pattern.sequence[i]
          const crease = pattern.creases.find(c => c.id === step.creaseId)!
          const factor = i === 0 ? react : react * 0.7
          applyFold(crease, crease.angle * factor)
        }
      }

      posAttr.needsUpdate = true
      nrmAttr.needsUpdate = true

      comp.composer.render()
    }

    animate()

    // Cleanup
    return () => {
      disposedRef.current = true
      window.removeEventListener('resize', onResize)
      cancelAnimationFrame(raf)
      window.clearInterval(albumIv)
      offFrame?.()
      texRef.current?.dispose(); texRef.current = null
      matRef.current = null
      scene.traverse((o: any) => {
        o.geometry?.dispose?.()
        if (Array.isArray(o.material)) o.material.forEach((m: any) => m?.dispose?.())
        else o.material?.dispose?.()
      })
      comp.dispose()
      disposeRenderer()
      renderer.dispose()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quality.renderScale, quality.bloom, accessibility.epilepsySafe, accessibility.reducedMotion, accessibility.highContrast, cfg.vignette, cfg.exposure, cfg.saturation, cfg.gamma, cfg.pattern, cfg.tileIntensity])

  const requestPlayInBrowser = () => {
    window.dispatchEvent(new CustomEvent('ffw:play-in-browser'))
  }

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* Top-center HUD */}
      <div
        style={{
          position: 'absolute',
          top: 8, left: '50%', transform: 'translateX(-50%)',
          zIndex: 10, display: 'flex', gap: 8, alignItems: 'center',
          padding: '6px 10px', borderRadius: 10, border: '1px solid rgba(43,47,58,0.9)',
          background: 'rgba(10,12,16,0.82)', color: '#e6f0ff',
          fontFamily: 'system-ui, sans-serif', fontSize: 12, lineHeight: 1.2,
          transition: 'opacity 200ms ease', opacity: (hudVisible || panelOpen) ? 1 : 0,
          pointerEvents: (hudVisible || panelOpen) ? 'auto' : 'none',
          boxShadow: hoverTop ? '0 2px 16px rgba(0,0,0,0.35)' : '0 2px 10px rgba(0,0,0,0.25)'
        }}
        onMouseEnter={() => setHudVisible(true)}
      >
        <select
          value={cfg.pattern}
          onChange={e => setCfg(c => ({ ...c, pattern: e.currentTarget.value as PatternName }))}
          style={{ padding: '6px', borderRadius: 8, border: '1px solid #2b2f3a', background: '#0f1218', color: '#cfe7ff' }}
        >
          <option value="Fox Head">Fox Head</option>
          <option value="Crane Simple">Crane (Simple)</option>
          <option value="Quad Base">Quad Base</option>
        </select>
        <button onClick={() => setPanelOpen(o => !o)} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #2b2f3a', background: '#0f1218', color: '#cfe7ff', cursor: 'pointer' }}>
          {panelOpen ? 'Close Visual Settings' : 'Visual Settings'}
        </button>
        <button onClick={requestPlayInBrowser} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #2b2f3a', background: '#0f1218', color: '#b7ffbf', cursor: 'pointer' }}>
          Play in browser
        </button>
      </div>

      <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} aria-label="Origami Fold Visual" />

      {panelOpen && (
        <div style={{ position: 'absolute', top: 56, right: 12, zIndex: 11, width: 380, padding: 12, borderRadius: 8, border: '1px solid #2b2f3a', background: 'rgba(10,12,16,0.94)', color: '#e6f0ff', fontFamily: 'system-ui, sans-serif', fontSize: 12 }}>
          <Section title="Core">
            <Row label="Auto Play">
              <input type="checkbox" checked={cfg.autoPlay} onChange={e => setCfg({ ...cfg, autoPlay: e.currentTarget.checked })} />
            </Row>
            <Slider label={`Fold Speed ${cfg.foldSpeed.toFixed(2)}`} min={0.2} max={2.0} step={0.01} value={cfg.foldSpeed} onChange={(v) => setCfg({ ...cfg, foldSpeed: v })} />
            <Slider label={`Fold Pause ${cfg.foldPause.toFixed(2)}s`} min={0.2} max={2.0} step={0.01} value={cfg.foldPause} onChange={(v) => setCfg({ ...cfg, foldPause: v })} />
            <Slider label={`Tile Intensity ${cfg.tileIntensity.toFixed(2)}`} min={0.0} max={1.0} step={0.01} value={cfg.tileIntensity} onChange={(v) => setCfg({ ...cfg, tileIntensity: v })} />
          </Section>
          <Section title="Look">
            <Slider label={`Exposure ${cfg.exposure.toFixed(2)}`} min={0.6} max={1.6} step={0.01} value={cfg.exposure} onChange={(v) => setCfg({ ...cfg, exposure: v })} />
            <Slider label={`Saturation ${cfg.saturation.toFixed(2)}`} min={0.6} max={1.6} step={0.01} value={cfg.saturation} onChange={(v) => setCfg({ ...cfg, saturation: v })} />
            <Slider label={`Gamma ${cfg.gamma.toFixed(2)}`} min={0.85} max={1.15} step={0.01} value={cfg.gamma} onChange={(v) => setCfg({ ...cfg, gamma: v })} />
            <Slider label={`Vignette ${cfg.vignette.toFixed(2)}`} min={0.0} max={1.0} step={0.01} value={cfg.vignette} onChange={(v) => setCfg({ ...cfg, vignette: v })} />
            <Slider label={`Fresnel ${cfg.fresnelStrength.toFixed(2)}`} min={0.0} max={1.0} step={0.01} value={cfg.fresnelStrength} onChange={(v) => setCfg({ ...cfg, fresnelStrength: v })} />
            <Slider label={`Edge Tint ${cfg.edgeTintStrength.toFixed(2)}`} min={0.0} max={1.0} step={0.01} value={cfg.edgeTintStrength} onChange={(v) => setCfg({ ...cfg, edgeTintStrength: v })} />
            <Slider label={`Paper Gloss ${cfg.paperGloss.toFixed(2)}`} min={0.0} max={0.6} step={0.01} value={cfg.paperGloss} onChange={(v) => setCfg({ ...cfg, paperGloss: v })} />
            <Slider label={`Backside Darken ${cfg.backsideDarken.toFixed(2)}`} min={0.0} max={0.6} step={0.01} value={cfg.backsideDarken} onChange={(v) => setCfg({ ...cfg, backsideDarken: v })} />
          </Section>
        </div>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid #2b2f3a', borderRadius: 8, padding: 10, marginTop: 8 }}>
      <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  )
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, margin: '6px 0' }}>
      <label style={{ fontSize: 12, opacity: 0.9, minWidth: 160 }}>{label}</label>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  )
}
function Slider({ label, min, max, step, value, onChange }: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <Row label={label}>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => {
        const v = Number(e.currentTarget.value)
        if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)))
      }} />
    </Row>
  )
}
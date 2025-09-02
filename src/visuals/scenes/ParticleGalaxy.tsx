import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { createRenderer, createComposer } from '../../three/Renderer'
import { reactivityBus, type ReactiveFrame } from '../../audio/ReactivityBus'
import { getPlaybackState } from '../../spotify/api'
import { extractPalette } from '../../utils/palette'

type Props = {
  quality: { renderScale: 1 | 1.25 | 1.5 | 1.75 | 2, msaa: 0 | 2 | 4 | 8, bloom: boolean, motionBlur: boolean }
  accessibility: { epilepsySafe: boolean, reducedMotion: boolean, highContrast: boolean }
}

type Preset = {
  name: string
  arms: { count: number; width: number; curvature: number; twist: number; speed: number }
  core: { count: number; radius: number }
  dust: { count: number; radius: number }
  colors?: { primary?: string; accent?: string; background?: string }
  bloom: { strength: number; radius: number; threshold: number }
}

const PRESETS: Preset[] = [
  { name: 'Chill Nebula',   arms: { count: 2, width: 1.8, curvature: 0.22, twist: 1.2, speed: 0.08 }, core: { count: 8000, radius: 1.4 },  dust: { count: 4000, radius: 16 }, bloom: { strength: 0.45, radius: 0.35, threshold: 0.62 } },
  { name: 'Bass Supernova', arms: { count: 3, width: 2.2, curvature: 0.18, twist: 1.6, speed: 0.12 }, core: { count: 12000, radius: 1.1 }, dust: { count: 6000, radius: 18 }, bloom: { strength: 0.7,  radius: 0.45, threshold: 0.65 } },
  { name: 'Hi‑Hat Sparkle', arms: { count: 4, width: 1.4, curvature: 0.26, twist: 0.9, speed: 0.10 }, core: { count: 9000,  radius: 1.2 }, dust: { count: 9000, radius: 22 }, bloom: { strength: 0.55, radius: 0.5,  threshold: 0.62 } },
  { name: 'Cinematic Core', arms: { count: 2, width: 1.1, curvature: 0.2,  twist: 0.7, speed: 0.06 }, core: { count: 16000, radius: 0.95 }, dust: { count: 4000, radius: 14 }, bloom: { strength: 0.7,  radius: 0.6,  threshold: 0.6  } },
  { name: 'Dusty Arms',     arms: { count: 5, width: 2.6, curvature: 0.24, twist: 1.1, speed: 0.09 }, core: { count: 7000,  radius: 1.5 },  dust: { count: 16000, radius: 28 }, bloom: { strength: 0.5,  radius: 0.55, threshold: 0.62 } }
]

// Safety limits and defaults to avoid white screens and lag
const SAFE = {
  MAX_TOTAL: 12000,          // hard ceiling for total particles (instanced or points)
  START_COUNT: 3500,         // ramp from this count upward only if FPS allows
  MIN_COUNT: 2500,           // never drop below this
  MAX_SIZE_SCALE: 1.2,
  MIN_SIZE_SCALE: 0.55,
  TARGET_FPS: 58,
  DOWN_FPS: 42
}

type UIConfig = {
  sizeScale: number
  twinkleSensitivity: number
  glowBoost: number
  spinMultiplier: number
  exposure: number
  bloomEnabled: boolean
  bloomStrength: number
  cursorFadeRadius: number
  safeMode: boolean
}
type TabKey = 'presets' | 'particles' | 'motion' | 'postfx'

function supportsInstancing(renderer: THREE.WebGLRenderer) {
  try {
    const gl = renderer.getContext()
    // @ts-ignore
    const webgl2 = !!(gl && (gl as WebGL2RenderingContext).drawArraysInstanced)
    const angle = !!gl.getExtension?.('ANGLE_instanced_arrays')
    return webgl2 || angle
  } catch {
    return false
  }
}

function spiralPoint(armIndex: number, arms: number, t: number, curvature: number, width: number, rand: number, twist: number) {
  const armAngle = (armIndex / arms) * Math.PI * 2.0
  const theta = t + armAngle + twist * 0.15 * t
  const r = 0.24 * t * (1.0 + curvature * t)
  const lateral = width * (rand - 0.5) * 0.32 * (0.2 + 0.8 * Math.min(1, r))
  const x = Math.cos(theta) * r + Math.cos(theta + Math.PI * 0.5) * lateral
  const z = Math.sin(theta) * r + Math.sin(theta + Math.PI * 0.5) * lateral
  const y = (rand - 0.5) * width * 0.26 * (0.2 + 0.8 * r)
  return new THREE.Vector3(x, y, z)
}

// Instanced billboard star material (fast, high quality)
function buildInstancedStarMaterial(primary: THREE.Color, accent: THREE.Color) {
  const uniforms = {
    uTime: { value: 0 },
    uSizeScale: { value: 0.9 },
    uTwinkle: { value: 0 },
    uGlow: { value: 0.8 },
    uPrimary: { value: primary },
    uAccent: { value: accent },
  }
  const vert = `
    precision mediump float;
    uniform float uSizeScale;
    attribute vec2 corner;
    attribute vec3 instancePosition;
    attribute float instanceSize;
    attribute float instanceSeed;
    attribute float instanceType;
    varying vec2 vCorner;
    varying float vSeed;
    varying float vType;
    varying float vDepth;
    void main() {
      vCorner = corner;
      vSeed = instanceSeed;
      vType = instanceType;
      vec4 mv = modelViewMatrix * vec4(instancePosition, 1.0);
      vDepth = -mv.z;
      vec3 right = normalize(vec3(modelViewMatrix[0][0], modelViewMatrix[1][0], modelViewMatrix[2][0]));
      vec3 up    = normalize(vec3(modelViewMatrix[0][1], modelViewMatrix[1][1], modelViewMatrix[2][1]));
      float sizePx = instanceSize * (160.0 / max(1.0, vDepth)) * uSizeScale;
      vec3 offsetVS = (right * corner.x + up * corner.y) * sizePx;
      gl_Position = projectionMatrix * vec4(mv.xyz + offsetVS, 1.0);
    }
  `
  const frag = `
    precision mediump float;
    varying vec2 vCorner;
    varying float vSeed;
    varying float vType;
    varying float vDepth;
    uniform float uTime;
    uniform float uTwinkle;
    uniform float uGlow;
    uniform vec3 uPrimary;
    uniform vec3 uAccent;
    float core(vec2 uv) { float r = dot(uv,uv); return exp(-r*8.0); }
    float spikes(vec2 uv){ float a=atan(uv.y,uv.x); float r=length(uv)+1e-4; return pow(abs(cos(6.0*a)),16.0)*pow(1.0-clamp(r,0.0,1.0),3.0); }
    float hash(float n){ return fract(sin(n)*43758.5453); }
    vec3 tonemap(vec3 x){ return x/(1.0+x); }
    void main() {
      vec2 uv = vCorner;
      float r = length(uv);
      float tCore = step(0.5, 0.5 - abs(vType - 0.0));
      float tArm  = step(0.5, 0.5 - abs(vType - 1.0));
      float tDust = step(0.5, 0.5 - abs(vType - 2.0));
      vec3 base = normalize(uPrimary*(tCore*1.1+tDust*0.45)+uAccent*(tArm*1.2+tDust*0.55)+1e-4);
      float jitter = 0.04*(hash(vSeed*97.0)-0.5);
      base = normalize(base+vec3(jitter,-jitter,0.0));
      float tw = 0.5+0.5*sin(uTime*(2.7+2.0*vSeed)+vSeed*9.0);
      float twinkle = mix(1.0, 1.0+0.6*tw, uTwinkle);
      float c = core(uv) + 0.25*spikes(uv);
      float depthGlow = mix(0.65, 1.0, smoothstep(0.0, 120.0, vDepth));
      vec3 col = base * (1.0 + uGlow*0.8) * c * twinkle * depthGlow;
      col = tonemap(col*1.1); // local tonemap to avoid washout
      float alpha = smoothstep(1.0, 0.0, r);
      alpha *= alpha;
      if (alpha < 0.01) discard;
      gl_FragColor = vec4(col, alpha);
    }
  `
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending
  })
  return { mat, uniforms }
}

// Points fallback (even safer)
function buildPointsMaterial(primary: THREE.Color, accent: THREE.Color) {
  const uniforms = {
    uTime: { value: 0 },
    uSizeScale: { value: 0.85 },
    uTwinkle: { value: 0 },
    uGlow: { value: 0.7 },
    uPrimary: { value: primary },
    uAccent: { value: accent },
  }
  const vert = `
    precision mediump float;
    uniform float uSizeScale;
    attribute float aSize;
    attribute float aSeed;
    attribute float aType;
    varying float vSeed;
    varying float vType;
    varying float vDepth;
    void main(){
      vSeed=aSeed; vType=aType;
      vec4 mv = modelViewMatrix*vec4(position,1.0);
      vDepth = -mv.z;
      float sizePx = aSize * (150.0 / max(1.0, vDepth)) * uSizeScale;
      gl_PointSize = clamp(sizePx, 0.5, 64.0);
      gl_Position = projectionMatrix * mv;
    }
  `
  const frag = `
    precision mediump float;
    varying float vSeed;
    varying float vType;
    varying float vDepth;
    uniform float uTime;
    uniform float uTwinkle;
    uniform float uGlow;
    uniform vec3 uPrimary;
    uniform vec3 uAccent;
    float hash(float n){ return fract(sin(n)*43758.5453); }
    void main(){
      vec2 uv = gl_PointCoord*2.0-1.0;
      float r = length(uv);
      float tCore = step(0.5, 0.5 - abs(vType - 0.0));
      float tArm  = step(0.5, 0.5 - abs(vType - 1.0));
      float tDust = step(0.5, 0.5 - abs(vType - 2.0));
      vec3 base = normalize(uPrimary*(tCore*1.1+tDust*0.45)+uAccent*(tArm*1.2+tDust*0.55)+1e-4);
      float jitter = 0.04*(hash(vSeed*97.0)-0.5);
      base = normalize(base+vec3(jitter,-jitter,0.0));
      float tw = 0.5+0.5*sin(uTime*(2.5+2.0*vSeed)+vSeed*9.0);
      float twinkle = mix(1.0, 1.0+0.5*tw, uTwinkle);
      float alpha = smoothstep(1.0, 0.0, r); alpha*=alpha;
      float depthGlow = mix(0.65, 1.0, smoothstep(0.0, 120.0, vDepth));
      vec3 col = base*(1.0+uGlow*0.7)*twinkle*depthGlow;
      if(alpha<0.02) discard;
      gl_FragColor = vec4(col, alpha);
    }
  `
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending
  })
  return { mat, uniforms }
}

function makeInstancedGeometry(count: number) {
  const geom = new THREE.InstancedBufferGeometry()
  const corners = new Float32Array([
    -1, -1,  1, -1,  1,  1,
    -1, -1,  1,  1, -1,  1
  ])
  geom.setAttribute('corner', new THREE.BufferAttribute(corners, 2))
  // dummy pos
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 3), 3))
  const instancePosition = new Float32Array(count * 3)
  const instanceSize = new Float32Array(count)
  const instanceSeed = new Float32Array(count)
  const instanceType = new Float32Array(count)
  geom.setAttribute('instancePosition', new THREE.InstancedBufferAttribute(instancePosition, 3))
  geom.setAttribute('instanceSize', new THREE.InstancedBufferAttribute(instanceSize, 1))
  geom.setAttribute('instanceSeed', new THREE.InstancedBufferAttribute(instanceSeed, 1))
  geom.setAttribute('instanceType', new THREE.InstancedBufferAttribute(instanceType, 1))
  geom.instanceCount = count
  return { geom, instancePosition, instanceSize, instanceSeed, instanceType }
}

function makePointsGeometry(count: number) {
  const geom = new THREE.BufferGeometry()
  const position = new Float32Array(count * 3)
  const aSize = new Float32Array(count)
  const aSeed = new Float32Array(count)
  const aType = new Float32Array(count)
  geom.setAttribute('position', new THREE.BufferAttribute(position, 3))
  geom.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1))
  geom.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1))
  geom.setAttribute('aType', new THREE.BufferAttribute(aType, 1))
  geom.setDrawRange(0, count)
  return { geom, position, aSize, aSeed, aType }
}

export default function ParticleGalaxy({ quality, accessibility }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [presetIdx, setPresetIdx] = useState(0)
  const preset = PRESETS[presetIdx]

  // Album-driven palette
  const primaryRef = useRef(new THREE.Color('#4ad3ff'))
  const accentRef = useRef(new THREE.Color('#ff6bd6'))
  const bgRef = useRef(new THREE.Color('#04070c'))

  // Safe defaults that won’t blow out brightness
  const [ui, setUi] = useState<UIConfig>({
    sizeScale: 0.85,
    twinkleSensitivity: 0.8,
    glowBoost: 0.85,
    spinMultiplier: 0.9,
    exposure: 0.9,
    bloomEnabled: false, // start disabled to avoid white-out
    bloomStrength: 0.55,
    cursorFadeRadius: 0.0,
    safeMode: true      // start in safe mode; user can disable in UI
  })
  const uiRef = useRef(ui)
  useEffect(() => { uiRef.current = ui }, [ui])

  const [showModal, setShowModal] = useState(false)
  const [activeTab, setActiveTab] = useState<TabKey>('presets')

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key >= '1' && e.key <= '5') setPresetIdx(Math.min(4, Math.max(0, parseInt(e.key, 10) - 1)))
      if (e.key === 'Escape') setShowModal(false)
      if (e.key.toLowerCase() === 'c') setShowModal(v => !v)
      if (e.key.toLowerCase() === 'p') paused = !paused // pause toggle
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // Scene and renderer
    const scene = new THREE.Scene()
    scene.background = bgRef.current.clone()

    const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 500)
    camera.position.set(0, 2.0, 9.0)

    const { renderer, dispose: disposeRenderer } = createRenderer(canvas, Math.min(quality.renderScale, 1.25))
    renderer.debug.checkShaderErrors = true
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = uiRef.current.exposure
    renderer.setClearColor(bgRef.current, 1)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75)) // clamp DPR

    // Pause when tab not visible
    let paused = false
    function onVis() { paused = document.hidden }
    document.addEventListener('visibilitychange', onVis)

    // Post FX composer (can be a passthrough if createComposer returns function)
    const comp = createComposer(renderer, scene, camera, {
      bloom: uiRef.current.bloomEnabled && !uiRef.current.safeMode,
      bloomStrength: uiRef.current.bloomStrength,
      bloomRadius: preset.bloom.radius,
      bloomThreshold: Math.max(0.65, preset.bloom.threshold),
      fxaa: true,
      vignette: true,
      vignetteStrength: 0.2,
      filmGrain: false,
      filmGrainStrength: 0,
      motionBlur: false
    })
    const compAny: any = comp as any
    const renderScene: () => void =
      typeof compAny === 'function' ? compAny : (compAny?.render?.bind(compAny) ?? (() => renderer.render(scene, camera)))
    const resizeComposer: () => void =
      typeof compAny === 'function' ? () => {} : (compAny?.onResize?.bind(compAny) ?? (() => {}))

    const root = new THREE.Group()
    scene.add(root)

    // Choose path: instanced quads (faster) vs points (safer)
    const useInstancing = supportsInstancing(renderer) && !uiRef.current.safeMode

    // Budget and caps
    const pixelScale = Math.min(1.5, Math.max(0.75, quality.renderScale))
    const baseScale = pixelScale * (accessibility.reducedMotion ? 0.7 : 1.0)
    const MAX_TOTAL = SAFE.MAX_TOTAL
    const CORE = Math.min(Math.floor(preset.core.count * baseScale), Math.floor(MAX_TOTAL * 0.4))
    const ARM_TOTAL = Math.min(Math.floor(preset.arms.count * 0.4 * preset.core.count * baseScale), Math.floor(MAX_TOTAL * 0.35))
    const DUST = Math.min(Math.floor(preset.dust.count * baseScale), Math.max(0, MAX_TOTAL - CORE - ARM_TOTAL))
    const TOTAL = Math.max(SAFE.MIN_COUNT, Math.min(MAX_TOTAL, CORE + ARM_TOTAL + DUST))

    // Geometry/material
    let liveCount = Math.min(SAFE.START_COUNT, TOTAL)
    let mesh: THREE.Object3D
    let uniforms: any

    if (useInstancing) {
      const { geom, instancePosition, instanceSize, instanceSeed, instanceType } = makeInstancedGeometry(TOTAL)
      // Fill data
      let k = 0
      // Core
      {
        const R = preset.core.radius
        for (let i = 0; i < CORE; i++) {
          const r = Math.pow(Math.random(), 0.8) * R
          const th = Math.random() * Math.PI * 2
          const ph = Math.acos(2 * Math.random() - 1)
          instancePosition[k * 3 + 0] = r * Math.sin(ph) * Math.cos(th)
          instancePosition[k * 3 + 1] = r * Math.cos(ph) * 0.8
          instancePosition[k * 3 + 2] = r * Math.sin(ph) * Math.sin(th)
          instanceSize[k] = THREE.MathUtils.lerp(1.4, 3.0, Math.random())
          instanceSeed[k] = Math.random()
          instanceType[k] = 0
          k++
        }
      }
      // Arms
      {
        const perArm = Math.floor(ARM_TOTAL / preset.arms.count)
        for (let a = 0; a < preset.arms.count; a++) {
          for (let i = 0; i < perArm; i++) {
            const t = Math.random() * 14.0
            const rand = Math.random()
            const p = spiralPoint(a, preset.arms.count, t, preset.arms.curvature, preset.arms.width, rand, preset.arms.twist)
            instancePosition[k * 3 + 0] = p.x
            instancePosition[k * 3 + 1] = p.y * 0.55
            instancePosition[k * 3 + 2] = p.z
            instanceSize[k] = THREE.MathUtils.lerp(1.0, 2.4, Math.random())
            instanceSeed[k] = Math.random()
            instanceType[k] = 1
            k++
            if (k >= TOTAL) break
          }
        }
      }
      // Dust
      for (; k < TOTAL; k++) {
        const R = preset.dust.radius
        const r = THREE.MathUtils.lerp(5, R, Math.pow(Math.random(), 0.7))
        const th = Math.random() * Math.PI * 2
        instancePosition[k * 3 + 0] = Math.cos(th) * r
        instancePosition[k * 3 + 1] = (Math.random() - 0.5) * (0.25 + 0.35 * r)
        instancePosition[k * 3 + 2] = Math.sin(th) * r
        instanceSize[k] = THREE.MathUtils.lerp(0.9, 1.8, Math.random())
        instanceSeed[k] = Math.random()
        instanceType[k] = 2
      }

      ;(geom.getAttribute('instancePosition') as THREE.InstancedBufferAttribute).needsUpdate = true
      ;(geom.getAttribute('instanceSize') as THREE.InstancedBufferAttribute).needsUpdate = true
      ;(geom.getAttribute('instanceSeed') as THREE.InstancedBufferAttribute).needsUpdate = true
      ;(geom.getAttribute('instanceType') as THREE.InstancedBufferAttribute).needsUpdate = true

      const { mat, uniforms: u } = buildInstancedStarMaterial(primaryRef.current.clone(), accentRef.current.clone())
      uniforms = u
      const stars = new THREE.Mesh(geom, mat)
      ;(stars as any).frustumCulled = false
      root.add(stars)
      mesh = stars
      ;(geom as THREE.InstancedBufferGeometry).instanceCount = liveCount
    } else {
      const { geom, position, aSize, aSeed, aType } = makePointsGeometry(TOTAL)
      let k = 0
      // Core
      {
        const R = preset.core.radius
        for (let i = 0; i < CORE; i++) {
          const r = Math.pow(Math.random(), 0.8) * R
          const th = Math.random() * Math.PI * 2
          const ph = Math.acos(2 * Math.random() - 1)
          position[k * 3 + 0] = r * Math.sin(ph) * Math.cos(th)
          position[k * 3 + 1] = r * Math.cos(ph) * 0.8
          position[k * 3 + 2] = r * Math.sin(ph) * Math.sin(th)
          aSize[k] = THREE.MathUtils.lerp(1.2, 2.6, Math.random())
          aSeed[k] = Math.random()
          aType[k] = 0
          k++
        }
      }
      // Arms
      {
        const perArm = Math.floor(ARM_TOTAL / preset.arms.count)
        for (let a = 0; a < preset.arms.count; a++) {
          for (let i = 0; i < perArm; i++) {
            const t = Math.random() * 14.0
            const rand = Math.random()
            const p = spiralPoint(a, preset.arms.count, t, preset.arms.curvature, preset.arms.width, rand, preset.arms.twist)
            position[k * 3 + 0] = p.x
            position[k * 3 + 1] = p.y * 0.55
            position[k * 3 + 2] = p.z
            aSize[k] = THREE.MathUtils.lerp(0.9, 2.2, Math.random())
            aSeed[k] = Math.random()
            aType[k] = 1
            k++
            if (k >= TOTAL) break
          }
        }
      }
      // Dust
      for (; k < TOTAL; k++) {
        const R = preset.dust.radius
        const r = THREE.MathUtils.lerp(5, R, Math.pow(Math.random(), 0.7))
        const th = Math.random() * Math.PI * 2
        position[k * 3 + 0] = Math.cos(th) * r
        position[k * 3 + 1] = (Math.random() - 0.5) * (0.25 + 0.35 * r)
        position[k * 3 + 2] = Math.sin(th) * r
        aSize[k] = THREE.MathUtils.lerp(0.8, 1.8, Math.random())
        aSeed[k] = Math.random()
        aType[k] = 2
      }
      ;(geom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
      ;(geom.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true
      ;(geom.getAttribute('aSeed') as THREE.BufferAttribute).needsUpdate = true
      ;(geom.getAttribute('aType') as THREE.BufferAttribute).needsUpdate = true
      geom.setDrawRange(0, liveCount)

      const { mat, uniforms: u } = buildPointsMaterial(primaryRef.current.clone(), accentRef.current.clone())
      uniforms = u
      const points = new THREE.Points(geom, mat)
      ;(points as any).frustumCulled = false
      root.add(points)
      mesh = points
    }

    // Audio frames
    let latest: ReactiveFrame | null = null
    const offFrame = reactivityBus.on('frame', f => { latest = f })

    // Palette from album art (safe, rare)
    let lastAlbumUrl: string | null = null
    async function refreshPalette() {
      try {
        const s = await getPlaybackState()
        const url = s?.item?.album?.images?.[0]?.url as string | undefined
        if (url && url !== lastAlbumUrl) {
          lastAlbumUrl = url
          const pal = await extractPalette(url)
          if (pal) {
            const pri = new THREE.Color(pal.primary || '#4ad3ff')
            const acc = new THREE.Color(pal.accent || '#ff6bd6')
            const bg = new THREE.Color(pal.background || '#04070c')
            primaryRef.current.copy(pri)
            accentRef.current.copy(acc)
            bgRef.current.copy(bg)
            scene.background = bg.clone()
            renderer.setClearColor(bg, 1)
            if (uniforms?.uPrimary) uniforms.uPrimary.value = pri
            if (uniforms?.uAccent) uniforms.uAccent.value = acc
          }
        }
      } catch { /* ignore palette failures */ }
    }
    const palIv = window.setInterval(refreshPalette, 8000)
    refreshPalette()

    // Resize
    function onResize() {
      const view = renderer.getSize(new THREE.Vector2())
      camera.aspect = Math.max(1e-3, view.x / Math.max(1, view.y))
      camera.updateProjectionMatrix()
      resizeComposer()
    }
    window.addEventListener('resize', onResize)
    onResize()

    // FPS watchdog + adaptive throttle
    let fpsAvg = 60
    let lastT = performance.now()
    let rampT = 0
    let whiteoutGuard = 0 // if brightness spikes, we back off exposure/bloom

    function sampleFPS() {
      const now = performance.now()
      const dt = Math.max(1, now - lastT)
      const fps = 1000 / dt
      fpsAvg = fpsAvg * 0.9 + fps * 0.1
      lastT = now
    }

    const clock = new THREE.Clock()
    let raf = 0
    let baseAngle = 0
    const shake = new THREE.Vector3()
    let beatCooldown = 0

    function setLiveCount(n: number) {
      liveCount = Math.max(SAFE.MIN_COUNT, Math.min(TOTAL, n | 0))
      if ((mesh as any).geometry instanceof THREE.InstancedBufferGeometry) {
        ;((mesh as any).geometry as THREE.InstancedBufferGeometry).instanceCount = liveCount
      } else {
        ;((mesh as any).geometry as THREE.BufferGeometry).setDrawRange(0, liveCount)
      }
    }

    function animate() {
      raf = requestAnimationFrame(animate)
      if (paused) return

      const t = clock.getElapsedTime()
      const dt = clock.getDelta()
      sampleFPS()

      // Audio
      const low = latest?.bands.low ?? 0.05
      const mid = latest?.bands.mid ?? 0.05
      const high = latest?.bands.high ?? 0.05
      const beat = !!latest?.beat

      // Spin
      const spinBase = preset.arms.speed * uiRef.current.spinMultiplier
      baseAngle += dt * (spinBase + low * 0.6 * uiRef.current.spinMultiplier)
      root.rotation.y = baseAngle

      // Camera gentle drift
      const camDist = 8.8 - Math.min(1.1, low * 2.0)
      camera.position.x = Math.cos(t * 0.05) * camDist
      camera.position.z = Math.sin(t * 0.05) * camDist
      camera.position.y = 1.9 + Math.sin(t * 0.6) * 0.22 + low * 0.3
      camera.rotation.z = Math.sin(t * 0.04) * 0.02

      if (beat && beatCooldown <= 0 && !accessibility.reducedMotion) {
        beatCooldown = 0.12
        shake.set((Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.08, 0)
      }
      if (beatCooldown > 0) {
        beatCooldown -= dt
        camera.position.add(shake)
        shake.multiplyScalar(0.86)
      }

      // Uniforms (guarded)
      if (uniforms) {
        if (uniforms.uTime) uniforms.uTime.value = t
        const twSafe = accessibility.epilepsySafe ? 0.5 : 1.0
        if (uniforms.uTwinkle) uniforms.uTwinkle.value = THREE.MathUtils.clamp(high * 1.4 * uiRef.current.twinkleSensitivity, 0, twSafe)
        if (uniforms.uGlow) uniforms.uGlow.value = THREE.MathUtils.lerp(0.25, 0.95, Math.min(1, (low * 1.8 + mid * 0.4) * uiRef.current.glowBoost))
        const sizeAuto = fpsAvg < SAFE.TARGET_FPS ? THREE.MathUtils.mapLinear(Math.max(20, fpsAvg), 20, SAFE.TARGET_FPS, SAFE.MIN_SIZE_SCALE, 1.0) : 1.0
        if (uniforms.uSizeScale) uniforms.uSizeScale.value = Math.max(SAFE.MIN_SIZE_SCALE, Math.min(SAFE.MAX_SIZE_SCALE, sizeAuto * uiRef.current.sizeScale))
      }

      // Renderer exposure clamped
      renderer.toneMappingExposure = Math.max(0.7, Math.min(1.15, uiRef.current.exposure))

      // Whiteout guard: if FPS tanks and bloom is on, reduce bloom/exposure automatically
      if (fpsAvg < SAFE.DOWN_FPS) {
        whiteoutGuard += dt
        if (whiteoutGuard > 0.5) {
          whiteoutGuard = 0
          renderer.toneMappingExposure = Math.max(0.75, renderer.toneMappingExposure * 0.92)
          // If composer object supports changing bloom at runtime
          // we rely on lower exposure; bloom already disabled in safe mode.
        }
      } else {
        whiteoutGuard = Math.max(0, whiteoutGuard - dt)
      }

      // Progressive ramp
      rampT += dt
      if (rampT > 0.33) {
        rampT = 0
        if (fpsAvg > SAFE.TARGET_FPS && liveCount < TOTAL) {
          setLiveCount(Math.min(TOTAL, liveCount + 1500))
        } else if (fpsAvg < SAFE.DOWN_FPS && liveCount > SAFE.MIN_COUNT) {
          setLiveCount(Math.max(SAFE.MIN_COUNT, Math.floor(liveCount * 0.8)))
        }
      }

      renderScene()
    }
    raf = requestAnimationFrame(animate)

    // Cleanup
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVis)
      window.clearInterval(palIv)
      reactivityBus.off('frame', offFrame as any)
      try {
        if ((mesh as any)?.geometry) (mesh as any).geometry.dispose?.()
        if ((mesh as any)?.material) (mesh as any).material.dispose?.()
      } catch {}
      disposeRenderer()
    }
  }, [presetIdx, quality.renderScale, ui.safeMode, ui.bloomEnabled, ui.bloomStrength])

  useEffect(() => {
    const c = PRESETS[presetIdx].colors
    if (c?.primary) primaryRef.current.set(c.primary)
    if (c?.accent) accentRef.current.set(c.accent)
    if (c?.background) bgRef.current.set(c.background)
  }, [presetIdx])

  // Center popup UI (adds Safe Mode toggle so you can try higher quality once stable)
  const Modal = useMemo(() => {
    if (!showModal) return null
    return (
      <>
        <div className="pg-backdrop" onClick={() => setShowModal(false)} />
        <div className="pg-modal enter" role="dialog" aria-modal="true">
          <div className="pg-modal-frame">
            <div className="pg-tabs">
              <button className={`pg-tab ${activeTab === 'presets' ? 'active' : ''}`} onClick={() => setActiveTab('presets')} title="Presets"><span>PR</span></button>
              <button className={`pg-tab ${activeTab === 'particles' ? 'active' : ''}`} onClick={() => setActiveTab('particles')} title="Particles"><span>PA</span></button>
              <button className={`pg-tab ${activeTab === 'motion' ? 'active' : ''}`} onClick={() => setActiveTab('motion')} title="Motion"><span>MO</span></button>
              <button className={`pg-tab ${activeTab === 'postfx' ? 'active' : ''}`} onClick={() => setActiveTab('postfx')} title="Post FX"><span>FX</span></button>
            </div>

            <div className="pg-title">
              Particle Galaxy — {PRESETS[presetIdx].name}
              <button className="pg-close" onClick={() => setShowModal(false)} aria-label="Close">✕</button>
            </div>

            <div className="pg-content">
              {activeTab === 'presets' && (
                <div className="pg-pane">
                  <div className="pg-row">
                    <label>Preset</label>
                    <select value={presetIdx} onChange={(e) => setPresetIdx(parseInt(e.currentTarget.value, 10))}>
                      {PRESETS.map((p, i) => <option key={i} value={i}>{i + 1}. {p.name}</option>)}
                    </select>
                    <span />
                  </div>
                  <div className="pg-row">
                    <label className="pg-checkbox">
                      <input
                        type="checkbox"
                        checked={ui.safeMode}
                        onChange={(e) => setUi(prev => ({ ...prev, safeMode: e.currentTarget.checked }))}
                      />
                      <span>Safe Mode (recommended)</span>
                    </label>
                    <span />
                    <span />
                  </div>
                  <div className="pg-hint">Safe Mode uses fewer particles and no bloom to prevent white screens and lag. Disable only after it looks stable.</div>
                </div>
              )}

              {activeTab === 'particles' && (
                <div className="pg-pane">
                  <div className="pg-row">
                    <label>Size scale</label>
                    <input type="range" min="0.5" max="1.2" step="0.01" value={ui.sizeScale}
                      onChange={e => setUi(prev => ({ ...prev, sizeScale: parseFloat(e.currentTarget.value) }))} />
                    <span className="pg-val">{ui.sizeScale.toFixed(2)}</span>
                  </div>
                  <div className="pg-row">
                    <label>Cursor fade radius</label>
                    <input type="range" min="0" max="6" step="0.1" value={ui.cursorFadeRadius}
                      onChange={e => setUi(prev => ({ ...prev, cursorFadeRadius: parseFloat(e.currentTarget.value) }))} />
                    <span className="pg-val">{ui.cursorFadeRadius.toFixed(1)}</span>
                  </div>
                </div>
              )}

              {activeTab === 'motion' && (
                <div className="pg-pane">
                  <div className="pg-row">
                    <label>Twinkle sensitivity</label>
                    <input type="range" min="0" max="1.6" step="0.01" value={ui.twinkleSensitivity}
                      onChange={e => setUi(prev => ({ ...prev, twinkleSensitivity: parseFloat(e.currentTarget.value) }))} />
                    <span className="pg-val">{ui.twinkleSensitivity.toFixed(2)}</span>
                  </div>
                  <div className="pg-row">
                    <label>Glow boost</label>
                    <input type="range" min="0.5" max="1.5" step="0.01" value={ui.glowBoost}
                      onChange={e => setUi(prev => ({ ...prev, glowBoost: parseFloat(e.currentTarget.value) }))} />
                    <span className="pg-val">{ui.glowBoost.toFixed(2)}</span>
                  </div>
                  <div className="pg-row">
                    <label>Spin multiplier</label>
                    <input type="range" min="0.5" max="1.6" step="0.01" value={ui.spinMultiplier}
                      onChange={e => setUi(prev => ({ ...prev, spinMultiplier: parseFloat(e.currentTarget.value) }))} />
                    <span className="pg-val">{ui.spinMultiplier.toFixed(2)}</span>
                  </div>
                </div>
              )}

              {activeTab === 'postfx' && (
                <div className="pg-pane">
                  <div className="pg-row">
                    <label>Exposure</label>
                    <input type="range" min="0.7" max="1.2" step="0.01" value={ui.exposure}
                      onChange={e => setUi(prev => ({ ...prev, exposure: parseFloat(e.currentTarget.value) }))} />
                    <span className="pg-val">{ui.exposure.toFixed(2)}</span>
                  </div>
                  <div className="pg-row">
                    <label className="pg-checkbox">
                      <input type="checkbox" checked={ui.bloomEnabled}
                        onChange={e => setUi(prev => ({ ...prev, bloomEnabled: e.currentTarget.checked }))} disabled={ui.safeMode} />
                      <span>Bloom</span>
                    </label>
                    <span />
                    <span />
                  </div>
                  <div className="pg-row">
                    <label>Bloom strength</label>
                    <input type="range" min="0" max="1.0" step="0.01" value={ui.bloomStrength}
                      onChange={e => setUi(prev => ({ ...prev, bloomStrength: parseFloat(e.currentTarget.value) }))} disabled={ui.safeMode} />
                    <span className="pg-val">{ui.bloomStrength.toFixed(2)}</span>
                  </div>
                  <div className="pg-hint">Bloom can cause bright white if too strong; keep exposure low when enabling.</div>
                </div>
              )}
            </div>
          </div>
        </div>
      </>
    )
  }, [showModal, activeTab, ui, presetIdx])

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      <button className="pg-gear" onClick={() => setShowModal(true)} title="Open Galaxy Settings (C)">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path fill="currentColor" d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm9.44 3.26-1.78-.69c-.1-.34-.22-.67-.37-.99l.96-1.68a.5.5 0 0 0-.07-.59l-1.41-1.41a.5.5 0 0 0-.59-.07l-1.68.96c-.32-.15-.65-.27-.99-.37l-.69-1.78a.5.5 0 0 0-.48-.34h-2a.5.5 0 0 0-.48.34l-.69 1.78c-.34.1-.67.22-.99.37l-1.68-.96a.5.5 0 0 0-.59.07L3.82 6.83a.5.5 0 0 0-.07.59l.96 1.68c-.15.32-.27.65-.37.99l-1.78.69a.5.5 0 0 0-.34.48v2c0 .22.14.41.34.48l1.78.69c.1.34.22.67.37.99l-.96 1.68a.5.5 0 0 0 .07.59l1.41 1.41c.16.16.41.2.59.07l1.68-.96c.32.15.65.27.99.37l.69 1.78c.07.2.26.34.48.34h2c.22 0 .41-.14.48-.34l.69-1.78c.34-.1.67-.22.99-.37l1.68.96c.18.13.43.09.59-.07l1.41-1.41a.5.5 0 0 0 .07-.59l-.96-1.68c.15-.32.27-.65.37-.99l1.78-.69c.2-.07.34-.26.34-.48v-2a.5.5 0 0 0-.34-.48Z"/>
        </svg>
      </button>
      {Modal}
    </div>
  )
}
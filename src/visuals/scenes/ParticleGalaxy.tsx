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
  { name: 'Chill Nebula',   arms: { count: 2, width: 1.8, curvature: 0.22, twist: 1.2, speed: 0.08 }, core: { count: 8000, radius: 1.4 },  dust: { count: 4000, radius: 16 }, bloom: { strength: 0.55, radius: 0.35, threshold: 0.52 } },
  { name: 'Bass Supernova', arms: { count: 3, width: 2.2, curvature: 0.18, twist: 1.6, speed: 0.14 }, core: { count: 12000, radius: 1.1 }, dust: { count: 6000, radius: 18 }, bloom: { strength: 0.9,  radius: 0.45, threshold: 0.48 } },
  { name: 'Hi‑Hat Sparkle', arms: { count: 4, width: 1.4, curvature: 0.26, twist: 0.9, speed: 0.12 }, core: { count: 9000,  radius: 1.2 }, dust: { count: 9000, radius: 22 }, bloom: { strength: 0.7,  radius: 0.5,  threshold: 0.5  } },
  { name: 'Cinematic Core', arms: { count: 2, width: 1.1, curvature: 0.2,  twist: 0.7, speed: 0.06 }, core: { count: 16000, radius: 0.95 }, dust: { count: 4000, radius: 14 }, bloom: { strength: 0.85, radius: 0.6,  threshold: 0.46 } },
  { name: 'Dusty Arms',     arms: { count: 5, width: 2.6, curvature: 0.24, twist: 1.1, speed: 0.1  }, core: { count: 7000,  radius: 1.5 },  dust: { count: 16000, radius: 28 }, bloom: { strength: 0.6,  radius: 0.55, threshold: 0.52 } }
]

// UI/config
type UIConfig = {
  sizeScale: number
  twinkleSensitivity: number
  glowBoost: number
  spinMultiplier: number
  exposure: number
  bloomEnabled: boolean
  bloomStrength: number
  cursorFadeRadius: number
}
type TabKey = 'presets' | 'particles' | 'motion' | 'postfx'

// Galaxy math helpers
function spiralPoint(armIndex: number, arms: number, t: number, curvature: number, width: number, rand: number, twist: number) {
  const armAngle = (armIndex / arms) * Math.PI * 2.0
  const theta = t + armAngle + twist * 0.15 * t
  const r = 0.25 * t * (1.0 + curvature * t)
  const lateral = width * (rand - 0.5) * 0.35 * (0.2 + 0.8 * Math.min(1, r))
  const x = Math.cos(theta) * r + Math.cos(theta + Math.PI * 0.5) * lateral
  const z = Math.sin(theta) * r + Math.sin(theta + Math.PI * 0.5) * lateral
  const y = (rand - 0.5) * width * 0.28 * (0.2 + 0.8 * r)
  return new THREE.Vector3(x, y, z)
}

// Instanced starfield geometry
function makeStarGeometry(count: number) {
  const geom = new THREE.InstancedBufferGeometry()

  // Base quad 2D corners (6 verts)
  const corners = new Float32Array([
    -1, -1,  1, -1,  1,  1,
    -1, -1,  1,  1, -1,  1
  ])
  geom.setAttribute('corner', new THREE.BufferAttribute(corners, 2))

  // Dummy position attribute so Three can infer draw count
  const pos = new Float32Array(6 * 3) // zeros
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3))

  // Instanced attributes
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

type StarUniforms = {
  uTime: { value: number }
  uSizeScale: { value: number }
  uTwinkle: { value: number }
  uGlow: { value: number }
  uPrimary: { value: THREE.Color }
  uAccent: { value: THREE.Color }
  uMouseWorld: { value: THREE.Vector3 }
  uMouseFade: { value: number }
}

function buildStarMaterial(primary: THREE.Color, accent: THREE.Color) {
  const uniforms: StarUniforms = {
    uTime: { value: 0 },
    uSizeScale: { value: 1 },
    uTwinkle: { value: 0 },
    uGlow: { value: 0.7 },
    uPrimary: { value: primary },
    uAccent: { value: accent },
    uMouseWorld: { value: new THREE.Vector3(1e6, 1e6, 1e6) },
    uMouseFade: { value: 0 }
  }

  const vert = `
    precision highp float;
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

      // View-space center
      vec4 mv = modelViewMatrix * vec4(instancePosition, 1.0);
      vDepth = -mv.z;

      // Camera-facing billboard axes from modelViewMatrix columns
      vec3 right = vec3(modelViewMatrix[0][0], modelViewMatrix[1][0], modelViewMatrix[2][0]);
      vec3 up    = vec3(modelViewMatrix[0][1], modelViewMatrix[1][1], modelViewMatrix[2][1]);

      float sizePx = instanceSize * (300.0 / max(1.0, vDepth)) * uSizeScale;
      vec3 offsetVS = (right * corner.x + up * corner.y) * sizePx;

      gl_Position = projectionMatrix * vec4(mv.xyz + offsetVS, 1.0);
    }
  `

  const frag = `
    precision highp float;

    varying vec2 vCorner;
    varying float vSeed;
    varying float vType;
    varying float vDepth;

    uniform float uTime;
    uniform float uTwinkle;
    uniform float uGlow;
    uniform vec3 uPrimary;
    uniform vec3 uAccent;

    float starCore(vec2 uv) {
      float r = length(uv);
      return exp(-r * r * 6.0);
    }
    float spikes(vec2 uv) {
      float a = atan(uv.y, uv.x);
      float r = length(uv) + 1e-5;
      return pow(abs(cos(6.0 * a)), 48.0) * pow(1.0 - clamp(r, 0.0, 1.0), 6.0);
    }
    float hash(float n) { return fract(sin(n) * 43758.5453123); }

    void main() {
      vec2 uv = vCorner; // -1..1
      float r = length(uv);

      float tCore = step(0.5, 0.5 - abs(vType - 0.0));
      float tArm  = step(0.5, 0.5 - abs(vType - 1.0));
      float tDust = step(0.5, 0.5 - abs(vType - 2.0));
      vec3 baseCol = normalize(uPrimary * (tCore * 1.15 + tDust * 0.45) + uAccent * (tArm * 1.25 + tDust * 0.55) + 1e-4);

      float hueJitter = 0.06 * (hash(vSeed * 97.0) - 0.5);
      baseCol = normalize(baseCol + vec3(hueJitter, -hueJitter, 0.0));

      float tw = 0.5 + 0.5 * sin(uTime * (3.0 + 2.0 * vSeed) + vSeed * 11.0);
      float twinkle = mix(1.0, 1.0 + 0.9 * tw, uTwinkle);

      float c = starCore(uv) + 0.85 * spikes(uv);
      vec3 col = baseCol * (1.0 + uGlow) * c * twinkle;

      float alpha = smoothstep(1.0, 0.0, r);
      alpha *= alpha;

      float glowBias = mix(0.65, 1.0, smoothstep(0.0, 120.0, vDepth));
      col *= glowBias;

      if (alpha < 0.02) discard;
      gl_FragColor = vec4(col, alpha);
    }
  `

  const mat = new THREE.ShaderMaterial({
    uniforms: uniforms as any,
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  })
  return { mat, uniforms }
}

export default function ParticleGalaxy({ quality, accessibility }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const disposedRef = useRef(false)

  const [presetIdx, setPresetIdx] = useState(0)
  const preset = PRESETS[presetIdx]
  const primaryRef = useRef(new THREE.Color('#4ad3ff'))
  const accentRef = useRef(new THREE.Color('#ff6bd6'))
  const bgRef = useRef(new THREE.Color('#04070c'))

  const [ui, setUi] = useState<UIConfig>({
    sizeScale: 1.0,
    twinkleSensitivity: 1.0,
    glowBoost: 1.0,
    spinMultiplier: 1.0,
    exposure: 1.0,
    bloomEnabled: true,
    bloomStrength: preset.bloom.strength,
    cursorFadeRadius: 0.0
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
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    disposedRef.current = false

    const scene = new THREE.Scene()
    scene.background = bgRef.current.clone()
    const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 500)
    camera.position.set(0, 2.2, 9.5)

    const { renderer, dispose: disposeRenderer } = createRenderer(canvas, quality.renderScale)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = uiRef.current.exposure

    const comp = createComposer(renderer, scene, camera, {
      bloom: uiRef.current.bloomEnabled,
      bloomStrength: uiRef.current.bloomStrength,
      bloomRadius: preset.bloom.radius,
      bloomThreshold: preset.bloom.threshold,
      fxaa: true,
      vignette: true,
      vignetteStrength: 0.22,
      filmGrain: false,
      filmGrainStrength: 0.0,
      motionBlur: false
    })
    const compAny: any = comp as any
    const renderScene: () => void =
      typeof compAny === 'function'
        ? compAny
        : (compAny?.render?.bind(compAny) ?? (() => renderer.render(scene, camera)))
    const resizeComposer: () => void =
      typeof compAny === 'function'
        ? () => {}
        : (compAny?.onResize?.bind(compAny) ?? (() => {}))

    const root = new THREE.Group()
    scene.add(root)

    const { mat: starMat, uniforms } = buildStarMaterial(primaryRef.current.clone(), accentRef.current.clone())
    const starMatRef = { current: starMat }

    // Geometry budgets
    const pixelScale = Math.min(2, Math.max(0.75, quality.renderScale))
    const budgetScale = pixelScale * (accessibility.reducedMotion ? 0.75 : 1.0)
    const CORE = Math.floor(preset.core.count * budgetScale)
    const ARM_TOTAL = Math.floor(preset.arms.count * 0.5 * preset.core.count * budgetScale)
    const DUST = Math.floor(preset.dust.count * budgetScale)
    const TOTAL = CORE + ARM_TOTAL + DUST

    const { geom, instancePosition, instanceSize, instanceSeed, instanceType } = makeStarGeometry(TOTAL)

    // Populate distributions
    let k = 0
    {
      const R = preset.core.radius
      for (let i = 0; i < CORE; i++) {
        const r = Math.pow(Math.random(), 0.8) * R
        const th = Math.random() * Math.PI * 2
        const ph = Math.acos(2 * Math.random() - 1)
        const x = r * Math.sin(ph) * Math.cos(th)
        const y = r * Math.cos(ph) * 0.85
        const z = r * Math.sin(ph) * Math.sin(th)
        instancePosition[k * 3 + 0] = x
        instancePosition[k * 3 + 1] = y
        instancePosition[k * 3 + 2] = z
        instanceSize[k] = THREE.MathUtils.lerp(1.8, 3.8, Math.random())
        instanceSeed[k] = Math.random()
        instanceType[k] = 0
        k++
      }
    }
    {
      const perArm = Math.floor(ARM_TOTAL / preset.arms.count)
      for (let a = 0; a < preset.arms.count; a++) {
        for (let i = 0; i < perArm; i++) {
          const t = Math.random() * 16.0
          const rand = Math.random()
          const p = spiralPoint(a, preset.arms.count, t, preset.arms.curvature, preset.arms.width, rand, preset.arms.twist)
          instancePosition[k * 3 + 0] = p.x
          instancePosition[k * 3 + 1] = p.y * 0.55
          instancePosition[k * 3 + 2] = p.z
          instanceSize[k] = THREE.MathUtils.lerp(1.2, 3.0, Math.random())
          instanceSeed[k] = Math.random()
          instanceType[k] = 1
          k++
          if (k >= TOTAL) break
        }
      }
    }
    {
      const R = preset.dust.radius
      for (; k < TOTAL; k++) {
        const r = THREE.MathUtils.lerp(5, R, Math.pow(Math.random(), 0.7))
        const th = Math.random() * Math.PI * 2
        const x = Math.cos(th) * r
        const z = Math.sin(th) * r
        const y = (Math.random() - 0.5) * (0.25 + 0.35 * r)
        instancePosition[k * 3 + 0] = x
        instancePosition[k * 3 + 1] = y
        instancePosition[k * 3 + 2] = z
        instanceSize[k] = THREE.MathUtils.lerp(0.9, 2.4, Math.random())
        instanceSeed[k] = Math.random()
        instanceType[k] = 2
      }
    }

    ;(geom.getAttribute('instancePosition') as THREE.InstancedBufferAttribute).needsUpdate = true
    ;(geom.getAttribute('instanceSize') as THREE.InstancedBufferAttribute).needsUpdate = true
    ;(geom.getAttribute('instanceSeed') as THREE.InstancedBufferAttribute).needsUpdate = true
    ;(geom.getAttribute('instanceType') as THREE.InstancedBufferAttribute).needsUpdate = true

    const stars = new THREE.Mesh(geom, starMat)
    ;(stars as any).frustumCulled = false
    root.add(stars)

    // Mouse world fade target (optional)
    const raycaster = new THREE.Raycaster()
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const mouseNDC = new THREE.Vector2()
    function updateMouse(ev: MouseEvent) {
      const rect = canvas.getBoundingClientRect()
      mouseNDC.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1
      mouseNDC.y = -(((ev.clientY - rect.top) / rect.height) * 2 - 1)
      raycaster.setFromCamera(mouseNDC, camera)
      const p = new THREE.Vector3()
      raycaster.ray.intersectPlane(plane, p)
      const u = (starMatRef.current.uniforms as any)
      if (u?.uMouseWorld?.value) u.uMouseWorld.value.copy(p || new THREE.Vector3(1e6,1e6,1e6))
    }
    window.addEventListener('mousemove', updateMouse)

    // Audio frames
    let latest: ReactiveFrame | null = null
    const offFrame = reactivityBus.on('frame', f => { latest = f })

    // Album-art palette polling
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
            const u = (starMatRef.current.uniforms as any)
            if (u?.uPrimary && u?.uAccent) {
              u.uPrimary.value = pri
              u.uAccent.value = acc
            }
          }
        }
      } catch {}
    }
    const palIv = window.setInterval(refreshPalette, 6000)
    refreshPalette()

    function onResize() {
      const view = renderer.getSize(new THREE.Vector2())
      camera.aspect = Math.max(1e-3, view.x / Math.max(1, view.y))
      camera.updateProjectionMatrix()
      resizeComposer()
    }
    window.addEventListener('resize', onResize)
    onResize()

    let fpsAvg = 60
    let lastT = performance.now()
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

    function animate() {
      raf = requestAnimationFrame(animate)
      const t = clock.getElapsedTime()
      const dt = clock.getDelta()
      sampleFPS()

      const low = latest?.bands.low ?? 0.08
      const mid = latest?.bands.mid ?? 0.08
      const high = latest?.bands.high ?? 0.08
      const beat = !!latest?.beat

      const spinBase = preset.arms.speed * uiRef.current.spinMultiplier
      baseAngle += dt * (spinBase + low * 0.9 * uiRef.current.spinMultiplier)
      root.rotation.y = baseAngle

      const camDist = 9.3 - Math.min(1.4, low * 2.8)
      const roll = Math.sin(t * 0.05) * 0.03
      camera.position.x = Math.cos(t * 0.06) * camDist
      camera.position.z = Math.sin(t * 0.06) * camDist
      camera.position.y = 2.0 + Math.sin(t * 0.7) * 0.25 + low * 0.4
      camera.rotation.z = roll

      if (beat && beatCooldown <= 0 && !accessibility.reducedMotion) {
        beatCooldown = 0.15
        shake.set((Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12, 0)
      }
      if (beatCooldown > 0) {
        beatCooldown -= dt
        camera.position.add(shake)
        shake.multiplyScalar(0.86)
      }

      const u = (starMatRef.current.uniforms as any)
      if (u) {
        if (u.uTime) u.uTime.value = t
        const twinkleSafe = accessibility.epilepsySafe ? 0.7 : 1.0
        if (u.uTwinkle) u.uTwinkle.value = THREE.MathUtils.clamp(high * 2.0 * uiRef.current.twinkleSensitivity, 0, twinkleSafe)
        if (u.uGlow) u.uGlow.value = THREE.MathUtils.lerp(0.35, 1.4, Math.min(1, (low * 2.2 + mid * 0.45) * uiRef.current.glowBoost))
        const sizeAuto = fpsAvg < 42 ? THREE.MathUtils.mapLinear(fpsAvg, 24, 42, 0.76, 1.0) : 1.0
        if (u.uSizeScale) u.uSizeScale.value = Math.max(0.65, Math.min(2.0, sizeAuto * uiRef.current.sizeScale))
        if (u.uMouseFade) u.uMouseFade.value = uiRef.current.cursorFadeRadius
      }
      renderer.toneMappingExposure = uiRef.current.exposure

      renderScene()
    }
    raf = requestAnimationFrame(animate)

    return () => {
      disposedRef.current = true
      window.removeEventListener('resize', onResize)
      window.removeEventListener('mousemove', updateMouse)
      window.clearInterval(palIv)
      cancelAnimationFrame(raf)
      geom.dispose()
      starMat.dispose()
      disposeRenderer()
    }
  }, [presetIdx, quality.renderScale, ui.bloomEnabled, ui.bloomStrength])

  useEffect(() => {
    const c = PRESETS[presetIdx].colors
    if (c?.primary) primaryRef.current.set(c.primary)
    if (c?.accent) accentRef.current.set(c.accent)
    if (c?.background) bgRef.current.set(c.background)
  }, [presetIdx])

  const Modal = useMemo(() => {
    if (!showModal) return null
    return (
      <>
        <div className="pg-backdrop" onClick={() => setShowModal(false)} />
        <div className="pg-modal enter">
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
                  <div className="pg-hint">Press 1–5 to switch presets.</div>
                </div>
              )}

              {activeTab === 'particles' && (
                <div className="pg-pane">
                  <div className="pg-row">
                    <label>Size scale</label>
                    <input type="range" min="0.5" max="1.8" step="0.01" value={ui.sizeScale}
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
                    <input type="range" min="0" max="2" step="0.01" value={ui.twinkleSensitivity}
                      onChange={e => setUi(prev => ({ ...prev, twinkleSensitivity: parseFloat(e.currentTarget.value) }))} />
                    <span className="pg-val">{ui.twinkleSensitivity.toFixed(2)}</span>
                  </div>
                  <div className="pg-row">
                    <label>Glow boost</label>
                    <input type="range" min="0.5" max="2" step="0.01" value={ui.glowBoost}
                      onChange={e => setUi(prev => ({ ...prev, glowBoost: parseFloat(e.currentTarget.value) }))} />
                    <span className="pg-val">{ui.glowBoost.toFixed(2)}</span>
                  </div>
                  <div className="pg-row">
                    <label>Spin multiplier</label>
                    <input type="range" min="0.2" max="2.5" step="0.01" value={ui.spinMultiplier}
                      onChange={e => setUi(prev => ({ ...prev, spinMultiplier: parseFloat(e.currentTarget.value) }))} />
                    <span className="pg-val">{ui.spinMultiplier.toFixed(2)}</span>
                  </div>
                </div>
              )}

              {activeTab === 'postfx' && (
                <div className="pg-pane">
                  <div className="pg-row">
                    <label>Exposure</label>
                    <input type="range" min="0.6" max="1.6" step="0.01" value={ui.exposure}
                      onChange={e => setUi(prev => ({ ...prev, exposure: parseFloat(e.currentTarget.value) }))} />
                    <span className="pg-val">{ui.exposure.toFixed(2)}</span>
                  </div>
                  <div className="pg-row">
                    <label className="pg-checkbox">
                      <input type="checkbox" checked={ui.bloomEnabled}
                        onChange={e => setUi(prev => ({ ...prev, bloomEnabled: e.currentTarget.checked }))} />
                      <span>Bloom</span>
                    </label>
                    <span />
                    <span />
                  </div>
                  <div className="pg-row">
                    <label>Bloom strength</label>
                    <input type="range" min="0" max="1.5" step="0.01" value={ui.bloomStrength}
                      onChange={e => setUi(prev => ({ ...prev, bloomStrength: parseFloat(e.currentTarget.value) }))} />
                    <span className="pg-val">{ui.bloomStrength.toFixed(2)}</span>
                  </div>
                  <div className="pg-hint">Bloom changes reinitialize post-processing.</div>
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
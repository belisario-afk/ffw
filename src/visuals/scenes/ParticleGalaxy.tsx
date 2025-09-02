import React, { useEffect, useRef, useState } from 'react'
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
  {
    name: 'Chill Nebula',
    arms: { count: 2, width: 1.8, curvature: 0.22, twist: 1.2, speed: 0.08 },
    core: { count: 8000, radius: 1.4 },
    dust: { count: 4000, radius: 16 },
    colors: {},
    bloom: { strength: 0.55, radius: 0.35, threshold: 0.52 }
  },
  {
    name: 'Bass Supernova',
    arms: { count: 3, width: 2.2, curvature: 0.18, twist: 1.6, speed: 0.14 },
    core: { count: 12000, radius: 1.1 },
    dust: { count: 6000, radius: 18 },
    colors: {},
    bloom: { strength: 0.9, radius: 0.45, threshold: 0.48 }
  },
  {
    name: 'Hi‑Hat Sparkle',
    arms: { count: 4, width: 1.4, curvature: 0.26, twist: 0.9, speed: 0.12 },
    core: { count: 9000, radius: 1.2 },
    dust: { count: 9000, radius: 22 },
    colors: {},
    bloom: { strength: 0.7, radius: 0.5, threshold: 0.5 }
  },
  {
    name: 'Cinematic Core',
    arms: { count: 2, width: 1.1, curvature: 0.2, twist: 0.7, speed: 0.06 },
    core: { count: 16000, radius: 0.95 },
    dust: { count: 4000, radius: 14 },
    colors: {},
    bloom: { strength: 0.85, radius: 0.6, threshold: 0.46 }
  },
  {
    name: 'Dusty Arms',
    arms: { count: 5, width: 2.6, curvature: 0.24, twist: 1.1, speed: 0.1 },
    core: { count: 7000, radius: 1.5 },
    dust: { count: 16000, radius: 28 },
    colors: {},
    bloom: { strength: 0.6, radius: 0.55, threshold: 0.52 }
  }
]

type GalaxyUniforms = {
  uTime: { value: number }
  uPrimary: { value: THREE.Color }
  uAccent: { value: THREE.Color }
  uTwinkle: { value: number }
  uGlow: { value: number }
  uSizeScale: { value: number }
}

function buildParticleMaterial({ primary, accent }: { primary: THREE.Color; accent: THREE.Color }) {
  const uniforms: GalaxyUniforms = {
    uTime: { value: 0 },
    uPrimary: { value: primary },
    uAccent: { value: accent },
    uTwinkle: { value: 0 },
    uGlow: { value: 0.6 },
    uSizeScale: { value: 1 }
  }

  const vert = `
    uniform float uSizeScale;

    attribute float aSize;
    attribute float aSeed;
    attribute float aType; // 0=core, 1=arm, 2=dust
    varying float vType;
    varying float vSeed;
    varying float vDepth;
    void main() {
      vSeed = aSeed;
      vType = aType;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vDepth = -mv.z;
      // approximate perspective size
      float size = aSize * (300.0 / max(1.0, vDepth)) * uSizeScale;
      gl_PointSize = size;
      gl_Position = projectionMatrix * mv;
    }
  `

  // Soft round sprite with gradient, color mix, twinkle
  const frag = `
    precision highp float;
    varying float vType;
    varying float vSeed;
    varying float vDepth;
    uniform float uTime;
    uniform vec3 uPrimary;
    uniform vec3 uAccent;
    uniform float uTwinkle;
    uniform float uGlow;

    // Fake HDR bloom helper via overbright
    vec3 over(vec3 c, float p) {
      return c * (1.0 + p);
    }

    void main() {
      vec2 uv = gl_PointCoord * 2.0 - 1.0;
      float r = length(uv);
      // Soft disc falloff
      float alpha = smoothstep(1.0, 0.2, r);
      // Type weighting for color balance
      float tCore = step(0.5, 0.5 - abs(vType - 0.0));
      float tArm  = step(0.5, 0.5 - abs(vType - 1.0));
      float tDust = step(0.5, 0.5 - abs(vType - 2.0));
      vec3 col = normalize(uPrimary * (tCore * 1.1 + tDust * 0.5) + uAccent * (tArm * 1.2 + tDust * 0.6) + 0.00001);

      // Twinkle: hi-hat sparkle on high band, seed offsets phase
      float tw = 0.5 + 0.5 * sin(uTime * (3.0 + 2.0 * vSeed) + vSeed * 11.0);
      float twinkle = mix(1.0, 1.0 + 0.9 * tw, uTwinkle);

      // Glow bias: center brighter
      float glow = mix(0.6, 1.0, smoothstep(0.0, 120.0, vDepth));
      vec3 c = over(col, uGlow) * twinkle * glow;

      // Feather edges
      float a = alpha;
      // Discard tiny alpha for cleaner circle
      if (a < 0.02) discard;
      gl_FragColor = vec4(c, a);
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

function spiralPoint(armIndex: number, arms: number, angle: number, curvature: number, radiusScale: number, width: number, rand: number) {
  const armAngle = (armIndex / arms) * Math.PI * 2.0
  const theta = angle + armAngle
  const r = radiusScale * (1.0 + curvature * angle)
  // Lateral spread
  const spread = width * (rand - 0.5) * 0.5 * (0.2 + 0.8 * radiusScale)
  const x = Math.cos(theta) * r + Math.cos(theta + Math.PI * 0.5) * spread
  const z = Math.sin(theta) * r + Math.sin(theta + Math.PI * 0.5) * spread
  const y = (rand - 0.5) * width * 0.35
  return new THREE.Vector3(x, y, z)
}

function makeLayer(count: number) {
  const geo = new THREE.BufferGeometry()
  const pos = new Float32Array(count * 3)
  const aSize = new Float32Array(count)
  const aSeed = new Float32Array(count)
  const aType = new Float32Array(count)
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1))
  geo.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1))
  geo.setAttribute('aType', new THREE.BufferAttribute(aType, 1))
  return { geo, pos, aSize, aSeed, aType }
}

function updateAttr(buf: THREE.BufferAttribute) { buf.needsUpdate = true }

export default function ParticleGalaxy({ quality, accessibility }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const disposedRef = useRef(false)

  const [presetIdx, setPresetIdx] = useState(0)
  const preset = PRESETS[presetIdx]

  // Palette fed by album art (fallback to cool neon)
  const primaryRef = useRef(new THREE.Color('#4ad3ff'))
  const accentRef = useRef(new THREE.Color('#ff6bd6'))
  const bgRef = useRef(new THREE.Color('#04070c'))

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key >= '1' && e.key <= '5') {
        setPresetIdx(Math.min(4, Math.max(0, parseInt(e.key, 10) - 1)))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    disposedRef.current = false

    // Scene setup
    const scene = new THREE.Scene()
    scene.background = bgRef.current.clone()

    const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 500)
    camera.position.set(0, 2.4, 8.5)

    const { renderer, dispose: disposeRenderer } = createRenderer(canvas, quality.renderScale)
    const comp = createComposer(renderer, scene, camera, {
      bloom: true,
      bloomStrength: preset.bloom.strength,
      bloomRadius: preset.bloom.radius,
      bloomThreshold: preset.bloom.threshold,
      fxaa: true,
      vignette: true,
      vignetteStrength: 0.24,
      filmGrain: false,
      filmGrainStrength: 0.0,
      motionBlur: false
    })

    // Normalize composer API (object with render/onResize OR plain function)
    const compAny: any = comp as any
    const renderScene: () => void =
      typeof compAny === 'function'
        ? compAny
        : (compAny?.render?.bind(compAny) ?? (() => renderer.render(scene, camera)))

    const resizeComposer: () => void =
      typeof compAny === 'function'
        ? () => {}
        : (compAny?.onResize?.bind(compAny) ?? (() => {}))

    // Groups
    const root = new THREE.Group()
    scene.add(root)

    // Materials
    const { mat: starMat } = buildParticleMaterial({
      primary: primaryRef.current.clone(),
      accent: accentRef.current.clone()
    })

    // Particle budgets (adaptive baseline)
    const pixelScale = Math.min(2, Math.max(0.75, quality.renderScale))
    const budgetScale = pixelScale * (accessibility.reducedMotion ? 0.7 : 1.0)
    let coreCount = Math.floor(preset.core.count * budgetScale)
    let armCountTotal = Math.floor(preset.arms.count * 0.5 * preset.core.count * budgetScale)
    let dustCount = Math.floor(preset.dust.count * budgetScale)

    // Layers
    const core = makeLayer(coreCount)
    const arms = makeLayer(armCountTotal)
    const dust = makeLayer(dustCount)

    const corePoints = new THREE.Points(core.geo, starMat)
    const armPoints = new THREE.Points(arms.geo, starMat)
    const dustPoints = new THREE.Points(dust.geo, starMat)
    root.add(corePoints, armPoints, dustPoints)

    // Initialize core
    {
      const R = preset.core.radius
      for (let i = 0; i < coreCount; i++) {
        const r = Math.pow(Math.random(), 0.9) * R
        const th = Math.random() * Math.PI * 2
        const ph = Math.acos(2 * Math.random() - 1)
        const x = r * Math.sin(ph) * Math.cos(th)
        const y = r * Math.cos(ph) * 0.8
        const z = r * Math.sin(ph) * Math.sin(th)
        core.pos[i * 3 + 0] = x
        core.pos[i * 3 + 1] = y
        core.pos[i * 3 + 2] = z
        core.aSize[i] = THREE.MathUtils.lerp(1.2, 3.6, Math.random())
        core.aSeed[i] = Math.random()
        core.aType[i] = 0
      }
      updateAttr(core.geo.getAttribute('position') as THREE.BufferAttribute)
      updateAttr(core.geo.getAttribute('aSize') as THREE.BufferAttribute)
      updateAttr(core.geo.getAttribute('aSeed') as THREE.BufferAttribute)
      updateAttr(core.geo.getAttribute('aType') as THREE.BufferAttribute)
    }

    // Initialize arms
    {
      const armsCfg = preset.arms
      let idx = 0
      const perArm = Math.floor(armCountTotal / armsCfg.count)
      for (let a = 0; a < armsCfg.count; a++) {
        for (let i = 0; i < perArm; i++) {
          const t = Math.random() * 12.0 // angle parameter
          const rand = Math.random()
          const p = spiralPoint(a, armsCfg.count, t, armsCfg.curvature, THREE.MathUtils.lerp(1.2, 1.0, Math.random()) * t, armsCfg.width, rand)
          arms.pos[idx * 3 + 0] = p.x
          arms.pos[idx * 3 + 1] = p.y * 0.5
          arms.pos[idx * 3 + 2] = p.z
          arms.aSize[idx] = THREE.MathUtils.lerp(1.4, 3.2, Math.random())
          arms.aSeed[idx] = Math.random()
          arms.aType[idx] = 1
          idx++
          if (idx >= arms.aSize.length) break
        }
      }
      updateAttr(arms.geo.getAttribute('position') as THREE.BufferAttribute)
      updateAttr(arms.geo.getAttribute('aSize') as THREE.BufferAttribute)
      updateAttr(arms.geo.getAttribute('aSeed') as THREE.BufferAttribute)
      updateAttr(arms.geo.getAttribute('aType') as THREE.BufferAttribute)
    }

    // Initialize dust
    {
      const R = preset.dust.radius
      for (let i = 0; i < dustCount; i++) {
        const r = THREE.MathUtils.lerp(4, R, Math.pow(Math.random(), 0.7))
        const th = Math.random() * Math.PI * 2
        const x = Math.cos(th) * r
        const z = Math.sin(th) * r
        const y = (Math.random() - 0.5) * (0.5 + 0.5 * r)
        dust.pos[i * 3 + 0] = x
        dust.pos[i * 3 + 1] = y
        dust.pos[i * 3 + 2] = z
        dust.aSize[i] = THREE.MathUtils.lerp(1.0, 2.6, Math.random())
        dust.aSeed[i] = Math.random()
        dust.aType[i] = 2
      }
      updateAttr(dust.geo.getAttribute('position') as THREE.BufferAttribute)
      updateAttr(dust.geo.getAttribute('aSize') as THREE.BufferAttribute)
      updateAttr(dust.geo.getAttribute('aSeed') as THREE.BufferAttribute)
      updateAttr(dust.geo.getAttribute('aType') as THREE.BufferAttribute)
    }

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
            ;(starMat.uniforms.uPrimary as any).value = pri
            ;(starMat.uniforms.uAccent as any).value = acc
          }
        }
      } catch {}
    }
    const palIv = window.setInterval(refreshPalette, 4000)
    refreshPalette()

    // Resize handling
    function onResize() {
      const view = renderer.getSize(new THREE.Vector2())
      camera.aspect = Math.max(1e-3, view.x / Math.max(1, view.y))
      camera.updateProjectionMatrix()
      resizeComposer()
    }
    window.addEventListener('resize', onResize)
    onResize()

    // Adaptive quality (simple FPS sampling)
    let fpsAvg = 60
    let lastT = performance.now()
    function sampleFPS() {
      const now = performance.now()
      const dt = Math.max(1, now - lastT)
      const fps = 1000 / dt
      fpsAvg = fpsAvg * 0.9 + fps * 0.1
      lastT = now
    }

    // Animate
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

      // Audio mappings
      const low = latest?.bands.low ?? 0.08   // bass
      const mid = latest?.bands.mid ?? 0.08   // body
      const high = latest?.bands.high ?? 0.08 // hats
      const beat = !!latest?.beat
      const beatStrength = latest?.beatStrength ?? 0

      // Orbit arms by bass
      const spinBase = preset.arms.speed
      baseAngle += dt * (spinBase + low * 0.9)
      root.rotation.y = baseAngle

      // Camera gentle motion
      const camDist = 8.5 - Math.min(1.2, low * 2.5)
      const roll = Math.sin(t * 0.05) * 0.03
      camera.position.x = Math.cos(t * 0.06) * camDist
      camera.position.z = Math.sin(t * 0.06) * camDist
      camera.position.y = 2.2 + Math.sin(t * 0.7) * 0.25 + low * 0.4
      camera.rotation.z = roll

      // Beat micro-shake
      if (beat && beatCooldown <= 0 && !accessibility.reducedMotion) {
        beatCooldown = 0.15
        shake.set((Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12, 0)
      }
      if (beatCooldown > 0) {
        beatCooldown -= dt
        camera.position.add(shake)
        shake.multiplyScalar(0.86)
      }

      // Twinkle map to highs; core glow to bass
      ;(starMat.uniforms.uTime as any).value = t
      ;(starMat.uniforms.uTwinkle as any).value = THREE.MathUtils.clamp(high * 2.0, 0, accessibility.epilepsySafe ? 0.7 : 1.0)
      ;(starMat.uniforms.uGlow as any).value = THREE.MathUtils.lerp(0.4, 1.2, Math.min(1, low * 2.2 + mid * 0.4))

      // Adaptive throttling: lower size scale if FPS drops
      const sizeScale = fpsAvg < 42 ? THREE.MathUtils.mapLinear(fpsAvg, 24, 42, 0.76, 1.0) : 1.0
      ;(starMat.uniforms.uSizeScale as any).value = Math.max(0.65, Math.min(1.0, sizeScale))

      renderScene()
    }
    raf = requestAnimationFrame(animate)

    // Cleanup
    return () => {
      disposedRef.current = true
      window.removeEventListener('resize', onResize)
      window.clearInterval(palIv)
      cancelAnimationFrame(raf)
      core.geo.dispose()
      arms.geo.dispose()
      dust.geo.dispose()
      ;(starMat as any).dispose?.()
      disposeRenderer()
    }
  // re-create when preset changes or quality toggles bloom parameters
  }, [presetIdx, quality.renderScale])

  // Apply preset color overrides if set (primary/accent/bg)
  useEffect(() => {
    const c = PRESETS[presetIdx].colors
    if (c?.primary) primaryRef.current.set(c.primary)
    if (c?.accent) accentRef.current.set(c.accent)
    if (c?.background) bgRef.current.set(c.background)
  }, [presetIdx])

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      <div style={{
        position: 'absolute', top: 12, right: 12, background: 'rgba(10,12,16,0.55)',
        border: '1px solid #263041', color: '#cfe7ff', fontSize: 12, padding: '6px 10px', borderRadius: 8
      }}>
        Particle Galaxy — Preset {presetIdx + 1}/5: {PRESETS[presetIdx].name} (press 1–5)
      </div>
    </div>
  )
}
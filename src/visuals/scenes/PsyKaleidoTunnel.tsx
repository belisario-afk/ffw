import React, { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { createRenderer, createComposer } from '../../three/Renderer'
import { reactivityBus, type ReactiveFrame } from '../../audio/ReactivityBus'
import { getPlaybackState } from '../../spotify/api'
import { cacheAlbumArt } from '../../utils/idb'

type Props = {
  auth: any
  quality: { renderScale: 1 | 1.25 | 1.5 | 1.75 | 2, msaa: 0 | 2 | 4 | 8, bloom: boolean, motionBlur: boolean }
  accessibility: { epilepsySafe: boolean, reducedMotion: boolean, highContrast: boolean }
}

type Cfg = {
  intensity: number
  speed: number
  slices: number
  chroma: number
  particleDensity: number
  exposure: number
}

const LS_KEY = 'ffw.kaleido.cfg.trippy.v1'

export default function PsyKaleidoTunnel({ quality, accessibility }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // Strong refs (no direct reads of uniform.value to avoid null access)
  const matRef = useRef<THREE.ShaderMaterial | null>(null)
  const particlesRef = useRef<THREE.Points | null>(null)
  const albumTexRef = useRef<THREE.Texture | null>(null)
  const scrollRef = useRef(0)

  const [panelOpen, setPanelOpen] = useState(false)
  const [cfg, setCfg] = useState<Cfg>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}')
      return { intensity: 0.85, speed: 0.65, slices: 12, chroma: 0.4, particleDensity: 1.0, exposure: 0.8, ...saved }
    } catch {
      return { intensity: 0.85, speed: 0.65, slices: 12, chroma: 0.4, particleDensity: 1.0, exposure: 0.8 }
    }
  })
  const cfgRef = useRef(cfg)
  useEffect(() => { cfgRef.current = cfg; try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)) } catch {} }, [cfg])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#04060a')

    const camera = new THREE.PerspectiveCamera(62, 1, 0.05, 500)
    camera.position.set(0, 0, 0)

    const { renderer, dispose: disposeRenderer } = createRenderer(canvas, quality.renderScale)
    const comp = createComposer(renderer, scene, camera, {
      bloom: quality.bloom,
      // keep bloom tasteful to avoid washout; shader has its own exposure
      bloomStrength: 0.7,
      bloomRadius: 0.38,
      bloomThreshold: 0.55,
      fxaa: true,
      vignette: true,
      vignetteStrength: 0.55,
      filmGrain: false,
      filmGrainStrength: 0.0,
      motionBlur: false
    })

    // Guard flags
    let running = true
    let disposed = false

    // Audio frame
    let latest: ReactiveFrame | null = null
    const offFrame = reactivityBus.on('frame', f => { latest = f })

    // Album palette (dominant + secondary) and texture (for real adaptation)
    const albumTintA = new THREE.Color('#77d0ff')
    const albumTintB = new THREE.Color('#b47bff')

    function quantizeTop2(imageData: Uint8ClampedArray): [THREE.Color, THREE.Color] {
      // Simple 5x5x5 RGB histogram to find two dominant bins (fast, good enough for 32x32)
      const bins = new Map<number, number>()
      const toBin = (r: number, g: number, b: number) => {
        const R = Math.min(4, Math.floor(r / 51))
        const G = Math.min(4, Math.floor(g / 51))
        const B = Math.min(4, Math.floor(b / 51))
        return (R << 6) | (G << 3) | B
      }
      for (let i = 0; i < imageData.length; i += 4) {
        const a = imageData[i + 3]
        if (a < 32) continue
        const bin = toBin(imageData[i], imageData[i + 1], imageData[i + 2])
        bins.set(bin, (bins.get(bin) || 0) + 1)
      }
      const sorted = [...bins.entries()].sort((a, b) => b[1] - a[1])
      const decode = (bin: number): THREE.Color => {
        const R = ((bin >> 6) & 0x7) * 51 + 25
        const G = ((bin >> 3) & 0x7) * 51 + 25
        const B = (bin & 0x7) * 51 + 25
        return new THREE.Color(R / 255, G / 255, B / 255)
      }
      const c1 = sorted[0] ? decode(sorted[0][0]) : new THREE.Color('#77d0ff')
      let c2 = sorted[1] ? decode(sorted[1][0]) : c1.clone().offsetHSL(0.12, 0.1, 0)
      // ensure adequate separation
      if (c1.distanceTo(c2) < 0.12) c2.offsetHSL(0.2, 0.2, 0)
      // normalize brightness a little toward mid
      const toMid = (c: THREE.Color) => c.lerp(new THREE.Color().setScalar(c.getLuminance() > 0.5 ? 0.8 : 0.6), 0.15)
      return [toMid(c1), toMid(c2)]
    }

    const loadAlbum = async () => {
      try {
        const s = await getPlaybackState().catch(() => null)
        const url = (s?.item?.album?.images?.[0]?.url as string) || ''
        if (!url) return
        const blobUrl = await cacheAlbumArt(url).catch(() => url)
        const img = await new Promise<HTMLImageElement>((res, rej) => {
          const im = new Image()
          im.onload = () => res(im)
          im.onerror = rej
          im.src = blobUrl
        })
        // average + dominant colors
        const c = document.createElement('canvas'); c.width = 48; c.height = 48
        const g = c.getContext('2d'); if (!g) return
        g.drawImage(img, 0, 0, 48, 48)
        const data = g.getImageData(0, 0, 48, 48).data
        const [cA, cB] = quantizeTop2(data)
        albumTintA.copy(cA)
        albumTintB.copy(cB)

        // texture for sampling inside shader
        const loader = new THREE.TextureLoader()
        const tex = await new Promise<THREE.Texture>((resolve, reject) => {
          loader.load(blobUrl, t => resolve(t), undefined, reject)
        })
        tex.colorSpace = THREE.SRGBColorSpace
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping
        tex.minFilter = THREE.LinearMipmapLinearFilter
        tex.magFilter = THREE.LinearFilter
        tex.generateMipmaps = true
        albumTexRef.current?.dispose()
        albumTexRef.current = tex
        setTex('tAlbum', tex)
        setF('uHasAlbum', 1.0)
      } catch {
        // ignore
      }
    }
    loadAlbum()
    const albumIv = window.setInterval(loadAlbum, 9000)

    // Geometry: inside a BackSide cylinder
    const radius = 14
    const tunnelLen = 200
    const tunnel = new THREE.CylinderGeometry(radius, radius, tunnelLen, 320, 1, true)
    tunnel.rotateZ(Math.PI * 0.5)

    // Build material with uniforms (include album texture + palette)
    const uniforms = {
      uTime: { value: 0.0 },
      uAudio: { value: new THREE.Vector3(0.1, 0.1, 0.1) },
      uLoud: { value: 0.15 },
      uBeat: { value: 0.0 },
      uSlices: { value: Math.max(1, Math.round(cfgRef.current.slices)) },
      uIntensity: { value: cfgRef.current.intensity },
      uChroma: { value: cfgRef.current.chroma },
      uScroll: { value: 0.0 },
      uSafe: { value: (accessibility.epilepsySafe || accessibility.reducedMotion) ? 1.0 : 0.0 },
      uContrastBoost: { value: accessibility.highContrast ? 1.0 : 0.0 },
      uExposure: { value: cfgRef.current.exposure },
      uSpin: { value: 0.0 },
      uZoom: { value: 0.0 },

      // album-driven
      uAlbumA: { value: new THREE.Color().copy(albumTintA) },
      uAlbumB: { value: new THREE.Color().copy(albumTintB) },
      uAlbumMix: { value: 0.35 },
      uHasAlbum: { value: 0.0 },
      tAlbum: { value: null as THREE.Texture | null }
    }
    const mat = new THREE.ShaderMaterial({
      uniforms,
      side: THREE.BackSide,
      transparent: false,
      depthWrite: true,
      vertexShader: `
        varying vec2 vUv;
        void main(){
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
        }
      `,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform float uTime;
        uniform vec3 uAudio;
        uniform float uLoud;
        uniform float uBeat;
        uniform float uIntensity;
        uniform float uChroma;
        uniform float uScroll;
        uniform float uSafe;
        uniform float uContrastBoost;
        uniform float uSlices;
        uniform float uExposure;
        uniform float uSpin;
        uniform float uZoom;

        uniform vec3 uAlbumA;
        uniform vec3 uAlbumB;
        uniform float uAlbumMix;
        uniform float uHasAlbum;
        uniform sampler2D tAlbum;

        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float noise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          float a = hash(i), b = hash(i+vec2(1.,0.)), c = hash(i+vec2(0.,1.)), d = hash(i+vec2(1.,1.));
          vec2 u = f*f*(3.-2.*f);
          return mix(a,b,u.x) + (c-a)*u.y*(1.-u.x) + (d-b)*u.x*u.y;
        }
        float fbm(vec2 p){
          float v=0.0, a=0.5;
          for(int i=0;i<5;i++){ v += a * noise(p); p *= 2.02; a *= 0.5; }
          return v;
        }

        // kaleidoscope fold
        float foldK(float x, float slices){
          float seg = 1.0 / max(1.0, slices);
          float xf = fract(x + 1.0);
          float m = mod(xf, seg) / seg;
          m = abs(m - 0.5) * 2.0;
          return m * seg + floor(xf/seg)*seg;
        }

        vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d){
          return a + b*cos(6.28318*(c*t + d));
        }

        // rotate around 0.5
        vec2 rotate2D(vec2 uv, float ang){
          uv -= 0.5;
          float s = sin(ang), c = cos(ang);
          uv = mat2(c, -s, s, c) * uv;
          return uv + 0.5;
        }

        // barrel distortion
        vec2 barrel(vec2 uv, float k){
          vec2 cc = uv - 0.5;
          float r2 = dot(cc, cc);
          vec2 off = cc * (1.0 + k * r2);
          return off + 0.5;
        }

        vec3 psychedelic(vec2 uvIn, float time, vec3 audio, float loud, float intensity, float slices, float chroma, float safe, float cboost, float exposure, vec3 albumA, vec3 albumB, float albumMix, float hasAlbum) {
          // spin + zoom breathing
          vec2 uv = rotate2D(uvIn, time * (0.12 + 0.35*intensity) + uSpin);
          uv = mix(uv, (uv - 0.5) * (1.0 - 0.2*uZoom) + 0.5, 0.8);

          // kaleido wrap
          uv.y = fract(uv.y - time*0.04 - uScroll);
          uv.x = foldK(uv.x, slices);

          // warp fields
          float warp = fbm(uv * (2.3 + 3.2*intensity) + vec2(time*0.14, -time*0.1));
          float rings = sin((uv.y*32.0 + warp*7.0) - time*7.0 * (0.6 + 0.8*loud));
          float spokes = sin((uv.x*56.0 + warp*8.0) + time*4.5 * (0.4 + 0.9*audio.z));
          float field = smoothstep(-1.0, 1.0, rings*spokes);

          // album-driven palette endpoints drive cosine palette
          vec3 a = mix(vec3(0.36,0.32,0.46), albumA, 0.7);
          vec3 b = mix(vec3(0.45,0.55,0.45), normalize(albumB + 0.001), 0.6);
          vec3 c = mix(vec3(0.8,0.5,0.3), vec3(0.9,0.8,0.5), 0.5);
          vec3 d = mix(vec3(0.2,0.0,0.6), vec3(0.0,0.2,0.4), 0.5);

          float hueShift = 0.15*intensity + 0.12*audio.y + 0.05*loud + 0.1*sin(time*0.22);
          vec3 colA = palette(fract(field*0.25 + hueShift), a, b, c, d);
          vec3 colB = palette(fract(field*0.5 + hueShift*1.4), b, a, c, d);
          vec3 col = mix(colA, colB, 0.45 + 0.25*audio.y);

          // chroma split via channel-specific fbm
          float off = 0.0025 * chroma * (0.4 + 0.6*intensity);
          float fR = smoothstep(0.25, 0.75, fbm((uv + vec2(off,0.0))*4.0 + time*0.06));
          float fG = smoothstep(0.25, 0.75, fbm((uv + vec2(0.0,off))*4.0 - time*0.04));
          float fB = smoothstep(0.25, 0.75, fbm((uv + vec2(-off,off))*4.0 + time*0.02));
          vec3 chrom = vec3(fR, fG, fB);
          col = mix(col, chrom, 0.22 * chroma);

          // sample album art into kaleido (heavily warped coords)
          if (hasAlbum > 0.5) {
            vec2 tuv = uv;
            // extra swirl and barrel distortion for trip effect
            float swirl = (uv.x - 0.5)*(uv.y - 0.5);
            tuv = rotate2D(tuv, swirl * (2.0 + 4.0*intensity));
            tuv = barrel(tuv, 0.35 * (0.3 + 0.7*intensity));
            vec3 texCol = texture2D(tAlbum, tuv * vec2(2.0, 4.0)).rgb;
            // mix album colors dynamically to rhythm (more with mids/highs)
            float mixAmt = clamp(albumMix * (0.5 + 0.9*audio.y + 0.5*audio.z), 0.0, 0.85);
            col = mix(col, texCol, mixAmt);
          }

          // flash clamp (safety)
          float flash = 0.34*loud + 0.42*audio.z + 0.24*audio.y;
          float maxFlash = mix(1.0, 0.4, safe);
          col *= (0.8 + 0.6*min(flash, maxFlash));

          // exposure + reinhard + slight gamma
          col *= mix(0.6, 1.45, clamp(exposure, 0.0, 1.2));
          col = col / (1.0 + col);
          col = pow(col, vec3(0.95 + 0.05*cboost));
          return clamp(col, 0.0, 1.0);
        }

        void main(){
          // add subtle radial motion to uv for breathing
          vec2 uv = vUv;
          float r = distance(uv, vec2(0.5));
          uv += (uv - 0.5) * (0.04 * sin(uTime*0.7) * uIntensity);

          vec3 col = psychedelic(uv, uTime, uAudio, uLoud, uIntensity, max(1.0,uSlices), uChroma, uSafe, uContrastBoost, uExposure, uAlbumA, uAlbumB, uAlbumMix, uHasAlbum);
          gl_FragColor = vec4(col, 1.0);
        }
      `
    })
    matRef.current = mat

    const tunnelMesh = new THREE.Mesh(tunnel, mat)
    scene.add(tunnelMesh)

    // Particles (streaks rushing by)
    const makeParticles = (density: number) => {
      const count = Math.floor(2200 * THREE.MathUtils.clamp(density, 0.1, 2.5))
      const geo = new THREE.BufferGeometry()
      const positions = new Float32Array(count * 3)
      const speeds = new Float32Array(count)
      for (let i = 0; i < count; i++) {
        const theta = Math.random() * Math.PI * 2
        const r = radius * (0.92 + Math.random() * 0.22)
        const x = Math.cos(theta) * r
        const y = Math.sin(theta) * r
        const z = -Math.random() * tunnelLen
        positions.set([x, y, z], i * 3)
        speeds[i] = 3.5 + Math.random() * 14
      }
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geo.setAttribute('speed', new THREE.BufferAttribute(speeds, 1))
      const pm = new THREE.PointsMaterial({ color: 0xe5f0ff, size: 0.04, sizeAttenuation: true, transparent: true, opacity: 0.65, depthWrite: false, blending: THREE.AdditiveBlending })
      const pts = new THREE.Points(geo, pm)
      pts.name = 'kaleido_particles'
      return pts
    }
    particlesRef.current = makeParticles(cfgRef.current.particleDensity)
    scene.add(particlesRef.current)

    // Safe uniform setters (no direct reads)
    const setF = (name: keyof typeof uniforms, v: number) => {
      const m = matRef.current as THREE.ShaderMaterial | null
      if (!m || !m.uniforms) return
      const u = (m.uniforms as any)[name]
      if (!u || u.value === undefined || u.value === null) return
      u.value = v
    }
    const setV3 = (name: keyof typeof uniforms, x: number, y: number, z: number) => {
      const m = matRef.current as THREE.ShaderMaterial | null
      if (!m || !m.uniforms) return
      const u = (m.uniforms as any)[name]
      if (!u) return
      if (u.value && (u.value as any).isVector3) (u.value as THREE.Vector3).set(x, y, z)
      else u.value = new THREE.Vector3(x, y, z)
    }
    const setColor = (name: keyof typeof uniforms, col: THREE.Color) => {
      const m = matRef.current as THREE.ShaderMaterial | null
      if (!m || !m.uniforms) return
      const u = (m.uniforms as any)[name]
      if (!u) return
      if (u.value && (u.value as any).isColor) (u.value as THREE.Color).copy(col)
      else u.value = col.clone()
    }
    const setTex = (name: keyof typeof uniforms, tex: THREE.Texture | null) => {
      const m = matRef.current as THREE.ShaderMaterial | null
      if (!m || !m.uniforms) return
      const u = (m.uniforms as any)[name]
      if (!u) return
      u.value = tex
    }

    // Resize
    const onResize = () => {
      if (disposed) return
      const view = renderer.getSize(new THREE.Vector2())
      camera.aspect = view.x / Math.max(1, view.y)
      camera.updateProjectionMatrix()
      comp.onResize()
    }
    window.addEventListener('resize', onResize)
    onResize()

    // Animate
    const clock = new THREE.Clock()
    let raf = 0
    // smoothed controls (avoid harsh jumps on sliders)
    let sIntensity = cfgRef.current.intensity
    let sSpeed = cfgRef.current.speed
    let sExposure = cfgRef.current.exposure
    let sSlices = cfgRef.current.slices
    let sChroma = cfgRef.current.chroma

    const animate = () => {
      raf = requestAnimationFrame(animate)
      if (!running || disposed) return

      const dt = Math.min(0.05, clock.getDelta())
      const t = clock.elapsedTime

      // Audio snapshot with fallbacks
      const low = latest?.bands.low ?? 0.06
      const mid = latest?.bands.mid ?? 0.06
      const high = latest?.bands.high ?? 0.06
      const loud = latest?.loudness ?? 0.12
      const beat = latest?.beat ? 1.0 : 0.0

      // Safety + cfg clamps (targets)
      const safe = (accessibility.epilepsySafe || accessibility.reducedMotion) ? 1.0 : 0.0
      const targetIntensity = THREE.MathUtils.clamp(cfgRef.current.intensity ?? 0.85, 0, 1.5)
      const targetSpeed = THREE.MathUtils.clamp(cfgRef.current.speed ?? 0.65, 0, 2.0)
      const targetExposure = THREE.MathUtils.clamp(cfgRef.current.exposure ?? 0.8, 0, 1.4)
      const targetSlices = Math.max(1, Math.round(cfgRef.current.slices ?? 12))
      const targetChroma = THREE.MathUtils.clamp(cfgRef.current.chroma ?? 0.4, 0, 1)

      // smooth toward targets
      const k = 1 - Math.pow(0.0001, dt) // roughly 10hz smoothing
      sIntensity += (targetIntensity - sIntensity) * k
      sSpeed += (targetSpeed - sSpeed) * k
      sExposure += (targetExposure - sExposure) * k
      sSlices += (targetSlices - sSlices) * k
      sChroma += (targetChroma - sChroma) * k

      // safety caps when in safe mode
      const kIntensity = THREE.MathUtils.lerp(sIntensity, Math.min(sIntensity, 0.55), safe)
      const kSpeed = THREE.MathUtils.lerp(sSpeed, Math.min(sSpeed, 0.35), safe)

      // spin/zoom driven by audio and speed
      const spin = 0.25 * kSpeed + 0.12 * high + 0.06 * Math.sin(t * 0.5)
      const zoom = 0.25 * kIntensity + 0.18 * mid + 0.12 * (beat > 0.5 ? 1.0 : 0.0)

      // push uniforms safely
      setF('uTime', t)
      setV3('uAudio', low, mid, high)
      setF('uLoud', loud)
      setF('uBeat', beat)
      setF('uSafe', safe)
      setF('uContrastBoost', accessibility.highContrast ? 1.0 : 0.0)
      setF('uSlices', Math.max(1, Math.round(sSlices)))
      setF('uIntensity', kIntensity)
      setF('uChroma', THREE.MathUtils.clamp(sChroma, 0, 1))
      setF('uExposure', THREE.MathUtils.clamp(sExposure, 0, 1.4))
      setF('uSpin', spin)
      setF('uZoom', zoom)
      // scroll
      scrollRef.current += dt * (0.22 + 0.95 * kSpeed + 0.45 * loud)
      setF('uScroll', scrollRef.current)
      // push album palette each frame (in case it changed)
      setColor('uAlbumA', albumTintA)
      setColor('uAlbumB', albumTintB)

      // Particles
      const pts = particlesRef.current
      if (pts) {
        const pos = pts.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
        const spd = pts.geometry.getAttribute('speed') as THREE.BufferAttribute | undefined
        if (pos && spd) {
          const base = (0.7 + 1.6 * kSpeed) + (loud * 1.3)
          for (let i = 0; i < spd.count; i++) {
            const speed = spd.getX(i) * (0.52 + 0.65 * kSpeed) * (1.0 + 0.42 * high)
            const z = pos.getZ(i) + dt * (base + speed)
            if (z > 2.0) {
              const theta = Math.random() * Math.PI * 2
              const r = radius * (0.9 + Math.random() * 0.25)
              const x = Math.cos(theta) * r
              const y = Math.sin(theta) * r
              pos.setXYZ(i, x, y, -tunnelLen)
            } else {
              pos.setZ(i, z)
            }
          }
          pos.needsUpdate = true
        }
      }

      // Rebuild particles if density changed a lot
      const desired = Math.floor(2200 * THREE.MathUtils.clamp(cfgRef.current.particleDensity ?? 1.0, 0.1, 2.5))
      const current = (particlesRef.current?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined)?.count ?? desired
      if (Math.abs(desired - current) > 600) {
        if (particlesRef.current) {
          scene.remove(particlesRef.current)
          particlesRef.current.geometry.dispose()
          ;(particlesRef.current.material as THREE.Material).dispose()
        }
        particlesRef.current = makeParticles(cfgRef.current.particleDensity)
        scene.add(particlesRef.current)
      }

      comp.composer.render()
    }

    animate()

    // Cleanup
    return () => {
      running = false
      disposed = true
      window.removeEventListener('resize', onResize)
      cancelAnimationFrame(raf)
      window.clearInterval(albumIv)
      offFrame?.()

      if (particlesRef.current) {
        scene.remove(particlesRef.current)
        particlesRef.current.geometry?.dispose()
        ;(particlesRef.current.material as THREE.Material)?.dispose()
        particlesRef.current = null
      }
      albumTexRef.current?.dispose()
      albumTexRef.current = null

      matRef.current = null
      scene.traverse(obj => {
        const any = obj as any
        if (any.geometry?.dispose) any.geometry.dispose()
        if (any.material) {
          if (Array.isArray(any.material)) any.material.forEach((m: any) => m?.dispose?.())
          else any.material?.dispose?.()
        }
      })
      comp.dispose()
      disposeRenderer()
      renderer.dispose()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quality.renderScale, quality.bloom, accessibility.epilepsySafe, accessibility.reducedMotion, accessibility.highContrast])

  return (
    <div data-visual="psy-kaleido" style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} aria-label="Psychedelic Kaleido Tunnel" />
      <Panel open={panelOpen} cfg={cfg} onToggle={() => setPanelOpen(o => !o)} onChange={setCfg} />
    </div>
  )
}

function Panel(props: { open: boolean, cfg: Cfg, onToggle: () => void, onChange: (u: (p: Cfg) => Cfg | Cfg) => void }) {
  const { open, cfg, onToggle, onChange } = props
  const Row = (p: { label: string, children: React.ReactNode }) => (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, margin:'6px 0' }}>
      <label style={{ fontSize:12, opacity:0.9 }}>{p.label}</label>
      <div>{p.children}</div>
    </div>
  )
  const Card = (p: { title: string, children: React.ReactNode }) => (
    <div style={{ border:'1px solid #2b2f3a', borderRadius:8, padding:10, marginTop:8 }}>
      <div style={{ fontSize:12, opacity:0.8, marginBottom:8 }}>{p.title}</div>
      {p.children}
    </div>
  )
  const btnStyle: React.CSSProperties = {
    padding:'6px 10px', fontSize:12, borderRadius:6, border:'1px solid #2b2f3a',
    background:'rgba(16,18,22,0.8)', color:'#cfe7ff', cursor:'pointer'
  }
  const onRange = (cb: (v: number) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.currentTarget.value)
    cb(v)
  }

  return (
    <div style={{ position:'absolute', top:12, right:12, zIndex:10, userSelect:'none', pointerEvents:'auto' }}>
      <button onClick={(e) => { e.stopPropagation(); onToggle() }} style={btnStyle}>
        {open ? 'Close Psy Settings' : 'Psy Settings'}
      </button>
      {open && (
        <div style={{ width: 300, marginTop:8, padding:12, border:'1px solid #2b2f3a', borderRadius:8,
          background:'rgba(10,12,16,0.88)', color:'#e6f0ff', fontFamily:'system-ui, sans-serif', fontSize:12, lineHeight:1.4 }}>
          <Card title="Intensity & Speed">
            <Row label={`Intensity: ${cfg.intensity.toFixed(2)}`}>
              <input type="range" min={0} max={1.5} step={0.01} value={cfg.intensity}
                     onChange={onRange(v => onChange(prev => ({ ...prev, intensity: Math.max(0, Math.min(1.5, v || 0)) })))} />
            </Row>
            <Row label={`Speed: ${cfg.speed.toFixed(2)}`}>
              <input type="range" min={0} max={2} step={0.01} value={cfg.speed}
                     onChange={onRange(v => onChange(prev => ({ ...prev, speed: Math.max(0, Math.min(2, v || 0)) })))} />
            </Row>
            <Row label={`Exposure: ${cfg.exposure.toFixed(2)}`}>
              <input type="range" min={0} max={1.4} step={0.01} value={cfg.exposure}
                     onChange={onRange(v => onChange(prev => ({ ...prev, exposure: Math.max(0, Math.min(1.4, v || 0.8)) })))} />
            </Row>
          </Card>
          <Card title="Kaleidoscope">
            <Row label={`Slices: ${Math.round(cfg.slices)}`}>
              <input type="range" min={1} max={24} step={1} value={cfg.slices}
                     onChange={onRange(v => onChange(prev => ({ ...prev, slices: Math.max(1, Math.round(v || 1)) })))} />
            </Row>
            <Row label={`Chroma: ${cfg.chroma.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.chroma}
                     onChange={onRange(v => onChange(prev => ({ ...prev, chroma: Math.max(0, Math.min(1, v || 0)) })))} />
            </Row>
          </Card>
          <Card title="Particles">
            <Row label={`Density: ${cfg.particleDensity.toFixed(2)}`}>
              <input type="range" min={0.2} max={2.5} step={0.01} value={cfg.particleDensity}
                     onChange={onRange(v => onChange(prev => ({ ...prev, particleDensity: Math.max(0.2, Math.min(2.5, v || 1.0)) })))} />
            </Row>
          </Card>
          <div style={{ display:'flex', gap:8, marginTop:10, justifyContent:'flex-end' }}>
            <button onClick={() => onChange({ intensity: 0.85, speed: 0.65, slices: 12, chroma: 0.4, particleDensity: 1.0, exposure: 0.8 })} style={btnStyle}>Reset</button>
            <button onClick={onToggle} style={btnStyle}>Close</button>
          </div>
        </div>
      )}
    </div>
  )
}
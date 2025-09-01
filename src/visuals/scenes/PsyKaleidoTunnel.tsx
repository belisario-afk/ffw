import React, { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { createRenderer, createComposer } from '../../three/Renderer'
import { reactivityBus, type ReactiveFrame } from '../../audio/ReactivityBus'
import { getPlaybackState } from '../../spotify/api'

type Props = {
  auth: any
  quality: { renderScale: 1 | 1.25 | 1.5 | 1.75 | 2; msaa: 0 | 2 | 4 | 8; bloom: boolean; motionBlur: boolean }
  accessibility: { epilepsySafe: boolean; reducedMotion: boolean; highContrast: boolean }
}

type Cfg = {
  intensity: number       // overall effect drive
  speed: number           // scroll speed
  slices: number          // kaleidoscope wedges
  chroma: number          // color fringing in shader
  particleDensity: number // particle count scaler
  exposure: number        // 0..1.4
  albumMix: number        // 0..1 how much album texture influences
  swirl: number           // 0..1 how much swirl/rotation
  warp: number            // 0..1 domain warping amount
}

const LS_KEY = 'ffw.kaleido.cfg.trippy.v2'

export default function PsyKaleidoTunnel({ quality, accessibility }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // Strong refs (never read uniform.value directly)
  const matRef = useRef<THREE.ShaderMaterial | null>(null)
  const particlesRef = useRef<THREE.Points | null>(null)
  const albumTexRef = useRef<THREE.Texture | null>(null)
  const scrollRef = useRef(0)

  const [panelOpen, setPanelOpen] = useState(false)
  const [cfg, setCfg] = useState<Cfg>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}')
      return {
        intensity: 0.9,
        speed: 0.7,
        slices: 12,
        chroma: 0.45,
        particleDensity: 1.1,
        exposure: 0.85,
        albumMix: 0.6,
        swirl: 0.7,
        warp: 0.7,
        ...saved
      }
    } catch {
      return { intensity: 0.9, speed: 0.7, slices: 12, chroma: 0.45, particleDensity: 1.1, exposure: 0.85, albumMix: 0.6, swirl: 0.7, warp: 0.7 }
    }
  })
  const cfgRef = useRef(cfg)
  useEffect(() => {
    cfgRef.current = cfg
    try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)) } catch {}
  }, [cfg])

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
      bloomStrength: 0.75,
      bloomRadius: 0.42,
      bloomThreshold: 0.55,
      fxaa: true,
      vignette: true,
      vignetteStrength: 0.6,
      filmGrain: false,
      filmGrainStrength: 0.0,
      motionBlur: false
    })

    // Keep loop safe
    let running = true
    let disposed = false

    // Audio frame
    let latest: ReactiveFrame | null = null
    const offFrame = reactivityBus.on('frame', f => { latest = f })

    // Track change -> reload album art
    const lastTrackIdRef = useRef<string | null>(null)

    // Dominant palette from album
    const albumA = new THREE.Color('#77d0ff')
    const albumB = new THREE.Color('#b47bff')

    function quantizeTop2(imageData: Uint8ClampedArray): [THREE.Color, THREE.Color] {
      // 6x6x6 bins
      const bins = new Map<number, number>()
      const toBin = (r: number, g: number, b: number) => {
        const R = Math.min(5, Math.floor(r / 43))
        const G = Math.min(5, Math.floor(g / 43))
        const B = Math.min(5, Math.floor(b / 43))
        return (R << 10) | (G << 5) | B
      }
      for (let i = 0; i < imageData.length; i += 4) {
        const a = imageData[i + 3]
        if (a < 24) continue
        bins.set(toBin(imageData[i], imageData[i + 1], imageData[i + 2]), (bins.get(toBin(imageData[i], imageData[i + 1], imageData[i + 2])) || 0) + 1)
      }
      const sorted = [...bins.entries()].sort((a, b) => b[1] - a[1])
      const decode = (bin: number) => {
        const R = ((bin >> 10) & 0x1f) * 43 + 21
        const G = ((bin >> 5) & 0x1f) * 43 + 21
        const B = (bin & 0x1f) * 43 + 21
        return new THREE.Color(R / 255, G / 255, B / 255)
      }
      const c1 = sorted[0] ? decode(sorted[0][0]) : new THREE.Color('#77d0ff')
      let c2 = sorted[1] ? decode(sorted[1][0]) : c1.clone().offsetHSL(0.18, 0.15, 0)
      if (c1.distanceTo(c2) < 0.15) c2.offsetHSL(0.25, 0.25, 0)
      return [c1, c2]
    }

    async function loadAlbumFromPlayback() {
      try {
        const s = await getPlaybackState().catch(() => null)
        const trackId = (s?.item?.id as string) || null
        if (!trackId || trackId === lastTrackIdRef.current) return
        lastTrackIdRef.current = trackId
        const url = (s?.item?.album?.images?.[0]?.url as string) || ''
        if (!url) return

        // Try crossOrigin first (Spotify CDN usually allows CORS)
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const im = new Image()
          im.crossOrigin = 'anonymous'
          im.onload = () => resolve(im)
          im.onerror = () => reject(new Error('img load fail'))
          im.src = url
        }).catch(async () => {
          // Fallback: fetch blob -> objectURL
          const blob = await fetch(url).then(r => r.blob())
          const objectUrl = URL.createObjectURL(blob)
          return await new Promise<HTMLImageElement>((resolve, reject) => {
            const im = new Image()
            im.onload = () => resolve(im)
            im.onerror = reject
            im.src = objectUrl
          })
        })

        // Palette
        const c = document.createElement('canvas')
        c.width = 64; c.height = 64
        const g = c.getContext('2d'); if (!g) return
        g.drawImage(img, 0, 0, c.width, c.height)
        const data = g.getImageData(0, 0, c.width, c.height).data
        const [cA, cB] = quantizeTop2(data)
        albumA.copy(cA)
        albumB.copy(cB)

        // Texture
        const loader = new THREE.TextureLoader()
        loader.setCrossOrigin('anonymous' as any)
        const tex = await new Promise<THREE.Texture>((resolve, reject) => {
          loader.load(url, t => resolve(t), undefined, reject)
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
        // push palette immediately
        setColor('uAlbumA', albumA)
        setColor('uAlbumB', albumB)
      } catch {
        // ignore
      }
    }

    // Kick and poll occasionally in case playback changes
    loadAlbumFromPlayback()
    const albumIv = window.setInterval(loadAlbumFromPlayback, 6000)

    // Geometry
    const radius = 14
    const tunnelLen = 220
    const tunnel = new THREE.CylinderGeometry(radius, radius, tunnelLen, 360, 1, true)
    tunnel.rotateZ(Math.PI * 0.5)

    // Uniforms
    const uniforms = {
      uTime: { value: 0.0 },
      uAudio: { value: new THREE.Vector3(0.1, 0.1, 0.1) },
      uLoud: { value: 0.15 },
      uBeat: { value: 0.0 },

      uSlices: { value: Math.max(1, Math.round(cfgRef.current.slices)) },
      uIntensity: { value: cfgRef.current.intensity },
      uChroma: { value: cfgRef.current.chroma },
      uExposure: { value: cfgRef.current.exposure },
      uScroll: { value: 0.0 },
      uSpinAmt: { value: 0.0 },
      uZoomAmt: { value: 0.0 },
      uSwirl: { value: cfgRef.current.swirl },
      uWarp: { value: cfgRef.current.warp },

      uSafe: { value: (accessibility.epilepsySafe || accessibility.reducedMotion) ? 1.0 : 0.0 },
      uContrastBoost: { value: accessibility.highContrast ? 1.0 : 0.0 },

      // Album adaptation
      uAlbumA: { value: albumA.clone() },
      uAlbumB: { value: albumB.clone() },
      uAlbumMix: { value: cfgRef.current.albumMix },
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

        uniform float uSlices;
        uniform float uIntensity;
        uniform float uChroma;
        uniform float uExposure;
        uniform float uScroll;
        uniform float uSpinAmt;
        uniform float uZoomAmt;
        uniform float uSwirl; // 0..1
        uniform float uWarp;  // 0..1

        uniform float uSafe;
        uniform float uContrastBoost;

        uniform vec3 uAlbumA;
        uniform vec3 uAlbumB;
        uniform float uAlbumMix;
        uniform float uHasAlbum;
        uniform sampler2D tAlbum;

        // hash/noise/fbm
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float noise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          float a = hash(i), b = hash(i+vec2(1.,0.)), c = hash(i+vec2(0.,1.)), d = hash(i+vec2(1.,1.));
          vec2 u = f*f*(3.-2.*f);
          return mix(a,b,u.x) + (c-a)*u.y*(1.-u.x) + (d-b)*u.x*u.y;
        }
        float fbm(vec2 p){
          float v=0.0, a=0.5;
          for(int i=0;i<6;i++){ v += a * noise(p); p *= 2.02; a *= 0.5; }
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
          return cc*(1.0 + k*r2) + 0.5;
        }

        vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d){
          return a + b*cos(6.28318*(c*t + d));
        }

        // chromatic aberration sampling helper (in-UV space)
        vec3 aberrate(vec2 uv, float amt, vec3 base){
          float off = amt * 0.0035;
          float r = smoothstep(0.25, 0.75, fbm((uv + vec2(off,0.0))*3.8 + uTime*0.05));
          float g = smoothstep(0.25, 0.75, fbm((uv + vec2(0.0,off))*3.8 - uTime*0.04));
          float b = smoothstep(0.25, 0.75, fbm((uv + vec2(-off,off))*3.8 + uTime*0.03));
          vec3 chrom = vec3(r,g,b);
          return mix(base, chrom, amt);
        }

        void main(){
          float time = uTime;

          // spin + zoom modulation
          vec2 uv = vUv;
          float spin = (0.1 + 0.5*uSwirl) * time + uSpinAmt;
          uv = rotate2D(uv, spin);
          float zoom = clamp(0.12 + 0.3*uZoomAmt, 0.0, 0.5);
          uv = mix(uv, (uv - 0.5) * (1.0 - zoom) + 0.5, 0.75);

          // kaleido along x and wrap y (scroll down tunnel)
          uv.y = fract(uv.y - time*0.045 - uScroll);
          uv.x = foldK(uv.x, uSlices);

          // domain warping
          float w = uWarp;
          vec2 warpVec = vec2(fbm(uv*2.5 + time*0.1), fbm(uv*2.7 - time*0.12));
          uv += (warpVec - 0.5) * (0.25 * w);

          // ring/spoke pattern
          float rings = sin((uv.y*36.0 + fbm(uv*3.0)*8.0) - time*7.5 * (0.6 + 0.8*uLoud));
          float spokes = sin((uv.x*64.0 + fbm(uv*3.4)*9.0) + time*5.0 * (0.4 + 0.9*uAudio.z));
          float field = smoothstep(-1.0, 1.0, rings * spokes);

          // album-driven palette endpoints
          vec3 a = mix(vec3(0.32,0.30,0.46), uAlbumA, 0.75);
          vec3 b = mix(vec3(0.48,0.54,0.46), normalize(uAlbumB + 0.001), 0.65);
          vec3 c = mix(vec3(0.85,0.6,0.45), vec3(0.7,0.9,0.6), 0.4);
          vec3 d = mix(vec3(0.2,0.0,0.6), vec3(0.0,0.2,0.4), 0.45);

          float hueShift = 0.16*uIntensity + 0.12*uAudio.y + 0.05*uLoud + 0.08*sin(time*0.24);
          vec3 colA = palette(fract(field*0.25 + hueShift), a, b, c, d);
          vec3 colB = palette(fract(field*0.5 + hueShift*1.45), b, a, c, d);
          vec3 col = mix(colA, colB, 0.45 + 0.25*uAudio.y);

          // album texture infusion (kaleido-mapped)
          if (uHasAlbum > 0.5) {
            vec2 tuv = uv;
            // more swirl + barrel for trippy feel
            float swirl = (uv.x - 0.5)*(uv.y - 0.5);
            tuv = rotate2D(tuv, swirl * (2.0 + 4.0*uIntensity));
            tuv = barrel(tuv, 0.35 * (0.25 + 0.75*uIntensity));
            vec3 texCol = texture2D(tAlbum, tuv * vec2(2.0, 4.0)).rgb;
            float mixAmt = clamp(uAlbumMix * (0.45 + 0.9*uAudio.y + 0.55*uAudio.z), 0.0, 0.9);
            col = mix(col, texCol, mixAmt);
          }

          // chroma split
          col = aberrate(uv, uChroma * (0.4 + 0.6*uIntensity), col);

          // safety flash clamp
          float flash = 0.34*uLoud + 0.42*uAudio.z + 0.24*uAudio.y;
          float maxFlash = mix(1.0, 0.4, uSafe);
          col *= (0.8 + 0.6*min(flash, maxFlash));

          // exposure + reinhard + gamma tuned by contrastBoost
          col *= mix(0.6, 1.5, clamp(uExposure, 0.0, 1.4));
          col = col / (1.0 + col);
          col = pow(col, vec3(0.95 + 0.05*uContrastBoost));

          gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
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
      const pm = new THREE.PointsMaterial({
        color: 0xe5f0ff, size: 0.04, sizeAttenuation: true, transparent: true,
        opacity: 0.65, depthWrite: false, blending: THREE.AdditiveBlending
      })
      const pts = new THREE.Points(geo, pm)
      pts.name = 'kaleido_particles'
      return pts
    }
    particlesRef.current = makeParticles(cfgRef.current.particleDensity)
    scene.add(particlesRef.current)

    // Safe uniform setters
    const setF = (name: keyof typeof uniforms, v: number) => {
      const m = matRef.current; if (!m || !m.uniforms) return
      const u = (m.uniforms as any)[name]; if (!u || u.value === undefined || u.value === null) return
      u.value = v
    }
    const setV3 = (name: keyof typeof uniforms, x: number, y: number, z: number) => {
      const m = matRef.current; if (!m || !m.uniforms) return
      const u = (m.uniforms as any)[name]; if (!u) return
      if (u.value && (u.value as any).isVector3) (u.value as THREE.Vector3).set(x, y, z)
      else u.value = new THREE.Vector3(x, y, z)
    }
    const setColor = (name: keyof typeof uniforms, col: THREE.Color) => {
      const m = matRef.current; if (!m || !m.uniforms) return
      const u = (m.uniforms as any)[name]; if (!u) return
      if (u.value && (u.value as any).isColor) (u.value as THREE.Color).copy(col)
      else u.value = col.clone()
    }
    const setTex = (name: keyof typeof uniforms, tex: THREE.Texture | null) => {
      const m = matRef.current; if (!m || !m.uniforms) return
      const u = (m.uniforms as any)[name]; if (!u) return
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

    // smoothed controls to avoid harsh jumps (and black screens)
    let sIntensity = cfgRef.current.intensity
    let sSpeed = cfgRef.current.speed
    let sExposure = cfgRef.current.exposure
    let sSlices = cfgRef.current.slices
    let sChroma = cfgRef.current.chroma
    let sAlbumMix = cfgRef.current.albumMix
    let sSwirl = cfgRef.current.swirl
    let sWarp = cfgRef.current.warp

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
      const targetIntensity = THREE.MathUtils.clamp(cfgRef.current.intensity, 0, 1.6)
      const targetSpeed = THREE.MathUtils.clamp(cfgRef.current.speed, 0, 2.0)
      const targetExposure = THREE.MathUtils.clamp(cfgRef.current.exposure, 0, 1.4)
      const targetSlices = Math.max(1, Math.round(cfgRef.current.slices))
      const targetChroma = THREE.MathUtils.clamp(cfgRef.current.chroma, 0, 1)
      const targetAlbumMix = THREE.MathUtils.clamp(cfgRef.current.albumMix, 0, 1)
      const targetSwirl = THREE.MathUtils.clamp(cfgRef.current.swirl, 0, 1)
      const targetWarp = THREE.MathUtils.clamp(cfgRef.current.warp, 0, 1)

      // smooth toward targets (10-12Hz feel)
      const k = 1 - Math.pow(0.0001, dt)
      sIntensity += (targetIntensity - sIntensity) * k
      sSpeed += (targetSpeed - sSpeed) * k
      sExposure += (targetExposure - sExposure) * k
      sSlices += (targetSlices - sSlices) * k
      sChroma += (targetChroma - sChroma) * k
      sAlbumMix += (targetAlbumMix - sAlbumMix) * k
      sSwirl += (targetSwirl - sSwirl) * k
      sWarp += (targetWarp - sWarp) * k

      // safety caps when in safe mode
      const kIntensity = THREE.MathUtils.lerp(sIntensity, Math.min(sIntensity, 0.6), safe)
      const kSpeed = THREE.MathUtils.lerp(sSpeed, Math.min(sSpeed, 0.4), safe)

      // spin/zoom driven by audio and speed
      const spin = 0.28 * kSpeed + 0.14 * high + 0.06 * Math.sin(t * 0.45)
      const zoom = 0.24 * kIntensity + 0.16 * mid + 0.12 * (beat > 0.5 ? 1.0 : 0.0)

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
      setF('uSpinAmt', spin)
      setF('uZoomAmt', zoom)
      setF('uSwirl', THREE.MathUtils.clamp(sSwirl, 0, 1))
      setF('uWarp', THREE.MathUtils.clamp(sWarp, 0, 1))
      setF('uAlbumMix', THREE.MathUtils.clamp(sAlbumMix, 0, 1))
      // palette refresh (if album changed)
      setColor('uAlbumA', albumA)
      setColor('uAlbumB', albumB)

      // scroll progression
      scrollRef.current += dt * (0.24 + 1.05 * kSpeed + 0.48 * loud)
      setF('uScroll', scrollRef.current)

      // Particles
      const pts = particlesRef.current
      if (pts) {
        const pos = pts.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
        const spd = pts.geometry.getAttribute('speed') as THREE.BufferAttribute | undefined
        if (pos && spd) {
          const base = (0.68 + 1.65 * kSpeed) + (loud * 1.35)
          for (let i = 0; i < spd.count; i++) {
            const speed = spd.getX(i) * (0.5 + 0.7 * kSpeed) * (1.0 + 0.45 * high)
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
      const desired = Math.floor(2200 * THREE.MathUtils.clamp(cfgRef.current.particleDensity, 0.1, 2.5))
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

function Panel(props: { open: boolean; cfg: Cfg; onToggle: () => void; onChange: (u: (p: Cfg) => Cfg | Cfg) => void }) {
  const { open, cfg, onToggle, onChange } = props
  const Row = (p: { label: string; children: React.ReactNode }) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, margin: '6px 0' }}>
      <label style={{ fontSize: 12, opacity: 0.9 }}>{p.label}</label>
      <div>{p.children}</div>
    </div>
  )
  const Card = (p: { title: string; children: React.ReactNode }) => (
    <div style={{ border: '1px solid #2b2f3a', borderRadius: 8, padding: 10, marginTop: 8 }}>
      <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>{p.title}</div>
      {p.children}
    </div>
  )
  const btnStyle: React.CSSProperties = {
    padding: '6px 10px',
    fontSize: 12,
    borderRadius: 6,
    border: '1px solid #2b2f3a',
    background: 'rgba(16,18,22,0.8)',
    color: '#cfe7ff',
    cursor: 'pointer'
  }

  const onRange = (cb: (v: number) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.currentTarget.value)
    cb(v)
  }

  return (
    <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 10, userSelect: 'none', pointerEvents: 'auto' }}>
      <button onClick={(e) => { e.stopPropagation(); onToggle() }} style={btnStyle}>
        {open ? 'Close Psy Settings' : 'Psy Settings'}
      </button>
      {open && (
        <div style={{
          width: 320, marginTop: 8, padding: 12, border: '1px solid #2b2f3a', borderRadius: 8,
          background: 'rgba(10,12,16,0.9)', color: '#e6f0ff', fontFamily: 'system-ui, sans-serif', fontSize: 12, lineHeight: 1.4
        }}>
          <Card title="Drive">
            <Row label={`Intensity: ${cfg.intensity.toFixed(2)}`}>
              <input type="range" min={0} max={1.6} step={0.01} value={cfg.intensity}
                     onChange={onRange(v => onChange(prev => ({ ...prev, intensity: Math.max(0, Math.min(1.6, v || 0)) })))} />
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

          <Card title="Kaleidoscope & Color">
            <Row label={`Slices: ${Math.round(cfg.slices)}`}>
              <input type="range" min={1} max={24} step={1} value={cfg.slices}
                     onChange={onRange(v => onChange(prev => ({ ...prev, slices: Math.max(1, Math.round(v || 1)) })))} />
            </Row>
            <Row label={`Chroma: ${cfg.chroma.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.chroma}
                     onChange={onRange(v => onChange(prev => ({ ...prev, chroma: Math.max(0, Math.min(1, v || 0)) })))} />
            </Row>
            <Row label={`Album Influence: ${cfg.albumMix.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.albumMix}
                     onChange={onRange(v => onChange(prev => ({ ...prev, albumMix: Math.max(0, Math.min(1, v || 0.6)) })))} />
            </Row>
          </Card>

          <Card title="Warp">
            <Row label={`Swirl: ${cfg.swirl.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.swirl}
                     onChange={onRange(v => onChange(prev => ({ ...prev, swirl: Math.max(0, Math.min(1, v || 0.7)) })))} />
            </Row>
            <Row label={`Warp: ${cfg.warp.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.warp}
                     onChange={onRange(v => onChange(prev => ({ ...prev, warp: Math.max(0, Math.min(1, v || 0.7)) })))} />
            </Row>
          </Card>

          <Card title="Particles">
            <Row label={`Density: ${cfg.particleDensity.toFixed(2)}`}>
              <input type="range" min={0.2} max={2.5} step={0.01} value={cfg.particleDensity}
                     onChange={onRange(v => onChange(prev => ({ ...prev, particleDensity: Math.max(0.2, Math.min(2.5, v || 1.1)) })))} />
            </Row>
          </Card>

          <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'space-between' }}>
            <button
              onClick={() => onChange({ intensity: 0.9, speed: 0.7, slices: 12, chroma: 0.45, particleDensity: 1.1, exposure: 0.85, albumMix: 0.6, swirl: 0.7, warp: 0.7 })}
              style={btnStyle}
            >
              Reset
            </button>
            <button onClick={onToggle} style={btnStyle}>Close</button>
          </div>
        </div>
      )}
    </div>
  )
}
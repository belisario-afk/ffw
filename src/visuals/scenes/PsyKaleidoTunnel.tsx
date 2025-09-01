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
  // Core
  intensity: number
  speed: number
  exposure: number

  // Kaleido + warp
  slices: number
  chroma: number
  swirl: number
  warp: number
  spiral: number
  ringDensity: number
  spokeDensity: number

  // Album adaptation
  albumMix: number        // overall amount of album influence (palette and/or texture)
  textureMix: number      // how much of the actual album texture to mix (requires CORS OK)
  albumTexScaleU: number
  albumTexScaleV: number
  albumTexWarp: number

  // Look
  particleDensity: number
  saturation: number
  paletteBias: number     // bias color palette toward album base
  paletteContrast: number // palette contrast
  vignette: number
  aberration: number
  gamma: number
}

type Preset = { name: string } & Cfg

const LS_KEY = 'ffw.kaleido.cfg.ultimate.v1'

const PRESETS: Record<string, Preset> = {
  mandalaSurge: {
    name: 'Mandala Surge',
    intensity: 1.10, speed: 0.85, exposure: 0.95,
    slices: 22, chroma: 0.55, swirl: 0.85, warp: 0.75, spiral: 0.25, ringDensity: 1.0, spokeDensity: 1.0,
    albumMix: 0.75, textureMix: 0.55, albumTexScaleU: 2.0, albumTexScaleV: 4.0, albumTexWarp: 0.35,
    particleDensity: 1.8, saturation: 1.08, paletteBias: 0.65, paletteContrast: 0.55, vignette: 0.65, aberration: 0.6, gamma: 0.96
  },
  petalDrift: {
    name: 'Petal Drift',
    intensity: 0.80, speed: 0.55, exposure: 0.85,
    slices: 10, chroma: 0.35, swirl: 0.55, warp: 0.55, spiral: 0.12, ringDensity: 0.85, spokeDensity: 0.8,
    albumMix: 0.55, textureMix: 0.35, albumTexScaleU: 1.4, albumTexScaleV: 3.2, albumTexWarp: 0.25,
    particleDensity: 1.2, saturation: 1.0, paletteBias: 0.55, paletteContrast: 0.45, vignette: 0.58, aberration: 0.35, gamma: 0.97
  },
  neonBloom: {
    name: 'Neon Bloom',
    intensity: 1.25, speed: 1.0, exposure: 1.02,
    slices: 18, chroma: 0.85, swirl: 0.90, warp: 0.85, spiral: 0.32, ringDensity: 1.15, spokeDensity: 1.2,
    albumMix: 0.6, textureMix: 0.45, albumTexScaleU: 2.8, albumTexScaleV: 5.0, albumTexWarp: 0.42,
    particleDensity: 2.2, saturation: 1.2, paletteBias: 0.5, paletteContrast: 0.6, vignette: 0.62, aberration: 0.75, gamma: 0.94
  },
  hyperWarp: {
    name: 'Hyper Warp',
    intensity: 1.35, speed: 1.2, exposure: 0.92,
    slices: 16, chroma: 0.65, swirl: 1.0, warp: 1.0, spiral: 0.45, ringDensity: 1.35, spokeDensity: 1.4,
    albumMix: 0.65, textureMix: 0.6, albumTexScaleU: 3.2, albumTexScaleV: 5.5, albumTexWarp: 0.48,
    particleDensity: 2.6, saturation: 1.1, paletteBias: 0.6, paletteContrast: 0.7, vignette: 0.68, aberration: 0.8, gamma: 0.93
  },
  albumTrip: {
    name: 'Album Trip',
    intensity: 0.95, speed: 0.75, exposure: 0.9,
    slices: 20, chroma: 0.5, swirl: 0.8, warp: 0.75, spiral: 0.2, ringDensity: 1.0, spokeDensity: 1.0,
    albumMix: 0.9, textureMix: 0.7, albumTexScaleU: 2.2, albumTexScaleV: 4.2, albumTexWarp: 0.4,
    particleDensity: 1.8, saturation: 1.05, paletteBias: 0.7, paletteContrast: 0.55, vignette: 0.6, aberration: 0.55, gamma: 0.96
  }
}

export default function PsyKaleidoTunnel({ quality, accessibility }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // Scene refs
  const matRef = useRef<THREE.ShaderMaterial | null>(null)
  const albumTexRef = useRef<THREE.Texture | null>(null)
  const particlesRef = useRef<THREE.Points | null>(null)
  const scrollRef = useRef(0)

  // Album palette always available; texture is best-effort
  const albumA = useRef(new THREE.Color('#77d0ff'))
  const albumB = useRef(new THREE.Color('#b47bff'))

  // UI state
  const [panelOpen, setPanelOpen] = useState(false)
  const [selectedPreset, setSelectedPreset] = useState<keyof typeof PRESETS>('mandalaSurge')
  const [cfg, setCfg] = useState<Cfg>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}')
      return { ...PRESETS.mandalaSurge, ...saved }
    } catch {
      return { ...PRESETS.mandalaSurge }
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
    scene.background = new THREE.Color('#02040a')

    const camera = new THREE.PerspectiveCamera(62, 1, 0.05, 500)
    camera.position.set(0, 0, 0)

    const { renderer, dispose: disposeRenderer } = createRenderer(canvas, quality.renderScale)
    const comp = createComposer(renderer, scene, camera, {
      bloom: quality.bloom,
      bloomStrength: 0.76,
      bloomRadius: 0.44,
      bloomThreshold: 0.54,
      fxaa: true,
      vignette: true,
      vignetteStrength: Math.min(1, Math.max(0, cfgRef.current.vignette)),
      filmGrain: false,
      filmGrainStrength: 0.0,
      motionBlur: false
    })

    let running = true
    let disposed = false

    // Audio frames
    let latest: ReactiveFrame | null = null
    const offFrame = reactivityBus.on('frame', f => { latest = f })

    // Track polling to update album palette/texture
    let lastTrackId: string | null = null

    function quantizeTop2(imageData: Uint8ClampedArray): [THREE.Color, THREE.Color] {
      // 6x6x6 RGB histogram
      const bins = new Map<number, number>()
      const toBin = (r: number, g: number, b: number) => {
        const R = Math.min(5, Math.floor(r / 43))
        const G = Math.min(5, Math.floor(g / 43))
        const B = Math.min(5, Math.floor(b / 43))
        return (R << 10) | (G << 5) | B
      }
      for (let i = 0; i < imageData.length; i += 4) {
        const a = imageData[i + 3]; if (a < 24) continue
        const key = toBin(imageData[i], imageData[i + 1], imageData[i + 2])
        bins.set(key, (bins.get(key) || 0) + 1)
      }
      const decode = (bin: number) => {
        const R = ((bin >> 10) & 0x1f) * 43 + 21
        const G = ((bin >> 5) & 0x1f) * 43 + 21
        const B = (bin & 0x1f) * 43 + 21
        return new THREE.Color(R / 255, G / 255, B / 255)
      }
      const sorted = [...bins.entries()].sort((a, b) => b[1] - a[1])
      const c1 = sorted[0] ? decode(sorted[0][0]) : new THREE.Color('#77d0ff')
      let c2 = sorted[1] ? decode(sorted[1][0]) : c1.clone().offsetHSL(0.2, 0.25, 0)
      if (c1.distanceTo(c2) < 0.15) c2.offsetHSL(0.28, 0.3, 0)
      return [c1, c2]
    }

    async function loadAlbumFromPlayback() {
      try {
        const s = await getPlaybackState().catch(() => null)
        const id = (s?.item?.id as string) || null
        const url = (s?.item?.album?.images?.[0]?.url as string) || ''
        if (!id || !url || id === lastTrackId) return
        lastTrackId = id

        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const im = new Image()
          im.crossOrigin = 'anonymous'
          im.onload = () => resolve(im)
          im.onerror = reject
          im.src = url
        }).catch(async () => {
          // Fallback to blob -> objectURL
          const resp = await fetch(url)
          const blob = await resp.blob()
          const obj = URL.createObjectURL(blob)
          return await new Promise<HTMLImageElement>((resolve, reject) => {
            const im = new Image()
            im.onload = () => resolve(im)
            im.onerror = reject
            im.src = obj
          })
        })

        // Palette
        const c = document.createElement('canvas'); c.width = 64; c.height = 64
        const g = c.getContext('2d')
        if (g) {
          g.drawImage(img, 0, 0, 64, 64)
          const data = g.getImageData(0, 0, 64, 64).data
          const [cA, cB] = quantizeTop2(data)
          albumA.current.copy(cA)
          albumB.current.copy(cB)
          setColor('uAlbumA', albumA.current)
          setColor('uAlbumB', albumB.current)
        }

        // Texture (best effort)
        try {
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
        } catch {
          setF('uHasAlbum', 0.0)
        }
      } catch {
        // ignore
      }
    }

    loadAlbumFromPlayback()
    const albumIv = window.setInterval(loadAlbumFromPlayback, 7000)

    // Geometry
    const radius = 14
    const tunnelLen = 260
    const tunnel = new THREE.CylinderGeometry(radius, radius, tunnelLen, 420, 1, true)
    tunnel.rotateZ(Math.PI * 0.5)

    // Uniforms
    const uniforms = {
      uTime: { value: 0.0 },
      uAudio: { value: new THREE.Vector3(0.1, 0.1, 0.1) },
      uLoud: { value: 0.12 },
      uBeat: { value: 0.0 },

      // Dynamics
      uScroll: { value: 0.0 },
      uSpinAmt: { value: 0.0 },
      uZoomAmt: { value: 0.0 },

      // Controls
      uIntensity: { value: cfgRef.current.intensity },
      uSpeed: { value: cfgRef.current.speed },
      uExposure: { value: cfgRef.current.exposure },
      uSlices: { value: Math.max(1, Math.round(cfgRef.current.slices)) },
      uChroma: { value: cfgRef.current.chroma },
      uSwirl: { value: cfgRef.current.swirl },
      uWarp: { value: cfgRef.current.warp },
      uSpiral: { value: cfgRef.current.spiral },
      uRingDensity: { value: cfgRef.current.ringDensity },
      uSpokeDensity: { value: cfgRef.current.spokeDensity },

      // Album
      uAlbumA: { value: albumA.current.clone() },
      uAlbumB: { value: albumB.current.clone() },
      uAlbumMix: { value: cfgRef.current.albumMix },
      uTextureMix: { value: cfgRef.current.textureMix },
      uAlbumTexScale: { value: new THREE.Vector2(cfgRef.current.albumTexScaleU, cfgRef.current.albumTexScaleV) },
      uAlbumTexWarp: { value: cfgRef.current.albumTexWarp },
      uHasAlbum: { value: 0.0 },
      tAlbum: { value: null as THREE.Texture | null },

      // Look
      uSaturation: { value: cfgRef.current.saturation },
      uPaletteBias: { value: cfgRef.current.paletteBias },
      uPaletteContrast: { value: cfgRef.current.paletteContrast },
      uVignette: { value: cfgRef.current.vignette },
      uAberration: { value: cfgRef.current.aberration },
      uGamma: { value: cfgRef.current.gamma },

      // Accessibility
      uSafe: { value: (accessibility.epilepsySafe || accessibility.reducedMotion) ? 1.0 : 0.0 },
      uContrastBoost: { value: accessibility.highContrast ? 1.0 : 0.0 }
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

        uniform float uScroll;
        uniform float uSpinAmt;
        uniform float uZoomAmt;

        uniform float uIntensity;
        uniform float uSpeed;
        uniform float uExposure;
        uniform float uSlices;
        uniform float uChroma;
        uniform float uSwirl;
        uniform float uWarp;
        uniform float uSpiral;
        uniform float uRingDensity;
        uniform float uSpokeDensity;

        uniform vec3 uAlbumA;
        uniform vec3 uAlbumB;
        uniform float uAlbumMix;
        uniform float uTextureMix;
        uniform vec2 uAlbumTexScale;
        uniform float uAlbumTexWarp;
        uniform float uHasAlbum;
        uniform sampler2D tAlbum;

        uniform float uSaturation;
        uniform float uPaletteBias;
        uniform float uPaletteContrast;
        uniform float uVignette;
        uniform float uAberration;
        uniform float uGamma;

        uniform float uSafe;
        uniform float uContrastBoost;

        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float noise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          float a = hash(i), b = hash(i+vec2(1.,0.)), c = hash(i+vec2(0.,1.)), d = hash(i+vec2(1.,1.));
          vec2 u = f*f*(3.-2.*f);
          return mix(a,b,u.x) + (c-a)*u.y*(1.-u.x) + (d-b)*u.x*u.y;
        }
        float fbm(vec2 p){
          float v=0.0, a=0.5;
          for(int i=0;i<6;i++){ v += a * noise(p); p *= 2.03; a *= 0.5; }
          return v;
        }

        float foldK(float x, float slices){
          float seg = 1.0 / max(1.0, slices);
          float xf = fract(x + 1.0);
          float m = mod(xf, seg) / seg;
          m = abs(m - 0.5) * 2.0;
          return m * seg + floor(xf/seg)*seg;
        }

        vec2 rotate2D(vec2 uv, float ang){
          uv -= 0.5;
          float s = sin(ang), c = cos(ang);
          uv = mat2(c, -s, s, c) * uv;
          return uv + 0.5;
        }

        vec2 barrel(vec2 uv, float k){
          vec2 cc = uv - 0.5;
          float r2 = dot(cc, cc);
          return cc*(1.0 + k*r2) + 0.5;
        }

        vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d){
          return a + b*cos(6.28318*(c*t + d));
        }

        vec3 sat(vec3 c, float s){
          float l = dot(c, vec3(0.299,0.587,0.114));
          return mix(vec3(l), c, s);
        }

        vec3 aberrate(vec2 uv, float amt, vec3 base, float time){
          float off = amt * 0.004;
          float r = smoothstep(0.25, 0.75, fbm((uv + vec2(off,0.0))*3.8 + time*0.05));
          float g = smoothstep(0.25, 0.75, fbm((uv + vec2(0.0,off))*3.8 - time*0.04));
          float b = smoothstep(0.25, 0.75, fbm((uv + vec2(-off,off))*3.8 + time*0.03));
          vec3 chrom = vec3(r,g,b);
          return mix(base, chrom, clamp(amt,0.0,1.0));
        }

        void main(){
          float time = uTime;

          // breathing spin/zoom with swirl
          vec2 uv = vUv;
          float spin = (0.14 + 0.55*uSwirl) * time + uSpinAmt;
          uv = rotate2D(uv, spin);
          float zoomA = clamp(0.10 + 0.28*uZoomAmt, 0.0, 0.55);
          uv = mix(uv, (uv - 0.5) * (1.0 - zoomA) + 0.5, 0.8);

          // spiral radial distortion (for mandala feel)
          vec2 dc = uv - 0.5;
          float r = length(dc);
          float ang = atan(dc.y, dc.x) + uSpiral * (0.5 + 0.8*uIntensity) * r * 6.28318;
          uv = vec2(cos(ang), sin(ang)) * r + 0.5;

          // wrap and kaleido fold
          uv.y = fract(uv.y - time*0.048 - uScroll);
          uv.x = foldK(uv.x, uSlices);

          // domain warping
          float w = uWarp;
          vec2 warpVec = vec2(fbm(uv*2.6 + time*0.11), fbm(uv*2.8 - time*0.13));
          uv += (warpVec - 0.5) * (0.28 * w);

          // structured fields with tunable densities
          float rings = sin((uv.y*(34.0+12.0*uRingDensity) + fbm(uv*3.1)*8.0) - time*7.5 * (0.6 + 0.8*uLoud));
          float spokes = sin((uv.x*(60.0+16.0*uSpokeDensity) + fbm(uv*3.4)*9.0) + time*5.0 * (0.4 + 0.9*uAudio.z));
          float field = smoothstep(-1.0, 1.0, rings * spokes);

          // album-driven palette (always available)
          vec3 baseA = mix(vec3(0.30,0.28,0.46), uAlbumA, clamp(uPaletteBias, 0.0, 1.0));
          vec3 baseB = mix(vec3(0.50,0.54,0.46), normalize(uAlbumB + 0.001), clamp(uPaletteBias, 0.0, 1.0));
          vec3 cpC = mix(vec3(0.85,0.60,0.45), vec3(0.72,0.92,0.64), clamp(uPaletteContrast, 0.0, 1.0));
          vec3 cpD = mix(vec3(0.2,0.0,0.6), vec3(0.0,0.2,0.4), 0.45);

          float hueShift = 0.16*uIntensity + 0.12*uAudio.y + 0.05*uLoud + 0.08*sin(time*0.24);
          vec3 colA = palette(fract(field*0.25 + hueShift), baseA, baseB, cpC, cpD);
          vec3 colB = palette(fract(field*0.5 + hueShift*1.45), baseB, baseA, cpC, cpD);
          vec3 col = mix(colA, colB, 0.45 + 0.25*uAudio.y);

          // album texture infusion (best effort)
          if (uHasAlbum > 0.5 && uTextureMix > 0.001) {
            vec2 tuv = uv;
            float swirl = (uv.x - 0.5)*(uv.y - 0.5);
            tuv = rotate2D(tuv, swirl * (2.0 + 4.0*uIntensity));
            tuv = barrel(tuv, uAlbumTexWarp * (0.25 + 0.75*uIntensity));
            tuv *= uAlbumTexScale;
            vec3 texCol = texture2D(tAlbum, tuv).rgb;
            float mixAmt = clamp(uTextureMix * (0.45 + 0.9*uAudio.y + 0.55*uAudio.z), 0.0, 0.9);
            col = mix(col, texCol, mixAmt);
          }

          // overall album color mix (palette bias based)
          vec3 palCol = mix(uAlbumA, uAlbumB, 0.5 + 0.3*sin(time*0.2));
          float palAmt = clamp(uAlbumMix * (0.35 + 0.7*uAudio.y), 0.0, 0.85);
          col = mix(col, palCol, palAmt);

          // saturation and chroma
          col = sat(col, clamp(uSaturation, 0.5, 1.6));
          float chromAmt = uChroma * (0.4 + 0.6*uIntensity);
          chromAmt *= mix(1.0, 0.55, uSafe);
          chromAmt *= mix(1.0, 0.75, uContrastBoost);
          col = aberrate(uv, clamp(uAberration, 0.0, 1.0) * chromAmt, col, time);

          // safety flash clamp
          float flash = 0.34*uLoud + 0.42*uAudio.z + 0.24*uAudio.y;
          float maxFlash = mix(1.0, 0.4, uSafe);
          col *= (0.8 + 0.6*min(flash, maxFlash));

          // exposure + reinhard + gamma
          col *= mix(0.6, 1.6, clamp(uExposure, 0.0, 1.6));
          col = col / (1.0 + col);
          col = pow(col, vec3(clamp(uGamma, 0.85, 1.15)));

          // vignette in-shader for extra control
          vec2 q = vUv - 0.5;
          float vig = 1.0 - clamp(dot(q, q) * 1.5, 0.0, 1.0);
          col *= mix(1.0, pow(vig, 1.8), clamp(uVignette, 0.0, 1.0));

          gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        }
      `
    })
    matRef.current = mat

    const tunnelMesh = new THREE.Mesh(tunnel, mat)
    scene.add(tunnelMesh)

    // Particles
    const makeParticles = (density: number) => {
      const count = Math.floor(2200 + 1400 * THREE.MathUtils.clamp(density, 0.1, 3.0))
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

    // Safe uniform setters (never read .value)
    const setF = (name: keyof typeof uniforms, v: number) => {
      const m = matRef.current; if (!m || !m.uniforms) return
      const u = (m.uniforms as any)[name]; if (!u || u.value === undefined || u.value === null) return
      u.value = v
    }
    const setV2 = (name: keyof typeof uniforms, x: number, y: number) => {
      const m = matRef.current; if (!m || !m.uniforms) return
      const u = (m.uniforms as any)[name]; if (!u) return
      if (u.value && (u.value as any).isVector2) (u.value as THREE.Vector2).set(x, y)
      else u.value = new THREE.Vector2(x, y)
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

    // Animate (smoothed params + chorus pulse heuristic)
    const clock = new THREE.Clock()
    let raf = 0

    // Smoothed params
    let s = { ...cfgRef.current }

    const loudBuf: number[] = []
    const midBuf: number[] = []
    let chorusT = 0

    const animate = () => {
      raf = requestAnimationFrame(animate)
      if (!running || disposed) return

      const dt = Math.min(0.05, clock.getDelta())
      const t = clock.elapsedTime

      // Audio snapshot
      const low = latest?.bands?.low ?? 0.06
      const mid = latest?.bands?.mid ?? 0.06
      const high = latest?.bands?.high ?? 0.06
      const loud = latest?.loudness ?? 0.12
      const beat = latest?.beat ? 1.0 : 0.0

      // Simple chorus pulse heuristic
      loudBuf.push(loud); if (loudBuf.length > 60) loudBuf.shift()
      midBuf.push(mid); if (midBuf.length > 60) midBuf.shift()
      const avgL = loudBuf.reduce((a, b) => a + b, 0) / (loudBuf.length || 1)
      const avgM = midBuf.reduce((a, b) => a + b, 0) / (midBuf.length || 1)
      if (loud > avgL * 1.25 && mid > avgM * 1.25) chorusT = 0.8
      else chorusT = Math.max(0, chorusT - dt)
      const chorusPulse = chorusT > 0 ? (0.5 + 0.5 * Math.sin(t * 6.0)) : 0.0

      // Targets (clamped)
      const safe = (accessibility.epilepsySafe || accessibility.reducedMotion) ? 1.0 : 0.0
      const T = cfgRef.current
      const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

      const target = {
        intensity: THREE.MathUtils.clamp(T.intensity, 0, 1.6),
        speed: THREE.MathUtils.clamp(T.speed, 0, 2.0),
        exposure: THREE.MathUtils.clamp(T.exposure, 0, 1.6),
        slices: Math.max(1, Math.min(32, Math.round(T.slices))),
        chroma: clamp01(T.chroma),
        swirl: clamp01(T.swirl),
        warp: clamp01(T.warp),
        spiral: clamp01(T.spiral),
        ringDensity: THREE.MathUtils.clamp(T.ringDensity, 0.5, 1.6),
        spokeDensity: THREE.MathUtils.clamp(T.spokeDensity, 0.5, 1.6),
        albumMix: clamp01(T.albumMix),
        textureMix: clamp01(T.textureMix),
        albumTexScaleU: THREE.MathUtils.clamp(T.albumTexScaleU, 0.5, 6),
        albumTexScaleV: THREE.MathUtils.clamp(T.albumTexScaleV, 0.5, 6),
        albumTexWarp: THREE.MathUtils.clamp(T.albumTexWarp, 0, 0.8),
        particleDensity: THREE.MathUtils.clamp(T.particleDensity, 0.2, 3.0),
        saturation: THREE.MathUtils.clamp(T.saturation, 0.6, 1.6),
        paletteBias: clamp01(T.paletteBias),
        paletteContrast: clamp01(T.paletteContrast),
        vignette: clamp01(T.vignette),
        aberration: clamp01(T.aberration),
        gamma: THREE.MathUtils.clamp(T.gamma, 0.85, 1.15)
      }

      // Smooth toward targets
      const k = 1 - Math.pow(0.0001, dt)
      ;(Object.keys(target) as (keyof typeof target)[]).forEach(key => {
        // @ts-ignore
        s[key] += (target[key] - s[key]) * k
      })

      // Safety caps
      const kIntensity = THREE.MathUtils.lerp(s.intensity, Math.min(s.intensity, 0.6), safe)
      const kSpeedBase = THREE.MathUtils.lerp(s.speed, Math.min(s.speed, 0.4), safe)

      const kSpeed = kSpeedBase + chorusPulse * 0.22
      const kSlices = Math.max(1, Math.round(s.slices + chorusPulse * 4))

      // Spin/zoom driven by audio
      const spin = 0.28 * kSpeed + 0.14 * high + 0.06 * Math.sin(t * 0.45)
      const zoom = 0.24 * kIntensity + 0.17 * mid + 0.12 * (beat > 0.5 ? 1.0 : 0.0)

      // Push uniforms
      setF('uTime', t)
      setV3('uAudio', low, mid, high)
      setF('uLoud', loud)
      setF('uBeat', beat)
      setF('uSafe', safe)
      setF('uContrastBoost', accessibility.highContrast ? 1.0 : 0.0)

      setF('uIntensity', kIntensity)
      setF('uSpeed', kSpeed)
      setF('uExposure', s.exposure)
      setF('uSlices', kSlices)
      setF('uChroma', s.chroma)
      setF('uSwirl', s.swirl)
      setF('uWarp', s.warp)
      setF('uSpiral', s.spiral)
      setF('uRingDensity', s.ringDensity)
      setF('uSpokeDensity', s.spokeDensity)

      setColor('uAlbumA', albumA.current)
      setColor('uAlbumB', albumB.current)
      setF('uAlbumMix', s.albumMix)
      setF('uTextureMix', s.textureMix)
      setV2('uAlbumTexScale', s.albumTexScaleU, s.albumTexScaleV)
      setF('uAlbumTexWarp', s.albumTexWarp)

      setF('uSaturation', s.saturation)
      setF('uPaletteBias', s.paletteBias)
      setF('uPaletteContrast', s.paletteContrast)
      setF('uVignette', s.vignette)
      setF('uAberration', s.aberration)
      setF('uGamma', s.gamma)

      scrollRef.current += dt * (0.26 + 1.1 * kSpeed + 0.5 * loud)
      setF('uScroll', scrollRef.current)

      // Particles motion
      const pts = particlesRef.current
      if (pts) {
        const pos = pts.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
        const spd = pts.geometry.getAttribute('speed') as THREE.BufferAttribute | undefined
        if (pos && spd) {
          const base = (0.66 + 1.7 * kSpeed) + (loud * 1.3)
          for (let i = 0; i < spd.count; i++) {
            const speed = spd.getX(i) * (0.5 + 0.7 * kSpeed) * (1.0 + 0.45 * high)
            const z = pos.getZ(i) + dt * (base + speed)
            if (z > 2.0) {
              const theta = Math.random() * Math.PI * 2
              const r2 = radius * (0.9 + Math.random() * 0.25)
              pos.setXYZ(i, Math.cos(theta) * r2, Math.sin(theta) * r2, -tunnelLen)
            } else {
              pos.setZ(i, z)
            }
          }
          pos.needsUpdate = true
        }
      }

      // Rebuild particles if density changed significantly
      const desired = Math.floor(2200 + 1400 * THREE.MathUtils.clamp(cfgRef.current.particleDensity, 0.1, 3.0))
      const current = (particlesRef.current?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined)?.count ?? desired
      if (Math.abs(desired - current) > 700) {
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
      <Panel
        open={panelOpen}
        cfg={cfg}
        selectedPreset={selectedPreset}
        onSelectPreset={setSelectedPreset}
        onApplyPreset={() => setCfg(PRESETS[selectedPreset])}
        onToggle={() => setPanelOpen(o => !o)}
        onChange={setCfg}
      />
    </div>
  )
}

function Panel(props: {
  open: boolean
  cfg: Cfg
  selectedPreset: keyof typeof PRESETS
  onSelectPreset: (k: keyof typeof PRESETS) => void
  onApplyPreset: () => void
  onToggle: () => void
  onChange: (u: (p: Cfg) => Cfg | Cfg) => void
}) {
  const { open, cfg, onToggle, onChange, selectedPreset, onSelectPreset, onApplyPreset } = props
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
    padding: '6px 10px', fontSize: 12, borderRadius: 6, border: '1px solid #2b2f3a',
    background: 'rgba(16,18,22,0.8)', color: '#cfe7ff', cursor: 'pointer'
  }
  const onRange = (cb: (v: number) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.currentTarget.value); cb(v)
  }

  return (
    <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 10, userSelect: 'none', pointerEvents: 'auto' }}>
      <button onClick={(e) => { e.stopPropagation(); onToggle() }} style={btnStyle}>
        {open ? 'Close Psy Settings' : 'Psy Settings'}
      </button>
      {open && (
        <div style={{
          width: 380, marginTop: 8, padding: 12, border: '1px solid #2b2f3a', borderRadius: 8,
          background: 'rgba(10,12,16,0.92)', color: '#e6f0ff', fontFamily: 'system-ui, sans-serif', fontSize: 12, lineHeight: 1.4
        }}>
          <Card title="Presets">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select
                value={selectedPreset}
                onChange={e => onSelectPreset(e.currentTarget.value as keyof typeof PRESETS)}
                style={{ background: '#0f1218', color: '#cfe7ff', border: '1px solid #2b2f3a', borderRadius: 6, padding: '6px' }}
              >
                {Object.entries(PRESETS).map(([key, p]) => (
                  <option key={key} value={key}>{p.name}</option>
                ))}
              </select>
              <button onClick={onApplyPreset} style={btnStyle}>Apply</button>
              <button onClick={() => onChange(PRESETS.albumTrip)} style={btnStyle}>Album Boost</button>
            </div>
          </Card>

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
              <input type="range" min={0} max={1.6} step={0.01} value={cfg.exposure}
                     onChange={onRange(v => onChange(prev => ({ ...prev, exposure: Math.max(0, Math.min(1.6, v || 1.0)) })))} />
            </Row>
          </Card>

          <Card title="Kaleidoscope & Warp">
            <Row label={`Slices: ${Math.round(cfg.slices)}`}>
              <input type="range" min={1} max={32} step={1} value={cfg.slices}
                     onChange={onRange(v => onChange(prev => ({ ...prev, slices: Math.max(1, Math.round(v || 1)) })))} />
            </Row>
            <Row label={`Chroma: ${cfg.chroma.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.chroma}
                     onChange={onRange(v => onChange(prev => ({ ...prev, chroma: Math.max(0, Math.min(1, v || 0)) })))} />
            </Row>
            <Row label={`Swirl: ${cfg.swirl.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.swirl}
                     onChange={onRange(v => onChange(prev => ({ ...prev, swirl: Math.max(0, Math.min(1, v || 0.75)) })))} />
            </Row>
            <Row label={`Warp: ${cfg.warp.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.warp}
                     onChange={onRange(v => onChange(prev => ({ ...prev, warp: Math.max(0, Math.min(1, v || 0.75)) })))} />
            </Row>
            <Row label={`Spiral: ${cfg.spiral.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.spiral}
                     onChange={onRange(v => onChange(prev => ({ ...prev, spiral: Math.max(0, Math.min(1, v || 0.2)) })))} />
            </Row>
            <Row label={`Rings: ${cfg.ringDensity.toFixed(2)}`}>
              <input type="range" min={0.5} max={1.6} step={0.01} value={cfg.ringDensity}
                     onChange={onRange(v => onChange(prev => ({ ...prev, ringDensity: Math.max(0.5, Math.min(1.6, v || 1.0)) })))} />
            </Row>
            <Row label={`Spokes: ${cfg.spokeDensity.toFixed(2)}`}>
              <input type="range" min={0.5} max={1.6} step={0.01} value={cfg.spokeDensity}
                     onChange={onRange(v => onChange(prev => ({ ...prev, spokeDensity: Math.max(0.5, Math.min(1.6, v || 1.0)) })))} />
            </Row>
          </Card>

          <Card title="Album Adaptation">
            <Row label={`Album Mix: ${cfg.albumMix.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.albumMix}
                     onChange={onRange(v => onChange(prev => ({ ...prev, albumMix: Math.max(0, Math.min(1, v || 0.7)) })))} />
            </Row>
            <Row label={`Texture Mix: ${cfg.textureMix.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.textureMix}
                     onChange={onRange(v => onChange(prev => ({ ...prev, textureMix: Math.max(0, Math.min(1, v || 0.5)) })))} />
            </Row>
            <Row label={`Tex Scale U: ${cfg.albumTexScaleU.toFixed(2)}`}>
              <input type="range" min={0.5} max={6} step={0.01} value={cfg.albumTexScaleU}
                     onChange={onRange(v => onChange(prev => ({ ...prev, albumTexScaleU: Math.max(0.5, Math.min(6, v || 2.0)) })))} />
            </Row>
            <Row label={`Tex Scale V: ${cfg.albumTexScaleV.toFixed(2)}`}>
              <input type="range" min={0.5} max={6} step={0.01} value={cfg.albumTexScaleV}
                     onChange={onRange(v => onChange(prev => ({ ...prev, albumTexScaleV: Math.max(0.5, Math.min(6, v || 4.0)) })))} />
            </Row>
            <Row label={`Tex Warp: ${cfg.albumTexWarp.toFixed(2)}`}>
              <input type="range" min={0} max={0.8} step={0.01} value={cfg.albumTexWarp}
                     onChange={onRange(v => onChange(prev => ({ ...prev, albumTexWarp: Math.max(0, Math.min(0.8, v || 0.35)) })))} />
            </Row>
          </Card>

          <Card title="Look">
            <Row label={`Particles: ${cfg.particleDensity.toFixed(2)}`}>
              <input type="range" min={0.2} max={3.0} step={0.01} value={cfg.particleDensity}
                     onChange={onRange(v => onChange(prev => ({ ...prev, particleDensity: Math.max(0.2, Math.min(3.0, v || 1.8)) })))} />
            </Row>
            <Row label={`Saturation: ${cfg.saturation.toFixed(2)}`}>
              <input type="range" min={0.6} max={1.6} step={0.01} value={cfg.saturation}
                     onChange={onRange(v => onChange(prev => ({ ...prev, saturation: Math.max(0.6, Math.min(1.6, v || 1.05)) })))} />
            </Row>
            <Row label={`Palette Bias: ${cfg.paletteBias.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.paletteBias}
                     onChange={onRange(v => onChange(prev => ({ ...prev, paletteBias: Math.max(0, Math.min(1, v || 0.6)) })))} />
            </Row>
            <Row label={`Palette Contrast: ${cfg.paletteContrast.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.paletteContrast}
                     onChange={onRange(v => onChange(prev => ({ ...prev, paletteContrast: Math.max(0, Math.min(1, v || 0.55)) })))} />
            </Row>
            <Row label={`Vignette: ${cfg.vignette.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.vignette}
                     onChange={onRange(v => onChange(prev => ({ ...prev, vignette: Math.max(0, Math.min(1, v || 0.62)) })))} />
            </Row>
            <Row label={`Aberration: ${cfg.aberration.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.aberration}
                     onChange={onRange(v => onChange(prev => ({ ...prev, aberration: Math.max(0, Math.min(1, v || 0.6)) })))} />
            </Row>
            <Row label={`Gamma: ${cfg.gamma.toFixed(2)}`}>
              <input type="range" min={0.85} max={1.15} step={0.001} value={cfg.gamma}
                     onChange={onRange(v => onChange(prev => ({ ...prev, gamma: Math.max(0.85, Math.min(1.15, v || 0.96)) })))} />
            </Row>
          </Card>

          <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'space-between' }}>
            <button onClick={() => onChange(PRESETS.mandalaSurge)} style={btnStyle}>Reset</button>
            <button onClick={onToggle} style={btnStyle}>Close</button>
          </div>
          <div style={{ marginTop: 8, opacity: 0.75 }}>
            Tips:
            <ul style={{ paddingLeft: 18, margin: 0 }}>
              <li>Slices 16–24 for wild mandalas; lower for chunky petals</li>
              <li>Turn chroma up for more color fringing; safe modes auto-dial it down</li>
              <li>Increase particle density for a stronger “rush” (desktop GPUs can handle 2–3x)</li>
              <li>Album Mix influences palette; Texture Mix blends the actual cover if CORS allows</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}
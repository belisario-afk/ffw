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

/**
Album-only visuals, crash-hardened
- Colors come only from album textures and swatches (avg + top3).
- Two modes: 0=Vortex Prism, 1=Liquid Mosaic.
- Interlacing/fusion between current and previous covers.
- Uniform writes are guarded by ensureUniform() to eliminate null.value crashes.
**/

type Cfg = {
  intensity: number
  speed: number
  exposure: number
  saturation: number
  gamma: number
  vignette: number

  shapeMode: 0 | 1
  slices: number
  tileScale: number
  tileRound: number

  prismDispersion: number
  prismWarp: number

  texScaleU: number
  texScaleV: number
  texRotate: number
  albumTexWarp: number

  interlaceMode: 0 | 1 | 2
  interlaceScale: number
  interlaceStrength: number
  fuseBias: number

  edgeEmphasis: number
}

type Preset = { name: string } & Cfg

const LS_KEY = 'ffw.kaleido.albumonly.safe.v4'

const PRESETS: Record<string, Preset> = {
  vortexPrism: {
    name: 'Vortex Prism',
    intensity: 1.1, speed: 1.0, exposure: 1.02, saturation: 1.18, gamma: 0.95, vignette: 0.63,
    shapeMode: 0, slices: 28, tileScale: 2.8, tileRound: 0.35,
    prismDispersion: 0.95, prismWarp: 0.85,
    texScaleU: 3.0, texScaleV: 5.0, texRotate: -0.28, albumTexWarp: 0.5,
    interlaceMode: 0, interlaceScale: 140.0, interlaceStrength: 0.7, fuseBias: 0.4,
    edgeEmphasis: 0.65
  },
  liquidMosaic: {
    name: 'Liquid Mosaic',
    intensity: 0.95, speed: 0.8, exposure: 0.98, saturation: 1.1, gamma: 0.96, vignette: 0.62,
    shapeMode: 1, slices: 16, tileScale: 2.6, tileRound: 0.45,
    prismDispersion: 0.5, prismWarp: 0.55,
    texScaleU: 2.2, texScaleV: 3.6, texRotate: -0.2, albumTexWarp: 0.36,
    interlaceMode: 2, interlaceScale: 160.0, interlaceStrength: 0.6, fuseBias: 0.5,
    edgeEmphasis: 0.55
  }
}

export default function PsyKaleidoTunnel({ quality, accessibility }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // Album textures (current & previous) and flags
  const tAlbum1Ref = useRef<THREE.Texture | null>(null)
  const tAlbum2Ref = useRef<THREE.Texture | null>(null)
  const has1Ref = useRef(0)
  const has2Ref = useRef(0)
  const crossRef = useRef(1) // 0->1

  // Album swatches
  const albAvg = useRef(new THREE.Color('#808080'))
  const albC1 = useRef(new THREE.Color('#77d0ff'))
  const albC2 = useRef(new THREE.Color('#b47bff'))
  const albC3 = useRef(new THREE.Color('#ffd077'))

  // Scene refs
  const matRef = useRef<THREE.ShaderMaterial | null>(null)
  const scrollRef = useRef(0)

  // UI
  const [panelOpen, setPanelOpen] = useState(false)
  const [selectedPreset, setSelectedPreset] = useState<keyof typeof PRESETS>('vortexPrism')
  const [cfg, setCfg] = useState<Cfg>(() => {
    try { return { ...PRESETS.vortexPrism, ...(JSON.parse(localStorage.getItem(LS_KEY) || '{}')) } }
    catch { return { ...PRESETS.vortexPrism } }
  })
  const cfgRef = useRef(cfg)
  useEffect(() => { cfgRef.current = cfg; try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)) } catch {} }, [cfg])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#01040a')

    const camera = new THREE.PerspectiveCamera(62, 1, 0.05, 500)
    camera.position.set(0, 0, 0)

    const { renderer, dispose: disposeRenderer } = createRenderer(canvas, quality.renderScale)
    const comp = createComposer(renderer, scene, camera, {
      bloom: quality.bloom,
      bloomStrength: 0.7,
      bloomRadius: 0.4,
      bloomThreshold: 0.55,
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

    // Album loader (palette + texture), robust against CORS
    let lastTrackId: string | null = null
    function quantizeTopN(data: Uint8ClampedArray, nPick = 3): THREE.Color[] {
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
      const sorted = [...bins.entries()].sort((a, b) => b[1] - a[1])
      const decode = (bin: number) => {
        const R = ((bin >> 10) & 0x1f) * 43 + 21
        const G = ((bin >> 5) & 0x1f) * 43 + 21
        const B = (bin & 0x1f) * 43 + 21
        return new THREE.Color(R / 255, G / 255, B / 255)
      }
      const picks: THREE.Color[] = []
      for (let i = 0; i < Math.min(nPick, sorted.length); i++) picks.push(decode(sorted[i][0]))
      while (picks.length < nPick) {
        const c = picks[picks.length - 1]?.clone() || new THREE.Color(1, 1, 1)
        c.offsetHSL(0.2 * (picks.length), 0.1, 0); picks.push(c)
      }
      albAvg.current.setRGB((ar / Math.max(1, n)) / 255, (ag / Math.max(1, n)) / 255, (ab / Math.max(1, n)) / 255)
      return picks
    }

    async function loadAlbum() {
      try {
        const s = await getPlaybackState().catch(() => null)
        const id = (s?.item?.id as string) || null
        const url = (s?.item?.album?.images?.[0]?.url as string) || ''
        if (!id || !url || id === lastTrackId) return
        lastTrackId = id

        // Move current to previous
        if (tAlbum1Ref.current) {
          tAlbum2Ref.current?.dispose()
          tAlbum2Ref.current = tAlbum1Ref.current
          has2Ref.current = 1
        }

        // Load cover image with CORS, fallback blob
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const im = new Image()
          im.crossOrigin = 'anonymous'
          im.onload = () => resolve(im)
          im.onerror = reject
          im.src = url
        }).catch(async () => {
          const resp = await fetch(url); const blob = await resp.blob()
          const obj = URL.createObjectURL(blob)
          return await new Promise<HTMLImageElement>((resolve, reject) => {
            const im = new Image()
            im.onload = () => resolve(im)
            im.onerror = reject
            im.src = obj
          })
        })

        // Swatches
        const c = document.createElement('canvas'); c.width = 64; c.height = 64
        const g = c.getContext('2d')
        if (g) {
          g.drawImage(img, 0, 0, 64, 64)
          const data = g.getImageData(0, 0, 64, 64).data
          const picks = quantizeTopN(data, 3)
          albC1.current.copy(picks[0]); albC2.current.copy(picks[1]); albC3.current.copy(picks[2])
          setColor('uC0', albAvg.current)
          setColor('uC1', albC1.current)
          setColor('uC2', albC2.current)
          setColor('uC3', albC3.current)
        }

        // Texture (current)
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
        tAlbum1Ref.current = tex
        setTex('tAlbum1', tex)
        has1Ref.current = 1
        setF('uHasAlbum1', 1.0)
        setF('uHasAlbum2', has2Ref.current ? 1.0 : 0.0)

        // Start crossfade to current
        crossRef.current = 0.0
        setF('uAlbumCross', 0.0)
      } catch { /* ignore */ }
    }

    loadAlbum()
    const albumIv = window.setInterval(loadAlbum, 6000)

    // Geometry
    const radius = 14, tunnelLen = 220
    const tunnel = new THREE.CylinderGeometry(radius, radius, tunnelLen, 360, 1, true)
    tunnel.rotateZ(Math.PI * 0.5)

    // Uniforms
    const uniforms = {
      uTime: { value: 0.0 },
      uAudio: { value: new THREE.Vector3(0.1, 0.1, 0.1) },
      uLoud: { value: 0.12 },
      uBeat: { value: 0.0 },

      uScroll: { value: 0.0 },
      uSpin: { value: 0.0 },
      uZoom: { value: 0.0 },

      tAlbum1: { value: null as THREE.Texture | null },
      tAlbum2: { value: null as THREE.Texture | null },
      uHasAlbum1: { value: 0.0 },
      uHasAlbum2: { value: 0.0 },
      uAlbumCross: { value: 1.0 },

      uC0: { value: albAvg.current.clone() },
      uC1: { value: albC1.current.clone() },
      uC2: { value: albC2.current.clone() },
      uC3: { value: albC3.current.clone() },

      uIntensity: { value: cfgRef.current.intensity },
      uSpeed: { value: cfgRef.current.speed },
      uExposure: { value: cfgRef.current.exposure },
      uSaturation: { value: cfgRef.current.saturation },
      uGamma: { value: cfgRef.current.gamma },
      uVignette: { value: cfgRef.current.vignette },

      uShapeMode: { value: cfgRef.current.shapeMode },
      uSlices: { value: Math.max(1, Math.round(cfgRef.current.slices)) },
      uTileScale: { value: cfgRef.current.tileScale },
      uTileRound: { value: cfgRef.current.tileRound },

      uPrismDispersion: { value: cfgRef.current.prismDispersion },
      uPrismWarp: { value: cfgRef.current.prismWarp },

      uTexScale: { value: new THREE.Vector2(cfgRef.current.texScaleU, cfgRef.current.texScaleV) },
      uTexRotate: { value: cfgRef.current.texRotate },
      uAlbumTexWarp: { value: cfgRef.current.albumTexWarp },

      uInterlaceMode: { value: cfgRef.current.interlaceMode },
      uInterlaceScale: { value: cfgRef.current.interlaceScale },
      uInterlaceStrength: { value: cfgRef.current.interlaceStrength },
      uFuseBias: { value: cfgRef.current.fuseBias },

      uEdgeEmphasis: { value: cfgRef.current.edgeEmphasis },

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
        uniform float uSpin;
        uniform float uZoom;

        uniform sampler2D tAlbum1;
        uniform sampler2D tAlbum2;
        uniform float uHasAlbum1;
        uniform float uHasAlbum2;
        uniform float uAlbumCross;

        uniform vec3 uC0;
        uniform vec3 uC1;
        uniform vec3 uC2;
        uniform vec3 uC3;

        uniform float uIntensity;
        uniform float uSpeed;
        uniform float uExposure;
        uniform float uSaturation;
        uniform float uGamma;
        uniform float uVignette;

        uniform float uShapeMode; // 0 prism, 1 mosaic
        uniform float uSlices;
        uniform float uTileScale;
        uniform float uTileRound;

        uniform float uPrismDispersion;
        uniform float uPrismWarp;

        uniform vec2  uTexScale;
        uniform float uTexRotate;
        uniform float uAlbumTexWarp;

        uniform float uInterlaceMode; // 0 radial, 1 stripes, 2 checker
        uniform float uInterlaceScale;
        uniform float uInterlaceStrength;
        uniform float uFuseBias;

        uniform float uEdgeEmphasis;

        uniform float uSafe;
        uniform float uContrastBoost;

        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float noise(vec2 p){
          vec2 i=floor(p), f=fract(p);
          float a=hash(i), b=hash(i+vec2(1.,0.)), c=hash(i+vec2(0.,1.)), d=hash(i+vec2(1.,1.));
          vec2 u=f*f*(3.-2.*f);
          return mix(a,b,u.x)+(c-a)*u.y*(1.-u.x)+(d-b)*u.x*u.y;
        }
        float fbm(vec2 p){
          float v=0.0, a=0.5;
          for(int i=0;i<5;i++){ v += a*noise(p); p *= 2.03; a *= 0.5; }
          return v;
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

        float foldKaleidoX(float x, float slices){
          float seg = 1.0 / max(1.0, slices);
          float xf = fract(x + 1.0);
          float m = mod(xf, seg) / seg;
          m = abs(m - 0.5) * 2.0;
          return m * seg + floor(xf/seg)*seg;
        }

        float stripeMask(vec2 uv, float scale){ return step(0.0, sin(uv.y*scale)); }
        float checkerMask(vec2 uv, float scale){ vec2 g=floor(uv*scale); return mod(g.x+g.y,2.0); }
        float radialMask(vec2 uv, float scale){ float r=distance(uv, vec2(0.5)); return step(0.0, sin(r*scale*6.28318)); }

        float mosaicMask(vec2 uv, float scale, float roundness){
          vec2 uvA=uv, uvB=rotate2D(uv, 2.09439510239), uvC=rotate2D(uv, -2.09439510239);
          vec2 g1=abs(fract(uvA*scale)-0.5);
          vec2 g2=abs(fract(uvB*scale)-0.5);
          vec2 g3=abs(fract(uvC*scale)-0.5);
          float d=min(min(g1.x+g1.y, g2.x+g2.y), g3.x+g3.y);
          return smoothstep(0.5, 0.5-0.2*roundness, d);
        }

        vec3 sat(vec3 c, float s){ float l=dot(c, vec3(0.299,0.587,0.114)); return mix(vec3(l), c, s); }

        vec3 sampleAlbums(vec2 uv, sampler2D a1, sampler2D a2, float has1, float has2, float cross, float mode, float scale, float strength, float fuseBias){
          vec3 A = has1>0.5 ? texture2D(a1, uv).rgb : vec3(0.0);
          vec3 B = has2>0.5 ? texture2D(a2, uv).rgb : A;
          float m = (mode>1.5) ? checkerMask(uv, scale) : (mode>0.5) ? stripeMask(uv, scale) : radialMask(uv, scale*0.25);
          float imix = mix(0.5, m, clamp(strength,0.0,1.0));
          vec3 inter = mix(B, A, imix);
          float xf = smoothstep(0.0, 1.0, cross);
          float xfBias = clamp(mix(xf, 1.0-xf, clamp(fuseBias,0.0,1.0)), 0.0, 1.0);
          return mix(B, inter, xfBias);
        }

        void main(){
          float time = uTime;

          vec2 uv = vUv;
          float spin = (0.1 + 0.5*uIntensity) * time + uSpin;
          uv = rotate2D(uv, spin);
          float zoom = clamp(0.10 + 0.25*uZoom, 0.0, 0.5);
          uv = mix(uv, (uv - 0.5) * (1.0 - zoom) + 0.5, 0.8);

          vec2 k = uv;
          k.y = fract(k.y - time*0.04 - uScroll);
          k.x = foldKaleidoX(k.x, uSlices);

          vec2 tuv = rotate2D(k, uTexRotate);
          tuv = barrel(tuv, uAlbumTexWarp * (0.25 + 0.75*uIntensity));
          vec2 nrm = vec2(fbm(tuv*3.0 + time*0.08) - 0.5, fbm(tuv*3.2 - time*0.07) - 0.5);
          vec2 baseUV = (tuv * uTexScale) + nrm * (uPrismWarp * 0.08);

          vec3 baseCol = sampleAlbums(baseUV, tAlbum1, tAlbum2, uHasAlbum1, uHasAlbum2, uAlbumCross, uInterlaceMode, uInterlaceScale, uInterlaceStrength, uFuseBias);

          vec3 dispCol = baseCol;
          if (uHasAlbum1 > 0.5) {
            float disp = uPrismDispersion * (0.4 + 0.6*uIntensity);
            vec2 offR = nrm * disp * 0.006;
            vec2 offG = nrm * disp * 0.004 * vec2(-1.0, 1.0);
            vec2 offB = nrm * disp * 0.005 * vec2(1.0, -1.0);
            vec3 r = texture2D(tAlbum1, baseUV + offR).rgb;
            vec3 g = texture2D(tAlbum1, baseUV + offG).rgb;
            vec3 b = texture2D(tAlbum1, baseUV + offB).rgb;
            dispCol = vec3(r.r, g.g, b.b);
          }

          float mode = uShapeMode;
          float mask = 1.0, edge = 0.0;
          if (mode < 0.5) {
            vec2 c = k - 0.5;
            float ang = atan(c.y, c.x);
            float blades = max(3.0, uSlices * 0.5 + 4.0);
            float star = abs(sin(ang * blades));
            mask = smoothstep(0.2, 0.95, star);
            edge = smoothstep(0.75, 0.9, star);
          } else {
            float m = mosaicMask(uv, uTileScale, uTileRound);
            mask = m;
            edge = smoothstep(0.35, 0.6, m) * 0.8;
          }

          vec3 col = mix(baseCol, dispCol, 0.35);
          vec3 edgeCol = mix(uC1, uC2, 0.5 + 0.3*sin(time*0.3));
          col = mix(col, edgeCol, uEdgeEmphasis * edge);
          vec3 pal = mix(mix(uC0, uC1, k.x), mix(uC2, uC3, k.y), 0.5);
          col = mix(col, pal, 0.12 * uIntensity);
          col *= (0.8 + 0.4*mask);

          col = sat(col, mix(uSaturation, 1.0, uSafe*0.3));
          col *= mix(0.6, 1.6, clamp(uExposure, 0.0, 1.6));
          col = col / (1.0 + col);
          col = pow(col, vec3(clamp(uGamma, 0.85, 1.15)));

          vec2 q = vUv - 0.5;
          float vig = 1.0 - clamp(dot(q,q)*1.4, 0.0, 1.0);
          col *= mix(1.0, pow(vig, 1.8), clamp(uVignette, 0.0, 1.0));

          gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        }
      `
    })
    matRef.current = mat

    const tunnelMesh = new THREE.Mesh(tunnel, mat)
    scene.add(tunnelMesh)

    // SAFER uniform setters: rebuild missing uniforms on the fly to avoid null.value
    const ensureUniform = (name: keyof typeof uniforms, init: any) => {
      const m = matRef.current as THREE.ShaderMaterial | null
      const table = m?.uniforms as any
      if (!m || !table) return null
      const u = table[name]
      if (!u || typeof u !== 'object' || !('value' in u)) { table[name] = { value: init }; return table[name] }
      return u
    }
    const setF = (name: keyof typeof uniforms, v: number) => { const u = ensureUniform(name, v); if (u) u.value = v }
    const setV2 = (name: keyof typeof uniforms, x: number, y: number) => {
      const u = ensureUniform(name, new THREE.Vector2(x, y)); if (!u) return
      if (u.value?.isVector2) u.value.set(x, y); else u.value = new THREE.Vector2(x, y)
    }
    const setV3 = (name: keyof typeof uniforms, x: number, y: number, z: number) => {
      const u = ensureUniform(name, new THREE.Vector3(x, y, z)); if (!u) return
      if (u.value?.isVector3) u.value.set(x, y, z); else u.value = new THREE.Vector3(x, y, z)
    }
    const setColor = (name: keyof typeof uniforms, col: THREE.Color) => {
      const u = ensureUniform(name, col.clone()); if (!u) return
      if (u.value?.isColor) u.value.copy(col); else u.value = col.clone()
    }
    const setTex = (name: keyof typeof uniforms, tex: THREE.Texture | null) => { const u = ensureUniform(name, tex); if (u) u.value = tex }

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
    let s = { ...cfgRef.current }

    const animate = () => {
      raf = requestAnimationFrame(animate)
      if (!running || disposed) return

      const dt = Math.min(0.05, clock.getDelta())
      const t = clock.elapsedTime

      const low = latest?.bands?.low ?? 0.06
      const mid = latest?.bands?.mid ?? 0.06
      const high = latest?.bands?.high ?? 0.06
      const loud = latest?.loudness ?? 0.12
      const beat = latest?.beat ? 1.0 : 0.0

      const safe = (accessibility.epilepsySafe || accessibility.reducedMotion) ? 1.0 : 0.0
      const T = cfgRef.current
      const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
      const target = {
        intensity: THREE.MathUtils.clamp(T.intensity, 0, 1.6),
        speed: THREE.MathUtils.clamp(T.speed, 0, 2.0),
        exposure: THREE.MathUtils.clamp(T.exposure, 0, 1.6),
        saturation: THREE.MathUtils.clamp(T.saturation, 0.6, 1.6),
        gamma: THREE.MathUtils.clamp(T.gamma, 0.85, 1.15),
        vignette: clamp01(T.vignette),

        shapeMode: (T.shapeMode === 1 ? 1 : 0) as 0 | 1,
        slices: Math.max(1, Math.min(48, Math.round(T.slices))),
        tileScale: THREE.MathUtils.clamp(T.tileScale, 0.8, 6.0),
        tileRound: clamp01(T.tileRound),

        prismDispersion: clamp01(T.prismDispersion),
        prismWarp: clamp01(T.prismWarp),

        texScaleU: THREE.MathUtils.clamp(T.texScaleU, 0.5, 6.0),
        texScaleV: THREE.MathUtils.clamp(T.texScaleV, 0.5, 6.0),
        texRotate: THREE.MathUtils.clamp(T.texRotate, -Math.PI, Math.PI),
        albumTexWarp: THREE.MathUtils.clamp(T.albumTexWarp, 0, 0.8),

        interlaceMode: (T.interlaceMode === 1 || T.interlaceMode === 2) ? T.interlaceMode : 0 as 0 | 1 | 2,
        interlaceScale: THREE.MathUtils.clamp(T.interlaceScale, 40, 600),
        interlaceStrength: clamp01(T.interlaceStrength),
        fuseBias: clamp01(T.fuseBias),

        edgeEmphasis: THREE.MathUtils.clamp(T.edgeEmphasis, 0, 1)
      }

      const k = 1 - Math.pow(0.0001, dt)
      ;(Object.keys(target) as (keyof typeof target)[]).forEach(key => {
        // @ts-ignore
        s[key] += (target[key] - s[key]) * k
      })

      const kIntensity = THREE.MathUtils.lerp(s.intensity, Math.min(s.intensity, 0.6), safe)
      const kSpeed = THREE.MathUtils.lerp(s.speed, Math.min(s.speed, 0.4), safe)

      const spin = 0.28 * kSpeed + 0.14 * high + 0.06 * Math.sin(t * 0.45)
      const zoom = 0.24 * kIntensity + 0.17 * mid + 0.12 * (beat > 0.5 ? 1.0 : 0.0)

      scrollRef.current += dt * (0.24 + 1.05 * kSpeed + 0.48 * loud)
      crossRef.current = Math.min(1, crossRef.current + dt * 0.35)

      setF('uTime', t)
      setV3('uAudio', low, mid, high)
      setF('uLoud', loud)
      setF('uBeat', beat)
      setF('uSafe', safe)
      setF('uContrastBoost', accessibility.highContrast ? 1.0 : 0.0)

      setF('uScroll', scrollRef.current)
      setF('uSpin', spin)
      setF('uZoom', zoom)

      setF('uIntensity', kIntensity)
      setF('uSpeed', kSpeed)
      setF('uExposure', s.exposure)
      setF('uSaturation', s.saturation)
      setF('uGamma', s.gamma)
      setF('uVignette', s.vignette)

      setF('uShapeMode', s.shapeMode)
      setF('uSlices', s.slices)
      setF('uTileScale', s.tileScale)
      setF('uTileRound', s.tileRound)

      setF('uPrismDispersion', s.prismDispersion)
      setF('uPrismWarp', s.prismWarp)

      setV2('uTexScale', s.texScaleU, s.texScaleV)
      setF('uTexRotate', s.texRotate)
      setF('uAlbumTexWarp', s.albumTexWarp)

      setF('uInterlaceMode', s.interlaceMode)
      setF('uInterlaceScale', s.interlaceScale)
      setF('uInterlaceStrength', s.interlaceStrength)
      setF('uFuseBias', s.fuseBias)

      setF('uEdgeEmphasis', s.edgeEmphasis)

      setF('uHasAlbum1', has1Ref.current ? 1.0 : 0.0)
      setF('uHasAlbum2', has2Ref.current ? 1.0 : 0.0)
      setF('uAlbumCross', crossRef.current)

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

      tAlbum1Ref.current?.dispose(); tAlbum1Ref.current = null
      tAlbum2Ref.current?.dispose(); tAlbum2Ref.current = null
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
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} aria-label="Album Kaleidoscope Tunnel" />
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
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, margin: '6px 0' }}>
      <label style={{ fontSize: 12, opacity: 0.9, minWidth: 140 }}>{p.label}</label>
      <div style={{ flex: 1 }}>{p.children}</div>
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
  const onRange = (cb: (v: number) => void) => (e: React.ChangeEvent<HTMLInputElement>) => cb(Number(e.currentTarget.value))

  return (
    <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 10, userSelect: 'none', pointerEvents: 'auto' }}>
      <button onClick={(e) => { e.stopPropagation(); onToggle() }} style={btnStyle}>
        {open ? 'Close Visual Settings' : 'Visual Settings'}
      </button>
      {open && (
        <div style={{
          width: 380, marginTop: 8, padding: 12, border: '1px solid #2b2f3a', borderRadius: 8,
          background: 'rgba(10,12,16,0.94)', color: '#e6f0ff', fontFamily: 'system-ui, sans-serif', fontSize: 12, lineHeight: 1.4
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
            </div>
          </Card>

          <Card title="Core">
            <Row label={`Intensity ${cfg.intensity.toFixed(2)}`}>
              <input type="range" min={0} max={1.6} step={0.01} value={cfg.intensity}
                     onChange={onRange(v => onChange(prev => ({ ...prev, intensity: Math.max(0, Math.min(1.6, v)) })))} />
            </Row>
            <Row label={`Speed ${cfg.speed.toFixed(2)}`}>
              <input type="range" min={0} max={2} step={0.01} value={cfg.speed}
                     onChange={onRange(v => onChange(prev => ({ ...prev, speed: Math.max(0, Math.min(2, v)) })))} />
            </Row>
            <Row label={`Exposure ${cfg.exposure.toFixed(2)}`}>
              <input type="range" min={0} max={1.6} step={0.01} value={cfg.exposure}
                     onChange={onRange(v => onChange(prev => ({ ...prev, exposure: Math.max(0, Math.min(1.6, v)) })))} />
            </Row>
            <Row label={`Saturation ${cfg.saturation.toFixed(2)}`}>
              <input type="range" min={0.6} max={1.6} step={0.01} value={cfg.saturation}
                     onChange={onRange(v => onChange(prev => ({ ...prev, saturation: Math.max(0.6, Math.min(1.6, v)) })))} />
            </Row>
            <Row label={`Gamma ${cfg.gamma.toFixed(3)}`}>
              <input type="range" min={0.85} max={1.15} step={0.001} value={cfg.gamma}
                     onChange={onRange(v => onChange(prev => ({ ...prev, gamma: Math.max(0.85, Math.min(1.15, v)) })))} />
            </Row>
            <Row label={`Vignette ${cfg.vignette.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.vignette}
                     onChange={onRange(v => onChange(prev => ({ ...prev, vignette: Math.max(0, Math.min(1, v)) })))} />
            </Row>
          </Card>

          <Card title="Shape (Vortex Prism / Liquid Mosaic)">
            <Row label="Shape Mode">
              <select
                value={cfg.shapeMode}
                onChange={e => onChange(prev => ({ ...prev, shapeMode: (Number(e.currentTarget.value) === 1 ? 1 : 0) as Cfg['shapeMode'] }))}
                style={{ width: '100%', background: '#0f1218', color: '#cfe7ff', border: '1px solid #2b2f3a', borderRadius: 6, padding: '6px' }}
              >
                <option value={0}>Vortex Prism</option>
                <option value={1}>Liquid Mosaic</option>
              </select>
            </Row>
            <Row label={`Slices (prism) ${Math.round(cfg.slices)}`}>
              <input type="range" min={1} max={48} step={1} value={cfg.slices}
                     onChange={onRange(v => onChange(prev => ({ ...prev, slices: Math.max(1, Math.min(48, Math.round(v))) })))} />
            </Row>
            <Row label={`Tile Scale (mosaic) ${cfg.tileScale.toFixed(2)}`}>
              <input type="range" min={0.8} max={6} step={0.01} value={cfg.tileScale}
                     onChange={onRange(v => onChange(prev => ({ ...prev, tileScale: Math.max(0.8, Math.min(6, v)) })))} />
            </Row>
            <Row label={`Tile Round (mosaic) ${cfg.tileRound.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.tileRound}
                     onChange={onRange(v => onChange(prev => ({ ...prev, tileRound: Math.max(0, Math.min(1, v)) })))} />
            </Row>
            <Row label={`Edge Emphasis ${cfg.edgeEmphasis.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.edgeEmphasis}
                     onChange={onRange(v => onChange(prev => ({ ...prev, edgeEmphasis: Math.max(0, Math.min(1, v)) })))} />
            </Row>
          </Card>

          <Card title="Prism / Refraction">
            <Row label={`Dispersion ${cfg.prismDispersion.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.prismDispersion}
                     onChange={onRange(v => onChange(prev => ({ ...prev, prismDispersion: Math.max(0, Math.min(1, v)) })))} />
            </Row>
            <Row label={`Warp ${cfg.prismWarp.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.prismWarp}
                     onChange={onRange(v => onChange(prev => ({ ...prev, prismWarp: Math.max(0, Math.min(1, v)) })))} />
            </Row>
          </Card>

          <Card title="Album Texture Mapping">
            <Row label={`Tex Scale U ${cfg.texScaleU.toFixed(2)}`}>
              <input type="range" min={0.5} max={6} step={0.01} value={cfg.texScaleU}
                     onChange={onRange(v => onChange(prev => ({ ...prev, texScaleU: Math.max(0.5, Math.min(6, v)) })))} />
            </Row>
            <Row label={`Tex Scale V ${cfg.texScaleV.toFixed(2)}`}>
              <input type="range" min={0.5} max={6} step={0.01} value={cfg.texScaleV}
                     onChange={onRange(v => onChange(prev => ({ ...prev, texScaleV: Math.max(0.5, Math.min(6, v)) })))} />
            </Row>
            <Row label={`Tex Rotate ${cfg.texRotate.toFixed(2)} rad`}>
              <input type="range" min={-3.14159} max={3.14159} step={0.01} value={cfg.texRotate}
                     onChange={onRange(v => onChange(prev => ({ ...prev, texRotate: Math.max(-Math.PI, Math.min(Math.PI, v)) })))} />
            </Row>
            <Row label={`Tex Warp ${cfg.albumTexWarp.toFixed(2)}`}>
              <input type="range" min={0} max={0.8} step={0.01} value={cfg.albumTexWarp}
                     onChange={onRange(v => onChange(prev => ({ ...prev, albumTexWarp: Math.max(0, Math.min(0.8, v)) })))} />
            </Row>
          </Card>

          <Card title="Interlacing / Fusion">
            <Row label="Mode">
              <select
                value={cfg.interlaceMode}
                onChange={e => onChange(prev => {
                  const val = Number(e.currentTarget.value)
                  return { ...prev, interlaceMode: (val === 2 ? 2 : val === 1 ? 1 : 0) as Cfg['interlaceMode'] }
                })}
                style={{ width: '100%', background: '#0f1218', color: '#cfe7ff', border: '1px solid #2b2f3a', borderRadius: 6, padding: '6px' }}
              >
                <option value={0}>Radial (for Prism)</option>
                <option value={1}>Stripes</option>
                <option value={2}>Checker</option>
              </select>
            </Row>
            <Row label={`Scale ${cfg.interlaceScale.toFixed(0)}`}>
              <input type="range" min={40} max={600} step={1} value={cfg.interlaceScale}
                     onChange={onRange(v => onChange(prev => ({ ...prev, interlaceScale: Math.max(40, Math.min(600, v)) })))} />
            </Row>
            <Row label={`Strength ${cfg.interlaceStrength.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.interlaceStrength}
                     onChange={onRange(v => onChange(prev => ({ ...prev, interlaceStrength: Math.max(0, Math.min(1, v)) })))} />
            </Row>
            <Row label={`Fuse Bias prev↔current ${cfg.fuseBias.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.fuseBias}
                     onChange={onRange(v => onChange(prev => ({ ...prev, fuseBias: Math.max(0, Math.min(1, v)) })))} />
            </Row>
          </Card>

          <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'space-between' }}>
            <button onClick={onApplyPreset} style={btnStyle}>Apply Preset</button>
            <button onClick={onToggle} style={btnStyle}>Close</button>
          </div>
        </div>
      )}
    </div>
  )
}
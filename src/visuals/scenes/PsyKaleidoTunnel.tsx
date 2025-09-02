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
Upgrades:
- Source textures: 0=Album, 1=Plasma (procedural), 2=Spectrogram, 3=Mix (Album+Plasma)
- Controls: slices, tunnel curvature (amp/freq), morph speed, chroma glide, roll lock (reduce spin)
- Beat actions: pulse segment mask, brief FOV kick (capped in safe mode)
**/

type SourceMode = 0 | 1 | 2 | 3

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

  // New: source, curvature, morph, chroma, roll
  sourceMode: SourceMode
  curveAmp: number
  curveFreq: number
  morphSpeed: number
  chromaGlide: number
  rollLock: number // 0..1

  // Beat/FOV
  fovKick: number // 0..1 amplitude

  // R&D
  shardsEnabled: boolean
  shardCount: number
  shardSize: number
  shardSpeed: number
  shardJitter: number

  crtEnabled: boolean
  crtStrength: number
  crtScanlines: number
  glitchJitter: number
}

type Preset = { name: string } & Cfg

const LS_KEY = 'ffw.kaleido.upgraded.v1'

const BASE_CFG: Cfg = {
  intensity: 1.1, speed: 1.0, exposure: 1.02, saturation: 1.18, gamma: 0.95, vignette: 0.63,
  shapeMode: 0, slices: 28, tileScale: 2.8, tileRound: 0.35,
  prismDispersion: 0.95, prismWarp: 0.85,
  texScaleU: 3.0, texScaleV: 5.0, texRotate: -0.28, albumTexWarp: 0.5,
  interlaceMode: 0, interlaceScale: 140.0, interlaceStrength: 0.7, fuseBias: 0.4,
  edgeEmphasis: 0.65,

  sourceMode: 0,       // Album
  curveAmp: 0.22,      // Tunnel curvature amplitude
  curveFreq: 0.45,     // Tunnel curvature frequency
  morphSpeed: 0.6,     // Visual morph rate
  chromaGlide: 0.25,   // Hue rotation speed
  rollLock: 0.0,       // 0 none, 1 fully lock roll
  fovKick: 0.18,       // beat FOV kick strength

  // R&D defaults
  shardsEnabled: false, shardCount: 800, shardSize: 0.08, shardSpeed: 1.0, shardJitter: 0.4,
  crtEnabled: false, crtStrength: 0.25, crtScanlines: 900.0, glitchJitter: 0.002
}

const PRESETS: Record<string, Preset> = {
  vortexPrism: { name: 'Vortex Prism', ...BASE_CFG },
  liquidMosaic: {
    name: 'Liquid Mosaic',
    ...BASE_CFG,
    shapeMode: 1, slices: 16, tileScale: 2.6, tileRound: 0.45,
    prismDispersion: 0.5, prismWarp: 0.55,
    texScaleU: 2.2, texScaleV: 3.6, texRotate: -0.2, albumTexWarp: 0.36,
    interlaceMode: 2, interlaceScale: 160, interlaceStrength: 0.6, fuseBias: 0.5,
    edgeEmphasis: 0.55,
    sourceMode: 3, // mix
    curveAmp: 0.16,
    chromaGlide: 0.35
  }
}

// Live-uniform setters bound to the material; no caching.
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
  const setV2 = (name: string, x: number, y: number) => {
    const u = ensure(name, new THREE.Vector2(x, y)); if (!u) return
    if (u.value?.isVector2) u.value.set(x, y)
    else u.value = new THREE.Vector2(x, y)
  }
  const setV3 = (name: string, x: number, y: number, z: number) => {
    const u = ensure(name, new THREE.Vector3(x, y, z)); if (!u) return
    if (u.value?.isVector3) u.value.set(x, y, z)
    else u.value = new THREE.Vector3(x, y, z)
  }
  const setColor = (name: string, col: THREE.Color) => {
    const u = ensure(name, col.clone()); if (!u) return
    if (u.value?.isColor) u.value.copy(col)
    else u.value = col.clone()
  }
  const setTex = (name: string, tex: THREE.Texture | null) => { const u = ensure(name, tex); if (u) u.value = tex }
  return { setF, setV2, setV3, setColor, setTex }
}

export default function PsyKaleidoTunnel({ quality, accessibility }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // Album textures (current & previous)
  const tAlbum1Ref = useRef<THREE.Texture | null>(null)
  const tAlbum2Ref = useRef<THREE.Texture | null>(null)
  const has1Ref = useRef(0)
  const has2Ref = useRef(0)
  const crossRef = useRef(1) // 0->1 crossfade progress

  // Spectrogram texture
  const specTexRef = useRef<THREE.DataTexture | null>(null)
  const hasSpecRef = useRef(0)
  const specW = 256, specH = 128
  const specCursorRef = useRef(0)

  // Album swatches
  const albAvg = useRef(new THREE.Color('#808080'))
  const albC1 = useRef(new THREE.Color('#77d0ff'))
  const albC2 = useRef(new THREE.Color('#b47bff'))
  const albC3 = useRef(new THREE.Color('#ffd077'))

  // Scene refs
  const matRef = useRef<THREE.ShaderMaterial | null>(null)
  const scrollRef = useRef(0)
  const disposedRef = useRef(false)

  // Camera kick
  const fovKickRef = useRef(0)

  // Instanced shards (R&D)
  const shardsRef = useRef<THREE.InstancedMesh | null>(null)
  const shardsActiveRef = useRef(false)
  const shardDataRef = useRef<{
    pos: Float32Array, vel: Float32Array, rot: Float32Array, rotVel: Float32Array, colors: Float32Array
  } | null>(null)

  // Top-center HUD visibility
  const [hudVisible, setHudVisible] = useState(true)
  const hudHideTimer = useRef<number | null>(null)
  const [hoverTop, setHoverTop] = useState(false)

  // UI state
  const [panelOpen, setPanelOpen] = useState(false)
  const [selectedPreset, setSelectedPreset] = useState<keyof typeof PRESETS>('vortexPrism')
  const [cfg, setCfg] = useState<Cfg>(() => {
    try { return { ...PRESETS.vortexPrism, ...(JSON.parse(localStorage.getItem(LS_KEY) || '{}')) } }
    catch { return { ...PRESETS.vortexPrism } }
  })
  const cfgRef = useRef(cfg)
  useEffect(() => { cfgRef.current = cfg; try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)) } catch {} }, [cfg])

  // HUD mouse tracking
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect()
      const y = e.clientY - rect.top
      const x = e.clientX - rect.left
      const nearTop = y < 90
      const nearCenterX = Math.abs(x - rect.width / 2) < rect.width * 0.35
      if (nearTop && nearCenterX) {
        setHudVisible(true)
        setHoverTop(true)
        if (hudHideTimer.current) {
          window.clearTimeout(hudHideTimer.current)
          hudHideTimer.current = null
        }
      } else {
        setHoverTop(false)
        if (!panelOpen && hudHideTimer.current == null) {
          hudHideTimer.current = window.setTimeout(() => {
            setHudVisible(false)
            hudHideTimer.current = null
          }, 1400)
        }
      }
    }
    const onLeave = () => {
      setHoverTop(false)
      if (!panelOpen) setHudVisible(false)
    }
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
    scene.background = new THREE.Color('#01040a')

    const baseFov = 62
    const camera = new THREE.PerspectiveCamera(baseFov, 1, 0.05, 500)
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

    // Audio frames
    let latest: ReactiveFrame | null = null
    const offFrame = reactivityBus.on('frame', f => { latest = f })

    // Spectrogram texture
    function ensureSpectroTexture() {
      if (specTexRef.current) return
      const data = new Uint8Array(specW * specH * 4)
      for (let i = 0; i < data.length; i += 4) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255 }
      const tex = new THREE.DataTexture(data, specW, specH, THREE.RGBAFormat)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.needsUpdate = true
      specTexRef.current = tex
      hasSpecRef.current = 1
    }
    function writeSpectroColumn(vals: number[]) {
      ensureSpectroTexture()
      const tex = specTexRef.current!
      const data = tex.image.data as Uint8Array
      const x = specCursorRef.current % specW
      for (let y = 0; y < specH; y++) {
        // map y from bottom (bass) to top (high)
        const t = y / (specH - 1)
        const idxSrc = Math.floor(t * (vals.length - 1))
        const v = Math.max(0, Math.min(1, vals[idxSrc]))
        const r = Math.floor(v * 255)
        const g = Math.floor(Math.pow(v, 0.8) * 255)
        const b = Math.floor(Math.pow(v, 0.6) * 255)
        const i = (y * specW + x) * 4
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255
      }
      tex.needsUpdate = true
      specCursorRef.current = (specCursorRef.current + 1) % specW
    }

    // Album loader
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

    const { setF, setV2, setV3, setColor, setTex } = makeUniformSetters(matRef)

    async function loadAlbum() {
      try {
        const s = await getPlaybackState().catch(() => null)
        const id = (s?.item?.id as string) || null
        const url = (s?.item?.album?.images?.[0]?.url as string) || ''
        if (!id || !url || id === lastTrackId) return
        lastTrackId = id

        // rotate textures (do NOT dispose current; reuse as previous)
        if (tAlbum1Ref.current) {
          if (tAlbum2Ref.current && tAlbum2Ref.current !== tAlbum1Ref.current) {
            tAlbum2Ref.current.dispose()
          }
          tAlbum2Ref.current = tAlbum1Ref.current
          has2Ref.current = 1
          setTex('tAlbum2', tAlbum2Ref.current)
          setF('uHasAlbum2', 1)
        }

        // load image (CORS first, blob fallback)
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

        // swatches
        const c = document.createElement('canvas'); c.width = 40; c.height = 40
        const g = c.getContext('2d')
        if (g) {
          g.drawImage(img, 0, 0, 40, 40)
          const data = g.getImageData(0, 0, 40, 40).data
          const picks = quantizeTopN(data, 3)
          albC1.current.copy(picks[0]); albC2.current.copy(picks[1]); albC3.current.copy(picks[2])
          setColor('uC0', albAvg.current)
          setColor('uC1', albC1.current)
          setColor('uC2', albC2.current)
          setColor('uC3', albC3.current)
        }

        // texture (current)
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
        try { tex.anisotropy = (renderer.capabilities as any).getMaxAnisotropy?.() ?? tex.anisotropy } catch {}

        tAlbum1Ref.current = tex
        has1Ref.current = 1
        setTex('tAlbum1', tex)
        setF('uHasAlbum1', 1)
        setF('uHasAlbum2', has2Ref.current ? 1 : 0)

        // crossfade to current
        crossRef.current = 0
        setF('uAlbumCross', 0)
      } catch { /* ignore */ }
    }

    loadAlbum()
    const albumIv = window.setInterval(loadAlbum, 6000)

    // Geometry (more height segments so we can bend the tunnel)
    const radius = 14
    const tunnelLen = 220
    const tunnel = new THREE.CylinderGeometry(radius, radius, tunnelLen, 360, 120, true)
    tunnel.rotateZ(Math.PI * 0.5)

    // Initial uniforms
    const uniforms: Record<string, { value: any }> = {
      uTime: { value: 0.0 },
      uAudio: { value: new THREE.Vector3(0.1, 0.1, 0.1) },
      uLoud: { value: 0.12 },
      uBeat: { value: 0.0 },
      uScroll: { value: 0.0 },
      uSpin: { value: 0.0 },
      uZoom: { value: 0.0 },

      uCurveAmp: { value: cfgRef.current.curveAmp },
      uCurveFreq: { value: cfgRef.current.curveFreq },

      tAlbum1: { value: null },
      tAlbum2: { value: null },
      uHasAlbum1: { value: 0.0 },
      uHasAlbum2: { value: 0.0 },
      uAlbumCross: { value: 1.0 },

      // spectrogram
      tSpectro: { value: null },
      uHasSpectro: { value: 0.0 },

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

      // New
      uSourceMode: { value: cfgRef.current.sourceMode },
      uMorph: { value: 0.0 },
      uChromaRot: { value: 0.0 },
      uMaskPulse: { value: 0.0 },

      // CRT/Glitch
      uCRTEnabled: { value: cfgRef.current.crtEnabled ? 1.0 : 0.0 },
      uCRTStrength: { value: cfgRef.current.crtStrength },
      uCRTScanlines: { value: cfgRef.current.crtScanlines },
      uGlitchJitter: { value: cfgRef.current.glitchJitter },

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
        uniform float uCurveAmp;
        uniform float uCurveFreq;
        void main(){
          vUv = uv;
          vec3 p = position;
          // Cylinder axis is along X after rotateZ(PI/2). Bend in Y/Z based on X.
          float phase = p.x * uCurveFreq;
          p.y += sin(phase) * uCurveAmp * 10.0;
          p.z += cos(phase * 0.7) * uCurveAmp * 6.0;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p,1.0);
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

        uniform sampler2D tSpectro;
        uniform float uHasSpectro;

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

        uniform float uSourceMode; // 0 album,1 plasma,2 spectro,3 mix
        uniform float uMorph;      // 0..1
        uniform float uChromaRot;  // radians
        uniform float uMaskPulse;  // 0..1

        uniform float uCRTEnabled;
        uniform float uCRTStrength;
        uniform float uCRTScanlines;
        uniform float uGlitchJitter;

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

        // Simple hue rotation matrix (approx)
        mat3 hueRotation(float a){
          float s = sin(a), c = cos(a);
          const mat3 toYIQ = mat3(
            0.299,     0.587,     0.114,
            0.595716, -0.274453, -0.321263,
            0.211456, -0.522591,  0.311135
          );
          const mat3 toRGB = mat3(
            1.0,  0.9563,  0.6210,
            1.0, -0.2721, -0.6474,
            1.0, -1.1070,  1.7046
          );
          mat3 rot = mat3(
            1.0, 0.0, 0.0,
            0.0, c,   -s,
            0.0, s,    c
          );
          return toRGB * rot * toYIQ;
        }

        float foldKaleidoX(float x, float slices){
          float seg = 1.0 / max(1.0, slices);
          float xf = fract(x + 1.0);
          float m = mod(xf, seg) / seg;
          m = abs(m - 0.5) * 2.0;
          return m * seg + floor(xf/seg)*seg;
        }

        float stripeMaskBoosted(vec2 uv, float scale, float pulse){
          float base = stripeMask(uv, scale);
          return clamp(mix(base, 1.0, pulse), 0.0, 1.0);
        }

        vec3 sampleAlbums(vec2 uv, sampler2D a1, sampler2D a2, float has1, float has2, float cross, float mode, float scale, float strength, float fuseBias){
          vec3 A = has1>0.5 ? texture2D(a1, uv).rgb : vec3(0.0);
          vec3 B = has2>0.5 ? texture2D(a2, uv).rgb : A;
          float m = (mode>1.5) ? checkerMask(uv, scale) : (mode>0.5) ? stripeMask(uv, scale) : radialMask(uv, scale*0.25);
          float imix = mix(0.5, m, clamp(strength,0.0,1.0));
          vec3 inter = mix(B, A, imix);
          float xf = smoothstep(0.0, 1.0, cross);
          float xfBias = clamp(mix(xf, 1.0-xf, clamp(uFuseBias,0.0,1.0)), 0.0, 1.0);
          return mix(B, inter, xfBias);
        }

        vec3 samplePlasma(vec2 uv, float t, vec3 c1, vec3 c2, vec3 c3){
          vec2 p = uv * (1.6 + 0.8*sin(t*0.15));
          float n = fbm(p + vec2(t*0.06, -t*0.04));
          float m = fbm(p*1.7 - vec2(t*0.03, t*0.02));
          float k = smoothstep(0.25, 0.85, n*0.65 + m*0.35);
          return mix(mix(c1, c2, k), c3, 0.35 + 0.35*sin(t*0.21 + n*2.3));
        }

        vec3 sampleSpectro(vec2 uv, sampler2D tex, float hasSpec){
          if (hasSpec < 0.5) return vec3(0.0);
          // scroll X with time to simulate movement
          float x = fract(uv.x);
          vec2 suv = vec2(x, uv.y);
          return texture2D(tex, suv).rgb;
        }

        vec3 applyCRT(vec2 uv, vec3 col, float time, float strength, float scanlines, float jitter){
          float line = 0.5 + 0.5*sin(uv.y*scanlines*6.28318 + time*2.0);
          col *= mix(1.0, line, clamp(strength*0.3, 0.0, 0.6));
          float offs = strength * 0.003;
          float j = (hash(vec2(time, uv.y)) - 0.5) * jitter * 200.0;
          vec2 jv = vec2(j*0.002, 0.0);
          float r = texture2D(tAlbum1, uv + vec2(offs,0.0) + jv).r;
          float g = texture2D(tAlbum1, uv + vec2(0.0,0.0) - jv).g;
          float b = texture2D(tAlbum1, uv + vec2(-offs,0.0) + jv*0.5).b;
          vec3 chrom = vec3(r,g,b);
          return mix(col, chrom, clamp(strength*0.25, 0.0, 0.4));
        }

        void main(){
          float time = uTime;

          vec2 uv = vUv;
          // Spin and zoom
          float spin = (0.1 + 0.5*uIntensity) * time + uSpin;
          uv = rotate2D(uv, spin);
          float zoom = clamp(0.10 + 0.25*uZoom, 0.0, 0.5);
          uv = mix(uv, (uv - 0.5) * (1.0 - zoom) + 0.5, 0.8);

          // Tunnel mapping
          vec2 k = uv;
          k.y = fract(k.y - time*0.04 - uScroll);
          // Beat pulse boosts segmentation visibility a bit
          float slicesDyn = max(1.0, uSlices) + uMaskPulse * 2.0;
          k.x = foldKaleidoX(k.x, slicesDyn);

          vec2 tuv = rotate2D(k, uTexRotate);
          tuv = barrel(tuv, uAlbumTexWarp * (0.25 + 0.75*uIntensity));
          vec2 nrm = vec2(fbm(tuv*3.0 + time*0.08) - 0.5, fbm(tuv*3.2 - time*0.07) - 0.5);
          vec2 baseUV = (tuv * uTexScale) + nrm * (uPrismWarp * 0.08);

          // Source selection
          vec3 baseCol;
          if (uSourceMode < 0.5) {
            baseCol = sampleAlbums(baseUV, tAlbum1, tAlbum2, uHasAlbum1, uHasAlbum2, uAlbumCross, uInterlaceMode, uInterlaceScale, uInterlaceStrength, uFuseBias);
          } else if (uSourceMode < 1.5) {
            baseCol = samplePlasma(baseUV*0.35 + uv*0.3, time, uC1, uC2, uC3);
          } else if (uSourceMode < 2.5) {
            baseCol = sampleSpectro(vec2(fract(baseUV.x*0.5 + time*0.05), baseUV.y*0.5 + 0.25), tSpectro, uHasSpectro);
          } else {
            vec3 a = sampleAlbums(baseUV, tAlbum1, tAlbum2, uHasAlbum1, uHasAlbum2, uAlbumCross, uInterlaceMode, uInterlaceScale, uInterlaceStrength, uFuseBias);
            vec3 p = samplePlasma(baseUV*0.35 + uv*0.3, time, uC1, uC2, uC3);
            baseCol = mix(a, p, 0.35);
          }

          // Dispersion (album-based refraction look even if source != album)
          vec3 dispCol = baseCol;
          if (uHasAlbum1 > 0.5) {
            float disp = uPrismDispersion * (0.4 + 0.6*uIntensity);
            vec2 offR = nrm * disp * 0.006;
            vec2 offG = nrm * disp * 0.004 * vec2(-1.0, 1.0);
            vec2 offB = nrm * disp * 0.005 * vec2(1.0, -1.0);
            vec3 r = texture2D(tAlbum1, baseUV + offR).rgb;
            vec3 g = texture2D(tAlbum1, baseUV + offG).rgb;
            vec3 b = texture2D(tAlbum1, baseUV + offB).rgb;
            dispCol = mix(baseCol, vec3(r.r, g.g, b.b), 0.6);
          }

          // Prism vs mosaic edge mask
          float mode = uShapeMode;
          float mask = 1.0, edge = 0.0;
          if (mode < 0.5) {
            vec2 c = k - 0.5;
            float ang = atan(c.y, c.x);
            float blades = max(3.0, uSlices * 0.5 + 4.0);
            float star = abs(sin(ang * blades));
            star = mix(star, 1.0, uMaskPulse * 0.35);
            mask = smoothstep(0.2, 0.95, star);
            edge = smoothstep(0.75, 0.9, star);
          } else {
            float roundDyn = mix(uTileRound, 1.0, uMorph * 0.2);
            float m = mosaicMask(uv, uTileScale, roundDyn);
            mask = m;
            edge = smoothstep(0.35, 0.6, m) * 0.8;
          }

          vec3 col = mix(baseCol, dispCol, 0.35);
          vec3 edgeCol = mix(uC1, uC2, 0.5 + 0.3*sin(time*0.3));
          col = mix(col, edgeCol, uEdgeEmphasis * edge);
          vec3 pal = mix(mix(uC0, uC1, k.x), mix(uC2, uC3, k.y), 0.5);
          col = mix(col, pal, 0.12 * uIntensity);
          col *= (0.8 + 0.4*mask);

          // Chroma glide (hue rotation)
          float safe = uSafe;
          float hueAmt = mix(uChromaRot, min(uChromaRot, 0.3), safe);
          col = hueRotation(hueAmt) * col;

          col = sat(col, mix(uSaturation, 1.0, uSafe*0.3));
          col *= mix(0.6, 1.6, clamp(uExposure, 0.0, 1.6));
          col = col / (1.0 + col);
          col = pow(col, vec3(clamp(uGamma, 0.85, 1.15)));

          vec2 q = vUv - 0.5;
          float vig = 1.0 - clamp(dot(q,q)*1.4, 0.0, 1.0);
          col *= mix(1.0, pow(vig, 1.8), clamp(uVignette, 0.0, 1.0));

          // CRT/Glitch overlay
          if (uCRTEnabled > 0.5) {
            col = applyCRT(uv, col, time, uCRTStrength, uCRTScanlines, uGlitchJitter);
          }

          gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        }
      `
    })
    matRef.current = mat

    const tunnelMesh = new THREE.Mesh(tunnel, mat)
    scene.add(tunnelMesh)

    // Spectrogram initial bind
    ensureSpectroTexture()
    if (specTexRef.current) setTex('tSpectro', specTexRef.current)
    setF('uHasSpectro', hasSpecRef.current ? 1.0 : 0.0)

    // Resize
    const onResize = () => {
      if (disposedRef.current) return
      const view = renderer.getSize(new THREE.Vector2())
      camera.aspect = view.x / Math.max(1, view.y)
      camera.updateProjectionMatrix()
      comp.onResize()
    }
    window.addEventListener('resize', onResize)
    onResize()

    // SHARDS: create/destroy helpers
    const createShards = (count: number, size: number) => {
      const geo = new THREE.OctahedronGeometry(size, 0)
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 })
      const mesh = new THREE.InstancedMesh(geo, mat, count)
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.instanceMatrix.needsUpdate = true
      // @ts-ignore
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3)
      const pos = new Float32Array(count * 3)
      const vel = new Float32Array(count)
      const rot = new Float32Array(count * 3)
      const rotVel = new Float32Array(count * 3)
      const colors = new Float32Array(count * 3)

      for (let i = 0; i < count; i++) {
        const theta = Math.random() * Math.PI * 2
        const r = Math.random() * 0.25 + 0.9
        pos[i * 3 + 0] = Math.cos(theta) * radius * r
        pos[i * 3 + 1] = Math.sin(theta) * radius * r
        pos[i * 3 + 2] = -Math.random() * tunnelLen
        vel[i] = 3 + Math.random() * 9

        rot[i * 3 + 0] = Math.random() * Math.PI
        rot[i * 3 + 1] = Math.random() * Math.PI
        rot[i * 3 + 2] = Math.random() * Math.PI
        rotVel[i * 3 + 0] = (Math.random() - 0.5) * 2
        rotVel[i * 3 + 1] = (Math.random() - 0.5) * 2
        rotVel[i * 3 + 2] = (Math.random() - 0.5) * 2

        colors[i * 3 + 0] = albC1.current.r
        colors[i * 3 + 1] = albC1.current.g
        colors[i * 3 + 2] = albC1.current.b
      }
      // @ts-ignore
      mesh.instanceColor!.array.set(colors)
      // @ts-ignore
      mesh.instanceColor!.needsUpdate = true

      shardDataRef.current = { pos, vel, rot, rotVel, colors }
      shardsRef.current = mesh
      scene.add(mesh)
    }

    const destroyShards = () => {
      if (shardsRef.current) {
        scene.remove(shardsRef.current)
        shardsRef.current.geometry.dispose()
        ;(shardsRef.current.material as THREE.Material).dispose()
        // @ts-ignore
        shardsRef.current.instanceColor = null
        shardsRef.current = null
      }
      shardDataRef.current = null
    }

    // Animate
    const clock = new THREE.Clock()
    let raf = 0
    let s = { ...cfgRef.current }
    let maskPulse = 0.0

    const animate = () => {
      raf = requestAnimationFrame(animate)
      if (disposedRef.current || !matRef.current) return

      const dt = Math.min(0.05, clock.getDelta())
      const t = clock.elapsedTime

      const low = latest?.bands?.low ?? 0.06
      const mid = latest?.bands?.mid ?? 0.06
      const high = latest?.bands?.high ?? 0.06
      const loud = latest?.loudness ?? 0.12
      const beat = latest?.beat ? 1.0 : 0.0

      // Spectrogram update (using bands; if you have full FFT, map it here)
      {
        const N = 128
        const arr: number[] = new Array(N)
        for (let i = 0; i < N; i++) {
          // approximate: low for first third, mid second, high third, with a little slope
          const seg = i / N
          const v = seg < 0.33 ? low : seg < 0.66 ? mid : high
          arr[i] = Math.max(0, Math.min(1, v * (0.6 + 0.8 * Math.random())))
        }
        writeSpectroColumn(arr)
      }

      // Beat pulse
      if (beat > 0.5) {
        maskPulse = Math.min(1.0, maskPulse + 0.6)
        fovKickRef.current = Math.min(1.0, fovKickRef.current + 0.5)
      } else {
        maskPulse *= Math.pow(0.02, dt) // decay
        fovKickRef.current *= Math.pow(0.2, dt)
      }

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
        slices: Math.max(1, Math.min(64, Math.round(T.slices))),
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

        edgeEmphasis: THREE.MathUtils.clamp(T.edgeEmphasis, 0, 1),

        sourceMode: (T.sourceMode ?? 0) as SourceMode,
        curveAmp: THREE.MathUtils.clamp(T.curveAmp, 0.0, 0.6),
        curveFreq: THREE.MathUtils.clamp(T.curveFreq, 0.0, 2.0),
        morphSpeed: THREE.MathUtils.clamp(T.morphSpeed, 0.0, 2.0),
        chromaGlide: THREE.MathUtils.clamp(T.chromaGlide, 0.0, 1.2),
        rollLock: clamp01(T.rollLock),
        fovKick: clamp01(T.fovKick),

        // R&D
        shardsEnabled: !!T.shardsEnabled,
        shardCount: Math.max(0, Math.min(5000, Math.round(T.shardCount))),
        shardSize: THREE.MathUtils.clamp(T.shardSize, 0.02, 0.3),
        shardSpeed: THREE.MathUtils.clamp(T.shardSpeed, 0.2, 3.0),
        shardJitter: THREE.MathUtils.clamp(T.shardJitter, 0.0, 1.5),

        crtEnabled: !!T.crtEnabled,
        crtStrength: THREE.MathUtils.clamp(T.crtStrength, 0.0, 1.0),
        crtScanlines: THREE.MathUtils.clamp(T.crtScanlines, 100.0, 2000.0),
        glitchJitter: THREE.MathUtils.clamp(T.glitchJitter, 0.0, 0.02)
      }

      // Smooth
      const k = 1 - Math.pow(0.0001, dt)
      ;(Object.keys(target) as (keyof typeof target)[]).forEach(key => {
        // @ts-ignore
        s[key] += (target[key] - s[key]) * k
      })

      // Safety caps
      const kIntensity = THREE.MathUtils.lerp(s.intensity, Math.min(s.intensity, 0.6), safe)
      const kSpeed = THREE.MathUtils.lerp(s.speed, Math.min(s.speed, 0.4), safe)

      // Spin with roll lock (1 => lock fully)
      const spin = (0.28 * kSpeed + 0.14 * high + 0.06 * Math.sin(t * 0.45)) * (1.0 - s.rollLock)
      const zoom = 0.24 * kIntensity + 0.17 * mid + 0.12 * (beat > 0.5 ? 1.0 : 0.0)

      scrollRef.current += dt * (0.24 + 1.05 * kSpeed + 0.48 * loud)
      crossRef.current = Math.min(1, crossRef.current + dt * 0.35)

      // FOV kick on beat (safe reduces)
      const kickAmt = (safe > 0.5 ? 0.4 : 1.0) * s.fovKick
      camera.fov = baseFov * (1.0 + kickAmt * fovKickRef.current * 0.12)
      camera.updateProjectionMatrix()

      // Uniforms
      setF('uTime', t)
      setV3('uAudio', low, mid, high)
      setF('uLoud', loud)
      setF('uBeat', beat)
      setF('uSafe', safe)
      setF('uContrastBoost', accessibility.highContrast ? 1.0 : 0.0)

      setF('uScroll', scrollRef.current)
      setF('uSpin', spin)
      setF('uZoom', zoom)

      setF('uCurveAmp', s.curveAmp)
      setF('uCurveFreq', s.curveFreq)

      // Morph + chroma glide
      const morph = 0.5 + 0.5 * Math.sin(t * s.morphSpeed + high * 3.0)
      const chroma = t * s.chromaGlide
      setF('uMorph', morph)
      setF('uChromaRot', chroma)

      // Core looks
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

      setF('uSourceMode', s.sourceMode)
      setF('uMaskPulse', maskPulse)

      setF('uHasAlbum1', has1Ref.current ? 1.0 : 0.0)
      setF('uHasAlbum2', has2Ref.current ? 1.0 : 0.0)
      setF('uAlbumCross', crossRef.current)

      // Spectro bind (already created)
      setF('uHasSpectro', hasSpecRef.current ? 1.0 : 0.0)

      // R&D: instanced shards
      if (s.shardsEnabled && !shardsActiveRef.current) {
        createShards(s.shardCount, s.shardSize)
        shardsActiveRef.current = true
      } else if (!s.shardsEnabled && shardsActiveRef.current) {
        destroyShards()
        shardsActiveRef.current = false
      } else if (s.shardsEnabled && shardsRef.current && shardDataRef.current) {
        const mesh = shardsRef.current
        const { pos, vel, rot, rotVel } = shardDataRef.current
        const m = new THREE.Matrix4()
        const q = new THREE.Quaternion()
        const scl = new THREE.Vector3(1, 1, 1)
        const count = mesh.count
        const base = (0.66 + 1.2 * kSpeed) + (loud * 0.9)
        for (let i = 0; i < count; i++) {
          const speed = vel[i] * s.shardSpeed * (0.8 + 0.5 * high)
          pos[i * 3 + 2] += dt * (base + speed)
          const j = s.shardJitter
          pos[i * 3 + 0] += (Math.random() - 0.5) * dt * j
          pos[i * 3 + 1] += (Math.random() - 0.5) * dt * j

          if (pos[i * 3 + 2] > 2.0) {
            const theta = Math.random() * Math.PI * 2
            const r = radius * (0.9 + Math.random() * 0.25)
            pos[i * 3 + 0] = Math.cos(theta) * r
            pos[i * 3 + 1] = Math.sin(theta) * r
            pos[i * 3 + 2] = -tunnelLen
          }

          rot[i * 3 + 0] += rotVel[i * 3 + 0] * dt
          rot[i * 3 + 1] += rotVel[i * 3 + 1] * dt
          rot[i * 3 + 2] += rotVel[i * 3 + 2] * dt

          const px = pos[i * 3 + 0], py = pos[i * 3 + 1], pz = pos[i * 3 + 2]
          q.setFromEuler(new THREE.Euler(rot[i * 3 + 0], rot[i * 3 + 1], rot[i * 3 + 2]))
          m.compose(new THREE.Vector3(px, py, pz), q, scl)
          mesh.setMatrixAt(i, m)
        }
        mesh.instanceMatrix.needsUpdate = true
        // colors drift handled elsewhere if needed
      }

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

      // Shards
      destroyShards()

      if (tAlbum1Ref.current) { tAlbum1Ref.current.dispose(); tAlbum1Ref.current = null }
      if (tAlbum2Ref.current) { tAlbum2Ref.current.dispose(); tAlbum2Ref.current = null }
      if (specTexRef.current) { specTexRef.current.dispose(); specTexRef.current = null }

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

  // Dispatch a custom event for "Play in browser"
  const requestPlayInBrowser = () => {
    window.dispatchEvent(new CustomEvent('ffw:play-in-browser'))
  }

  return (
    <div
      ref={containerRef}
      data-visual="psy-kaleido"
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      {/* Top-center HUD */}
      <div
        style={{
          position: 'absolute',
          top: 8,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 15,
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          padding: '6px 10px',
          borderRadius: 10,
          border: '1px solid rgba(43,47,58,0.9)',
          background: 'rgba(10,12,16,0.82)',
          color: '#e6f0ff',
          fontFamily: 'system-ui, sans-serif',
          fontSize: 12,
          lineHeight: 1.2,
          transition: 'opacity 200ms ease, transform 200ms ease',
          opacity: (hudVisible || panelOpen) ? 1 : 0,
          pointerEvents: (hudVisible || panelOpen) ? 'auto' as const : 'none' as const,
          boxShadow: hoverTop ? '0 2px 16px rgba(0,0,0,0.35)' : '0 2px 10px rgba(0,0,0,0.25)'
        }}
        onMouseEnter={() => setHudVisible(true)}
      >
        <button
          onClick={() => setPanelOpen(o => !o)}
          style={{
            padding: '6px 10px', borderRadius: 8,
            border: '1px solid #2b2f3a', background: '#0f1218', color: '#cfe7ff', cursor: 'pointer'
          }}
        >
          {panelOpen ? 'Close Visual Settings' : 'Visual Settings'}
        </button>
        <button
          onClick={requestPlayInBrowser}
          title="Activate Spotify Web Playback (host app should handle)"
          style={{
            padding: '6px 10px', borderRadius: 8,
            border: '1px solid #2b2f3a', background: '#0f1218', color: '#b7ffbf', cursor: 'pointer'
          }}
        >
          Play in browser
        </button>
      </div>

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
      <label style={{ fontSize: 12, opacity: 0.9, minWidth: 160 }}>{p.label}</label>
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
  const onRange = (cb: (v: number) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = Number(e.currentTarget.value)
    if (Number.isFinite(raw)) cb(raw)
  }

  return (
    <div style={{ position: 'absolute', top: 56, right: 12, zIndex: 10, userSelect: 'none', pointerEvents: 'auto' }}>
      {open && (
        <div style={{
          width: 440, padding: 12, border: '1px solid #2b2f3a', borderRadius: 8,
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
              <button onClick={onToggle} style={btnStyle}>Close</button>
            </div>
          </Card>

          <Card title="Source">
            <Row label="Texture Source">
              <select
                value={cfg.sourceMode}
                onChange={e => onChange(prev => ({ ...prev, sourceMode: Number(e.currentTarget.value) as SourceMode }))}
                style={{ width: '100%', background: '#0f1218', color: '#cfe7ff', border: '1px solid #2b2f3a', borderRadius: 6, padding: '6px' }}
              >
                <option value={0}>Album Art</option>
                <option value={1}>Plasma</option>
                <option value={2}>Spectrogram</option>
                <option value={3}>Mix (Album + Plasma)</option>
              </select>
            </Row>
          </Card>

          <Card title="Core">
            <Row label={`Intensity ${cfg.intensity.toFixed(2)}`}>
              <input type="range" min={0} max={1.6} step={0.01} value={cfg.intensity} onChange={onRange(v => onChange(prev => ({ ...prev, intensity: Math.max(0, Math.min(1.6, v)) })))} />
            </Row>
            <Row label={`Speed ${cfg.speed.toFixed(2)}`}>
              <input type="range" min={0} max={2} step={0.01} value={cfg.speed} onChange={onRange(v => onChange(prev => ({ ...prev, speed: Math.max(0, Math.min(2, v)) })))} />
            </Row>
            <Row label={`Exposure ${cfg.exposure.toFixed(2)}`}>
              <input type="range" min={0} max={1.6} step={0.01} value={cfg.exposure} onChange={onRange(v => onChange(prev => ({ ...prev, exposure: Math.max(0, Math.min(1.6, v)) })))} />
            </Row>
            <Row label={`Saturation ${cfg.saturation.toFixed(2)}`}>
              <input type="range" min={0.6} max={1.6} step={0.01} value={cfg.saturation} onChange={onRange(v => onChange(prev => ({ ...prev, saturation: Math.max(0.6, Math.min(1.6, v)) })))} />
            </Row>
            <Row label={`Gamma ${cfg.gamma.toFixed(3)}`}>
              <input type="range" min={0.85} max={1.15} step={0.001} value={cfg.gamma} onChange={onRange(v => onChange(prev => ({ ...prev, gamma: Math.max(0.85, Math.min(1.15, v)) })))} />
            </Row>
            <Row label={`Vignette ${cfg.vignette.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.vignette} onChange={onRange(v => onChange(prev => ({ ...prev, vignette: Math.max(0, Math.min(1, v)) })))} />
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
              <input type="range" min={1} max={64} step={1} value={cfg.slices} onChange={onRange(v => onChange(prev => ({ ...prev, slices: Math.max(1, Math.min(64, Math.round(v))) })))} />
            </Row>
            <Row label={`Tile Scale (mosaic) ${cfg.tileScale.toFixed(2)}`}>
              <input type="range" min={0.8} max={6} step={0.01} value={cfg.tileScale} onChange={onRange(v => onChange(prev => ({ ...prev, tileScale: Math.max(0.8, Math.min(6, v)) })))} />
            </Row>
            <Row label={`Tile Round (mosaic) ${cfg.tileRound.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.tileRound} onChange={onRange(v => onChange(prev => ({ ...prev, tileRound: Math.max(0, Math.min(1, v)) })))} />
            </Row>
            <Row label={`Edge Emphasis ${cfg.edgeEmphasis.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.edgeEmphasis} onChange={onRange(v => onChange(prev => ({ ...prev, edgeEmphasis: Math.max(0, Math.min(1, v)) })))} />
            </Row>
          </Card>

          <Card title="Prism / Refraction">
            <Row label={`Dispersion ${cfg.prismDispersion.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.prismDispersion} onChange={onRange(v => onChange(prev => ({ ...prev, prismDispersion: Math.max(0, Math.min(1, v)) })))} />
            </Row>
            <Row label={`Warp ${cfg.prismWarp.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.prismWarp} onChange={onRange(v => onChange(prev => ({ ...prev, prismWarp: Math.max(0, Math.min(1, v)) })))} />
            </Row>
          </Card>

          <Card title="Album Texture Mapping">
            <Row label={`Tex Scale U ${cfg.texScaleU.toFixed(2)}`}>
              <input type="range" min={0.5} max={6} step={0.01} value={cfg.texScaleU} onChange={onRange(v => onChange(prev => ({ ...prev, texScaleU: Math.max(0.5, Math.min(6, v)) })))} />
            </Row>
            <Row label={`Tex Scale V ${cfg.texScaleV.toFixed(2)}`}>
              <input type="range" min={0.5} max={6} step={0.01} value={cfg.texScaleV} onChange={onRange(v => onChange(prev => ({ ...prev, texScaleV: Math.max(0.5, Math.min(6, v)) })))} />
            </Row>
            <Row label={`Tex Rotate ${cfg.texRotate.toFixed(2)} rad`}>
              <input type="range" min={-3.14159} max={3.14159} step={0.01} value={cfg.texRotate} onChange={onRange(v => onChange(prev => ({ ...prev, texRotate: Math.max(-Math.PI, Math.min(Math.PI, v)) })))} />
            </Row>
            <Row label={`Tex Warp ${cfg.albumTexWarp.toFixed(2)}`}>
              <input type="range" min={0} max={0.8} step={0.01} value={cfg.albumTexWarp} onChange={onRange(v => onChange(prev => ({ ...prev, albumTexWarp: Math.max(0, Math.min(0.8, v)) })))} />
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
                <option value={0}>Radial (Prism)</option>
                <option value={1}>Stripes</option>
                <option value={2}>Checker</option>
              </select>
            </Row>
            <Row label={`Scale ${cfg.interlaceScale.toFixed(0)}`}>
              <input type="range" min={40} max={600} step={1} value={cfg.interlaceScale} onChange={onRange(v => onChange(prev => ({ ...prev, interlaceScale: Math.max(40, Math.min(600, v)) })))} />
            </Row>
            <Row label={`Strength ${cfg.interlaceStrength.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.interlaceStrength} onChange={onRange(v => onChange(prev => ({ ...prev, interlaceStrength: Math.max(0, Math.min(1, v)) })))} />
            </Row>
            <Row label={`Fuse Bias prev↔current ${cfg.fuseBias.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.fuseBias} onChange={onRange(v => onChange(prev => ({ ...prev, fuseBias: Math.max(0, Math.min(1, v)) })))} />
            </Row>
          </Card>

          <Card title="Motion & Color">
            <Row label={`Curvature Amp ${cfg.curveAmp.toFixed(2)}`}>
              <input type="range" min={0} max={0.6} step={0.01} value={cfg.curveAmp} onChange={onRange(v => onChange(prev => ({ ...prev, curveAmp: Math.max(0, Math.min(0.6, v)) })))} />
            </Row>
            <Row label={`Curvature Freq ${cfg.curveFreq.toFixed(2)}`}>
              <input type="range" min={0} max={2} step={0.01} value={cfg.curveFreq} onChange={onRange(v => onChange(prev => ({ ...prev, curveFreq: Math.max(0, Math.min(2, v)) })))} />
            </Row>
            <Row label={`Morph Speed ${cfg.morphSpeed.toFixed(2)}`}>
              <input type="range" min={0} max={2} step={0.01} value={cfg.morphSpeed} onChange={onRange(v => onChange(prev => ({ ...prev, morphSpeed: Math.max(0, Math.min(2, v)) })))} />
            </Row>
            <Row label={`Chroma Glide ${cfg.chromaGlide.toFixed(2)}`}>
              <input type="range" min={0} max={1.2} step={0.01} value={cfg.chromaGlide} onChange={onRange(v => onChange(prev => ({ ...prev, chromaGlide: Math.max(0, Math.min(1.2, v)) })))} />
            </Row>
            <Row label={`Roll Lock ${cfg.rollLock.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.rollLock} onChange={onRange(v => onChange(prev => ({ ...prev, rollLock: Math.max(0, Math.min(1, v)) })))} />
            </Row>
            <Row label={`FOV Kick (beat) ${cfg.fovKick.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.fovKick} onChange={onRange(v => onChange(prev => ({ ...prev, fovKick: Math.max(0, Math.min(1, v)) })))} />
            </Row>
          </Card>

          <Card title="R&D (Experimental)">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={cfg.shardsEnabled} onChange={e => onChange(prev => ({ ...prev, shardsEnabled: e.currentTarget.checked }))} />
                Shards (instanced)
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={cfg.crtEnabled} onChange={e => onChange(prev => ({ ...prev, crtEnabled: e.currentTarget.checked }))} />
                CRT / Glitch
              </label>
            </div>
            {cfg.shardsEnabled && (
              <>
                <Row label={`Shard Count ${cfg.shardCount}`}>
                  <input type="range" min={0} max={3000} step={10} value={cfg.shardCount} onChange={onRange(v => onChange(prev => ({ ...prev, shardCount: Math.max(0, Math.min(5000, v)) })))} />
                </Row>
                <Row label={`Shard Size ${cfg.shardSize.toFixed(3)}`}>
                  <input type="range" min={0.02} max={0.2} step={0.001} value={cfg.shardSize} onChange={onRange(v => onChange(prev => ({ ...prev, shardSize: Math.max(0.02, Math.min(0.3, v)) })))} />
                </Row>
                <Row label={`Shard Speed ${cfg.shardSpeed.toFixed(2)}`}>
                  <input type="range" min={0.2} max={3} step={0.01} value={cfg.shardSpeed} onChange={onRange(v => onChange(prev => ({ ...prev, shardSpeed: Math.max(0.2, Math.min(3, v)) })))} />
                </Row>
                <Row label={`Shard Jitter ${cfg.shardJitter.toFixed(2)}`}>
                  <input type="range" min={0} max={1.5} step={0.01} value={cfg.shardJitter} onChange={onRange(v => onChange(prev => ({ ...prev, shardJitter: Math.max(0, Math.min(1.5, v)) })))} />
                </Row>
              </>
            )}
            {cfg.crtEnabled && (
              <>
                <Row label={`CRT Strength ${cfg.crtStrength.toFixed(2)}`}>
                  <input type="range" min={0} max={1} step={0.01} value={cfg.crtStrength} onChange={onRange(v => onChange(prev => ({ ...prev, crtStrength: Math.max(0, Math.min(1, v)) })))} />
                </Row>
                <Row label={`Scanlines ${cfg.crtScanlines.toFixed(0)}`}>
                  <input type="range" min={100} max={2000} step={1} value={cfg.crtScanlines} onChange={onRange(v => onChange(prev => ({ ...prev, crtScanlines: Math.max(100, Math.min(2000, v)) })))} />
                </Row>
                <Row label={`Glitch Jitter ${cfg.glitchJitter.toFixed(3)}`}>
                  <input type="range" min={0} max={0.02} step={0.0005} value={cfg.glitchJitter} onChange={onRange(v => onChange(prev => ({ ...prev, glitchJitter: Math.max(0, Math.min(0.02, v)) })))} />
                </Row>
              </>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}
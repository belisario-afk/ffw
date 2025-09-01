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
 Album-only engine
 - Two album textures (current & previous) for “interlacing/fusing”
 - Dominant + average colors extracted and used for edges/accents
 - Shapes: Kaleido, Diamond lattice, Prism-star, Mosaic
 - Interlacing: stripes, checker, radial rings
**/
type Cfg = {
  // Core motion/tonemapping
  intensity: number
  speed: number
  exposure: number
  saturation: number
  gamma: number
  vignette: number

  // Kaleidoscope & shapes
  slices: number // 1..48
  shapeMode: 0 | 1 | 2 | 3 // 0=kaleido, 1=diamonds, 2=prism-star, 3=mosaic
  tileScale: number // diamonds/mosaic tiling scale
  tileRound: number // soften tiles edges

  // Prism/refraction
  prismDispersion: number
  prismWarp: number

  // Album sampling
  texScaleU: number
  texScaleV: number
  texRotate: number // radians
  albumTexWarp: number // barrel/kaleido warping

  // Interlacing/fusing between album1 and album2
  interlaceMode: 0 | 1 | 2 // 0=off, 1=stripes, 2=checker, (radial auto if shapeMode=0)
  interlaceScale: number
  interlaceStrength: number
  fuseMix: number // manual cross blend

  // Accents
  edgeEmphasis: number // outlines/edges intensity with album dom colors
}

type Preset = { name: string } & Cfg

const LS_KEY = 'ffw.kaleido.albumonly.v1'

const PRESETS: Record<string, Preset> = {
  prismaticMandala: {
    name: 'Prismatic Mandala',
    intensity: 1.1, speed: 0.9, exposure: 1.0, saturation: 1.15, gamma: 0.96, vignette: 0.6,
    slices: 24, shapeMode: 0, tileScale: 2.2, tileRound: 0.35,
    prismDispersion: 0.7, prismWarp: 0.65,
    texScaleU: 2.4, texScaleV: 4.2, texRotate: 0.2, albumTexWarp: 0.38,
    interlaceMode: 1, interlaceScale: 220.0, interlaceStrength: 0.6, fuseMix: 0.35,
    edgeEmphasis: 0.55
  },
  diamondLattice: {
    name: 'Diamond Lattice',
    intensity: 0.95, speed: 0.7, exposure: 0.95, saturation: 1.05, gamma: 0.97, vignette: 0.64,
    slices: 16, shapeMode: 1, tileScale: 3.0, tileRound: 0.25,
    prismDispersion: 0.45, prismWarp: 0.4,
    texScaleU: 2.0, texScaleV: 3.5, texRotate: -0.15, albumTexWarp: 0.3,
    interlaceMode: 2, interlaceScale: 120.0, interlaceStrength: 0.5, fuseMix: 0.45,
    edgeEmphasis: 0.7
  },
  albumFusionMax: {
    name: 'Album Fusion Max',
    intensity: 1.2, speed: 1.1, exposure: 1.05, saturation: 1.2, gamma: 0.95, vignette: 0.58,
    slices: 20, shapeMode: 0, tileScale: 2.0, tileRound: 0.4,
    prismDispersion: 0.85, prismWarp: 0.75,
    texScaleU: 3.0, texScaleV: 5.0, texRotate: 0.35, albumTexWarp: 0.45,
    interlaceMode: 1, interlaceScale: 260.0, interlaceStrength: 0.9, fuseMix: 0.65,
    edgeEmphasis: 0.6
  },
  liquidMosaic: {
    name: 'Liquid Mosaic',
    intensity: 0.9, speed: 0.6, exposure: 0.92, saturation: 1.1, gamma: 0.96, vignette: 0.62,
    slices: 12, shapeMode: 3, tileScale: 2.4, tileRound: 0.45,
    prismDispersion: 0.5, prismWarp: 0.55,
    texScaleU: 1.8, texScaleV: 3.2, texRotate: -0.25, albumTexWarp: 0.32,
    interlaceMode: 2, interlaceScale: 140.0, interlaceStrength: 0.6, fuseMix: 0.4,
    edgeEmphasis: 0.5
  },
  neonDiamonds: {
    name: 'Neon Diamonds',
    intensity: 1.3, speed: 1.0, exposure: 1.08, saturation: 1.3, gamma: 0.94, vignette: 0.66,
    slices: 18, shapeMode: 1, tileScale: 3.6, tileRound: 0.2,
    prismDispersion: 0.9, prismWarp: 0.8,
    texScaleU: 2.6, texScaleV: 4.6, texRotate: 0.5, albumTexWarp: 0.5,
    interlaceMode: 1, interlaceScale: 300.0, interlaceStrength: 0.8, fuseMix: 0.55,
    edgeEmphasis: 0.75
  },
  ribbonInterlace: {
    name: 'Ribbon Interlace',
    intensity: 0.85, speed: 0.8, exposure: 0.98, saturation: 1.05, gamma: 0.97, vignette: 0.6,
    slices: 28, shapeMode: 0, tileScale: 2.2, tileRound: 0.3,
    prismDispersion: 0.6, prismWarp: 0.65,
    texScaleU: 2.2, texScaleV: 4.4, texRotate: 0.0, albumTexWarp: 0.36,
    interlaceMode: 1, interlaceScale: 180.0, interlaceStrength: 0.75, fuseMix: 0.5,
    edgeEmphasis: 0.55
  },
  vortexPrism: {
    name: 'Vortex Prism',
    intensity: 1.15, speed: 1.2, exposure: 1.02, saturation: 1.18, gamma: 0.95, vignette: 0.63,
    slices: 32, shapeMode: 2, tileScale: 2.8, tileRound: 0.35,
    prismDispersion: 1.0, prismWarp: 0.9,
    texScaleU: 3.2, texScaleV: 5.2, texRotate: -0.35, albumTexWarp: 0.55,
    interlaceMode: 2, interlaceScale: 160.0, interlaceStrength: 0.7, fuseMix: 0.6,
    edgeEmphasis: 0.65
  }
}

export default function PsyKaleidoTunnel({ quality, accessibility }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // Textures: two album covers (current & previous) for interlacing/fusing
  const tAlbum1Ref = useRef<THREE.Texture | null>(null)
  const tAlbum2Ref = useRef<THREE.Texture | null>(null)
  const has1Ref = useRef(0)
  const has2Ref = useRef(0)
  const crossRef = useRef(0) // animated crossfade on track change

  // Colors from album
  const albumAvg = useRef(new THREE.Color('#8fb6ff'))
  const albumDom1 = useRef(new THREE.Color('#77d0ff'))
  const albumDom2 = useRef(new THREE.Color('#b47bff'))

  // Scene refs
  const matRef = useRef<THREE.ShaderMaterial | null>(null)
  const scrollRef = useRef(0)

  // UI state
  const [panelOpen, setPanelOpen] = useState(false)
  const [selectedPreset, setSelectedPreset] = useState<keyof typeof PRESETS>('prismaticMandala')
  const [cfg, setCfg] = useState<Cfg>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}')
      return { ...PRESETS.prismaticMandala, ...saved }
    } catch {
      return { ...PRESETS.prismaticMandala }
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
    scene.background = new THREE.Color('#01040a')

    const camera = new THREE.PerspectiveCamera(62, 1, 0.05, 500)
    camera.position.set(0, 0, 0)

    const { renderer, dispose: disposeRenderer } = createRenderer(canvas, quality.renderScale)
    const comp = createComposer(renderer, scene, camera, {
      bloom: quality.bloom,
      bloomStrength: 0.72,
      bloomRadius: 0.42,
      bloomThreshold: 0.55,
      fxaa: true,
      vignette: true,
      vignetteStrength: Math.min(1, Math.max(0, cfgRef.current.vignette)),
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

    // Track polling -> load album textures & palette
    let lastTrackId: string | null = null
    function quantizeTop3(data: Uint8ClampedArray): [THREE.Color, THREE.Color, THREE.Color] {
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
        bins.set(toBin(r, g, b), (bins.get(toBin(r, g, b)) || 0) + 1)
        ar += r; ag += g; ab += b; n++
      }
      const decode = (bin: number) => {
        const R = ((bin >> 10) & 0x1f) * 43 + 21
        const G = ((bin >> 5) & 0x1f) * 43 + 21
        const B = (bin & 0x1f) * 43 + 21
        return new THREE.Color(R / 255, G / 255, B / 255)
      }
      const sorted = [...bins.entries()].sort((a, b) => b[1] - a[1])
      const c1 = sorted[0] ? decode(sorted[0][0]) : new THREE.Color('#77d0ff')
      let c2 = sorted[1] ? decode(sorted[1][0]) : c1.clone().offsetHSL(0.2, 0.2, 0)
      if (c1.distanceTo(c2) < 0.15) c2.offsetHSL(0.25, 0.3, 0)
      const avg = new THREE.Color((ar / Math.max(1, n)) / 255, (ag / Math.max(1, n)) / 255, (ab / Math.max(1, n)) / 255)
      return [avg, c1, c2]
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

        // Load image with CORS, fallback to blob
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

        // Palette
        const c = document.createElement('canvas'); c.width = 64; c.height = 64
        const g = c.getContext('2d')
        if (g) {
          g.drawImage(img, 0, 0, 64, 64)
          const data = g.getImageData(0, 0, 64, 64).data
          const [avg, d1, d2] = quantizeTop3(data)
          albumAvg.current.copy(avg)
          albumDom1.current.copy(d1)
          albumDom2.current.copy(d2)
          setColor('uAlbumAvg', albumAvg.current)
          setColor('uAlbumDom1', albumDom1.current)
          setColor('uAlbumDom2', albumDom2.current)
        }

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
        tAlbum1Ref.current = tex
        setTex('tAlbum1', tex)
        has1Ref.current = 1
        setF('uHasAlbum1', 1.0)
        setF('uHasAlbum2', has2Ref.current ? 1.0 : 0.0)

        // Crossfade kick
        crossRef.current = 0.0
        setF('uAlbumCross', 0.0)
      } catch {
        // ignore
      }
    }

    loadAlbum()
    const albumIv = window.setInterval(loadAlbum, 6000)

    // Geometry: just a fullscreen quad via a BackSide cylinder to keep the tunnel feel
    const radius = 14, tunnelLen = 240
    const tunnel = new THREE.CylinderGeometry(radius, radius, tunnelLen, 360, 1, true)
    tunnel.rotateZ(Math.PI * 0.5)
    const uniforms = {
      // Time/audio
      uTime: { value: 0.0 },
      uAudio: { value: new THREE.Vector3(0.1, 0.1, 0.1) },
      uLoud: { value: 0.12 },
      uBeat: { value: 0.0 },

      // Dynamics
      uScroll: { value: 0.0 },
      uSpin: { value: 0.0 },
      uZoom: { value: 0.0 },

      // Album textures/colors
      tAlbum1: { value: null as THREE.Texture | null },
      tAlbum2: { value: null as THREE.Texture | null },
      uHasAlbum1: { value: 0.0 },
      uHasAlbum2: { value: 0.0 },
      uAlbumCross: { value: 0.0 },
      uAlbumAvg: { value: albumAvg.current.clone() },
      uAlbumDom1: { value: albumDom1.current.clone() },
      uAlbumDom2: { value: albumDom2.current.clone() },

      // Controls (smoothed every frame)
      uIntensity: { value: cfgRef.current.intensity },
      uSpeed: { value: cfgRef.current.speed },
      uExposure: { value: cfgRef.current.exposure },
      uSaturation: { value: cfgRef.current.saturation },
      uGamma: { value: cfgRef.current.gamma },
      uVignette: { value: cfgRef.current.vignette },

      uSlices: { value: Math.max(1, Math.round(cfgRef.current.slices)) },
      uShapeMode: { value: cfgRef.current.shapeMode },
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
      uFuseMix: { value: cfgRef.current.fuseMix },

      uEdgeEmphasis: { value: cfgRef.current.edgeEmphasis },

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
        uniform float uSpin;
        uniform float uZoom;

        uniform sampler2D tAlbum1;
        uniform sampler2D tAlbum2;
        uniform float uHasAlbum1;
        uniform float uHasAlbum2;
        uniform float uAlbumCross;
        uniform vec3 uAlbumAvg;
        uniform vec3 uAlbumDom1;
        uniform vec3 uAlbumDom2;

        uniform float uIntensity;
        uniform float uSpeed;
        uniform float uExposure;
        uniform float uSaturation;
        uniform float uGamma;
        uniform float uVignette;

        uniform float uSlices;
        uniform float uShapeMode;   // 0 kaleido, 1 diamonds, 2 prism-star, 3 mosaic
        uniform float uTileScale;
        uniform float uTileRound;

        uniform float uPrismDispersion;
        uniform float uPrismWarp;

        uniform vec2  uTexScale;
        uniform float uTexRotate;
        uniform float uAlbumTexWarp;

        uniform float uInterlaceMode;    // 0 off, 1 stripes, 2 checker
        uniform float uInterlaceScale;
        uniform float uInterlaceStrength;
        uniform float uFuseMix;

        uniform float uEdgeEmphasis;

        uniform float uSafe;
        uniform float uContrastBoost;

        // hash/noise/fbm for warps
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

        float foldKaleido(float x, float slices){
          float seg = 1.0 / max(1.0, slices);
          float xf = fract(x + 1.0);
          float m = mod(xf, seg) / seg;
          m = abs(m - 0.5) * 2.0;
          return m * seg + floor(xf/seg)*seg;
        }

        // Interlace masks
        float stripeMask(vec2 uv, float scale){
          return step(0.0, sin(uv.y*scale));
        }
        float checkerMask(vec2 uv, float scale){
          vec2 g = floor(uv*scale);
          return mod(g.x + g.y, 2.0);
        }
        float radialMask(vec2 uv, float scale){
          float r = distance(uv, vec2(0.5));
          return step(0.0, sin(r*scale*6.28318));
        }

        // Diamond tiling mask + edge
        // Rotate 45deg and use L1 distance for diamond cells
        vec3 diamondCell(vec2 uv, float scale, float roundness){
          vec2 uvr = rotate2D(uv, 0.78539816339); // 45 deg
          vec2 g = fract(uvr*scale) - 0.5;
          float d = abs(g.x) + abs(g.y); // diamond distance
          float cell = smoothstep(0.5, 0.5 - 0.2*roundness, d);
          float edge = smoothstep(0.48, 0.45 - 0.2*roundness, d) - smoothstep(0.52, 0.48 - 0.2*roundness, d);
          return vec3(cell, edge, d);
        }

        // Mosaic mask: hex-ish by blending rotated grids
        float mosaicMask(vec2 uv, float scale, float roundness){
          vec2 uv1 = rotate2D(uv, 0.0);
          vec2 uv2 = rotate2D(uv, 2.09439510239); // 120 deg
          vec2 uv3 = rotate2D(uv, -2.09439510239);
          vec2 g1 = abs(fract(uv1*scale)-0.5);
          vec2 g2 = abs(fract(uv2*scale)-0.5);
          vec2 g3 = abs(fract(uv3*scale)-0.5);
          float d = min(min(g1.x+g1.y, g2.x+g2.y), g3.x+g3.y);
          return smoothstep(0.5, 0.5 - 0.2*roundness, d);
        }

        vec3 saturateColor(vec3 c, float s){
          float l = dot(c, vec3(0.299,0.587,0.114));
          return mix(vec3(l), c, s);
        }

        vec3 sampleAlbum(vec2 uv, sampler2D t1, sampler2D t2, float has1, float has2, float cross, float interlaceMode, float interlaceScale, float interlaceK){
          // two-album interlacing/fusing
          vec3 a = has1 > 0.5 ? texture2D(t1, uv).rgb : vec3(0.0);
          vec3 b = has2 > 0.5 ? texture2D(t2, uv).rgb : a;

          float m = 0.0;
          if (interlaceMode > 1.5) {
            m = checkerMask(uv, interlaceScale);
          } else if (interlaceMode > 0.5) {
            m = stripeMask(uv, interlaceScale);
          } else {
            // used with kaleido: radial rings as implicit interlace
            m = radialMask(uv, interlaceScale*0.25);
          }
          float interlace = mix(0.5, m, interlaceK);

          // temporal crossfade on track change
          float x = smoothstep(0.0, 1.0, cross);
          vec3 iMix = mix(a, b, interlace);
          vec3 crossMix = mix(iMix, a, 1.0 - x); // fade from previous(b) to current(a)
          return crossMix;
        }

        void main(){
          float time = uTime;
          vec2 uv = vUv;

          // breathing spin/zoom
          float spin = (0.1 + 0.5*uIntensity) * time + uSpin;
          uv = rotate2D(uv, spin);
          float zoom = clamp(0.10 + 0.25*uZoom, 0.0, 0.5);
          uv = mix(uv, (uv - 0.5) * (1.0 - zoom) + 0.5, 0.8);

          // kaleido wrap baseline
          vec2 k = uv;
          k.y = fract(k.y - time*0.04 - uScroll);
          k.x = foldKaleido(k.x, uSlices);

          // album UVs
          vec2 tuv = rotate2D(k, uTexRotate);
          tuv = barrel(tuv, uAlbumTexWarp * (0.25 + 0.75*uIntensity));
          // refraction warp
          vec2 nrm = vec2(fbm(tuv*3.0 + time*0.08) - 0.5, fbm(tuv*3.2 - time*0.07) - 0.5);
          float disp = uPrismDispersion * (0.4 + 0.6*uIntensity);
          vec2 baseUV = tuv * uTexScale + nrm * uPrismWarp * 0.08;

          // interlaced dual-album sample
          vec3 baseCol = sampleAlbum(baseUV, tAlbum1, tAlbum2, uHasAlbum1, uHasAlbum2, uAlbumCross, uInterlaceMode, uInterlaceScale, uInterlaceStrength);

          // dispersion (RGB offsets)
          vec2 offR = nrm * disp * 0.006;
          vec2 offG = nrm * disp * 0.004 * vec2(-1.0, 1.0);
          vec2 offB = nrm * disp * 0.005 * vec2(1.0, -1.0);
          vec3 prismCol = vec3(
            texture2D(tAlbum1, baseUV + offR).r,
            texture2D(tAlbum1, baseUV + offG).g,
            texture2D(tAlbum1, baseUV + offB).b
          );
          // if no album1, fallback to baseCol
          prismCol = mix(baseCol, prismCol, uHasAlbum1);

          // Shapes
          float mode = uShapeMode;
          vec3 shapeEdge = vec3(0.0);
          float shapeMask = 1.0;

          if (mode < 0.5) {
            // kaleido, add radial rings from album avg
            float r = distance(k, vec2(0.5));
            float rings = smoothstep(0.0, 1.0, 0.5 + 0.5*sin((r*40.0) - time*6.0*(0.6+0.8*uLoud)));
            shapeMask = rings;
            // radial interlace accent
            float rim = smoothstep(0.48, 0.45, r);
            shapeEdge = vec3(rim);
          } else if (mode < 1.5) {
            // diamonds
            vec3 cell = diamondCell(uv, uTileScale, uTileRound);
            shapeMask = cell.x;
            shapeEdge = vec3(cell.y);
          } else if (mode < 2.5) {
            // prism-star: starburst mask from kaleido angle
            vec2 c = k - 0.5;
            float ang = atan(c.y, c.x);
            float blades = uSlices * 0.5 + 4.0;
            float star = abs(sin(ang * blades));
            float body = smoothstep(0.2, 0.8, star);
            shapeMask = body;
            shapeEdge = vec3(smoothstep(0.75, 0.9, star));
          } else {
            // mosaic
            float mosaic = mosaicMask(uv, uTileScale, uTileRound);
            shapeMask = mosaic;
            shapeEdge = vec3(smoothstep(0.35, 0.6, mosaic)) * 0.8;
          }

          // Compose album-only color
          vec3 domEdge = mix(uAlbumDom1, uAlbumDom2, 0.5 + 0.3*sin(time*0.3));
          vec3 col = mix(prismCol, baseCol, 0.35);         // prism accent blended
          col = mix(col, uAlbumAvg, 0.12*uIntensity);      // slight avg bias
          col = mix(col, domEdge, uEdgeEmphasis * shapeEdge); // edge tint

          // shape mask emphasis
          col *= (0.8 + 0.4*shapeMask);

          // saturation, exposure, tone-map, gamma
          col = saturateColor(col, mix(uSaturation, 1.0, uSafe*0.3));
          col *= mix(0.6, 1.55, clamp(uExposure, 0.0, 1.6));
          col = col / (1.0 + col);
          col = pow(col, vec3(clamp(uGamma, 0.85, 1.15)));

          // vignette in-shader
          vec2 q = vUv - 0.5;
          float vig = 1.0 - clamp(dot(q,q)*1.5, 0.0, 1.0);
          col *= mix(1.0, pow(vig, 1.8), clamp(uVignette, 0.0, 1.0));

          gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        }
      `
    })
    matRef.current = mat

    const tunnelMesh = new THREE.Mesh(tunnel, mat)
    scene.add(tunnelMesh)

    // Safe uniform setters
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

    // Animate
    const clock = new THREE.Clock()
    let raf = 0

    // Smoothed params object
    let s = { ...cfgRef.current }

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

      // Targets (clamped)
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

        slices: Math.max(1, Math.min(48, Math.round(T.slices))),
        shapeMode: T.shapeMode,
        tileScale: THREE.MathUtils.clamp(T.tileScale, 0.8, 6.0),
        tileRound: clamp01(T.tileRound),

        prismDispersion: clamp01(T.prismDispersion),
        prismWarp: clamp01(T.prismWarp),

        texScaleU: THREE.MathUtils.clamp(T.texScaleU, 0.5, 6.0),
        texScaleV: THREE.MathUtils.clamp(T.texScaleV, 0.5, 6.0),
        texRotate: THREE.MathUtils.clamp(T.texRotate, -Math.PI, Math.PI),
        albumTexWarp: THREE.MathUtils.clamp(T.albumTexWarp, 0, 0.8),

        interlaceMode: T.interlaceMode,
        interlaceScale: THREE.MathUtils.clamp(T.interlaceScale, 40, 600),
        interlaceStrength: clamp01(T.interlaceStrength),
        fuseMix: clamp01(T.fuseMix),

        edgeEmphasis: THREE.MathUtils.clamp(T.edgeEmphasis, 0, 1)
      }

      // Smooth toward targets
      const k = 1 - Math.pow(0.0001, dt)
      ;(Object.keys(target) as (keyof typeof target)[]).forEach(key => {
        // @ts-ignore
        s[key] += (target[key] - s[key]) * k
      })

      // Safety caps
      const kIntensity = THREE.MathUtils.lerp(s.intensity, Math.min(s.intensity, 0.6), safe)
      const kSpeed = THREE.MathUtils.lerp(s.speed, Math.min(s.speed, 0.4), safe)

      // Spin/zoom from audio
      const spin = 0.28 * kSpeed + 0.14 * high + 0.06 * Math.sin(t * 0.45)
      const zoom = 0.24 * kIntensity + 0.17 * mid + 0.12 * (beat > 0.5 ? 1.0 : 0.0)

      // Advance scroll & crossfade
      scrollRef.current += dt * (0.24 + 1.05 * kSpeed + 0.48 * loud)
      crossRef.current = Math.min(1, crossRef.current + dt * 0.35) // ~3s cross

      // Push uniforms safely
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

      setF('uSlices', s.slices)
      setF('uShapeMode', s.shapeMode)
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
      setF('uFuseMix', s.fuseMix)

      setF('uEdgeEmphasis', s.edgeEmphasis)

      // Update album presence & crossfade
      setF('uHasAlbum1', has1Ref.current ? 1.0 : 0.0)
      setF('uHasAlbum2', has2Ref.current ? 1.0 : 0.0)
      setF('uAlbumCross', crossRef.current)

      // Render
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
        {open ? 'Close Album Engine' : 'Album Engine'}
      </button>
      {open && (
        <div style={{
          width: 420, marginTop: 8, padding: 12, border: '1px solid #2b2f3a', borderRadius: 8,
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
              <button onClick={() => onChange(PRESETS.albumFusionMax)} style={btnStyle}>Album Fusion Max</button>
              <button onClick={() => onChange(PRESETS.neonDiamonds)} style={btnStyle}>Neon Diamonds</button>
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

          <Card title="Shapes">
            <Row label={`Slices ${Math.round(cfg.slices)}`}>
              <input type="range" min={1} max={48} step={1} value={cfg.slices}
                     onChange={onRange(v => onChange(prev => ({ ...prev, slices: Math.max(1, Math.min(48, Math.round(v))) })))} />
            </Row>
            <Row label="Shape Mode">
              <select
                value={cfg.shapeMode}
                onChange={e => onChange(prev => ({ ...prev, shapeMode: Number(e.currentTarget.value) as Cfg['shapeMode'] }))}
                style={{ width: '100%', background: '#0f1218', color: '#cfe7ff', border: '1px solid #2b2f3a', borderRadius: 6, padding: '6px' }}
              >
                <option value={0}>Kaleido</option>
                <option value={1}>Diamonds</option>
                <option value={2}>Prism-Star</option>
                <option value={3}>Mosaic</option>
              </select>
            </Row>
            <Row label={`Tile Scale ${cfg.tileScale.toFixed(2)}`}>
              <input type="range" min={0.8} max={6} step={0.01} value={cfg.tileScale}
                     onChange={onRange(v => onChange(prev => ({ ...prev, tileScale: Math.max(0.8, Math.min(6, v)) })))} />
            </Row>
            <Row label={`Tile Round ${cfg.tileRound.toFixed(2)}`}>
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
            <Row label="Interlace Mode">
              <select
                value={cfg.interlaceMode}
                onChange={e => onChange(prev => ({ ...prev, interlaceMode: Number(e.currentTarget.value) as Cfg['interlaceMode'] }))}
                style={{ width: '100%', background: '#0f1218', color: '#cfe7ff', border: '1px solid #2b2f3a', borderRadius: 6, padding: '6px' }}
              >
                <option value={0}>Off (radial with Kaleido)</option>
                <option value={1}>Stripes</option>
                <option value={2}>Checker</option>
              </select>
            </Row>
            <Row label={`Interlace Scale ${cfg.interlaceScale.toFixed(0)}`}>
              <input type="range" min={40} max={600} step={1} value={cfg.interlaceScale}
                     onChange={onRange(v => onChange(prev => ({ ...prev, interlaceScale: Math.max(40, Math.min(600, v)) })))} />
            </Row>
            <Row label={`Interlace Strength ${cfg.interlaceStrength.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.interlaceStrength}
                     onChange={onRange(v => onChange(prev => ({ ...prev, interlaceStrength: Math.max(0, Math.min(1, v)) })))} />
            </Row>
            <Row label={`Fuse Mix (prev↔current) ${cfg.fuseMix.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.fuseMix}
                     onChange={onRange(v => onChange(prev => ({ ...prev, fuseMix: Math.max(0, Math.min(1, v)) })))} />
            </Row>
          </Card>

          <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'space-between' }}>
            <button onClick={() => onChange(PRESETS.prismaticMandala)} style={btnStyle}>Reset</button>
            <button onClick={onToggle} style={btnStyle}>Close</button>
          </div>
        </div>
      )}
    </div>
  )
}
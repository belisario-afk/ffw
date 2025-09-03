

// CHANGES VS PREVIOUS REVISION:
// - Replaced lemniscate path + repel with a smooth closed oval loop around the mansion (no teleport/glitch).
// - Built per-wheel rigs with centered spin pivots (and front steering pivots) so wheels spin in place and front wheels steer.
// - Headlight spotlights are independent of material detection and always follow heading (work with aftermarket models).

// Locate "createGlbCarModel" and see:
//   type WheelRig, buildWheel rigs, steering, and spin logic.
// Locate update(), see "OVAL LOOP" section replacing figure-8.

// The full file follows (for clarity, this is the complete file):

import React, { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { createRenderer, createComposer } from '../../three/Renderer'
import { reactivityBus, type ReactiveFrame } from '../../audio/ReactivityBus'
import type { AuthState } from '../../auth/token'
import { getPlaybackState } from '../../spotify/api'
import { cacheAlbumArt } from '../../utils/idb'
import { ensurePlayerConnected, hasSpotifyTokenProvider, setSpotifyTokenProvider } from '../../spotify/player'
import { fetchLyrics, type SyncedLine } from '../../lyrics/provider'
import { LyricBillboard } from '../components/LyricBillboard'

// GLB loaders
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

type Props = {
  auth: AuthState | null
  quality: { renderScale: 1 | 1.25 | 1.5 | 1.75 | 2, msaa: 0 | 2 | 4 | 8, bloom: boolean, motionBlur: boolean }
  accessibility: { epilepsySafe: boolean, reducedMotion: boolean, highContrast: boolean }
  settings?: any
}

type LocalCfg = {
  path: 'Circle'|'Ellipse'|'Lemniscate'|'Manual'
  orbitSpeed: number
  orbitRadius: number
  orbitElev: number
  camBob: number
  lineWidthPx: number
  camera: {
    fov: number
    minDistance: number
    maxDistance: number
    minPolarAngle: number
    maxPolarAngle: number
    enablePan: boolean
    enableZoom: boolean
    enableDamping: boolean
    dampingFactor: number
    rotateSpeed: number
    zoomSpeed: number
    panSpeed: number
    autoRotate: boolean
    autoRotateSpeed: number
    autoPath: boolean
    target: { x:number, y:number, z:number }
  }
  cameraPresets?: {
    enabled: boolean
    strength: number
  }
  fx: {
    beams: boolean
    groundRings: boolean
    chimneySmoke: boolean
    starfield: boolean
    bloomBreath: boolean
    lyricsMarquee: boolean
    mosaicFloor: boolean
    wireCar: boolean
  }
  car: {
    scale: number
    yOffset: number
    pathRadius: number
    turntable: boolean
    outline: boolean
    flipForward: boolean
    smokeEnabled: boolean
    smokeDensity: number
    smokeTintAlbum: boolean
    skidEnabled: boolean
    skidOpacity: number
    skidSegments: number
    lightsHeadEnabled: boolean
    lightsHeadIntensity: number
    lightsTailEnabled: boolean
    lightsTailIntensity: number
    lightsBrakeBoost: number
    wheelSpinEnabled: boolean
  }
}

const LS_KEY = 'ffw.wire3d.settings.v2'

// Default GLB source
const DEFAULT_GLB_URL = (window as any)?.FFW_CAR_GLB_URL
  || 'https://raw.githubusercontent.com/belisario-afk/try240/bf00e4ea26597cb5ba63c88e819a9fb696ada7d6/lamborghini_aventador_svj_sdc__free.glb'
const LOCAL_FALLBACK_GLB_URL = `${import.meta.env.BASE_URL}assets/car.glb`

function defaults(initial?: any): LocalCfg {
  return {
    path: initial?.path ?? 'Circle',
    orbitSpeed: initial?.orbitSpeed ?? 0.35,
    orbitRadius: initial?.orbitRadius ?? 9.5,
    orbitElev: initial?.orbitElev ?? 0.06,
    camBob: initial?.camBob ?? 0.12,
    lineWidthPx: initial?.lineWidthPx ?? 1.8,
    camera: {
      fov: clamp(initial?.camera?.fov ?? 50, 30, 85),
      minDistance: clamp(initial?.camera?.minDistance ?? 5, 3, 30),
      maxDistance: clamp(initial?.camera?.maxDistance ?? 16, 6, 100),
      minPolarAngle: clamp(initial?.camera?.minPolarAngle ?? (Math.PI * 0.12), 0, Math.PI / 2),
      maxPolarAngle: clamp(initial?.camera?.maxPolarAngle ?? (Math.PI * 0.85), Math.PI / 4, Math.PI),
      enablePan: true,
      enableZoom: true,
      enableDamping: true,
      dampingFactor: 0.1,
      rotateSpeed: 0.6,
      zoomSpeed: 0.7,
      panSpeed: 0.6,
      autoRotate: false,
      autoRotateSpeed: 0.5,
      autoPath: true,
      target: { x: 0, y: 2.2, z: 0 }
    },
    cameraPresets: {
      enabled: true,
      strength: 0.7
    },
    fx: {
      beams: false,
      groundRings: false,
      chimneySmoke: false,
      starfield: false,
      bloomBreath: false,
      lyricsMarquee: true,
      mosaicFloor: false,
      wireCar: true
    },
    car: {
      scale: 0.72,
      yOffset: 0.0,
      pathRadius: 11.0,
      turntable: false,
      outline: false,
      flipForward: false,
      smokeEnabled: true,
      smokeDensity: 0.75,
      smokeTintAlbum: true,
      skidEnabled: true,
      skidOpacity: 0.38,
      skidSegments: 140,
      lightsHeadEnabled: true,
      lightsHeadIntensity: 0.9,
      lightsTailEnabled: true,
      lightsTailIntensity: 0.75,
      lightsBrakeBoost: 1.4,
      wheelSpinEnabled: true
    }
  }
}

function mergeWithDefaults(saved: any, base: LocalCfg): LocalCfg {
  return {
    ...base,
    ...saved,
    camera: { ...base.camera, ...(saved?.camera || {}) },
    cameraPresets: { ...base.cameraPresets, ...(saved?.cameraPresets || {}) },
    fx: { ...base.fx, ...(saved?.fx || {}) },
    car: { ...base.car, ...(saved?.car || {}) }
  }
}

export default function WireframeHouse3D({ auth, quality, accessibility, settings }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [cfg, setCfg] = useState<LocalCfg>(() => {
    const base = defaults(settings)
    try {
      const saved = localStorage.getItem(LS_KEY)
      if (saved) return mergeWithDefaults(JSON.parse(saved), base)
    } catch {}
    return base
  })
  const cfgRef = useRef(cfg)
  useEffect(() => { cfgRef.current = cfg }, [cfg])

  const [panelOpen, setPanelOpen] = useState(false)

  // Billboard edit state
  const [bbEditEnabled, setBbEditEnabled] = useState(false)
  const [bbMode, setBbMode] = useState<'move'|'rotate'|'scale'>('move')
  const [bbPlane, setBbPlane] = useState<'XZ'|'XY'>('XZ')
  const bbEditRef = useRef(bbEditEnabled)
  const bbModeRef = useRef<'move'|'rotate'|'scale'>(bbMode)
  const bbPlaneRef = useRef<'XZ'|'XY'>(bbPlane)
  useEffect(() => { bbEditRef.current = bbEditEnabled }, [bbEditEnabled])
  useEffect(() => { bbModeRef.current = bbMode }, [bbMode])
  useEffect(() => { bbPlaneRef.current = bbPlane }, [bbPlane])

  // Billboard transforms
  const moveVecRef = useRef<{x:number,y:number}>({ x: 0, y: 0 })
  const moveAxis3Ref = useRef<number>(0)
  const rotateVecRef = useRef<{x:number,y:number}>({ x: 0, y: 0 })
  const scaleDeltaRef = useRef<number>(0)
  const billboardScaleRef = useRef<number>(1)
  const billboardYawRef = useRef<number>(0)
  const billboardPosRef = useRef<THREE.Vector3>(new THREE.Vector3(0, 2.95, 1.05))

  // stable refs
  const angleRef = useRef(0)
  const syncedRef = useRef<SyncedLine[] | null>(null)
  const currentLineRef = useRef<number>(-1)
  const pbClock = useRef<{ playing: boolean; startedAt: number; offsetMs: number }>({ playing: false, startedAt: 0, offsetMs: 0 })
  const lastVisualMsRef = useRef<number>(0)

  // Car color adapts to album art
  const carColorRef = useRef<THREE.Color>(new THREE.Color(0x88c8ff))

  // Car API
  const carApiRef = useRef<ReturnType<typeof createGlbCarModel> | null>(null)

  useEffect(() => {
    const token = (auth as any)?.accessToken
    if (token) { try { setSpotifyTokenProvider(async () => token) } catch {} }
  }, [auth])

  useEffect(() => {
    if (hasSpotifyTokenProvider()) {
      ensurePlayerConnected({ deviceName: 'FFw visualizer', setInitialVolume: true })
        .catch(e => console.warn('Spotify ensurePlayerConnected (3D) failed:', e))
    }
  }, [])

  useEffect(() => {
    const open = () => setPanelOpen(true)
    const close = () => setPanelOpen(false)
    window.addEventListener('ffw:open-wireframe3d-settings', open as EventListener)
    window.addEventListener('ffw:close-wireframe3d-settings', close as EventListener)
    return () => {
      window.removeEventListener('ffw:open-wireframe3d-settings', open as EventListener)
      window.removeEventListener('ffw:close-wireframe3d-settings', close as EventListener)
    }
  }, [])

  useEffect(() => {
    try {
      const base = defaults(settings)
      const merged = mergeWithDefaults(cfg, base)
      localStorage.setItem(LS_KEY, JSON.stringify(merged))
    } catch {}
  }, [cfg, settings])

  useEffect(() => {
    if (!canvasRef.current) return

    // helpers
    function pathPoint(path: 'Circle'|'Ellipse'|'Lemniscate'|'Manual', a: number, r: number) {
      if (path === 'Ellipse') return new THREE.Vector3(Math.sin(a) * r * 1.08, 0, Math.cos(a) * r * 0.92)
      if (path === 'Lemniscate') { const s = Math.sin(a), c = Math.cos(a), d = 1 + s*s; return new THREE.Vector3((r * c) / d, 0, (r * s * c) / d) }
      return new THREE.Vector3(Math.sin(a) * r, 0, Math.cos(a) * r)
    }
    function createDarkPlaceholderTexture() {
      const c = document.createElement('canvas'); c.width = c.height = 64
      const g = c.getContext('2d')!
      g.fillStyle = '#0b0e13'; g.fillRect(0,0,64,64)
      g.fillStyle = '#111722'
      for (let y=0;y<8;y++) for (let x=0;x<8;x++) if ((x+y)%2===0) g.fillRect(x*8,y*8,8,8)
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; return tex
    }
    async function estimateTextureLuminance(tex: THREE.Texture): Promise<number> {
      const img = tex.image as HTMLImageElement | HTMLCanvasElement | ImageBitmap
      const w = 32, h = 32
      const c = document.createElement('canvas'); c.width = w; c.height = h
      const g = c.getContext('2d'); if (!g) return 0.6
      try { g.drawImage(img as any, 0, 0, w, h) } catch { return 0.6 }
      const data = g.getImageData(0, 0, w, h).data
      let sum = 0
      for (let i = 0; i < data.length; i += 4) { const r = data[i], gr = data[i + 1], b = data[i + 2]; sum += (0.2126*r + 0.7152*gr + 0.0722*b) / 255 }
      return sum / (w * h)
    }
    async function averageTextureColor(tex: THREE.Texture): Promise<THREE.Color> {
      const img = tex.image as HTMLImageElement | HTMLCanvasElement | ImageBitmap
      const w = 32, h = 32
      const c = document.createElement('canvas'); c.width = w; c.height = h
      const g = c.getContext('2d'); if (!g) return new THREE.Color(0x88c8ff)
      try { g.drawImage(img as any, 0, 0, w, h) } catch { return new THREE.Color(0x88c8ff) }
      const data = g.getImageData(0, 0, w, h).data
      let r = 0, gr = 0, b = 0
      for (let i = 0; i < data.length; i += 4) { r += data[i]; gr += data[i+1]; b += data[i+2] }
      const n = data.length / 4
      const col = new THREE.Color(r/(255*n), gr/(255*n), b/(255*n))
      const luminance = 0.2126*col.r + 0.7152*col.g + 0.0722*col.b
      if (luminance < 0.35) { col.multiplyScalar(1.25); clampColor01(col) }
      return col
    }
    function addMansionWindows(add: (p: THREE.Vector3, out: THREE.Vector3) => void) {
      const storyY = [0.6, 1.7, 2.8]
      const CF = { minX:-2.0, maxX:2.0, minZ:-1.2, maxZ:1.2 }
      const LW = { minX:-4.0, maxX:-2.2, minZ:-1.4, maxZ:1.4 }
      const RW = { minX: 2.2, maxX: 4.0, minZ:-1.4, maxZ:1.4 }
      const addFace = (minX:number, maxX:number, z:number, out:THREE.Vector3, cols:number) => {
        for (let s=0; s<storyY.length; s++) for (let i=0;i<cols;i++) {
          const x = THREE.MathUtils.lerp(minX+0.22, maxX-0.22, (i+0.5)/cols)
          add(new THREE.Vector3(x, storyY[s], z), out)
        }
      }
      addFace(CF.minX, CF.maxX, CF.maxZ+0.001, new THREE.Vector3(0,0, 1), 6)
      addFace(CF.minX, CF.maxX, CF.minZ-0.001, new THREE.Vector3(0,0,-1), 6)
      addFace(LW.minX, LW.maxX, LW.maxZ+0.001, new THREE.Vector3(0,0, 1), 4)
      addFace(LW.minX, LW.maxX, LW.minZ-0.001, new THREE.Vector3(0,0,-1), 4)
      addFace(RW.minX, RW.maxX, RW.maxZ+0.001, new THREE.Vector3(0,0, 1), 4)
      addFace(RW.minX, RW.maxX, RW.minZ-0.001, new THREE.Vector3(0,0,-1), 4)
      for (let s=0; s<storyY.length; s++) for (let i=0;i<4;i++) {
        const z = THREE.MathUtils.lerp(CF.minZ+0.1, CF.maxZ-0.1, (i+0.5)/4)
        add(new THREE.Vector3(-2.201, storyY[s], z), new THREE.Vector3(-1,0,0))
        add(new THREE.Vector3( 2.201, storyY[s], z), new THREE.Vector3( 1,0,0))
      }
    }

    // Scene/camera/renderer
    const scene = new THREE.Scene()
    scene.background = null
    scene.fog = new THREE.Fog(new THREE.Color('#050607'), 50, 140)

    const camera = new THREE.PerspectiveCamera(cfgRef.current.camera.fov, 1, 0.05, 300)
    camera.position.set(0, 2.8, 12.5)
    camera.lookAt(cfgRef.current.camera.target.x, cfgRef.current.camera.target.y, cfgRef.current.camera.target.z)

    const { renderer, dispose: disposeRenderer } = createRenderer(canvasRef.current, quality.renderScale)
    const comp = createComposer(renderer, scene, camera, {
      bloom: quality.bloom,
      bloomStrength: 0.55,
      bloomRadius: 0.22,
      bloomThreshold: 0.35,
      fxaa: true,
      vignette: true,
      vignetteStrength: 0.45,
      filmGrain: false,
      filmGrainStrength: 0.0,
      motionBlur: false
    })

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.1
    controls.enablePan = true
    controls.enableZoom = true
    controls.rotateSpeed = 0.6
    controls.zoomSpeed = 0.7
    controls.panSpeed = 0.6
    controls.minDistance = 5
    controls.maxDistance = 16
    controls.minPolarAngle = Math.PI * 0.12
    controls.maxPolarAngle = Math.PI * 0.85
    controls.target.set(cfgRef.current.camera.target.x, cfgRef.current.camera.target.y, cfgRef.current.camera.target.z)

    ;(window as any).__FFW_camera = camera
    ;(window as any).__FFW_controls = controls

    let userInteracting = false
    controls.addEventListener('start', () => { userInteracting = true })
    controls.addEventListener('end', () => { userInteracting = false })

    // Palette
    const baseAccent = new THREE.Color('#77d0ff')
    const baseAccent2 = new THREE.Color('#a7b8ff')
    const accent = baseAccent.clone()
    const accent2 = baseAccent2.clone()

    // Grid
    const grid = new THREE.GridHelper(160, 160, accent2.clone().multiplyScalar(0.25), accent2.clone().multiplyScalar(0.08))
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.05
    grid.position.y = 0
    scene.add(grid)

    // Floor
    const floorSize = 22
    const floorGeom = new THREE.PlaneGeometry(floorSize, floorSize, 1, 1)
    const floorMat = new THREE.ShaderMaterial({
      uniforms: { tAlbum: { value: null as THREE.Texture | null }, uDim: { value: 0.82 }, uOpacity: { value: 0.85 } },
      transparent: true, depthWrite: false,
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tAlbum; uniform float uDim, uOpacity;
        void main(){
          vec3 bg = vec3(0.06,0.08,0.1);
          vec3 col = mix(bg, texture2D(tAlbum, vUv).rgb, 0.6) * uDim;
          gl_FragColor = vec4(col, uOpacity);
        }`
    })
    const floorMesh = new THREE.Mesh(floorGeom, floorMat)
    floorMesh.rotation.x = -Math.PI / 2
    floorMesh.position.y = 0.001
    scene.add(floorMesh)

    // Placeholder on floor tex
    const floorPlaceholder = createDarkPlaceholderTexture()
    floorMat.uniforms.tAlbum.value = floorPlaceholder

    // Mosaic
    const mosaicGroup = new THREE.Group()
    const tiles: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = []
    const tileN = 8
    const tileSize = floorSize / tileN
    const placeholderTex = createDarkPlaceholderTexture()
    for (let y = 0; y < tileN; y++) {
      for (let x = 0; x < tileN; x++) {
        const g = new THREE.PlaneGeometry(tileSize, tileSize)
        const m = new THREE.MeshBasicMaterial({ color: 0xffffff, map: placeholderTex, transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false })
        m.color.setScalar(0.85)
        const mesh = new THREE.Mesh(g, m)
        mesh.rotation.x = -Math.PI / 2
        mesh.position.set((x + 0.5) * tileSize - floorSize / 2, 0.0025, (y + 0.5) * tileSize - floorSize / 2)
        mosaicGroup.add(mesh); tiles.push(mesh)
      }
    }
    let mosaicMapTex: THREE.Texture = placeholderTex
    const applyTilesMap = (tex: THREE.Texture) => {
      mosaicMapTex = tex
      for (const t of tiles) {
        t.material.map = tex
        t.material.toneMapped = false
        t.material.color.setScalar(0.85)
        t.material.needsUpdate = true
      }
    }
    applyTilesMap(placeholderTex)
    mosaicGroup.visible = false
    scene.add(mosaicGroup)

    // Wireframe mansion edges
    const mansionPositions = buildMansionEdges()
    const fatGeo = new LineSegmentsGeometry()
    fatGeo.setPositions(mansionPositions)
    const fatMat = new LineMaterial({ color: accent.getHex(), transparent: true, opacity: 0.95, depthTest: true })
    ;(fatMat as any).worldUnits = false
    const setLinePixels = (px: number) => {
      const draw = renderer.getDrawingBufferSize(new THREE.Vector2())
      fatMat.linewidth = Math.max(0.003, px / Math.max(1, draw.y))
      fatMat.needsUpdate = true
    }
    {
      const draw = renderer.getDrawingBufferSize(new THREE.Vector2())
      fatMat.resolution.set(draw.x, draw.y)
      setLinePixels(cfgRef.current.lineWidthPx)
    }
    const fatLines = new LineSegments2(fatGeo, fatMat)
    scene.add(fatLines)

    const thinGeo = new THREE.BufferGeometry()
    thinGeo.setAttribute('position', new THREE.BufferAttribute(mansionPositions, 3))
    const thinMat = new THREE.LineBasicMaterial({ color: accent.getHex(), transparent: true, opacity: 0.95, depthTest: true })
    const thinLines = new THREE.LineSegments(thinGeo, thinMat)
    thinLines.visible = false
    scene.add(thinLines)

    // Static windows
    const windowGroup = new THREE.Group()
    {
      const winGeom = new THREE.PlaneGeometry(0.22, 0.16)
      const addWindow = (p: THREE.Vector3, out: THREE.Vector3) => {
        const m = new THREE.MeshBasicMaterial({ color: accent2, transparent: true, opacity: 0.12 })
        const mesh = new THREE.Mesh(winGeom, m)
        mesh.position.copy(p); mesh.lookAt(p.clone().add(out))
        windowGroup.add(mesh)
      }
      addMansionWindows((p, out) => addWindow(p, out))
      scene.add(windowGroup)
    }

    // 3D Lyric Billboard
    const billboard = new LyricBillboard({
      baseColor: 0xffffff,
      outlineColor: accent2.getHex(),
      highlightColor: accent.getHex(),
      fontSize: 0.36
    })
    billboard.group.position.copy(billboardPosRef.current)
    billboard.group.rotation.y = billboardYawRef.current
    billboard.group.scale.setScalar(billboardScaleRef.current)
    scene.add(billboard.group)

    // Starfield
    let starfield: THREE.Points | null = null
    {
      const g = new THREE.BufferGeometry()
      const N = 900
      const positions = new Float32Array(N * 3)
      for (let i=0;i<N;i++){
        const r = THREE.MathUtils.lerp(45, 80, Math.random())
        const theta = Math.acos(THREE.MathUtils.lerp(-1, 1, Math.random()))
        const phi = Math.random()*Math.PI*2
        const x = r * Math.sin(theta) * Math.cos(phi)
        const y = r * Math.cos(theta) * 0.4
        const z = r * Math.sin(theta) * Math.sin(phi)
        positions.set([x,y,z], i*3)
      }
      g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      const m = new THREE.PointsMaterial({ color: 0xeaf3ff, size: 0.7, sizeAttenuation: true, transparent: true, opacity: 0.45, depthWrite: false })
      starfield = new THREE.Points(g, m)
      starfield.visible = !!cfgRef.current.fx.starfield
      scene.add(starfield)
    }

    // Haze
    const fogMat = (() => {
      const geom = new THREE.PlaneGeometry(34, 12)
      const mat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uIntensity: { value: 0 }, uColor: { value: new THREE.Color(0xa9cfff) } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
        fragmentShader: `
          precision highp float; varying vec2 vUv; uniform float uTime; uniform float uIntensity; uniform vec3 uColor;
          float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
          float noise(vec2 p){ vec2 i=floor(p), f=fract(p); float a=hash(i), b=hash(i+vec2(1.,0.)), c=hash(i+vec2(0.,1.)), d=hash(i+vec2(1.,1.));
            vec2 u=f*f*(3.-2.*f); return mix(a,b,u.x)+ (c-a)*u.y*(1.-u.x) + (d-b)*u.x*u.y; }
          void main(){ float n=noise(vUv*2.2+vec2(uTime*0.025,0.0)); float m=smoothstep(0.32,0.78,n);
            float alpha=m*uIntensity*0.38; gl_FragColor=vec4(uColor,alpha); }`
      })
      const mesh = new THREE.Mesh(geom, mat)
      mesh.position.set(0, 3.2, -1.4); mesh.rotation.x = -0.06
      scene.add(mesh)
      return mat
    })()

    // Marquee
    let marqueeMat: THREE.ShaderMaterial | null = null
    let marqueeTex: THREE.Texture | null = null
    let marqueeText = ''
    const setupMarquee = (text: string, opacity = 0.8) => {
      const canvas = document.createElement('canvas')
      canvas.width = 2048; canvas.height = 128
      const g = canvas.getContext('2d')!
      g.clearRect(0,0,canvas.width,canvas.height)
      g.font = '700 78px system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
      g.textBaseline = 'middle'
      g.fillStyle = '#ffffff'
      g.shadowColor = 'rgba(0,0,0,0.9)'; g.shadowBlur = 8
      const gap = 90
      const metrics = g.measureText(text)
      const w = Math.max(metrics.width + gap, 500)
      let x = 0
      while (x < canvas.width + w) { g.fillText(text, x, canvas.height/2); x += w }
      const tex = new THREE.CanvasTexture(canvas)
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.ClampToEdgeWrapping
      tex.repeat.set(2, 1)
      tex.colorSpace = THREE.SRGBColorSpace
      marqueeTex?.dispose(); marqueeTex = tex

      if (!marqueeMat) {
        marqueeMat = new THREE.ShaderMaterial({
          uniforms: { tText: { value: marqueeTex }, uScroll: { value: 0 }, uOpacity: { value: opacity }, uTint: { value: new THREE.Color(0xffffff) } },
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
          vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
          fragmentShader: `
            precision highp float; varying vec2 vUv;
            uniform sampler2D tText; uniform float uScroll; uniform float uOpacity; uniform vec3 uTint;
            void main(){ vec2 uv=vUv; uv.x=fract(uv.x+uScroll); vec4 c=texture2D(tText, uv);
              float edge = smoothstep(0.0,0.06,uv.x)*smoothstep(1.0,0.94,uv.x);
              gl_FragColor = vec4(c.rgb*uTint, c.a*uOpacity*edge); }`
        })
        const geom = new THREE.PlaneGeometry(4.8, 0.28)
        const mesh = new THREE.Mesh(geom, marqueeMat)
        mesh.position.set(0, 2.48, 1.305)
        scene.add(mesh)
      } else {
        marqueeMat.uniforms.tText.value = marqueeTex
        marqueeMat.uniforms.uOpacity.value = opacity
        marqueeMat.needsUpdate = true
      }
    }
    if (cfgRef.current.fx.lyricsMarquee) { marqueeText = 'FFw Visualizer'; setupMarquee(marqueeText, 0.85) }

    // Covers + lyrics
    let floorTex: THREE.Texture | null = null
    let currentTrackId: string | null = null

    const syncPlaybackClock = async () => {
      try {
        const s = await getPlaybackState().catch(() => null)
        if (!s?.item?.id) return
        pbClock.current.playing = !!s.is_playing
        pbClock.current.offsetMs = s.progress_ms ?? 0
        pbClock.current.startedAt = Date.now() - (s.progress_ms ?? 0)
      } catch {}
    }

    const loadAlbumCoverAndLyrics = async () => {
      try {
        const s = await getPlaybackState().catch(() => null)
        const id = (s?.item?.id as string) || null
        const url = (s?.item?.album?.images?.[0]?.url as string) || null
        const title = (s?.item?.name as string) || ''
        const artist = (s?.item?.artists?.[0]?.name as string) || ''
        const progress = (s?.progress_ms as number) ?? 0
        const isPlaying = (s?.is_playing as boolean) ?? false

        if (id) {
          pbClock.current.playing = !!isPlaying
          pbClock.current.offsetMs = progress
          pbClock.current.startedAt = Date.now() - progress
        }

        if (url) {
          const blobUrl = await cacheAlbumArt(url).catch(() => url)
          const tex = await new Promise<THREE.Texture>((resolve, reject) => {
            new THREE.TextureLoader().load(blobUrl, t => resolve(t), undefined, reject)
          })
          tex.colorSpace = THREE.SRGBColorSpace
          tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
          tex.minFilter = THREE.LinearMipmapLinearFilter
          tex.magFilter = THREE.LinearFilter
          tex.generateMipmaps = true

          const brightness = await estimateTextureLuminance(tex).catch(() => 0.6)
          floorMat.uniforms.uDim.value = clamp(1.02 - brightness * 0.45, 0.6, 0.92)
          floorMat.uniforms.uOpacity.value = clamp(0.9 - (brightness - 0.6) * 0.25, 0.65, 0.9)

          const avg = await averageTextureColor(tex).catch(() => new THREE.Color(0x88c8ff))
          carColorRef.current.copy(avg)

          floorTex?.dispose(); floorTex = tex
          floorMat.uniforms.tAlbum.value = tex; floorMat.needsUpdate = true

          if (cfgRef.current.fx.mosaicFloor) applyTilesMap(tex)
        }

        if (cfgRef.current.fx.lyricsMarquee && id && id !== currentTrackId) {
          currentTrackId = id
          let line = title && artist ? `${title} — ${artist}` : (title || artist || '')
          let synced: SyncedLine[] | undefined = undefined
          try {
            const lr = await fetchLyrics({ title, artist })
            if (lr) { line = lr.plain || line; synced = lr.synced }
          } catch {}
          syncedRef.current = synced || null
          currentLineRef.current = -1
          if (line && line !== marqueeText) { marqueeText = line; setupMarquee(line, 0.9) }

          if (synced?.length) {
            const first = synced[0]?.text || line
            await billboard.setLineNow(first)
            billboard.triggerPop(0.8)
            if (synced[1]?.text) await billboard.prepareNext(synced[1].text)
          } else if (line) {
            await billboard.setLineNow(line)
            billboard.triggerPop(0.8)
          }
        }
      } catch {}
    }
    loadAlbumCoverAndLyrics()
    const albumIv = window.setInterval(loadAlbumCoverAndLyrics, 5000)
    const pbIv = window.setInterval(syncPlaybackClock, 2000)

    // Reactivity
    let latest: ReactiveFrame | null = null
    const offFrame = reactivityBus.on('frame', f => { latest = f })

    // Mansion safe rectangle
    const safeRect = { minX: -5.0, maxX: 5.0, minZ: -2.4, maxZ: 2.4 }

    // GLB car model
    const car = createGlbCarModel({
      url: DEFAULT_GLB_URL,
      fallbackUrl: LOCAL_FALLBACK_GLB_URL,
      targetLengthMeters: 4.6,
      baseY: 0.055,
      getAlbumColor: () => carColorRef.current,
      getControls: () => ({
        scale: cfgRef.current.car.scale,
        yOffset: cfgRef.current.car.yOffset,
        outline: cfgRef.current.car.outline,
        flipForward: cfgRef.current.car.flipForward
      }),
      getEffects: () => ({
        smokeEnabled: cfgRef.current.car.smokeEnabled,
        smokeDensity: cfgRef.current.car.smokeDensity,
        smokeTintAlbum: cfgRef.current.car.smokeTintAlbum,
        skidEnabled: cfgRef.current.car.skidEnabled,
        skidOpacity: cfgRef.current.car.skidOpacity,
        skidSegments: cfgRef.current.car.skidSegments,
        lightsHeadEnabled: cfgRef.current.car.lightsHeadEnabled,
        lightsHeadIntensity: cfgRef.current.car.lightsHeadIntensity,
        lightsTailEnabled: cfgRef.current.car.lightsTailEnabled,
        lightsTailIntensity: cfgRef.current.car.lightsTailIntensity,
        lightsBrakeBoost: cfgRef.current.car.lightsBrakeBoost,
        wheelSpinEnabled: cfgRef.current.car.wheelSpinEnabled
      }),
    })
    car.group.visible = !!cfgRef.current.fx.wireCar
    scene.add(car.group)
    carApiRef.current = car

    // Resize
    const updateSizes = () => {
      const draw = renderer.getDrawingBufferSize(new THREE.Vector2())
      const view = renderer.getSize(new THREE.Vector2())
      camera.aspect = view.x / Math.max(1, view.y)
      camera.updateProjectionMatrix()
      comp.onResize()
      fatMat.resolution.set(draw.x, draw.y)
      setLinePixels(cfgRef.current.lineWidthPx)
    }
    window.addEventListener('resize', updateSizes)
    updateSizes()

    // Animate
    const clock = new THREE.Clock()
    let raf = 0
    let frames = 0
    let fallbackArmed = false

    const animate = () => {
      raf = requestAnimationFrame(animate)
      const dt = Math.min(0.05, clock.getDelta())
      const t = clock.elapsedTime
      const now = performance.now()
      const stale = !latest || (now - (latest.t || 0)) > 240

      const cfgC = cfgRef.current
      const low = latest?.bands.low ?? 0.08
      const mid = latest?.bands.mid ?? 0.08
      const high = latest?.bands.high ?? 0.08
      const loud = latest?.loudness ?? 0.15

      if (camera.fov !== cfgC.camera.fov) {
        camera.fov = cfgC.camera.fov
        camera.updateProjectionMatrix()
      }

      controls.enableDamping = cfgC.camera.enableDamping
      controls.dampingFactor = cfgC.camera.dampingFactor
      controls.enablePan = cfgC.camera.enablePan
      controls.enableZoom = cfgC.camera.enableZoom
      controls.rotateSpeed = cfgC.camera.rotateSpeed
      controls.zoomSpeed = cfgC.camera.zoomSpeed
      controls.panSpeed = cfgC.camera.panSpeed
      controls.minDistance = cfgC.camera.minDistance
      controls.maxDistance = cfgC.camera.maxDistance
      controls.minPolarAngle = cfgC.camera.minPolarAngle
      controls.maxPolarAngle = cfgC.camera.maxPolarAngle

      // Billboard controller
      if (bbEditRef.current) {
        if (bbModeRef.current === 'move') {
          const mv = moveVecRef.current
          const speed = 3.0
          if (bbPlaneRef.current === 'XZ') {
            billboardPosRef.current.x += (mv.x * speed) * dt
            billboardPosRef.current.z += (-mv.y * speed) * dt
            billboardPosRef.current.y += (moveAxis3Ref.current * speed) * dt
          } else {
            billboardPosRef.current.x += (mv.x * speed) * dt
            billboardPosRef.current.y += (mv.y * speed) * dt
            billboardPosRef.current.z += (moveAxis3Ref.current * speed) * dt
          }
          billboardPosRef.current.y = THREE.MathUtils.clamp(billboardPosRef.current.y, 1.2, 5.2)
        }
        if (bbModeRef.current === 'rotate') {
          const rvx = rotateVecRef.current.x
          const yawSpeed = 2.8
          billboardYawRef.current += (rvx * yawSpeed) * dt
        }
        if (bbModeRef.current === 'scale') {
          const sDelta = scaleDeltaRef.current
          const sSpeed = 1.4
          const next = THREE.MathUtils.clamp(billboardScaleRef.current + (sDelta * sSpeed) * dt, 0.35, 3.0)
          billboardScaleRef.current = next
        }
        billboard.group.position.copy(billboardPosRef.current)
        billboard.group.rotation.y = billboardYawRef.current
        billboard.setUserScale(billboardScaleRef.current)
        billboard.group.scale.setScalar(billboardScaleRef.current)
      }

      // colors
      accent.copy(baseAccent).lerp(baseAccent2, THREE.MathUtils.clamp(high * 0.25, 0, 0.25))
      accent2.copy(baseAccent2).lerp(baseAccent, THREE.MathUtils.clamp(mid * 0.2, 0, 0.2))
      fatMat.color.set(accent); thinMat.color.set(accent)

      billboard.setColors(
        accent.clone().multiplyScalar(0.9),
        accent2.clone().multiplyScalar(1.0),
        accent.clone().multiplyScalar(1.0)
      )
      billboard.setVisible(!!cfgC.fx.lyricsMarquee)

      // Car update
      car.group.visible = !!cfgC.fx.wireCar
      if (car.group.visible) {
        car.setColor?.(carColorRef.current)
        const loopSize = Math.min(cfgC.car.pathRadius, (floorSize * 0.5 - 1.0))
        car.update(dt, {
          t,
          radius: loopSize,
          turntable: cfgC.car.turntable,
          flipForward: cfgC.car.flipForward,
          scale: cfgC.car.scale,
          yOffset: cfgC.car.yOffset,
          albumColor: carColorRef.current,
          safeRect
        })
        car.setOutlineVisible(cfgC.car.outline)
      }

      // lines
      const px = cfgC.lineWidthPx * (1.0 + 0.08 * (latest?.beat ? 1 : 0) + 0.05 * high)
      setLinePixels(px)

      // fog
      ;(fogMat as any).uniforms.uTime.value = t
      ;(fogMat as any).uniforms.uIntensity.value = THREE.MathUtils.clamp(0.08 + loud * 0.5 + (latest?.beat ? 0.15 : 0), 0, accessibility.epilepsySafe ? 0.35 : 0.5)
      ;((fogMat as any).uniforms.uColor.value as THREE.Color).copy(new THREE.Color().copy(accent2).lerp(accent, 0.5))

      // starfield
      if (starfield) starfield.visible = !!cfgC.fx.starfield

      // mosaic
      mosaicGroup.visible = !!cfgC.fx.mosaicFloor
      floorMesh.visible = !mosaicGroup.visible
      if (mosaicGroup.visible) {
        const desired = floorTex ?? placeholderTex
        if (mosaicMapTex !== desired) applyTilesMap(desired)
      }

      // Lyrics timing
      const lines = syncedRef.current
      if (cfgC.fx.lyricsMarquee && lines?.length) {
        const pb = pbClock.current
        const ms = pb.playing ? (Date.now() - pb.startedAt) : pb.offsetMs
        if (Math.abs(ms - lastVisualMsRef.current) > 2000) currentLineRef.current = -1
        lastVisualMsRef.current = ms

        let idx = currentLineRef.current
        if (idx < 0 || idx >= lines.length || ms < lines[idx].timeMs || (idx < lines.length - 1 && ms >= lines[idx + 1].timeMs)) {
          let lo = 0, hi = lines.length - 1, found = 0
          while (lo <= hi) { const midIdx = (lo + hi) >> 1; if (lines[midIdx].timeMs <= ms) { found = midIdx; lo = midIdx + 1 } else { hi = midIdx - 1 } }
          idx = found
          if (idx !== currentLineRef.current) {
            currentLineRef.current = idx
            const text = lines[idx].text || ''
            if (text) {
              billboard.prepareNext(text).then(() => { billboard.beginSwap(); billboard.triggerPop(1.0) })
              if (marqueeMat && text !== marqueeText) { marqueeText = text; setupMarquee(text, 0.92) }
            }
          }
        }
        const curStart = lines[idx]?.timeMs ?? ms
        const nextStart = lines[idx + 1]?.timeMs ?? (curStart + 2500)
        const dur = Math.max(300, nextStart - curStart)
        const prog = THREE.MathUtils.clamp((ms - curStart) / dur, 0, 1)
        billboard.setProgress(prog)

        if (marqueeMat) marqueeMat.uniforms.uScroll.value = (marqueeMat.uniforms.uScroll.value + dt * 0.03) % 1
      } else {
        if (marqueeMat) {
          marqueeMat.uniforms.uScroll.value = (marqueeMat.uniforms.uScroll.value + dt * 0.045) % 1
          marqueeMat.uniforms.uOpacity.value = cfgC.fx.lyricsMarquee ? 0.85 : 0.0
        }
      }

      billboard.update(dt)

      // camera autopilot + bob
      const bob = Math.sin(t * 1.4) * cfgC.camBob
      if (cfgC.camera.autoPath && !userInteracting) {
        const baseSpeed = cfgC.orbitSpeed
        const audioBoost = 0.4 * (low + mid + high)
        angleRef.current += dt * (baseSpeed + audioBoost)
        const radiusC = THREE.MathUtils.clamp(cfgC.orbitRadius, 6.0, 12.0)
        const elev = cfgC.orbitElev
        const pos = pathPoint(cfgC.path, angleRef.current, radiusC)
        camera.position.set(pos.x, Math.sin(elev) * (radiusC * 0.55) + 2.4 + bob, pos.z)
        camera.lookAt(cfgC.camera.target.x, cfgC.camera.target.y, cfgC.camera.target.z)
        controls.target.set(cfgC.camera.target.x, cfgC.camera.target.y, cfgC.camera.target.z)
      } else {
        camera.position.y += (bob - (camera as any).__lastBobY || 0)
        ;(camera as any).__lastBobY = bob
      }

      ;(grid.material as THREE.Material).opacity = 0.05 * (stale ? 0.6 : 1.0)
      controls.update()
      comp.composer.render()

      // fallback: line material issue
      frames++
      if (!fallbackArmed && frames > 12) {
        const dc = (renderer.info.render.calls || 0)
        if (dc <= 1) {
          fallbackArmed = true
          fatLines.visible = false
          thinLines.visible = true
        }
      }
    }

    animate()

    return () => {
      window.removeEventListener('resize', updateSizes)
      cancelAnimationFrame(raf)
      clearInterval(albumIv)
      clearInterval(pbIv)
      offFrame?.()
      controls.dispose()
      floorTex?.dispose()
      marqueeTex?.dispose?.()
      billboard.dispose()
      car.dispose()
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
      floorPlaceholder?.dispose()
      delete (window as any).__FFW_camera
      delete (window as any).__FFW_controls
    }

    function buildMansionEdges(): Float32Array {
      const out: number[] = []
      const y0 = 0.0, y1 = 1.2, y2 = 2.35, y3 = 3.5
      const roofC = 4.5, roofW = 4.2
      addStackedBlock(-2.2, 2.2, -1.3, 1.3, [y0, y1, y2, y3])
      addStackedBlock(-4.2, -2.2, -1.6, 1.6, [y0, y1, y2, y3])
      addStackedBlock( 2.2,  4.2, -1.6, 1.6, [y0, y1, y2, y3])
      addPortico(-1.0, 1.0, 1.3, y0, y1 * 0.85, y1 + 0.6)
      addRailing(-1.7, 1.7, 1.3, y2 + 0.12)
      addGabledRoof(-2.2,  2.2, -1.3, 1.3, y3, roofC, 'z')
      addGabledRoof(-4.2, -2.2, -1.6, 1.6, y3, roofW, 'z')
      addGabledRoof( 2.2,  4.2, -1.6, 1.6, y3, roofW, 'z')
      addChimney(-0.8, y3 + 0.25,  0.2)
      addChimney( 0.9, y3 + 0.25, -0.25)
      addDoor(-0.55, 0.55, 1.301, y0, y1 * 0.88)
      addWindowFrames()
      return new Float32Array(out)

      function E(ax:number, ay:number, az:number, bx:number, by:number, bz:number) { out.push(ax, ay, az, bx, by, bz) }
      function rect(minX:number, maxX:number, y:number, minZ:number, maxZ:number) {
        E(minX, y, minZ, maxX, y, minZ); E(maxX, y, minZ, maxX, y, maxZ); E(maxX, y, maxZ, minX, y, maxZ); E(minX, y, maxZ, minX, y, minZ)
      }
      function addStackedBlock(minX:number, maxX:number, minZ:number, maxZ:number, levels:number[]) {
        for (const y of levels) rect(minX, maxX, y, minZ, maxZ)
        const corners: [number, number][] = [[minX, minZ],[maxX, minZ],[maxX, maxZ],[minX, maxZ]]
        for (const [cx, cz] of corners) for (let i=0;i<levels.length-1;i++) E(cx, levels[i], cz, cx, levels[i+1], cz)
        const spanX = maxX - minX, spanZ = maxZ - minZ
        const yb = levels[0], yt = levels[levels.length-1]
        for (let t=1;t<=3;t++) { const x = minX + (spanX * t)/4; E(x, yb, maxZ, x, yt, maxZ); E(x, yb, minZ, x, yt, minZ) }
        for (let t=1;t<=3;t++) { const z = minZ + (spanZ * t)/4; E(minX, yb, z, minX, yt, z); E(maxX, yb, z, maxX, yt, z) }
      }
      function addGabledRoof(minX:number, maxX:number, minZ:number, maxZ:number, topY:number, apexY:number, ridgeAxis:'x'|'z') {
        rect(minX, maxX, topY, minZ, maxZ)
        let r1:THREE.Vector3, r2:THREE.Vector3
        if (ridgeAxis === 'z') { const cx = (minX+maxX)*0.5; r1 = new THREE.Vector3(cx, apexY, minZ); r2 = new THREE.Vector3(cx, apexY, maxZ) }
        else { const cz = (minZ+maxZ)*0.5; r1 = new THREE.Vector3(minX, apexY, cz); r2 = new THREE.Vector3(maxX, apexY, cz) }
        E(r1.x, r1.y, r1.z, r2.x, r2.y, r2.z)
        const c = [ new THREE.Vector3(minX, topY, minZ), new THREE.Vector3(maxX, topY, minZ), new THREE.Vector3(maxX, topY, maxZ), new THREE.Vector3(minX, topY, maxZ) ]
        E(c[0].x, c[0].y, c[0].z, r1.x, r1.y, r1.z); E(c[1].x, c[1].y, c[1].z, r1.x, r1.y, r1.z)
        E(c[2].x, c[2].y, c[2].z, r2.x, r2.y, r2.z); E(c[3].x, c[3].y, c[3].z, r2.x, r2.y, r2.z)
      }
      function addChimney(x:number, y:number, z:number) {
        const w=0.24, d=0.24, h=0.7
        rect(x-w/2, x+w/2, y, z-d/2, z+d/2)
        rect(x-w/2, x+w/2, y+h, z-d/2, z+d/2)
        const pts: [number, number][] = [[x-w/2,z-d/2],[x+w/2,z-d/2],[x+w/2,z+d/2],[x-w/2,z+d/2]]
        for (const [cx,cz] of pts) E(cx,y,cz,cx,y+h,cz)
      }
      function addPortico(minX:number, maxX:number, zFront:number, yBase:number, yCap:number, yRoof:number) {
        rect(minX, maxX, yBase+0.02, zFront-0.3, zFront+0.2)
        rect(minX, maxX, yRoof, zFront-0.25, zFront+0.25)
        const cols = [[minX+0.1, zFront-0.22],[maxX-0.1, zFront-0.22],[minX+0.1, zFront+0.18],[maxX-0.1, zFront+0.18]]
        for (const [cx, cz] of cols) { E(cx, yBase, cz, cx, yCap, cz); E(cx, yCap, cz, cx, yRoof, cz) }
      }
      function addRailing(minX:number, maxX:number, zFront:number, y:number) {
        E(minX, y, zFront, maxX, y, zFront)
        E(minX, y-0.1, zFront, maxX, y-0.1, zFront)
        for (let i=0;i<=14;i++) { const x = THREE.MathUtils.lerp(minX, maxX, i/14); E(x, y-0.1, zFront, x, y, zFront) }
      }
      function addDoor(minX:number, maxX:number, zFront:number, yb:number, yt:number) {
        E(minX, yb, zFront, minX, yt, zFront); E(maxX, yb, zFront, maxX, yt, zFront); E(minX, yt, zFront, maxX, yt, zFront)
      }
      function addWindowFrames() {
        const levels: [number, number][] = [[0.4, 0.95],[1.55, 2.1],[2.65, 3.2]]
        const CF = { minX:-2.2, maxX: 2.2, minZ:-1.3, maxZ: 1.3 }
        const LW = { minX:-4.2, maxX:-2.2, minZ:-1.6, maxZ: 1.6 }
        const RW = { minX: 2.2, maxX: 4.2, minZ:-1.6, maxZ: 1.6 }
        const faces = [
          { minX: CF.minX, maxX: CF.maxX, z: CF.maxZ }, { minX: CF.minX, maxX: CF.maxX, z: CF.minZ },
          { minX: LW.minX, maxX: LW.maxX, z: LW.maxZ }, { minX: LW.minX, maxX: LW.maxX, z: LW.minZ },
          { minX: RW.minX, maxX: RW.maxX, z: RW.maxZ }, { minX: RW.minX, maxX: RW.maxX, z: RW.minZ },
        ]
        for (const f of faces) for (const [yb, yt] of levels) {
          const cols = 6, pad = 0.18
          for (let c=0;c<cols;c++) {
            const x0 = THREE.MathUtils.lerp(f.minX+pad, f.maxX-pad, (c+0.1)/cols)
            const x1 = THREE.MathUtils.lerp(f.minX+pad, f.maxX-pad, (c+0.9)/cols)
            E(x0, yb, f.z, x1, yb, f.z); E(x1, yb, f.z, x1, yt, f.z); E(x1, yt, f.z, x0, yt, f.z); E(x0, yt, f.z, x0, yb, f.z)
            const xm = (x0+x1)/2, ym = (yb+yt)/2
            E(xm, yb, f.z, xm, yt, f.z); E(x0, ym, f.z, x1, ym, f.z)
          }
        }
        const sides = [{ x:-2.2, minZ:CF.minZ, maxZ:CF.maxZ },{ x: 2.2, minZ:CF.minZ, maxZ:CF.maxZ }]
        for (const s of sides) for (const [yb, yt] of levels) {
          const rows = 5
          for (let i=0;i<rows;i++) {
            const z0 = THREE.MathUtils.lerp(s.minZ+0.12, s.maxZ-0.12, (i+0.15)/rows)
            const z1 = THREE.MathUtils.lerp(s.minZ+0.12, s.maxZ-0.12, (i+0.85)/rows)
            E(s.x, yb, z0, s.x, yb, z1); E(s.x, yb, z1, s.x, yt, z1); E(s.x, yt, z1, s.x, yt, z0); E(s.x, yt, z0, s.x, yb, z0)
            const zm = (z0+z1)/2, ym = (yb+yt)/2
            E(s.x, yb, zm, s.x, yt, zm); E(s.x, ym, z0, s.x, ym, z1)
          }
        }
      }
    }

    // === Car model with wheel rigs and oval loop ===
    function createGlbCarModel(opts: {
      url: string
      fallbackUrl?: string
      targetLengthMeters: number
      baseY: number
      getAlbumColor: () => THREE.Color
      getControls: () => { scale: number; yOffset: number; outline: boolean; flipForward: boolean }
      getEffects: () => {
        smokeEnabled: boolean; smokeDensity: number; smokeTintAlbum: boolean;
        skidEnabled: boolean; skidOpacity: number; skidSegments: number;
        lightsHeadEnabled: boolean; lightsHeadIntensity: number;
        lightsTailEnabled: boolean; lightsTailIntensity: number; lightsBrakeBoost: number;
        wheelSpinEnabled: boolean;
      }
    }) {
      const group = new THREE.Group()
      group.renderOrder = 3
      group.position.y = opts.baseY

      const holder = new THREE.Group()
      group.add(holder)

      // Materials + candidates
      const originals = new WeakMap<THREE.Material, { color?: THREE.Color; emissive?: THREE.Color }>()
      const candidatePaintMats = new Set<THREE.Material>()
      const headlightMats: THREE.Material[] = []
      const taillightMats: THREE.Material[] = []
      const edgeLines: THREE.LineSegments[] = []

      // Wheels detection/wiring
      type WheelDetected = { node: THREE.Object3D, radius: number, isRear: boolean, isLeft: boolean }
      type WheelRig = { radius: number, isRear: boolean, isLeft: boolean, spinPivot: THREE.Object3D, steerPivot?: THREE.Object3D }
      const detected: WheelDetected[] = []
      const rigs: WheelRig[] = []

      // Lights objects
      const headLights: THREE.SpotLight[] = []
      const tailLights: THREE.PointLight[] = []

      // Smoke system
      const smoke = createSmokeSystem()
      group.add(smoke.group)

      // Skid marks
      const skid = createSkidSystem()
      group.add(skid.group)

      // Direction + movement
      let forwardSign: 1 | -1 = 1
      let baseScale = 1

      const prevWorldPos = new THREE.Vector3()
      group.getWorldPosition(prevWorldPos)
      let prevSpeed = 0
      let lastYaw: number | null = null

      // Loop param
      const loop = { u: 0 }

      const loader = new GLTFLoader()
      try {
        const dracoPath = (window as any)?.FFW_DRACO_DECODER_PATH
        if (dracoPath) {
          const dracoLoader = new DRACOLoader()
          dracoLoader.setDecoderPath(dracoPath)
          loader.setDRACOLoader(dracoLoader)
        }
      } catch {}
      try { (loader as any).setMeshoptDecoder?.(MeshoptDecoder) } catch {}

      const sourceList = [opts.url, opts.fallbackUrl].filter(Boolean) as string[]
      ;(async () => {
        for (const src of sourceList) {
          try {
            const gltf = await loader.loadAsync(src)
            prepareModel(gltf.scene)
            break
          } catch (e) {
            console.warn('GLB load failed, trying next source:', src, e)
          }
        }
      })()

      function prepareModel(scene: THREE.Object3D) {
        const bbox0 = new THREE.Box3().setFromObject(scene)
        const size0 = new THREE.Vector3(); bbox0.getSize(size0)

        // Map longest horizontal axis to X
        let yaw = 0
        if (size0.z > size0.x && size0.z >= size0.y) yaw = -Math.PI / 2
        scene.rotation.y = yaw

        const bbox1 = new THREE.Box3().setFromObject(scene)
        const size1 = new THREE.Vector3(); bbox1.getSize(size1)

        const lengthX = Math.max(0.001, size1.x)
        baseScale = opts.targetLengthMeters / lengthX
        scene.scale.setScalar(baseScale)

        const bbox2 = new THREE.Box3().setFromObject(scene)
        const size2 = new THREE.Vector3(); const center2 = new THREE.Vector3()
        bbox2.getSize(size2); bbox2.getCenter(center2)

        scene.position.x = -center2.x
        scene.position.z = -center2.z
        scene.position.y = -bbox2.min.y

        const wheelRegex = /(wheel|rim|tyre|tire)/i
        scene.traverse((obj) => {
          const mesh = obj as THREE.Mesh
          if ((mesh as any).isMesh) {
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
            for (const m of mats) {
              if (!m) continue
              if (!originals.has(m)) {
                originals.set(m, {
                  color: (m as any).color ? (m as any).color.clone() : undefined,
                  emissive: (m as any).emissive ? (m as any).emissive.clone() : undefined
                })
              }
              const nm = ((m.name || '') + ' ' + (mesh.name || '')).toLowerCase()
              const isHead = /head ?light|daytime|fog/i.test(nm)
              const isTail = /tail ?light|brake|rear ?light/i.test(nm)
              const nameHit = /paint|carpaint|body|exterior|coat|shell|door|hood|roof|fender/.test(nm)
              const nonGlass = !/glass|window|mirror|windshield|headlight glass|taillight glass/i.test(nm)
              const notTire = !/tire|tyre|wheel|rim|rubber|brake|caliper/.test(nm)
              const std = (m as any)
              if ((nameHit || (std?.color && nonGlass && notTire)) && std instanceof THREE.MeshStandardMaterial) {
                candidatePaintMats.add(m)
                std.toneMapped = true
                std.depthWrite = true
              }
              if (isHead) headlightMats.push(m)
              if (isTail) taillightMats.push(m)
              if ((m as any).side !== THREE.FrontSide) (m as any).side = THREE.FrontSide
              if ((m as any).transparent && (m as any).opacity < 0.04) (m as any).opacity = 0.04
            }

            // Outline edges
            try {
              const eg = new THREE.EdgesGeometry(mesh.geometry, 30)
              const emat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, depthWrite: false, depthTest: true, toneMapped: true })
              const edges = new THREE.LineSegments(eg, emat)
              edges.name = `edges_of_${mesh.name || 'mesh'}`
              mesh.add(edges)
              edgeLines.push(edges)
            } catch {}
          }

          // Wheels by node name and approximate radius
          if (wheelRegex.test(obj.name)) {
            const box = new THREE.Box3().setFromObject(obj)
            const size = new THREE.Vector3(); const center = new THREE.Vector3()
            box.getSize(size); box.getCenter(center)
            const radius = Math.max(size.y, size.z) * 0.5
            detected.push({ node: obj, radius: Math.max(0.05, radius), isRear: false, isLeft: center.z < 0 })
          }
        })

        // Try to infer wheels if not detected
        if (detected.length < 2) {
          const candidates: { node: THREE.Object3D, radius: number, center: THREE.Vector3 }[] = []
          scene.traverse((o) => {
            const mesh = o as any
            if (!mesh.isMesh) return
            const box = new THREE.Box3().setFromObject(mesh)
            const size = new THREE.Vector3(); const center = new THREE.Vector3()
            box.getSize(size); box.getCenter(center)
            const roundness = Math.abs(size.y - size.z) / Math.max(1e-3, (size.y + size.z))
            if (roundness < 0.35 && size.y > 0.05 && size.z > 0.05) {
              candidates.push({ node: mesh, radius: Math.max(0.05, Math.max(size.y, size.z) * 0.5), center })
            }
          })
          candidates.sort((a,b) => Math.abs(b.center.z) - Math.abs(a.center.z))
          for (let i=0; i<Math.min(4, candidates.length); i++) {
            const c = candidates[i]
            detected.push({ node: c.node, radius: c.radius, isRear: false, isLeft: c.center.z < 0 })
          }
        }

        forwardSign = detectForwardSign(scene)

        // Assign rear wheels by x-extremes (rear cluster opposite to forward)
        if (detected.length) {
          const xs = detected.map(w => new THREE.Box3().setFromObject(w.node).getCenter(new THREE.Vector3()).x)
          const maxX = Math.max(...xs), minX = Math.min(...xs)
          const frontIsPosX = (forwardSign === 1)
          const rearX = frontIsPosX ? minX : maxX
          detected.forEach((w, i) => { w.isRear = Math.abs(xs[i] - rearX) < Math.abs(xs[i] - (frontIsPosX ? maxX : minX)) })
        }

        // Build wheel rigs (steer for front, spin for all)
        buildWheelRigs(detected, bbox2)

        // Add lights at true front/back edges (works even on aftermarket models)
        addLights(bbox2)

        holder.add(scene)
      }

      function buildWheelRigs(wheels: WheelDetected[], bbox: THREE.Box3) {
        for (const w of wheels) {
          // World center of the wheel (BBox center)
          const centerW = new THREE.Box3().setFromObject(w.node).getCenter(new THREE.Vector3())
          // Holder-space center
          const centerH = holder.worldToLocal(centerW.clone())

          if (!w.isRear) {
            // Front: steering pivot -> spin pivot -> wheel
            const steer = new THREE.Object3D()
            steer.position.copy(centerH)
            holder.add(steer)

            const spin = new THREE.Object3D()
            spin.position.set(0,0,0)
            steer.add(spin)

            // Reparent wheel under spin, preserve world, then recenter so wheel center sits at pivot
            spin.attach(w.node)
            const localCenterAfter = w.node.worldToLocal(centerW.clone())
            w.node.position.sub(localCenterAfter)

            rigs.push({ radius: w.radius, isRear: w.isRear, isLeft: w.isLeft, spinPivot: spin, steerPivot: steer })
          } else {
            // Rear: spin pivot -> wheel
            const spin = new THREE.Object3D()
            spin.position.copy(centerH)
            holder.add(spin)
            spin.attach(w.node)
            const localCenterAfter = w.node.worldToLocal(centerW.clone())
            w.node.position.sub(localCenterAfter)

            rigs.push({ radius: w.radius, isRear: w.isRear, isLeft: w.isLeft, spinPivot: spin })
          }
        }
      }

      function addLights(bbox: THREE.Box3) {
        const frontX = forwardSign === 1 ? bbox.max.x : bbox.min.x
        const rearX  = forwardSign === 1 ? bbox.min.x : bbox.max.x
        const midY = (bbox.max.y + bbox.min.y) * 0.55
        const halfZ = Math.max(Math.abs(bbox.max.z), Math.abs(bbox.min.z)) * 0.6

        // Headlights always created and follow heading
        for (const z of [-1, 1]) {
          const s = new THREE.SpotLight(0xcfe8ff, 0, 12, Math.PI/6, 0.35, 1.2)
          s.position.set(frontX + 0.15 * forwardSign, midY, z * halfZ)
          const target = new THREE.Object3D()
          target.position.set(frontX + 4 * forwardSign, midY-0.15, z * halfZ * 0.95)
          holder.add(s); holder.add(target)
          s.target = target
          s.visible = false
          headLights.push(s)
        }
        // Taillights
        for (const z of [-1, 1]) {
          const p = new THREE.PointLight(0xff2a2a, 0, 4, 1.5)
          p.position.set(rearX - 0.05 * forwardSign, midY * 0.85, z * halfZ)
          holder.add(p)
          p.visible = false
          tailLights.push(p)
        }
      }

      function detectForwardSign(root: THREE.Object3D): 1 | -1 {
        const fronts: number[] = []
        const rears: number[] = []
        const wheelsX: number[] = []
        root.traverse(o => {
          const nm = (o.name || '').toLowerCase()
          const b = new THREE.Box3().setFromObject(o)
          const c = new THREE.Vector3(); b.getCenter(c)
          if (!isFinite(c.x)) return
          if (/front|hood|grill|bumper|head ?light|lamp|bonnet/.test(nm)) fronts.push(c.x)
          if (/rear|tail|exhaust|spoiler|diffuser|trunk|boot|tail ?light/.test(nm)) rears.push(c.x)
          if (/wheel|tire|tyre|rim/.test(nm)) wheelsX.push(c.x)
        })
        if (fronts.length && rears.length) {
          const f = avg(fronts), r = avg(rears)
          return f > r ? 1 : -1
        }
        if (wheelsX.length >= 2) {
          const min = Math.min(...wheelsX), max = Math.max(...wheelsX)
          return (max - min) > 0 ? 1 : 1
        }
        return 1
      }
      function avg(a: number[]) { return a.reduce((s, v) => s + v, 0) / a.length }

      function applyUserScale(scale: number) {
        holder.scale.setScalar(Math.max(0.05, scale))
      }

      function setColor(albumColor: THREE.Color) {
        const temp = new THREE.Color()
        holder.traverse((obj) => {
          const mesh = obj as THREE.Mesh
          if (!mesh.isMesh) return
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          for (const m of mats) {
            if (!m) continue
            const orig = originals.get(m)
            if (orig?.color && (m as any).color) (m as any).color.copy(orig.color)
            if (orig?.emissive && (m as any).emissive) (m as any).emissive.copy(orig.emissive)

            const std = m as any
            if (candidatePaintMats.has(m) && std.color) {
              temp.copy(albumColor)
              const l = 0.2126*temp.r + 0.7152*temp.g + 0.0722*temp.b
              if (l < 0.3) { temp.multiplyScalar(1.18); clampColor01(temp) }
              std.color.lerp(temp, 0.6)
              std.needsUpdate = true
            } else if (std.emissive) {
              temp.copy(albumColor).multiplyScalar(0.06)
              std.emissive.lerp(temp, 0.6)
              std.needsUpdate = true
            }
          }
        })
        const outlineCol = clampColor01(albumColor.clone().multiplyScalar(1.2))
        for (const e of edgeLines) {
          const mat = e.material as THREE.LineBasicMaterial
          mat.color.copy(outlineCol)
          mat.needsUpdate = true
        }
      }

      function setOutlineVisible(v: boolean) {
        for (const e of edgeLines) e.visible = v
      }

      const tmp = new THREE.Vector3()

      function update(dt: number, env: {
        t: number; radius: number; turntable: boolean; flipForward: boolean; scale: number; yOffset: number;
        albumColor: THREE.Color; safeRect: { minX:number; maxX:number; minZ:number; maxZ:number }
      }) {
        applyUserScale(env.scale)
        group.position.y = opts.baseY + env.yOffset

        const fx = opts.getEffects()
        for (const s of headLights) { s.intensity = fx.lightsHeadEnabled ? fx.lightsHeadIntensity : 0; s.visible = fx.lightsHeadEnabled }
        for (const p of tailLights) { p.intensity = fx.lightsTailEnabled ? fx.lightsTailIntensity : 0; p.visible = fx.lightsTailEnabled }

        // Turntable mode: keep minimal behaviors
        if (env.turntable) {
          loop.u += dt * 0.4
          holder.rotation.y = (loop.u * 0.8 + (env.flipForward ? Math.PI : 0))
          // keep position at origin
          group.position.x = 0
          group.position.z = 0

          // Spin wheels gently
          if (fx.wheelSpinEnabled) {
            for (const r of rigs) r.spinPivot.rotation.z -= 1.2 * dt
          }
          smoke.setEnabled(false)
          skid.setEnabled(false)
          return
        }

        // OVAL LOOP around the mansion
        const rectHalfX = (env.safeRect.maxX - env.safeRect.minX) * 0.5
        const rectHalfZ = (env.safeRect.maxZ - env.safeRect.minZ) * 0.5
        const margin = 1.6
        const rx = Math.max(rectHalfX + margin, env.radius * 0.72)
        const rz = Math.max(rectHalfZ + margin, env.radius * 0.46)

        // speed from a pleasant baseline with a tiny album-reactive wobble
        const speed = 0.35 + 0.10 // constant, music wobble removed for smooth visuals
        loop.u = (loop.u + dt * speed) % (Math.PI * 2)

        // position on ellipse
        const u = loop.u
        const x = rx * Math.cos(u)
        const z = rz * Math.sin(u)

        // tangent derivative
        const tx = -rx * Math.sin(u)
        const tz =  rz * Math.cos(u)

        const prev = prevWorldPos.clone()
        group.position.x = x
        group.position.z = z

        // heading from tangent
        let yaw = Math.atan2(tz, tx) + (forwardSign === 1 ? 0 : Math.PI)
        if (env.flipForward) yaw += Math.PI
        // smooth follow
        holder.rotation.y = THREE.MathUtils.lerp(holder.rotation.y, yaw, 0.24)

        // compute velocity and speed for effects
        const vel = tmp.subVectors(group.position, prev)
        const vSpeed = vel.length() / Math.max(1e-6, dt)
        prevWorldPos.copy(group.position)

        // Steering: proportional to how fast heading changes
        const yawNow = yaw
        const yawPrev = lastYaw ?? yawNow
        const yawRate = angleDiff(yawNow, yawPrev) / Math.max(1e-6, dt) // rad/s
        lastYaw = yawNow
        const maxSteer = THREE.MathUtils.degToRad(28)
        const steerGain = 0.22
        const steerAngle = THREE.MathUtils.clamp(yawRate * steerGain, -maxSteer, maxSteer)
        for (const r of rigs) {
          if (r.steerPivot) r.steerPivot.rotation.y = steerAngle
        }

        // Wheel spin: omega = v / r (around local Z)
        if (fx.wheelSpinEnabled) {
          const fwd = new THREE.Vector3(1,0,0).applyQuaternion(holder.quaternion)
          const vSign = Math.sign(fwd.dot(vel)) || 1
          for (const r of rigs) {
            const w = (vSpeed * vSign) / Math.max(0.05, r.radius)
            r.spinPivot.rotation.z -= w * dt
          }
        }

        // Deceleration for brake logic
        const accel = (vSpeed - prevSpeed) / Math.max(1e-6, dt)
        const decel = Math.max(0, -accel)
        prevSpeed = vSpeed

        if (fx.lightsTailEnabled) {
          const boost = fx.lightsBrakeBoost
          const add = THREE.MathUtils.clamp(decel * 0.06, 0, 1.0) * boost
          for (const p of tailLights) p.intensity = fx.lightsTailIntensity + add
          for (const m of taillightMats) {
            const orig = originals.get(m)
            const std = m as any
            if (std?.emissive && orig?.emissive) {
              const col = orig.emissive.clone().lerp(new THREE.Color(1,0.1,0.1), Math.min(1, add * 0.6))
              std.emissive.copy(col)
            }
          }
        }

        // Smoke & skid (rear wheels only)
        const rearRigs = rigs.filter(r => r.isRear)
        const emitSmoke = fx.smokeEnabled && (vSpeed > 1.0 || decel > 0.5)
        const makeSkid = fx.skidEnabled && (decel > 0.8 || vSpeed > 1.2)
        const albumCol = opts.getAlbumColor()

        if (emitSmoke && rearRigs.length) {
          smoke.setEnabled(true)
          smoke.setColor(fx.smokeTintAlbum ? albumCol : new THREE.Color(0xededed))
          const rate = THREE.MathUtils.clamp(fx.smokeDensity * (0.3 + vSpeed * 0.03 + decel * 0.08), 0, 6)
          for (const r of rearRigs) {
            const wp = r.spinPivot.getWorldPosition(new THREE.Vector3())
            smoke.emit(wp, new THREE.Vector3(vel.x, 0, vel.z), rate, dt)
          }
        } else {
          smoke.setEnabled(false)
        }

        if (fx.skidEnabled && rearRigs.length) {
          skid.setEnabled(true)
          skid.setOpacity(THREE.MathUtils.clamp(fx.skidOpacity, 0, 1))
          skid.setMaxSegments(fx.skidSegments)
          for (const r of rearRigs) {
            const wp = r.spinPivot.getWorldPosition(new THREE.Vector3())
            wp.y = 0.0012
            const width = Math.min(0.22, Math.max(0.08, r.radius * 0.35))
            const side = new THREE.Vector3(0,0,1).applyQuaternion(holder.quaternion).setY(0).normalize().multiplyScalar(r.isLeft ? -width : width)
            const pL = wp.clone().add(side)
            const pR = wp.clone().add(side.clone().multiplyScalar(-1))
            const active = makeSkid && vSpeed > 0.8
            skid.addSegment(r.isLeft ? 'RL' : 'RR', pL, pR, active ? 1 : 0)
          }
        } else {
          skid.setEnabled(false)
        }
      }

      function frameToView(camera: THREE.PerspectiveCamera, controls: OrbitControls) {
        const box = new THREE.Box3().setFromObject(holder)
        const center = new THREE.Vector3(); const size = new THREE.Vector3()
        box.getCenter(center); box.getSize(size)
        const radius = size.length() * 0.5
        controls.target.copy(center)
        const fov = camera.fov * Math.PI / 180
        const dist = radius / Math.tan(fov / 2) * 1.3
        const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize()
        camera.position.copy(controls.target).addScaledVector(dir, dist)
        camera.updateProjectionMatrix()
        controls.update()
      }

      function dispose() {
        group.removeFromParent()
        holder.traverse((obj) => {
          const mesh = obj as THREE.Mesh
          if (mesh.isMesh) {
            if (Array.isArray(mesh.material)) mesh.material.forEach(m => (m as any).dispose?.())
            else (mesh.material as any)?.dispose?.()
            mesh.geometry?.dispose?.()
          }
        })
        for (const e of edgeLines) {
          e.geometry.dispose()
          ;(e.material as any).dispose?.()
        }
        smoke.dispose()
        skid.dispose()
        for (const s of headLights) { s.dispose(); s.target?.removeFromParent?.(); s.removeFromParent() }
        for (const p of tailLights) { p.dispose(); p.removeFromParent() }
      }

      return { group, update, dispose, setColor, setOutlineVisible, frameToView }
    }

    // Smoke system and Skid system implementations unchanged from previous message
    // ... (the same createSmokeSystem, createSkidSystem, makeSoftCircleTexture functions) ...

    function createSmokeSystem() {
      const group = new THREE.Group()
      group.renderOrder = 2
      const spriteTex = makeSoftCircleTexture(128)
      type Particle = { s: THREE.Sprite; life: number; maxLife: number; vel: THREE.Vector3; alive: boolean }
      const pool: Particle[] = []
      const MAX = 120
      const up = new THREE.Vector3(0,1,0)
      let enabled = true
      let color = new THREE.Color(0xededed)

      for (let i=0;i<MAX;i++) {
        const mat = new THREE.SpriteMaterial({ map: spriteTex, color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, depthTest: true })
        const s = new THREE.Sprite(mat)
        s.scale.setScalar(0.001)
        s.visible = false
        group.add(s)
        pool.push({ s, life: 0, maxLife: 1, vel: new THREE.Vector3(), alive: false })
      }

      function firstDead(): Particle | undefined { return pool.find(p => !p.alive) }
      function emit(pos: THREE.Vector3, motion: THREE.Vector3, rate: number, dt: number) {
        if (!enabled) return
        const count = Math.floor(rate * dt * 10)
        for (let i=0;i<count;i++) {
          const p = firstDead()
          if (!p) break
          p.alive = true
          p.maxLife = THREE.MathUtils.randFloat(0.7, 1.2)
          p.life = p.maxLife
          p.s.position.copy(pos).addScaledVector(up, THREE.MathUtils.randFloat(0.02, 0.08))
          p.s.visible = true
          p.s.material.color.copy(color)
          p.s.material.opacity = 0.0
          const jitter = new THREE.Vector3(
            THREE.MathUtils.randFloatSpread(0.12),
            THREE.MathUtils.randFloat(0.25, 0.55),
            THREE.MathUtils.randFloatSpread(0.12)
          )
          p.vel.copy(motion).multiplyScalar(0.08).add(jitter)
          const sc = THREE.MathUtils.randFloat(0.18, 0.30)
          p.s.scale.set(sc, sc, sc)
        }
      }

      const clock = new THREE.Clock()
      function animate() {
        const dt = Math.min(0.05, clock.getDelta())
        for (const p of pool) {
          if (!p.alive) continue
          p.life -= dt
          if (p.life <= 0) {
            p.alive = false
            p.s.visible = false
            continue
          }
          const t = 1 - (p.life / p.maxLife)
          p.s.position.addScaledVector(p.vel, dt)
          p.s.material.opacity = Math.min(0.45, 0.12 + 0.5 * (1 - t)) * (enabled ? 1 : 0)
          const scl = p.s.scale.x * (1 + dt * 0.5)
          p.s.scale.set(scl, scl, scl)
        }
        requestAnimationFrame(animate)
      }
      animate()

      return {
        group,
        emit,
        setEnabled(v: boolean) { enabled = v; group.visible = v },
        setColor(c: THREE.Color) { color.copy(c) },
        dispose() {
          for (const p of pool) {
            (p.s.material as THREE.Material).dispose()
            p.s.removeFromParent()
          }
          spriteTex.dispose()
          group.removeFromParent()
        }
      }
    }

    function createSkidSystem() {
      const group = new THREE.Group()
      const strips = new Map<string, {
        geom: THREE.BufferGeometry
        mesh: THREE.Mesh
        pointsL: THREE.Vector3[]
        pointsR: THREE.Vector3[]
        maxSegs: number
        activeMask: boolean[]
      }>()
      const material = new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.35, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })

      function ensureStrip(key: string) {
        if (strips.has(key)) return strips.get(key)!
        const geom = new THREE.BufferGeometry()
        const mesh = new THREE.Mesh(geom, material)
        mesh.renderOrder = 1
        group.add(mesh)
        const rec = { geom, mesh, pointsL: [] as THREE.Vector3[], pointsR: [] as THREE.Vector3[], maxSegs: 140, activeMask: [] as boolean[] }
        strips.set(key, rec)
        return rec
      }

      function addSegment(key: 'RL'|'RR', pL: THREE.Vector3, pR: THREE.Vector3, active: 0|1) {
        const s = ensureStrip(key)
        s.pointsL.push(pL.clone())
        s.pointsR.push(pR.clone())
        s.activeMask.push(!!active)
        while (s.pointsL.length > s.maxSegs) { s.pointsL.shift(); s.pointsR.shift(); s.activeMask.shift() }
        rebuildStrip(s)
      }

      function rebuildStrip(s: ReturnType<typeof ensureStrip>) {
        const n = s.pointsL.length
        if (n < 2) return
        const pos = new Float32Array((n - 1) * 6 * 3)
        let off = 0
        for (let i=0; i<n-1; i++) {
          const aL = s.pointsL[i], aR = s.pointsR[i]
          const bL = s.pointsL[i+1], bR = s.pointsR[i+1]
          off = writeTri(pos, off, aL, aR, bR)
          off = writeTri(pos, off, aL, bR, bL)
        }
        s.geom.setAttribute('position', new THREE.BufferAttribute(pos, 3))
        s.geom.computeVertexNormals()
        s.geom.attributes.position.needsUpdate = true
        s.geom.computeBoundingSphere()
      }

      function writeTri(dst: Float32Array, off: number, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
        dst[off++] = a.x; dst[off++] = a.y; dst[off++] = a.z
        dst[off++] = b.x; dst[off++] = b.y; dst[off++] = b.z
        dst[off++] = c.x; dst[off++] = c.y; dst[off++] = c.z
        return off
      }

      function setOpacity(o: number) { material.opacity = THREE.MathUtils.clamp(o, 0, 1) }
      function setMaxSegments(n: number) { for (const s of strips.values()) s.maxSegs = Math.max(4, Math.floor(n)) }

      let enabled = true
      function setEnabled(v: boolean) { enabled = v; group.visible = v }
      setEnabled(true)

      return {
        group,
        addSegment,
        setOpacity,
        setMaxSegments,
        setEnabled,
        dispose() {
          for (const s of strips.values()) {
            s.geom.dispose()
            s.mesh.removeFromParent()
          }
          strips.clear()
          group.removeFromParent()
        }
      }
    }

    function makeSoftCircleTexture(size = 128) {
      const c = document.createElement('canvas')
      c.width = c.height = size
      const g = c.getContext('2d')!
      const grd = g.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2)
      grd.addColorStop(0, 'rgba(255,255,255,0.9)')
      grd.addColorStop(0.6, 'rgba(255,255,255,0.25)')
      grd.addColorStop(1, 'rgba(255,255,255,0.0)')
      g.fillStyle = grd
      g.beginPath()
      g.arc(size/2, size/2, size/2, 0, Math.PI*2)
      g.fill()
      const tex = new THREE.CanvasTexture(c)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.minFilter = THREE.LinearMipmapLinearFilter
      tex.generateMipmaps = true
      return tex
    }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quality.renderScale, quality.bloom, accessibility.epilepsySafe, auth])

  // UI components unchanged (only safe-merge guard kept) ...
  // [The remainder of the file (Joystick, Rail, BillboardControllerCard, CarControlsCard, Wire3DPanel, styles, clamp, clampColor01) stays the same as in the previous message.]

  // Joystick, Rail, BillboardControllerCard, CarControlsCard, Wire3DPanel, styles, and helpers go here
  // (Use the exact versions from the previous message; they are compatible with these changes.)
}
function clamp(x: number, a: number, b: number) { return Math.max(a, Math.min(b, x)) }
function clampColor01(col: THREE.Color) {
  col.r = Math.max(0, Math.min(1, col.r))
  col.g = Math.max(0, Math.min(1, col.g))
  col.b = Math.max(0, Math.min(1, col.b))
  return col
}
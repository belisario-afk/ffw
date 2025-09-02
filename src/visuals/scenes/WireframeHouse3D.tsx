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
}

const LS_KEY = 'ffw.wire3d.settings.v2'

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
    }
  }
}

export default function WireframeHouse3D({ auth, quality, accessibility, settings }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [cfg, setCfg] = useState<LocalCfg>(() => {
    try { const saved = localStorage.getItem(LS_KEY); if (saved) return { ...defaults(settings), ...JSON.parse(saved) } } catch {}
    return defaults(settings)
  })
  const cfgRef = useRef(cfg)
  useEffect(() => { cfgRef.current = cfg }, [cfg])

  const [panelOpen, setPanelOpen] = useState(false)

  // Billboard controller UI state (in Settings panel)
  const [bbEditEnabled, setBbEditEnabled] = useState(false)
  const [bbMode, setBbMode] = useState<'move'|'rotate'|'scale'>('move')
  const [bbPlane, setBbPlane] = useState<'XZ'|'XY'>('XZ')

  // Mirror billboard UI state into refs for the render loop
  const bbEditRef = useRef(bbEditEnabled)
  const bbModeRef = useRef<'move'|'rotate'|'scale'>(bbMode)
  const bbPlaneRef = useRef<'XZ'|'XY'>(bbPlane)
  useEffect(() => { bbEditRef.current = bbEditEnabled }, [bbEditEnabled])
  useEffect(() => { bbModeRef.current = bbMode }, [bbMode])
  useEffect(() => { bbPlaneRef.current = bbPlane }, [bbPlane])

  // Billboard transforms (controlled by UI)
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

  useEffect(() => {
    const token = (auth as any)?.accessToken
    if (token) { try { setSpotifyTokenProvider(async () => token) } catch {} }
  }, [auth])

  // Connect Spotify player if available
  useEffect(() => {
    if (hasSpotifyTokenProvider()) {
      ensurePlayerConnected({ deviceName: 'FFw visualizer', setInitialVolume: true })
        .catch(e => console.warn('Spotify ensurePlayerConnected (3D) failed:', e))
    } else {
      console.warn('WireframeHouse3D: Spotify token provider not set. Skipping player connect.')
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

  useEffect(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)) } catch {} }, [cfg])

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

    // Controls (never add to scene)
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

    // Mosaic (safe)
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
      fatMat.linewidth = Math.max(0.0015, px / Math.max(1, draw.y))
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

    // Optional starfield
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

    // Lyrics marquee (fallback/secondary)
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

          floorTex?.dispose(); floorTex = tex
          floorMat.uniforms.tAlbum.value = tex; floorMat.needsUpdate = true

          if (cfgRef.current.fx.mosaicFloor && tiles.length) {
            mosaicGroup.visible = true
            for (const t of tiles) {
              t.material.map = tex
              t.material.toneMapped = false
              t.material.color.setScalar(0.85)
              t.material.needsUpdate = true
            }
          } else {
            mosaicGroup.visible = false
          }
        } else {
          mosaicGroup.visible = false
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

    // Supercar (wireframe) drifting over album cover
    const car = createSuperCar()
    car.group.visible = !!cfgRef.current.fx.wireCar
    scene.add(car.group)

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

      // Live-apply FOV from slider
      if (camera.fov !== cfgC.camera.fov) {
        camera.fov = cfgC.camera.fov
        camera.updateProjectionMatrix()
      }

      // Controls live updates
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

      // Apply billboard controller (reads refs, no scene re-init)
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

      // update billboard colors to match palette
      billboard.setColors(
        accent.clone().multiplyScalar(0.9),
        accent2.clone().multiplyScalar(1.0),
        accent.clone().multiplyScalar(1.0)
      )
      billboard.setVisible(!!cfgC.fx.lyricsMarquee)

      // Drive supercar drift
      car.group.visible = !!cfgC.fx.wireCar
      if (car.group.visible) {
        car.update(dt, {
          t,
          loud,
          beat: !!latest?.beat,
          high,
          floorHalf: floorSize * 0.5 - 0.8,
          accent,
          accent2
        })
      }

      // lines
      const px = cfgC.lineWidthPx * (1.0 + 0.08 * (latest?.beat ? 1 : 0) + 0.05 * high)
      setLinePixels(px)

      // fog
      ;(fogMat as any).uniforms.uTime.value = t
      ;(fogMat as any).uniforms.uIntensity.value = THREE.MathUtils.clamp(0.08 + loud * 0.5 + (latest?.beat ? 0.15 : 0), 0, accessibility.epilepsySafe ? 0.35 : 0.5)
      ;((fogMat as any).uniforms.uColor.value as THREE.Color).copy(new THREE.Color().copy(accent2).lerp(accent, 0.5))

      // starfield visibility
      if (starfield) starfield.visible = !!cfgC.fx.starfield

      // mosaic/floor
      mosaicGroup.visible = !!cfgC.fx.mosaicFloor && !!floorTex
      floorMesh.visible = !mosaicGroup.visible

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

      // Animate billboard transitions and pop decay
      billboard.update(dt)

      // camera autopilot + bob
      const bob = Math.sin(t * 1.4) * cfgC.camBob
      if (cfgC.camera.autoPath && !userInteracting) {
        const baseSpeed = cfgC.orbitSpeed
        const audioBoost = 0.4 * (low + mid + high)
        angleRef.current += dt * (baseSpeed + audioBoost)
        const radius = THREE.MathUtils.clamp(cfgC.orbitRadius, 6.0, 12.0)
        const elev = cfgC.orbitElev
        const pos = pathPoint(cfgC.path, angleRef.current, radius)
        camera.position.set(pos.x, Math.sin(elev) * (radius * 0.55) + 2.4 + bob, pos.z)
        camera.lookAt(cfgC.camera.target.x, cfgC.camera.target.y, cfgC.camera.target.z)
        controls.target.set(cfgC.camera.target.x, cfgC.camera.target.y, cfgC.camera.target.z)
      } else {
        camera.position.y += (bob - (camera as any).__lastBobY || 0)
        ;(camera as any).__lastBobY = bob
      }
        function lerpAngle(a: number, b: number, t: number) {
        const TAU = Math.PI * 2
        let d = (b - a) % TAU
        if (d > Math.PI) d -= TAU
        if (d < -Math.PI) d += TAU
        return a + d * t
      }

      ;(grid.material as THREE.Material).opacity = 0.05 * (stale ? 0.6 : 1.0)
      controls.update()
      comp.composer.render()

      // fallback: if fat lines aren’t drawing, swap to thin
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

    // cleanup
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
    }

    // build edges helpers
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

    // Supercar: model + drift dynamics
    function createSuperCar() {
      const group = new THREE.Group()
      group.position.set(0, 0.06, 0)
      group.renderOrder = 3

      // Materials
      const wire = new THREE.MeshBasicMaterial({ color: 0x77d0ff, wireframe: true, transparent: true, opacity: 0.95, depthWrite: false })
      const wire2 = new THREE.MeshBasicMaterial({ color: 0xa7b8ff, wireframe: true, transparent: true, opacity: 0.85, depthWrite: false })
      const glowAdd = new THREE.MeshBasicMaterial({ color: 0x9fdcff, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })
      const blackSoft = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.14, depthWrite: false })

      // Proportions (low & wide)
      const W = 2.0, H = 0.36, L = 3.4
      const chassis = new THREE.Mesh(new THREE.BoxGeometry(L, H, W*0.9), wire)
      chassis.position.y = H*0.5
      group.add(chassis)

      // Hood wedge
      const hood = new THREE.Mesh(new THREE.BoxGeometry(L*0.55, H*0.28, W*0.88), wire)
      hood.position.set(L*0.08, H*0.86, 0)
      hood.rotation.x = -0.12
      group.add(hood)

      // Roof low
      const roof = new THREE.Mesh(new THREE.BoxGeometry(L*0.42, H*0.26, W*0.78), wire2)
      roof.position.set(-L*0.05, H*1.12, 0)
      group.add(roof)

      // Side skirts (thin boxes)
      const skirtL = new THREE.Mesh(new THREE.BoxGeometry(L*0.8, 0.06, 0.05), wire)
      skirtL.position.set(0, 0.1,  W*0.5)
      const skirtR = skirtL.clone()
      skirtR.position.z = -W*0.5
      group.add(skirtL, skirtR)

      // Front splitter
      const splitter = new THREE.Mesh(new THREE.BoxGeometry(L*0.45, 0.04, W*1.0), wire)
      splitter.position.set(L*0.52, 0.12, 0)
      group.add(splitter)

      // Spoiler
      const spoilerBase = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.2, W*0.9), wire)
      spoilerBase.position.set(-L*0.6, 0.38, 0)
      const spoilerWing = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.05, W*1.1), wire2)
      spoilerWing.position.set(-L*0.6, 0.56, 0)
      group.add(spoilerBase, spoilerWing)

      // Wheels (front steerable)
      const tireR = 0.34, tireT = 0.09
      const tireGeom = new THREE.TorusGeometry(tireR, tireT, 8, 18)
      const rimGeom = new THREE.TorusGeometry(tireR*0.62, tireT*0.36, 6, 16)
      const wheelPositions: [number, number][] = [
        [ L*0.52,  W*0.42],
        [ L*0.52, -W*0.42],
        [-L*0.52,  W*0.42],
        [-L*0.52, -W*0.42],
      ]
      const wheels: THREE.Group[] = []
      const frontWheels: THREE.Group[] = []
      for (let i=0;i<4;i++) {
        const isFront = i < 2
        const hub = new THREE.Group()
        const tire = new THREE.Mesh(tireGeom, wire)
        tire.rotation.y = Math.PI / 2
        const rim = new THREE.Mesh(rimGeom, wire2)
        rim.rotation.y = Math.PI / 2
        const y = 0.18
        hub.position.set(wheelPositions[i][0], y, wheelPositions[i][1])
        hub.add(tire, rim)
        group.add(hub)
        wheels.push(hub)
        if (isFront) frontWheels.push(hub)
      }

      // Headlights and tail lights (glow planes)
      const headL = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.08), glowAdd)
      const headR = headL.clone()
      headL.position.set(L*0.9, 0.38,  W*0.35)
      headR.position.set(L*0.9, 0.38, -W*0.35)
      headL.lookAt(headL.position.clone().add(new THREE.Vector3(1,0,-0.2)))
      headR.lookAt(headR.position.clone().add(new THREE.Vector3(1,0, 0.2)))
      group.add(headL, headR)

      const tailL = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.08), new THREE.MeshBasicMaterial({ color: 0xff3355, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }))
      const tailR = tailL.clone()
      tailL.position.set(-L*0.95, 0.38,  W*0.35)
      tailR.position.set(-L*0.95, 0.38, -W*0.35)
      tailL.lookAt(tailL.position.clone().add(new THREE.Vector3(-1,0,-0.2)))
      tailR.lookAt(tailR.position.clone().add(new THREE.Vector3(-1,0, 0.2)))
      group.add(tailL, tailR)

      // Under-glow + shadow
      const glow = new THREE.Mesh(new THREE.CircleGeometry(1.6, 26), new THREE.MeshBasicMaterial({ color: 0x90d7ff, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }))
      glow.rotation.x = -Math.PI/2
      glow.position.y = 0.002
      group.add(glow)
      const shadow = new THREE.Mesh(new THREE.CircleGeometry(1.2, 20), blackSoft)
      shadow.rotation.x = -Math.PI/2
      shadow.position.y = 0.001
      group.add(shadow)

      // Kinematics state
      const state = {
        pos: new THREE.Vector3(0, 0.06, 0),
        vel: new THREE.Vector3(0, 0, 0),
        lastPos: new THREE.Vector3(0, 0.06, 0),
        yaw: 0,
        slip: 0,
        steer: 0,
        distance: 0,
        t: 0
      }
      const tmp = {
        p0: new THREE.Vector3(),
        p1: new THREE.Vector3(),
        forward: new THREE.Vector3(),
        velDir: new THREE.Vector3(),
        side: new THREE.Vector3()
      }

      function update(dt: number, env: { t: number; loud: number; beat: boolean; high: number; floorHalf: number; accent: THREE.Color; accent2: THREE.Color }) {
        // Palette sync
        ;(wire.color as THREE.Color).copy(env.accent)
        ;(wire2.color as THREE.Color).copy(env.accent2)

        // Speed profile: base + loudness, beat kick
        const targetSpeed = 4.2 + env.loud * 6.0
        const speed = env.beat ? targetSpeed * 1.08 : targetSpeed

        // Parameter along lemniscate path drives target direction
        state.t += dt * 0.5
        const R = 6.4
        const a0 = state.t * 0.9
        const a1 = a0 + 0.012
        tmp.p0.copy(pathPoint('Lemniscate', a0, R))
        tmp.p1.copy(pathPoint('Lemniscate', a1, R))
        tmp.forward.subVectors(tmp.p1, tmp.p0).normalize()

        // Desired velocity along path with slight audio wiggle
        const wiggle = (Math.sin(env.t * 1.7) * 0.3 + Math.cos(env.t * 2.3) * 0.2) * (0.25 + env.high * 0.5)
        const desired = tmp.forward.clone().multiplyScalar(speed).add(new THREE.Vector3(0,0,0))
        // Simple velocity steering (approach desired vel)
        const accel = desired.clone().sub(state.vel).multiplyScalar(1.8) // responsiveness
        state.vel.add(accel.multiplyScalar(dt))
        // Integrate position in XZ
        state.pos.add(state.vel.clone().multiplyScalar(dt))
        state.pos.y = 0.06 + Math.sin(env.t * 3.2) * 0.01
        // Bounds on album floor
        state.pos.x = THREE.MathUtils.clamp(state.pos.x, -env.floorHalf, env.floorHalf)
        state.pos.z = THREE.MathUtils.clamp(state.pos.z, -env.floorHalf, env.floorHalf)

        // Slip is lateral velocity vs forward direction with easing
        tmp.velDir.copy(state.vel).setY(0)
        const vLen = tmp.velDir.length() + 1e-6
        tmp.velDir.normalize()
        const fwd2D = tmp.forward.clone().setY(0).normalize()
        const cross = fwd2D.x * tmp.velDir.z - fwd2D.z * tmp.velDir.x // signed lateral
        const targetSlip = THREE.MathUtils.clamp(cross * (0.9 + env.high * 0.8) + wiggle * 0.2, -0.9, 0.9)
        state.slip += (targetSlip - state.slip) * Math.min(1, dt * 3.2)

        // Yaw aims partly at velocity direction (drift), partly at path forward
        const yawVel = Math.atan2(tmp.velDir.z, tmp.velDir.x)
        const yawFwd = Math.atan2(fwd2D.z, fwd2D.x)
        const driftMix = 0.65 + (0.2 * (0.3 + Math.abs(state.slip))) // more slip -> more velocity-following
        let yawTarget = lerpAngle(yawFwd, yawVel, THREE.MathUtils.clamp(driftMix, 0, 1))
        state.yaw = lerpAngle(state.yaw, yawTarget, Math.min(1, dt * 6.0))

        // Steer front wheels counter to slip (counter-steer) within limits
        const steerTarget = THREE.MathUtils.clamp(-state.slip * 0.8, -0.5, 0.5)
        state.steer += (steerTarget - state.steer) * Math.min(1, dt * 10.0)
        for (const fw of frontWheels) fw.rotation.y = state.steer

        // Wheel rolling based on distance traveled
        const stepDist = state.pos.distanceTo(state.lastPos)
        state.distance += stepDist
        state.lastPos.copy(state.pos)
        const wheelRot = state.distance / (tireR) * 0.7
        for (const w of wheels) {
          // their child[0] is tire (x-rotation), child[1] rim; rotate children, not hub
          const tire = w.children[0] as THREE.Mesh
          tire.rotation.x = wheelRot
          const rim = w.children[1] as THREE.Mesh
          rim.rotation.x = wheelRot
        }

        // Pose car
        group.position.copy(state.pos)
        const bank = THREE.MathUtils.clamp(-state.slip * 0.35, -0.45, 0.45)
        group.rotation.set(0, state.yaw, bank)

        // Audio glow
        ;(glow.material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.clamp(0.12 + (vLen/8) * 0.25 + (env.beat ? 0.1 : 0) + env.loud * 0.2, 0.08, 0.5)
        ;(glow.material as THREE.MeshBasicMaterial).color.copy(env.accent.clone().multiplyScalar(1.0))
      }

      function dispose() {
        group.removeFromParent()
        const disposables: (THREE.Object3D | THREE.Material | THREE.BufferGeometry)[] = []
        group.traverse(obj => {
          const mesh = obj as THREE.Mesh
          if (mesh.isMesh) {
            if (mesh.geometry) disposables.push(mesh.geometry)
            if (mesh.material) {
              if (Array.isArray(mesh.material)) disposables.push(...mesh.material)
              else disposables.push(mesh.material)
            }
          }
        })
        disposables.forEach(d => (d as any).dispose?.())
      }

      return { group, update, dispose }
    }
  // Only re-run when renderScale/bloom/accessibility/auth change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quality.renderScale, quality.bloom, accessibility.epilepsySafe, auth])

  // UI: Joystick and Rail components for the Billboard controller inside Settings
  const Joystick = (props: { size?: number; onChange: (nx: number, ny: number) => void; label?: string }) => {
    const size = props.size ?? 110
    const radius = size / 2
    const knobRef = useRef<HTMLDivElement | null>(null)
    const baseRef = useRef<HTMLDivElement | null>(null)
    const dragRef = useRef<{active:boolean; cx:number; cy:number}>({ active:false, cx:0, cy:0 })

    const setKnob = (nx: number, ny: number) => {
      const k = knobRef.current; if (!k) return
      const x = nx * (radius - 14), y = ny * (radius - 14)
      k.style.transform = `translate(${x}px, ${y}px)`
    }
    const onPointerDown = (e: React.PointerEvent) => {
      const rect = baseRef.current!.getBoundingClientRect()
      dragRef.current.active = true
      dragRef.current.cx = rect.left + rect.width/2
      dragRef.current.cy = rect.top + rect.height/2
      ;(e.target as HTMLElement).setPointerCapture?.((e as any).pointerId)
      onPointerMove(e)
    }
    const onPointerMove = (e: React.PointerEvent) => {
      if (!dragRef.current.active) return
      const dx = e.clientX - dragRef.current.cx
      const dy = e.clientY - dragRef.current.cy
      const dist = Math.min(1, Math.hypot(dx, dy) / (radius - 14))
      const ang = Math.atan2(dy, dx)
      const nx = Math.cos(ang) * dist
      const ny = Math.sin(ang) * dist
      setKnob(nx, ny)
      props.onChange(nx, ny)
    }
    const end = (e?: React.PointerEvent) => {
      dragRef.current.active = false
      setKnob(0, 0)
      props.onChange(0, 0)
      if (e) (e.target as HTMLElement).releasePointerCapture?.((e as any).pointerId)
    }

    return (
      <div style={{ display:'inline-flex', flexDirection:'column', alignItems:'center', gap:6 }}>
        <div
          ref={baseRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={end}
          onPointerCancel={end}
          onPointerLeave={() => {}}
          style={{
            position:'relative',
            width:size, height:size, borderRadius:'50%',
            background:'radial-gradient(ellipse at center, rgba(40,48,60,0.65), rgba(15,18,24,0.85))',
            border:'1px solid #2b2f3a',
            boxShadow:'inset 0 2px 14px rgba(0,0,0,0.4)',
            touchAction:'none',
            userSelect:'none'
          }}
        >
          <div ref={knobRef} style={{
            position:'absolute', left:'50%', top:'50%',
            width:28, height:28, marginLeft:-14, marginTop:-14, borderRadius:'50%',
            background:'linear-gradient(180deg,#cfe7ff,#9fb7d6)', boxShadow:'0 2px 8px rgba(0,0,0,0.35)',
            border:'1px solid #5a6b84', transform:'translate(0px,0px)'
          }}/>
        </div>
        {props.label && <div style={{ fontSize:10, opacity:0.75 }}>{props.label}</div>}
      </div>
    )
  }

  const Rail = (props: { length?: number; vertical?: boolean; onChange: (n: number) => void; value?: number; label?: string }) => {
    const length = props.length ?? 120
    const vertical = !!props.vertical
    const railRef = useRef<HTMLDivElement | null>(null)
    const knobRef = useRef<HTMLDivElement | null>(null)
    const dragRef = useRef<{active:boolean; min:number; max:number}>({ active:false, min:0, max:0 })

    useEffect(() => {
      const k = knobRef.current; if (!k) return
      const v = THREE.MathUtils.clamp(props.value ?? 0, -1, 1)
      if (vertical) k.style.transform = `translate(0px, ${((1 - v) * 0.5 * length) - (length/2)}px)`
      else k.style.transform = `translate(${((v + 1) * 0.5 * length) - (length/2)}px, 0px)`
    }, [props.value, vertical, length])

    const start = (e: React.PointerEvent) => {
      const rect = railRef.current!.getBoundingClientRect()
      dragRef.current.active = true
      dragRef.current.min = vertical ? rect.top : rect.left
      dragRef.current.max = vertical ? rect.bottom : rect.right
      ;(e.target as HTMLElement).setPointerCapture?.((e as any).pointerId)
      move(e)
    }
    const move = (e: React.PointerEvent) => {
      if (!dragRef.current.active) return
      const pos = vertical ? e.clientY : e.clientX
      const t = THREE.MathUtils.clamp((pos - dragRef.current.min) / Math.max(1, (dragRef.current.max - dragRef.current.min)), 0, 1)
      const v = vertical ? (1 - t) * 2 - 1 : t * 2 - 1
      if (knobRef.current) {
        if (vertical) knobRef.current.style.transform = `translate(0px, ${((1 - v) * 0.5 * length) - (length/2)}px)`
        else knobRef.current.style.transform = `translate(${((v + 1) * 0.5 * length) - (length/2)}px, 0px)`
      }
      props.onChange(v)
    }
    const end = (e: React.PointerEvent) => {
      dragRef.current.active = false
      ;(e.target as HTMLElement).releasePointerCapture?.((e as any).pointerId)
    }

    return (
      <div style={{ display:'inline-flex', flexDirection:'column', alignItems:'center', gap:6 }}>
        <div
          ref={railRef}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          style={{
            width: vertical ? 18 : length,
            height: vertical ? length : 18,
            borderRadius: 9,
            background:'linear-gradient(180deg, rgba(28,34,44,0.9), rgba(18,22,28,0.9))',
            border:'1px solid #2b2f3a',
            position:'relative',
            touchAction:'none',
            userSelect:'none'
          }}
        >
          <div ref={knobRef} style={{
            position:'absolute', left: vertical ? 3 : '50%', top: vertical ? '50%' : 3,
            width: 12, height: 12, marginLeft: vertical ? 0 : -6, marginTop: vertical ? -6 : 0,
            borderRadius: 6, background:'linear-gradient(180deg,#cfe7ff,#9fb7d6)',
            border:'1px solid #5a6b84', boxShadow:'0 2px 6px rgba(0,0,0,0.35)', transform: 'translate(0px,0px)'
          }}/>
        </div>
        {props.label && <div style={{ fontSize:10, opacity:0.75 }}>{props.label}</div>}
      </div>
    )
  }

  const BillboardControllerCard = () => (
    <div style={{ border:'1px solid #2b2f3a', borderRadius:8, padding:10, marginTop:8 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
        <div style={{ fontSize:12, opacity:0.8 }}>Billboard (Move/Rotate/Scale)</div>
        <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:12 }}>
          <input type="checkbox" checked={bbEditEnabled} onChange={e => setBbEditEnabled(e.target.checked)} />
          Edit
        </label>
      </div>

      <div style={{ display:'flex', gap:6, marginBottom:10 }}>
        <button onClick={() => setBbMode('move')} style={tabBtnStyle(bbMode === 'move')}>Move</button>
        <button onClick={() => setBbMode('rotate')} style={tabBtnStyle(bbMode === 'rotate')}>Rotate</button>
        <button onClick={() => setBbMode('scale')} style={tabBtnStyle(bbMode === 'scale')}>Scale</button>
      </div>

      {bbMode === 'move' && (
        <div style={{ display:'flex', gap:12, alignItems:'center', flexWrap:'wrap' }}>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            <div style={{ display:'flex', gap:6 }}>
              <button onClick={() => setBbPlane('XZ')} style={chipStyle(bbPlane === 'XZ')}>XZ</button>
              <button onClick={() => setBbPlane('XY')} style={chipStyle(bbPlane === 'XY')}>XY</button>
            </div>
            <Joystick label={bbPlane === 'XZ' ? 'X/Z' : 'X/Y'} onChange={(nx, ny) => { moveVecRef.current.x = nx; moveVecRef.current.y = ny }} />
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:8, alignItems:'center' }}>
            <Rail vertical length={120} label={bbPlane === 'XZ' ? 'Y' : 'Z'} onChange={(v) => { moveAxis3Ref.current = v }} />
            <div style={{ fontSize:11, opacity:0.7 }}>
              Pos: {billboardPosRef.current.x.toFixed(2)}, {billboardPosRef.current.y.toFixed(2)}, {billboardPosRef.current.z.toFixed(2)}
            </div>
            <button onClick={() => { billboardPosRef.current.set(0, 2.95, 1.05) }} style={btnMini}>Center</button>
          </div>
        </div>
      )}

      {bbMode === 'rotate' && (
        <div style={{ display:'flex', gap:12, alignItems:'center', flexWrap:'wrap' }}>
          <Joystick label="Yaw" onChange={(nx) => { rotateVecRef.current.x = nx; rotateVecRef.current.y = 0 }} />
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            <div style={{ fontSize:11, opacity:0.7 }}>Yaw: {(billboardYawRef.current * 57.2958).toFixed(1)}°</div>
            <button onClick={() => { billboardYawRef.current = 0 }} style={btnMini}>Reset</button>
          </div>
        </div>
      )}

      {bbMode === 'scale' && (
        <div style={{ display:'flex', gap:12, alignItems:'center', flexWrap:'wrap' }}>
          <Rail length={160} label="Scale velocity" onChange={(v) => { scaleDeltaRef.current = v }} />
          <div style={{ display:'flex', flexDirection:'column', gap:8, alignItems:'center' }}>
            <div style={{ fontSize:11, opacity:0.7 }}>Scale: {billboardScaleRef.current.toFixed(2)}×</div>
            <div style={{ display:'flex', gap:6 }}>
              <button onClick={() => { billboardScaleRef.current = Math.max(0.35, billboardScaleRef.current - 0.1) }} style={btnMini}>-</button>
              <button onClick={() => { billboardScaleRef.current = Math.min(3.0, billboardScaleRef.current + 0.1) }} style={btnMini}>+</button>
            </div>
            <button onClick={() => { billboardScaleRef.current = 1 }} style={btnMini}>Reset</button>
          </div>
        </div>
      )}
    </div>
  )

  return (
    <div data-visual="wireframe3d" style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} aria-label="Wireframe House 3D" />
      <Wire3DPanel
        open={panelOpen}
        cfg={cfg}
        onToggle={() => setPanelOpen(o => !o)}
        onChange={setCfg}
        extra={<>
          <BillboardControllerCard />
          <EffectsCardToggles cfg={cfg} onChange={setCfg} />
        </>}
      />
    </div>
  )
}

function EffectsCardToggles({ cfg, onChange }: { cfg: LocalCfg; onChange: (updater: (prev: LocalCfg) => LocalCfg | LocalCfg) => void }) {
  return (
    <div style={{ border:'1px solid #2b2f3a', borderRadius:8, padding:10, marginTop:8 }}>
      <div style={{ fontSize:12, opacity:0.8, marginBottom:8 }}>Effects</div>
      <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
        <label style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:10 }}>
          <span>Mosaic floor</span>
          <input type="checkbox" checked={cfg.fx.mosaicFloor} onChange={e => onChange(prev => ({ ...prev, fx: { ...prev.fx, mosaicFloor: e.target.checked } }))}/>
        </label>
        <label style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:10 }}>
          <span>Starfield</span>
          <input type="checkbox" checked={cfg.fx.starfield} onChange={e => onChange(prev => ({ ...prev, fx: { ...prev.fx, starfield: e.target.checked } }))}/>
        </label>
        <label style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:10 }}>
          <span>Lyrics marquee</span>
          <input type="checkbox" checked={cfg.fx.lyricsMarquee} onChange={e => onChange(prev => ({ ...prev, fx: { ...prev.fx, lyricsMarquee: e.target.checked } }))}/>
        </label>
        <label style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:10 }}>
          <span>Wireframe car</span>
          <input type="checkbox" checked={cfg.fx.wireCar} onChange={e => onChange(prev => ({ ...prev, fx: { ...prev.fx, wireCar: e.target.checked } }))}/>
        </label>
      </div>
    </div>
  )
}

function Wire3DPanel(props: {
  open: boolean
  cfg: LocalCfg
  onToggle: () => void
  onChange: (updater: (prev: LocalCfg) => LocalCfg | LocalCfg) => void
  extra?: React.ReactNode
}) {
  const { open, cfg, onToggle, onChange, extra } = props
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

  return (
    <div data-panel="wireframe3d" style={{ position:'absolute', top:12, right:12, zIndex:10, userSelect:'none', pointerEvents:'auto' }}>
      <button onClick={(e) => { e.stopPropagation(); onToggle() }} style={btnStyle}>
        {open ? 'Close 3D Settings' : '3D Settings'}
      </button>
      {open && (
        <div style={{ width: 320, marginTop:8, padding:12, border:'1px solid #2b2f3a', borderRadius:8,
          background:'rgba(10,12,16,0.88)', color:'#e6f0ff', fontFamily:'system-ui, sans-serif', fontSize:12, lineHeight:1.4 }}>
          <Card title="Camera">
            <Row label={`FOV: ${cfg.camera.fov.toFixed(0)}`}>
              <input type="range" min={30} max={85} step={1} value={cfg.camera.fov}
                     onChange={e => onChange(prev => ({ ...prev, camera: { ...prev.camera, fov: +e.target.value } }))} />
            </Row>
            <Row label={`Orbit speed: ${cfg.orbitSpeed.toFixed(2)}`}>
              <input type="range" min={0.05} max={2} step={0.01} value={cfg.orbitSpeed}
                     onChange={e => onChange(prev => ({ ...prev, orbitSpeed: +e.target.value }))} />
            </Row>
            <Row label={`Orbit radius: ${cfg.orbitRadius.toFixed(1)}`}>
              <input type="range" min={6} max={12} step={0.1} value={cfg.orbitRadius}
                     onChange={e => onChange(prev => ({ ...prev, orbitRadius: +e.target.value }))} />
            </Row>
            <Row label={`Elevation: ${cfg.orbitElev.toFixed(2)}`}>
              <input type="range" min={0.03} max={0.2} step={0.01} value={cfg.orbitElev}
                     onChange={e => onChange(prev => ({ ...prev, orbitElev: +e.target.value }))} />
            </Row>
            <Row label={`Camera bob: ${cfg.camBob.toFixed(2)}`}>
              <input type="range" min={0} max={0.6} step={0.01} value={cfg.camBob}
                     onChange={e => onChange(prev => ({ ...prev, camBob: +e.target.value }))} />
            </Row>
            <Row label={`Auto path`}>
              <input type="checkbox" checked={cfg.camera.autoPath}
                     onChange={e => onChange(prev => ({ ...prev, camera: { ...prev.camera, autoPath: e.target.checked } }))}/>
            </Row>
          </Card>

          <Card title="Wireframe">
            <Row label={`Line width: ${cfg.lineWidthPx.toFixed(2)} px`}>
              <input type="range" min={0.8} max={4} step={0.1} value={cfg.lineWidthPx}
                     onChange={e => onChange(prev => ({ ...prev, lineWidthPx: +e.target.value }))} />
            </Row>
          </Card>

          {extra}

          <div style={{ display:'flex', gap:8, marginTop:10, justifyContent:'flex-end' }}>
            <button onClick={() => onChange(defaults())} style={btnStyle}>Reset</button>
            <button onClick={onToggle} style={btnStyle}>Close</button>
          </div>
        </div>
      )}
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  padding:'6px 10px', fontSize:12, borderRadius:6, border:'1px solid #2b2f3a',
  background:'rgba(16,18,22,0.8)', color:'#cfe7ff', cursor:'pointer'
}
const btnMini: React.CSSProperties = {
  padding:'6px 8px', fontSize:12, borderRadius:6, border:'1px solid #2b2f3a',
  background:'rgba(16,18,22,0.8)', color:'#cfe7ff', cursor:'pointer'
}
const tabBtnStyle = (active: boolean): React.CSSProperties => ({
  padding:'6px 10px',
  fontSize:12,
  borderRadius:6,
  border:'1px solid #2b2f3a',
  background: active ? 'linear-gradient(180deg,#1e2632,#141a23)' : 'rgba(16,18,22,0.8)',
  color: active ? '#e6f0ff' : '#cfe7ff',
  cursor:'pointer'
})
const chipStyle = (active: boolean): React.CSSProperties => ({
  padding:'4px 8px',
  fontSize:11,
  borderRadius:12,
  border:'1px solid #2b2f3a',
  background: active ? 'rgba(32,38,48,0.9)' : 'rgba(16,18,22,0.7)',
  color: active ? '#e6f0ff' : '#cfe7ff',
  cursor:'pointer'
})

function clamp(x: number, a: number, b: number) { return Math.max(a, Math.min(b, x)) }
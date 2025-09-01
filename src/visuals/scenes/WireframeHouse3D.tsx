// Minimal scene + robust lyrics + safe mosaic defaults.

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
import { fetchLyrics } from '../../lyrics/provider'

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
  fx: {
    beams: boolean
    groundRings: boolean
    chimneySmoke: boolean
    starfield: boolean
    bloomBreath: boolean
    lyricsMarquee: boolean
    mosaicFloor: boolean
  }
}

const LS_KEY = 'ffw.wire3d.settings.v2'

function defaults(initial?: any): LocalCfg {
  return {
    path: initial?.path ?? 'Circle',
    orbitSpeed: initial?.orbitSpeed ?? 0.35,
    orbitRadius: initial?.orbitRadius ?? 9.5,
    orbitElev: initial?.orbitElev ?? 0.06,
    camBob: initial?.camBob ?? 0.08,
    lineWidthPx: initial?.lineWidthPx ?? 1.6,
    camera: {
      fov: clamp(initial?.camera?.fov ?? 50, 30, 85),
      minDistance: clamp(initial?.camera?.minDistance ?? 5, 3, 30),
      maxDistance: clamp(initial?.camera?.maxDistance ?? 16, 6, 100),
      minPolarAngle: clamp(initial?.camera?.minPolarAngle ?? (Math.PI * 0.12), 0, Math.PI / 2),
      maxPolarAngle: clamp(initial?.camera?.maxPolarAngle ?? (Math.PI * 0.85), Math.PI / 4, Math.PI),
      enablePan: initial?.camera?.enablePan ?? true,
      enableZoom: initial?.camera?.enableZoom ?? true,
      enableDamping: initial?.camera?.enableDamping ?? true,
      dampingFactor: clamp(initial?.camera?.dampingFactor ?? 0.1, 0.05, 0.2),
      rotateSpeed: clamp(initial?.camera?.rotateSpeed ?? 0.6, 0.1, 5),
      zoomSpeed: clamp(initial?.camera?.zoomSpeed ?? 0.7, 0.1, 5),
      panSpeed: clamp(initial?.camera?.panSpeed ?? 0.6, 0.1, 5),
      autoRotate: initial?.camera?.autoRotate ?? false,
      autoRotateSpeed: clamp(initial?.camera?.autoRotateSpeed ?? 0.5, 0.05, 5),
      autoPath: initial?.camera?.autoPath ?? true,
      target: { x: 0, y: 2.2, z: 0 }
    },
    fx: {
      beams: initial?.fx?.beams ?? false,
      groundRings: initial?.fx?.groundRings ?? false,
      chimneySmoke: initial?.fx?.chimneySmoke ?? false,
      starfield: initial?.fx?.starfield ?? false,
      bloomBreath: initial?.fx?.bloomBreath ?? false,
      lyricsMarquee: initial?.fx?.lyricsMarquee ?? true,
      mosaicFloor: initial?.fx?.mosaicFloor ?? false
    }
  }
}

export default function WireframeHouse3D({ auth, quality, accessibility, settings }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [cfg, setCfg] = useState<LocalCfg>(() => {
    try { const saved = localStorage.getItem(LS_KEY); if (saved) return { ...defaults(settings), ...JSON.parse(saved) } } catch {}
    return defaults(settings)
  })
  const [panelOpen, setPanelOpen] = useState(false)

  useEffect(() => {
    const token = (auth as any)?.accessToken
    if (token) { try { setSpotifyTokenProvider(async () => token) } catch {} }
  }, [auth])

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

    const scene = new THREE.Scene()
    scene.background = null
    scene.fog = new THREE.Fog(new THREE.Color('#050607'), 50, 140)

    const camera = new THREE.PerspectiveCamera(cfg.camera.fov, 1, 0.05, 300)
    camera.position.set(0, 2.8, 12.5)
    camera.lookAt(cfg.camera.target.x, cfg.camera.target.y, cfg.camera.target.z)

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
    // NOTE: If you still see texImage3D warnings from Renderer.ts, ensure any 3D texture pass sets UNPACK_FLIP_Y_WEBGL=false before upload.

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = cfg.camera.enableDamping
    controls.dampingFactor = cfg.camera.dampingFactor
    controls.enablePan = cfg.camera.enablePan
    controls.enableZoom = cfg.camera.enableZoom
    controls.rotateSpeed = cfg.camera.rotateSpeed
    controls.zoomSpeed = cfg.camera.zoomSpeed
    controls.panSpeed = cfg.camera.panSpeed
    controls.minDistance = cfg.camera.minDistance
    controls.maxDistance = cfg.camera.maxDistance
    controls.minPolarAngle = cfg.camera.minPolarAngle
    controls.maxPolarAngle = cfg.camera.maxPolarAngle
    controls.target.set(cfg.camera.target.x, cfg.camera.target.y, cfg.camera.target.z)
    controls.autoRotate = cfg.camera.autoRotate
    controls.autoRotateSpeed = cfg.camera.autoRotateSpeed
    let userInteracting = false
    controls.addEventListener('start', () => { userInteracting = true })
    controls.addEventListener('end', () => { userInteracting = false; controls.target.set(cfg.camera.target.x, cfg.camera.target.y, cfg.camera.target.z) })

    const baseAccent = new THREE.Color('#77d0ff')
    const baseAccent2 = new THREE.Color('#a7b8ff')
    const accent = baseAccent.clone()
    const accent2 = baseAccent2.clone()

    const grid = new THREE.GridHelper(160, 160, accent2.clone().multiplyScalar(0.25), accent2.clone().multiplyScalar(0.08))
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.05
    grid.position.y = 0
    scene.add(grid)

    // Floor (no ripple)
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

    // Mosaic floor — start with dark placeholder to avoid bright white tiles
    const mosaicGroup = new THREE.Group()
    const tiles: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = []
    const tileN = 8
    const tileSize = floorSize / tileN
    const placeholderTex = createDarkPlaceholderTexture()
    for (let y = 0; y < tileN; y++) {
      for (let x = 0; x < tileN; x++) {
        const g = new THREE.PlaneGeometry(tileSize, tileSize)
        const m = new THREE.MeshBasicMaterial({ color: 0xffffff, map: placeholderTex, transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false })
        m.color.setScalar(0.85) // dim
        const mesh = new THREE.Mesh(g, m)
        mesh.rotation.x = -Math.PI / 2
        mesh.position.set((x + 0.5) * tileSize - floorSize / 2, 0.0025, (y + 0.5) * tileSize - floorSize / 2)
        mosaicGroup.add(mesh); tiles.push(mesh)
      }
    }
    // Show mosaic only when we have at least one cover
    mosaicGroup.visible = false
    scene.add(mosaicGroup)

    // Mansion edges
    const mansionPositions = buildMansionEdges()
    const fatGeo = new LineSegmentsGeometry()
    fatGeo.setPositions(mansionPositions)
    const fatMat = new LineMaterial({ color: accent.getHex(), transparent: true, opacity: 0.95, depthTest: true })
    ;(fatMat as any).worldUnits = false
    const setLinePixels = (px: number) => {
      const draw = renderer.getDrawingBufferSize(new THREE.Vector2())
      fatMat.linewidth = Math.max(0.0008, px / Math.max(1, draw.y))
      fatMat.needsUpdate = true
    }
    {
      const draw = renderer.getDrawingBufferSize(new THREE.Vector2())
      fatMat.resolution.set(draw.x, draw.y)
      setLinePixels(cfg.lineWidthPx)
    }
    const fatLines = new LineSegments2(fatGeo, fatMat)
    scene.add(fatLines)

    const thinGeo = new THREE.BufferGeometry()
    thinGeo.setAttribute('position', new THREE.BufferAttribute(mansionPositions, 3))
    const thinMat = new THREE.LineBasicMaterial({ color: accent.getHex(), transparent: true, opacity: 0.95, depthTest: true })
    const thinLines = new THREE.LineSegments(thinGeo, thinMat)
    thinLines.visible = false
    scene.add(thinLines)

    // Static windows (no flicker)
    const windowGroup = new THREE.Group()
    {
      const winGeom = new THREE.PlaneGeometry(0.22, 0.16)
      const addWindow = (p: THREE.Vector3, out: THREE.Vector3) => {
        const m = new THREE.MeshBasicMaterial({ color: accent2, transparent: true, opacity: 0.12 })
        const mesh = new THREE.Mesh(winGeom, m)
        mesh.position.copy(p)
        mesh.lookAt(p.clone().add(out))
        windowGroup.add(mesh)
      }
      addMansionWindows((p, out) => addWindow(p, out))
      scene.add(windowGroup)
    }

    // Optional background
    let starfield: THREE.Points | null = null
    const beamGroup = new THREE.Group()
    if (cfg.fx.starfield) {
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
      scene.add(starfield)
    }
    if (cfg.fx.beams) {
      const beamGeom = new THREE.PlaneGeometry(0.06, 6.2)
      for (let i = 0; i < 12; i++) {
        const mat = new THREE.MeshBasicMaterial({ color: accent2, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false })
        const beam = new THREE.Mesh(beamGeom, mat)
        beam.position.set(0, 1.8, 0); beam.rotation.y = (i / 12) * Math.PI * 2
        beamGroup.add(beam)
      }
      scene.add(beamGroup)
    }

    // Haze
    const fogSheet = (() => {
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
      return mesh
    })()

    // Lyrics marquee (always create a visible fallback)
    let marqueeMat: THREE.ShaderMaterial | null = null
    let marqueeTex: THREE.Texture | null = null
    let marqueeMesh: THREE.Mesh | null = null
    let marqueeText = ''
    const setupMarquee = (text: string) => {
      const canvas = document.createElement('canvas')
      canvas.width = 2048; canvas.height = 128
      const g = canvas.getContext('2d')!
      g.clearRect(0,0,canvas.width,canvas.height)
      // readability
      g.font = '600 72px system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
      g.textBaseline = 'middle'
      g.fillStyle = '#ffffff'
      g.shadowColor = 'rgba(0,0,0,0.85)'
      g.shadowBlur = 6
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
          uniforms: {
            tText: { value: marqueeTex },
            uScroll: { value: 0 },
            uOpacity: { value: 0.7 }, // strong baseline so it's clearly visible
            uTint: { value: new THREE.Color(0xffffff) }
          },
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
          vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
          fragmentShader: `
            precision highp float; varying vec2 vUv;
            uniform sampler2D tText; uniform float uScroll; uniform float uOpacity; uniform vec3 uTint;
            void main(){
              vec2 uv=vUv; uv.x=fract(uv.x+uScroll);
              vec4 c=texture2D(tText, uv);
              // edge fade for cleaner look
              float edge = smoothstep(0.0,0.06,uv.x) * smoothstep(1.0,0.94,uv.x);
              gl_FragColor = vec4(c.rgb*uTint, c.a * uOpacity * edge);
            }`
        })
        const geom = new THREE.PlaneGeometry(4.4, 0.26) // slightly larger
        marqueeMesh = new THREE.Mesh(geom, marqueeMat)
        marqueeMesh.position.set(0, 2.48, 1.305)
        scene.add(marqueeMesh)
      } else {
        marqueeMat.uniforms.tText.value = marqueeTex
        marqueeMat.needsUpdate = true
      }
    }
    if (cfg.fx.lyricsMarquee) {
      marqueeText = 'FFw Visualizer'
      setupMarquee(marqueeText)
    }

    // Covers + lyrics
    let floorTex: THREE.Texture | null = null
    const coverTextures: THREE.Texture[] = []
    let currentTrackId: string | null = null

    const loadAlbumCoverAndLyrics = async () => {
      try {
        const s = await getPlaybackState().catch(() => null) // may 403 if scope missing
        const id = (s?.item?.id as string) || null
        const url = (s?.item?.album?.images?.[0]?.url as string) || null
        const title = (s?.item?.name as string) || ''
        const artist = (s?.item?.artists?.[0]?.name as string) || ''

        // Covers
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

          // Dimness based on cover brightness
          const brightness = await estimateTextureLuminance(tex).catch(() => 0.6)
          const dim = clamp(1.02 - brightness * 0.45, 0.6, 0.92)
          floorMat.uniforms.uDim.value = dim
          floorMat.uniforms.uOpacity.value = clamp(0.9 - (brightness - 0.6) * 0.25, 0.65, 0.9)

          floorTex?.dispose(); floorTex = tex
          floorMat.uniforms.tAlbum.value = tex
          floorMat.needsUpdate = true

          coverTextures.push(tex)
          if (cfg.fx.mosaicFloor && tiles.length && coverTextures.length === 1) {
            // First usable cover => enable mosaic
            mosaicGroup.visible = true
            // seed all tiles with the first cover
            tiles.forEach(t => { t.material.map = tex; t.material.toneMapped = false; t.material.color.setScalar(0.85); t.material.needsUpdate = true })
          }
        } else {
          // No cover available: hide mosaic to avoid white tiles
          mosaicGroup.visible = false
        }

        // Lyrics
        if (cfg.fx.lyricsMarquee && (title || artist) && id && id !== currentTrackId) {
          currentTrackId = id
          let line = title && artist ? `${title} — ${artist}` : (title || artist || '')
          try {
            // User override first
            const hook = (window as any).__ffw__getLyrics
            if (typeof hook === 'function') {
              const res = await hook({ id, title, artist })
              const plain = normalizeLyrics(res)
              if (plain) line = plain
            } else {
              // LRCLIB fallback
              const lr = await fetchLyrics({ title, artist })
              if (lr?.plain) line = lr.plain
            }
          } catch {}
          if (line && line !== marqueeText) { marqueeText = line; setupMarquee(line) }
        }
      } catch {}
    }
    loadAlbumCoverAndLyrics()
    const albumIv = window.setInterval(loadAlbumCoverAndLyrics, 5000)

    // Reactivity
    let latest: ReactiveFrame | null = null
    const offFrame = reactivityBus.on('frame', f => { latest = f })

    // Resize
    const updateSizes = () => {
      const draw = renderer.getDrawingBufferSize(new THREE.Vector2())
      const view = renderer.getSize(new THREE.Vector2())
      camera.aspect = view.x / Math.max(1, view.y)
      camera.fov = cfg.camera.fov
      camera.updateProjectionMatrix()
      comp.onResize()
      fatMat.resolution.set(draw.x, draw.y)
      setLinePixels(cfg.lineWidthPx)
    }
    window.addEventListener('resize', updateSizes)
    updateSizes()

    let frames = 0
    let fallbackArmed = false

    const clock = new THREE.Clock()
    let raf = 0
    const animate = () => {
      raf = requestAnimationFrame(animate)
      const dt = Math.min(0.05, clock.getDelta())
      const t = clock.elapsedTime
      const now = performance.now()
      const stale = !latest || (now - (latest.t || 0)) > 240

      const low = latest?.bands.low ?? 0.08
      const mid = latest?.bands.mid ?? 0.08
      const high = latest?.bands.high ?? 0.08
      const loud = latest?.loudness ?? 0.15

      accent.copy(baseAccent).lerp(baseAccent2, THREE.MathUtils.clamp(high * 0.25, 0, 0.25))
      accent2.copy(baseAccent2).lerp(baseAccent, THREE.MathUtils.clamp(mid * 0.2, 0, 0.2))
      fatMat.color.set(accent); thinMat.color.set(accent)

      const px = cfg.lineWidthPx * (1.0 + 0.08 * (latest?.beat ? 1 : 0) + 0.05 * high)
      setLinePixels(px)

      if (cfg.fx.beams) {
        beamGroup.rotation.y += dt * (0.2 + high * 1.2)
        beamGroup.children.forEach((b) => {
          const m = (b as THREE.Mesh).material as THREE.MeshBasicMaterial
          m.opacity = THREE.MathUtils.clamp(0.02 + high * 0.4 + (latest?.beat ? 0.15 : 0), 0, 0.6)
          ;(m.color as THREE.Color).copy(accent2)
        })
      }
      if (starfield) {
        starfield.rotation.y += dt * 0.015
        starfield.rotation.x = Math.sin(t * 0.02) * 0.015
      }

      // Haze
      const fogMat = fogSheet.material as THREE.ShaderMaterial
      fogMat.uniforms.uTime.value = t
      fogMat.uniforms.uIntensity.value = THREE.MathUtils.clamp(0.08 + loud * 0.5 + (latest?.beat ? 0.15 : 0), 0, accessibility.epilepsySafe ? 0.35 : 0.5)
      ;(fogMat.uniforms.uColor.value as THREE.Color).copy(new THREE.Color().copy(accent2).lerp(accent, 0.5))

      // Mosaic visibility respects having covers
      mosaicGroup.visible = !!cfg.fx.mosaicFloor && coverTextures.length > 0
      floorMesh.visible = !mosaicGroup.visible

      // Lyrics marquee — keep visible and readable even when stale
      if (cfg.fx.lyricsMarquee && marqueeMat) {
        marqueeMat.uniforms.uScroll.value = (marqueeMat.uniforms.uScroll.value + dt * 0.05) % 1
        // Clamp minimum opacity high enough to be seen
        const minOp = 0.55
        const extra = THREE.MathUtils.clamp(loud * 0.3, 0, 0.3)
        marqueeMat.uniforms.uOpacity.value = Math.min(0.9, minOp + extra)
        ;(marqueeMat.uniforms.uTint.value as THREE.Color).copy(accent)
      }

      ;(grid.material as THREE.Material).opacity = 0.05 * (stale ? 0.6 : 1.0)

      controls.update()
      comp.composer.render()

      frames++
      if (!fallbackArmed && frames > 10) {
        const dc = (renderer.info.render.calls || 0)
        if (dc <= 1) { fallbackArmed = true; fatLines.visible = false; thinLines.visible = true }
      }
    }
    type Path = 'Circle'|'Ellipse'|'Lemniscate'|'Manual'
    const pathPoint = (path: Path, a: number, r: number) => {
      if (path === 'Ellipse') return new THREE.Vector3(Math.sin(a) * r * 1.08, 0, Math.cos(a) * r * 0.92)
      if (path === 'Lemniscate') { const s = Math.sin(a), c = Math.cos(a), d = 1 + s*s; return new THREE.Vector3((r * c) / d, 0, (r * s * c) / d) }
      return new THREE.Vector3(Math.sin(a) * r, 0, Math.cos(a) * r)
    }
    let angle = 0
    animate()

    return () => {
      cancelAnimationFrame(raf)
      clearInterval(albumIv)
      window.removeEventListener('resize', updateSizes)
      offFrame?.()
      controls.dispose()
      floorTex?.dispose()
      marqueeTex?.dispose?.()
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

    function createDarkPlaceholderTexture(): THREE.Texture {
      const c = document.createElement('canvas')
      c.width = c.height = 64
      const g = c.getContext('2d')!
      g.fillStyle = '#0b0e13'
      g.fillRect(0,0,64,64)
      g.fillStyle = '#111722'
      for (let y=0;y<8;y++) for (let x=0;x<8;x++) {
        if ((x+y)%2===0) g.fillRect(x*8,y*8,8,8)
      }
      const tex = new THREE.CanvasTexture(c)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = 1
      return tex
    }

    function normalizeLyrics(input: any): string {
      if (!input) return ''
      if (typeof input === 'string') return collapse(input)
      if (Array.isArray(input)) return input.map(String).join('  •  ')
      if (typeof input === 'object') {
        if (input.text) return collapse(String(input.text))
        if (Array.isArray(input.lines)) return input.lines.map(String).join('  •  ')
      }
      return ''
    }
    function collapse(s: string): string {
      return s.replace(/\[[0-9:.]+\]/g, ' ').replace(/\s+/g, ' ').trim()
    }
  }, [cfg, quality.renderScale, quality.bloom, accessibility.epilepsySafe, auth])

  return (
    <div data-visual="wireframe3d" style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} aria-label="Wireframe House 3D" />
      <Wire3DPanel open={panelOpen} cfg={cfg} onToggle={() => setPanelOpen(o => !o)} onChange={setCfg} />
    </div>
  )
}

function Wire3DPanel(props: {
  open: boolean
  cfg: LocalCfg
  onToggle: () => void
  onChange: (updater: (prev: LocalCfg) => LocalCfg | LocalCfg) => void
}) {
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

  return (
    <div data-panel="wireframe3d" style={{ position:'absolute', top:12, right:12, zIndex:10, userSelect:'none', pointerEvents:'auto' }}>
      <button onClick={(e) => { e.stopPropagation(); onToggle() }} style={btnStyle}>
        {open ? 'Close 3D Settings' : '3D Settings'}
      </button>
      {open && (
        <div style={{ width: 300, marginTop:8, padding:12, border:'1px solid #2b2f3a', borderRadius:8,
          background:'rgba(10,12,16,0.88)', color:'#e6f0ff', fontFamily:'system-ui, sans-serif', fontSize:12, lineHeight:1.4 }}>
          <Card title="Camera">
            <Row label={`FOV: ${cfg.camera.fov.toFixed(0)}`}>
              <input type="range" min={30} max={85} step={1} value={cfg.camera.fov}
                     onChange={e => onChange(prev => ({ ...prev, camera: { ...prev.camera, fov: +e.target.value } }))} />
            </Row>
            <Row label={`Orbit speed: ${cfg.orbitSpeed.toFixed(2)}`}>
              <input type="range" min={0.05} max={2} step={0.01} value={cfg.orbitSpeed}
                     onChange={e => onChange({ ...cfg, orbitSpeed: +e.target.value })} />
            </Row>
            <Row label={`Orbit radius: ${cfg.orbitRadius.toFixed(1)}`}>
              <input type="range" min={6} max={12} step={0.1} value={cfg.orbitRadius}
                     onChange={e => onChange({ ...cfg, orbitRadius: +e.target.value })} />
            </Row>
            <Row label={`Elevation: ${cfg.orbitElev.toFixed(2)}`}>
              <input type="range" min={0.03} max={0.2} step={0.01} value={cfg.orbitElev}
                     onChange={e => onChange({ ...cfg, orbitElev: +e.target.value })} />
            </Row>
            <Row label={`Auto path`}>
              <input type="checkbox" checked={cfg.camera.autoPath}
                     onChange={e => onChange(prev => ({ ...prev, camera: { ...prev.camera, autoPath: e.target.checked } }))}/>
            </Row>
          </Card>

          <Card title="Effects">
            <Row label="Mosaic floor"><input type="checkbox" checked={cfg.fx.mosaicFloor} onChange={e => onChange({ ...cfg, fx: { ...cfg.fx, mosaicFloor: e.target.checked } })}/></Row>
            <Row label="Beams"><input type="checkbox" checked={cfg.fx.beams} onChange={e => onChange({ ...cfg, fx: { ...cfg.fx, beams: e.target.checked } })}/></Row>
            <Row label="Starfield"><input type="checkbox" checked={cfg.fx.starfield} onChange={e => onChange({ ...cfg, fx: { ...cfg.fx, starfield: e.target.checked } })}/></Row>
            <Row label="Chimney smoke"><input type="checkbox" checked={cfg.fx.chimneySmoke} onChange={e => onChange({ ...cfg, fx: { ...cfg.fx, chimneySmoke: e.target.checked } })}/></Row>
            <Row label="Bloom breathing"><input type="checkbox" checked={cfg.fx.bloomBreath} onChange={e => onChange({ ...cfg, fx: { ...cfg.fx, bloomBreath: e.target.checked } })}/></Row>
            <Row label="Lyrics marquee"><input type="checkbox" checked={cfg.fx.lyricsMarquee} onChange={e => onChange({ ...cfg, fx: { ...cfg.fx, lyricsMarquee: e.target.checked } })}/></Row>
          </Card>

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

function clamp(x: number, a: number, b: number) { return Math.max(a, Math.min(b, x)) }
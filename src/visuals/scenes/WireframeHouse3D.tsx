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
import { ensurePlayerConnected, hasSpotifyTokenProvider } from '../../spotify/player'

type Props = {
  auth: AuthState | null
  quality: { renderScale: 1 | 1.25 | 1.5 | 1.75 | 2, msaa: 0 | 2 | 4 | 8, bloom: boolean, motionBlur: boolean }
  accessibility: { epilepsySafe: boolean, reducedMotion: boolean, highContrast: boolean }
  // settings prop is still accepted but this component now manages its own panel/state (used as initial)
  settings?: any
}

// Local settings dedicated to the 3D scene (independent from WireframeHouse.tsx)
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
  // New FX toggles
  fx: {
    beams: boolean
    groundRings: boolean
    floorRipple: boolean
    windowEQ: boolean
    chimneySmoke: boolean
    starfield: boolean
    bloomBreath: boolean
  }
}

const LS_KEY = 'ffw.wire3d.settings.v2'

function defaults(initial?: any): LocalCfg {
  return {
    path: initial?.path ?? 'Circle',
    orbitSpeed: initial?.orbitSpeed ?? 0.55,
    orbitRadius: initial?.orbitRadius ?? 8.0,
    orbitElev: initial?.orbitElev ?? 0.08,
    camBob: initial?.camBob ?? 0.15,
    lineWidthPx: initial?.lineWidthPx ?? 2.5,
    camera: {
      fov: clamp(initial?.camera?.fov ?? 55, 30, 95),
      minDistance: clamp(initial?.camera?.minDistance ?? 4, 2, 30),
      maxDistance: clamp(initial?.camera?.maxDistance ?? 18, 6, 100),
      minPolarAngle: clamp(initial?.camera?.minPolarAngle ?? (Math.PI * 0.1), 0, Math.PI / 2),
      maxPolarAngle: clamp(initial?.camera?.maxPolarAngle ?? (Math.PI * 0.9), Math.PI / 4, Math.PI),
      enablePan: initial?.camera?.enablePan ?? true,
      enableZoom: initial?.camera?.enableZoom ?? true,
      enableDamping: initial?.camera?.enableDamping ?? true,
      dampingFactor: clamp(initial?.camera?.dampingFactor ?? 0.08, 0.01, 0.2),
      rotateSpeed: clamp(initial?.camera?.rotateSpeed ?? 0.8, 0.1, 5),
      zoomSpeed: clamp(initial?.camera?.zoomSpeed ?? 0.8, 0.1, 5),
      panSpeed: clamp(initial?.camera?.panSpeed ?? 0.8, 0.1, 5),
      autoRotate: initial?.camera?.autoRotate ?? false,
      autoRotateSpeed: clamp(initial?.camera?.autoRotateSpeed ?? 0.8, 0.05, 10),
      autoPath: initial?.camera?.autoPath ?? true,
      target: {
        x: initial?.camera?.target?.x ?? 0,
        y: initial?.camera?.target?.y ?? 2.2,
        z: initial?.camera?.target?.z ?? 0
      }
    },
    fx: {
      beams: initial?.fx?.beams ?? true,
      groundRings: initial?.fx?.groundRings ?? true,
      floorRipple: initial?.fx?.floorRipple ?? true,
      windowEQ: initial?.fx?.windowEQ ?? true,
      chimneySmoke: initial?.fx?.chimneySmoke ?? true,
      starfield: initial?.fx?.starfield ?? true,
      bloomBreath: initial?.fx?.bloomBreath ?? true
    }
  }
}

export default function WireframeHouse3D({ quality, accessibility, settings }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [cfg, setCfg] = useState<LocalCfg>(() => {
    try {
      const saved = localStorage.getItem(LS_KEY)
      if (saved) return { ...defaults(settings), ...JSON.parse(saved) }
    } catch {}
    return defaults(settings)
  })
  const [panelOpen, setPanelOpen] = useState(false)

  // Spotify: only attempt to connect if a token provider exists
  useEffect(() => {
    if (hasSpotifyTokenProvider()) {
      ensurePlayerConnected({ deviceName: 'FFw visualizer', setInitialVolume: false })
        .catch(e => console.warn('Spotify ensurePlayerConnected (3D) failed:', e))
    } else {
      console.warn('WireframeHouse3D: Spotify token provider not set. Skipping player connect.')
    }
  }, [])

  // Allow a global gear to open ONLY this 3D panel via a custom event
  useEffect(() => {
    const open = () => setPanelOpen(true)
    const close = () => setPanelOpen(false)
    window.addEventListener('ffw:open-wireframe3d-settings', open as EventListener)
    window.addEventListener('ffw:close-wireframe3d-settings', close as EventListener)
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'S' || e.key === 's') && (e.shiftKey || e.metaKey)) setPanelOpen(p => !p)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('ffw:open-wireframe3d-settings', open as EventListener)
      window.removeEventListener('ffw:close-wireframe3d-settings', close as EventListener)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // Persist settings
  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)) } catch {}
  }, [cfg])

  useEffect(() => {
    if (!canvasRef.current) return

    // Scene & camera
    const scene = new THREE.Scene()
    scene.background = null
    scene.fog = new THREE.Fog(new THREE.Color('#06080a'), 60, 180)

    const camera = new THREE.PerspectiveCamera(cfg.camera.fov, 1, 0.05, 300)
    camera.position.set(0, 3.2, 14)
    camera.lookAt(cfg.camera.target.x, cfg.camera.target.y, cfg.camera.target.z)

    // Renderer + post
    const { renderer, dispose: disposeRenderer } = createRenderer(canvasRef.current, quality.renderScale)
    const comp = createComposer(renderer, scene, camera, {
      bloom: quality.bloom,
      bloomStrength: 0.9,
      bloomRadius: 0.28,
      bloomThreshold: 0.25,
      fxaa: true,
      vignette: true,
      vignetteStrength: 0.55,
      filmGrain: true,
      filmGrainStrength: 0.3
    })

    // Orbit Controls
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
    controls.addEventListener('end', () => {
      userInteracting = false
      controls.target.set(cfg.camera.target.x, cfg.camera.target.y, cfg.camera.target.z)
    })

    // Palette
    const cssColor = (name: string, fallback: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
    const baseAccent = new THREE.Color(cssColor('--accent', '#00f0ff'))
    const baseAccent2 = new THREE.Color(cssColor('--accent-2', '#ff00f0'))
    const accent = baseAccent.clone()
    const accent2 = baseAccent2.clone()

    // Grid
    const grid = new THREE.GridHelper(160, 160, accent2.clone().multiplyScalar(0.35), accent2.clone().multiplyScalar(0.12))
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.08
    grid.position.y = 0
    scene.add(grid)

    // Album floor — ShaderMaterial: album texture + dim + ripple
    const floorSize = 22
    const floorGeom = new THREE.PlaneGeometry(floorSize, floorSize, 1, 1)
    const floorMat = new THREE.ShaderMaterial({
      uniforms: {
        tAlbum: { value: null as THREE.Texture | null },
        uDim: { value: 0.9 },
        uOpacity: { value: 0.95 },
        uTime: { value: 0 },
        uRippleAmp: { value: cfg.fx.floorRipple ? 0.0 : 0.0 },
        uRippleRadius: { value: 0.0 },
        uRippleDecay: { value: 1.0 }
      },
      transparent: true,
      depthWrite: false,
      vertexShader: `
        precision highp float; precision highp int;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float; precision highp int;
        varying vec2 vUv;
        uniform sampler2D tAlbum;
        uniform float uDim, uOpacity, uTime;
        uniform float uRippleAmp, uRippleRadius, uRippleDecay;
        void main() {
          vec2 uv = vUv;
          // Ripple: radial from center
          if (uRippleAmp > 0.0) {
            vec2 p = uv - 0.5;
            float r = length(p);
            float wave = sin(20.0 * (r - uRippleRadius) - uTime * 4.0) * exp(-uRippleDecay * abs(r - uRippleRadius));
            uv += normalize(p) * wave * (uRippleAmp * 0.015);
          }
          vec4 tex = texture2D(tAlbum, uv);
          vec3 col = tex.rgb * uDim;
          gl_FragColor = vec4(col, uOpacity);
        }
      `
    })
    const floorMesh = new THREE.Mesh(floorGeom, floorMat)
    floorMesh.rotation.x = -Math.PI / 2
    floorMesh.position.y = 0.001
    scene.add(floorMesh)

    // Mansion edges (fat lines + fallback)
    const mansionPositions = buildMansionEdges()
    const fatGeo = new LineSegmentsGeometry()
    fatGeo.setPositions(mansionPositions)
    const fatMat = new LineMaterial({
      color: accent.getHex(),
      transparent: true,
      opacity: 0.98,
      depthTest: true
    })
    ;(fatMat as any).worldUnits = false
    const setLinePixels = (px: number) => {
      const draw = renderer.getDrawingBufferSize(new THREE.Vector2())
      fatMat.linewidth = Math.max(0.0009, px / Math.max(1, draw.y))
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
    const thinMat = new THREE.LineBasicMaterial({ color: accent.getHex(), transparent: true, opacity: 0.98, depthTest: true })
    const thinLines = new THREE.LineSegments(thinGeo, thinMat)
    thinLines.visible = false
    scene.add(thinLines)

    // Starfield (background parallax)
    let starfield: THREE.Points | null = null
    if (cfg.fx.starfield) {
      const g = new THREE.BufferGeometry()
      const N = 1500
      const positions = new Float32Array(N * 3)
      for (let i=0;i<N;i++){
        const r = THREE.MathUtils.lerp(40, 90, Math.random())
        const theta = Math.acos(THREE.MathUtils.lerp(-1, 1, Math.random()))
        const phi = Math.random()*Math.PI*2
        const x = r * Math.sin(theta) * Math.cos(phi)
        const y = r * Math.cos(theta) * 0.5
        const z = r * Math.sin(theta) * Math.sin(phi)
        positions.set([x,y,z], i*3)
      }
      g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      const m = new THREE.PointsMaterial({ color: 0xffffff, size: 0.8, sizeAttenuation: true, transparent: true, opacity: 0.6, depthWrite: false })
      starfield = new THREE.Points(g, m)
      scene.add(starfield)
    }

    // Party beams (additive rotating planes)
    const beamGroup = new THREE.Group()
    if (cfg.fx.beams) {
      const beamGeom = new THREE.PlaneGeometry(0.08, 7.5)
      for (let i = 0; i < 16; i++) {
        const mat = new THREE.MeshBasicMaterial({
          color: accent2,
          transparent: true,
          opacity: 0.0,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        })
        const beam = new THREE.Mesh(beamGeom, mat)
        beam.position.set(0, 1.8, 0)
        beam.rotation.y = (i / 16) * Math.PI * 2
        beamGroup.add(beam)
      }
      scene.add(beamGroup)
    }

    // Ground pulse rings (spawn on beat)
    const rings: THREE.Mesh[] = []
    let ringPool: THREE.Mesh[] = []
    const emitRing = () => {
      if (!cfg.fx.groundRings) return
      const mesh = ringPool.pop() ?? (() => {
        const rg = new THREE.RingGeometry(0.1, 0.12, 64)
        const rm = new THREE.MeshBasicMaterial({ color: accent.getHex(), transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false })
        const m = new THREE.Mesh(rg, rm)
        m.rotation.x = -Math.PI/2
        return m
      })()
      mesh.scale.setScalar(0.5)
      ;(mesh.material as THREE.MeshBasicMaterial).opacity = 0.6
      mesh.position.set(0, 0.003, 0)
      scene.add(mesh)
      rings.push(mesh)
      if (rings.length > 12) {
        const old = rings.shift()!
        scene.remove(old)
        ringPool.push(old)
      }
    }

    // Windows (emissive planes) + optional EQ behavior
    const windowGroup = new THREE.Group()
    const windowMeta: { mesh: THREE.Mesh, story: number, col: number, side: 'front'|'back'|'left'|'right' }[] = []
    {
      const winGeom = new THREE.PlaneGeometry(0.22, 0.16)
      const addWindow = (p: THREE.Vector3, out: THREE.Vector3, story: number, col: number, side: 'front'|'back'|'left'|'right') => {
        const m = new THREE.MeshBasicMaterial({ color: accent2, transparent: true, opacity: 0 })
        const mesh = new THREE.Mesh(winGeom, m)
        mesh.position.copy(p)
        mesh.lookAt(p.clone().add(out))
        windowGroup.add(mesh)
        windowMeta.push({ mesh, story, col, side })
      }
      addMansionWindows(addWindow)
      scene.add(windowGroup)
    }

    // Chimney smoke (lightweight particles)
    const smokeGroup = new THREE.Group()
    let smokeTex: THREE.Texture | null = createSoftCircleTexture()
    const smokeEmitters = [
      new THREE.Vector3(-0.8, 3.75, 0.2),
      new THREE.Vector3( 0.9, 3.75,-0.25),
    ]
    const smokeSprites: THREE.Sprite[] = []
    if (cfg.fx.chimneySmoke && smokeTex) {
      for (let i=0;i<60;i++) {
        const mat = new THREE.SpriteMaterial({ map: smokeTex, color: 0xffffff, transparent: true, opacity: 0, depthWrite: false })
        const s = new THREE.Sprite(mat)
        resetSmoke(s, smokeEmitters[i%smokeEmitters.length], true)
        smokeGroup.add(s)
        smokeSprites.push(s)
      }
      scene.add(smokeGroup)
    }

    // Haze sheet
    const fogSheet = (() => {
      const geom = new THREE.PlaneGeometry(34, 12)
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uIntensity: { value: 0 },
          uColor: { value: new THREE.Color(0x9fc7ff) }
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: `
          precision highp float; precision highp int;
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          precision highp float; precision highp int;
          varying vec2 vUv;
          uniform float uTime; uniform float uIntensity; uniform vec3 uColor;
          float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
          float noise(vec2 p){
            vec2 i=floor(p), f=fract(p);
            float a=hash(i), b=hash(i+vec2(1.,0.)), c=hash(i+vec2(0.,1.)), d=hash(i+vec2(1.,1.));
            vec2 u=f*f*(3.-2.*f);
            return mix(a,b,u.x)+ (c-a)*u.y*(1.-u.x) + (d-b)*u.x*u.y;
          }
          void main(){
            float n = noise(vUv*2.6 + vec2(uTime*0.03, 0.0));
            float m = smoothstep(0.25, 0.82, n);
            float alpha = m * uIntensity * 0.55;
            gl_FragColor = vec4(uColor, alpha);
          }
        `
      })
      const mesh = new THREE.Mesh(geom, mat)
      mesh.position.set(0, 3.4, -1.2)
      mesh.rotation.x = -0.06
      scene.add(mesh)
      return mesh
    })()

    // Album cover loader + brightness compensation feeding floor shader
    let floorTex: THREE.Texture | null = null
    const loadAlbumCover = async () => {
      try {
        const s = await getPlaybackState().catch(() => null)
        const url = (s?.item?.album?.images?.[0]?.url as string) || null
        if (!url) return
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
        const dim = clamp(1.05 - brightness * 0.5, 0.55, 0.95)
        floorMat.uniforms.uDim.value = dim
        floorMat.uniforms.uOpacity.value = clamp(0.95 - (brightness - 0.6) * 0.25, 0.7, 0.95)

        floorTex?.dispose()
        floorTex = tex
        floorMat.uniforms.tAlbum.value = tex
        floorMat.needsUpdate = true
      } catch {}
    }
    loadAlbumCover()
    const albumIv = window.setInterval(loadAlbumCover, 5000)

    // Reactivity
    let latest: ReactiveFrame | null = null
    const offFrame = reactivityBus.on('frame', f => { latest = f })
    const offBeat = reactivityBus.on('beat', () => {
      if (cfg.fx.groundRings) emitRing()
      if (cfg.fx.floorRipple) {
        floorMat.uniforms.uRippleAmp.value = 1.0
        floorMat.uniforms.uRippleRadius.value = 0.05
        floorMat.uniforms.uRippleDecay.value = 10.0
      }
    })
    const offBar = reactivityBus.on('bar', () => {
      if (cfg.camera.autoPath) {
        const vary = (v:number, amt:number, min:number, max:number) => clamp(v + THREE.MathUtils.randFloatSpread(amt), min, max)
        cfg.orbitRadius = vary(cfg.orbitRadius, 1.0, 5.0, 13.0)
        cfg.orbitElev = vary(cfg.orbitElev, 0.02, 0.02, 0.25)
      }
    })

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

    // Fallback watch
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

      const low = latest?.bands.low ?? 0.12
      const mid = latest?.bands.mid ?? 0.12
      const high = latest?.bands.high ?? 0.12
      const loud = latest?.loudness ?? 0.2

      // Accent color morph by highs
      accent.copy(baseAccent).lerp(baseAccent2, THREE.MathUtils.clamp(high * 0.8, 0, 1))
      accent2.copy(baseAccent2).lerp(baseAccent, THREE.MathUtils.clamp(mid * 0.5, 0, 1))
      fatMat.color.set(accent)
      thinMat.color.set(accent)

      // Line width pulse
      const px = cfg.lineWidthPx * (latest?.beat ? 1.35 : 1.0) * (1.0 + 0.15 * high)
      setLinePixels(px)

      // Windows: EQ-like behavior per story
      windowMeta.forEach((w, i) => {
        const mat = w.mesh.material as THREE.MeshBasicMaterial
        let energy = 0.4 + 0.6 * mid
        if (cfg.fx.windowEQ) {
          energy = (
            (w.story === 0 ? (0.25 + 1.2 * low) : 0) +
            (w.story === 1 ? (0.25 + 1.2 * mid) : 0) +
            (w.story === 2 ? (0.25 + 1.2 * high) : 0)
          )
        }
        const flicker = energy * Math.abs(Math.sin((t + i * 0.17) * (3.2 + (i % 5))))
        mat.opacity = THREE.MathUtils.clamp(flicker, 0, 1)
        ;(mat.color as THREE.Color).copy(accent2)
      })

      // Beams
      if (cfg.fx.beams) {
        beamGroup.rotation.y += dt * (0.35 + high * 2.6)
        beamGroup.children.forEach((b, bi) => {
          const m = (b as THREE.Mesh).material as THREE.MeshBasicMaterial
          m.opacity = THREE.MathUtils.clamp(0.05 + high * 0.8 + (latest?.beat && (bi%4===0) ? 0.3 : 0), 0, 1)
          ;(m.color as THREE.Color).copy(accent2)
        })
      }

      // Haze
      const fogMat = fogSheet.material as THREE.ShaderMaterial
      fogMat.uniforms.uTime.value = t
      fogMat.uniforms.uIntensity.value = THREE.MathUtils.clamp(0.2 + loud * 0.8 + (latest?.beat ? 0.5 : 0), 0, accessibility.epilepsySafe ? 0.6 : 1.0)
      ;(fogMat.uniforms.uColor.value as THREE.Color).copy(new THREE.Color().copy(accent2).lerp(accent, 0.45))

      // Floor ripple decay
      if (cfg.fx.floorRipple) {
        floorMat.uniforms.uTime.value = t
        floorMat.uniforms.uRippleAmp.value = THREE.MathUtils.lerp(floorMat.uniforms.uRippleAmp.value, 0.0, 0.1)
        floorMat.uniforms.uRippleRadius.value += dt * (0.3 + low * 1.2)
        floorMat.uniforms.uRippleDecay.value = 10.0 + high * 8.0
      }

      // Smoke
      if (cfg.fx.chimneySmoke) {
        smokeSprites.forEach((s, i) => {
          const mat = s.material as THREE.SpriteMaterial
          s.position.y += dt * (0.35 + loud * 1.5)
          s.position.x += Math.sin(t * 0.5 + i) * 0.001
          s.position.z += Math.cos(t * 0.45 + i * 0.7) * 0.001
          s.scale.setScalar(0.35 + Math.min(1.2, t * 0.02 + loud * 0.3))
          mat.opacity = Math.min(0.55, (mat.opacity ?? 0) + dt * 0.25)
          if (s.position.y > 6) {
            resetSmoke(s, smokeEmitters[i%smokeEmitters.length], false)
          }
        })
      }

      // Starfield subtle drift
      if (starfield) {
        starfield.rotation.y += dt * 0.02
        starfield.rotation.x = Math.sin(t * 0.03) * 0.02
      }

      // Camera auto path
      if (cfg.camera.autoPath && !userInteracting) {
        const baseSpeed = (cfg.orbitSpeed ?? 0.55) * (stale ? 0.15 : 1.0)
        angle += dt * (baseSpeed + low * 1.0 + (latest?.beatStrength ?? 0) * 1.3)
        const radius = THREE.MathUtils.clamp((cfg.orbitRadius ?? 8.0) + Math.sin((latest?.phases.bar ?? 0) * Math.PI * 2) * 0.25, 5.0, 13.0)
        const elev = (cfg.orbitElev ?? 0.08)
        const pos = pathPoint(cfg.path, angle, radius)
        camera.position.set(pos.x, Math.sin(elev) * (radius * 0.6) + 2.6 + (cfg.camBob || 0) * (0.0 + low * 0.35), pos.z)
        camera.lookAt(cfg.camera.target.x, cfg.camera.target.y, cfg.camera.target.z)
        controls.target.set(cfg.camera.target.x, cfg.camera.target.y, cfg.camera.target.z)
      }

      // Post: bloom breathing
      if (cfg.fx.bloomBreath) {
        const strength = THREE.MathUtils.clamp(0.7 + high * 1.2 + (latest?.beat ? 0.4 : 0), 0, accessibility.epilepsySafe ? 1.0 : 2.2)
        const threshold = THREE.MathUtils.clamp(0.2 + (1.0 - high) * 0.3, 0.05, 0.6)
        try { (comp as any).updatePost?.({ bloom: true, bloomStrength: strength, bloomRadius: 0.3, bloomThreshold: threshold, fxaa: true, vignette: true, vignetteStrength: 0.55, filmGrain: true, filmGrainStrength: 0.3 }) } catch {}
      }

      // Ground rings update
      for (let i= rings.length - 1; i>=0; i--) {
        const r = rings[i]
        r.scale.multiplyScalar(1 + dt * (1.6 + low * 2.0))
        const m = r.material as THREE.MeshBasicMaterial
        m.opacity *= (1.0 - dt * (0.6 + high * 1.0))
        if (m.opacity < 0.03) {
          scene.remove(r)
          rings.splice(i, 1)
          ringPool.push(r)
        }
      }

      // Budget on stale
      ;(grid.material as THREE.Material).opacity = 0.08 * (stale ? 0.6 : 1.0)

      controls.update()
      comp.composer.render()

      // Fallback
      frames++
      if (!fallbackArmed && frames > 10) {
        const dc = (renderer.info.render.calls || 0)
        if (dc <= 1) {
          fallbackArmed = true
          fatLines.visible = false
          thinLines.visible = true
        }
      }
    }
    // Camera path
    type Path = 'Circle'|'Ellipse'|'Lemniscate'|'Manual'
    const pathPoint = (path: Path, a: number, r: number) => {
      if (path === 'Ellipse') return new THREE.Vector3(Math.sin(a) * r * 1.2, 0, Math.cos(a) * r * 0.85)
      if (path === 'Lemniscate') { const s = Math.sin(a), c = Math.cos(a), d = 1 + s*s; return new THREE.Vector3((r * c) / d, 0, (r * s * c) / d) }
      return new THREE.Vector3(Math.sin(a) * r, 0, Math.cos(a) * r)
    }
    let angle = 0
    animate()

    return () => {
      cancelAnimationFrame(raf)
      clearInterval(albumIv)
      window.removeEventListener('resize', updateSizes)
      offFrame?.(); offBeat?.(); offBar?.()
      controls.dispose()
      floorTex?.dispose()
      smokeTex?.dispose?.()
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

    // Helpers

    async function estimateTextureLuminance(tex: THREE.Texture): Promise<number> {
      const img = tex.image as HTMLImageElement | HTMLCanvasElement | ImageBitmap
      const w = 32, h = 32
      const c = document.createElement('canvas')
      c.width = w; c.height = h
      const g = c.getContext('2d')
      if (!g) return 0.6
      try {
        g.drawImage(img as any, 0, 0, w, h)
      } catch { return 0.6 }
      const data = g.getImageData(0, 0, w, h).data
      let sum = 0
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], gr = data[i + 1], b = data[i + 2]
        sum += (0.2126 * r + 0.7152 * gr + 0.0722 * b) / 255
      }
      return sum / (w * h)
    }

    function buildMansionEdges(): Float32Array {
      const out: number[] = []
      const y0 = 0.0, y1 = 1.2, y2 = 2.35, y3 = 3.5 // floors
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
        E(minX, y, minZ, maxX, y, minZ)
        E(maxX, y, minZ, maxX, y, maxZ)
        E(maxX, y, maxZ, minX, y, maxZ)
        E(minX, y, maxZ, minX, y, minZ)
      }
      function addStackedBlock(minX:number, maxX:number, minZ:number, maxZ:number, levels:number[]) {
        for (const y of levels) rect(minX, maxX, y, minZ, maxZ)
        const corners: [number, number][] = [[minX, minZ],[maxX, minZ],[maxX, maxZ],[minX, maxZ]]
        for (const [cx, cz] of corners) for (let i=0;i<levels.length-1;i++) E(cx, levels[i], cz, cx, levels[i+1], cz)
        const spanX = maxX - minX, spanZ = maxZ - minZ
        const yb = levels[0], yt = levels[levels.length-1]
        for (let t=1;t<=3;t++) {
          const x = minX + (spanX * t)/4
          E(x, yb, maxZ, x, yt, maxZ) // front
          E(x, yb, minZ, x, yt, minZ) // back
        }
        for (let t=1;t<=3;t++) {
          const z = minZ + (spanZ * t)/4
          E(minX, yb, z, minX, yt, z)
          E(maxX, yb, z, maxX, yt, z)
        }
      }
      function addGabledRoof(minX:number, maxX:number, minZ:number, maxZ:number, topY:number, apexY:number, ridgeAxis:'x'|'z') {
        rect(minX, maxX, topY, minZ, maxZ)
        let r1:THREE.Vector3, r2:THREE.Vector3
        if (ridgeAxis === 'z') {
          const cx = (minX+maxX)*0.5
          r1 = new THREE.Vector3(cx, apexY, minZ)
          r2 = new THREE.Vector3(cx, apexY, maxZ)
        } else {
          const cz = (minZ+maxZ)*0.5
          r1 = new THREE.Vector3(minX, apexY, cz)
          r2 = new THREE.Vector3(maxX, apexY, cz)
        }
        E(r1.x, r1.y, r1.z, r2.x, r2.y, r2.z)
        const c = [
          new THREE.Vector3(minX, topY, minZ), new THREE.Vector3(maxX, topY, minZ),
          new THREE.Vector3(maxX, topY, maxZ), new THREE.Vector3(minX, topY, maxZ),
        ]
        E(c[0].x, c[0].y, c[0].z, r1.x, r1.y, r1.z)
        E(c[1].x, c[1].y, c[1].z, r1.x, r1.y, r1.z)
        E(c[2].x, c[2].y, c[2].z, r2.x, r2.y, r2.z)
        E(c[3].x, c[3].y, c[3].z, r2.x, r2.y, r2.z)
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
          { minX: CF.minX, maxX: CF.maxX, z: CF.maxZ },
          { minX: CF.minX, maxX: CF.maxX, z: CF.minZ },
          { minX: LW.minX, maxX: LW.maxX, z: LW.maxZ },
          { minX: LW.minX, maxX: LW.maxX, z: LW.minZ },
          { minX: RW.minX, maxX: RW.maxX, z: RW.maxZ },
          { minX: RW.minX, maxX: RW.maxX, z: RW.minZ },
        ]
        for (const f of faces) for (const [yb, yt] of levels) {
          const cols = 6, pad = 0.18
          for (let c=0;c<cols;c++) {
            const x0 = THREE.MathUtils.lerp(f.minX+pad, f.maxX-pad, (c+0.1)/cols)
            const x1 = THREE.MathUtils.lerp(f.minX+pad, f.maxX-pad, (c+0.9)/cols)
            E(x0, yb, f.z, x1, yb, f.z); E(x1, yb, f.z, x1, yt, f.z); E(x1, yt, f.z, x0, yt, f.z); E(x0, yt, f.z, x0, yb, f.z)
            const xm = (x0+x1)/2, ym = (yb+yt)/2
            E(xm, yb, f.z, xm, yt, f.z)
            E(x0, ym, f.z, x1, ym, f.z)
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

    function addMansionWindows(add: (p: THREE.Vector3, out: THREE.Vector3, story: number, col: number, side: 'front'|'back'|'left'|'right') => void) {
      const storyY = [0.6, 1.7, 2.8]
      const CF = { minX:-2.0, maxX:2.0, minZ:-1.2, maxZ:1.2 }
      const LW = { minX:-4.0, maxX:-2.2, minZ:-1.4, maxZ:1.4 }
      const RW = { minX: 2.2, maxX: 4.0, minZ:-1.4, maxZ:1.4 }
      const addFace = (minX:number, maxX:number, z:number, out:THREE.Vector3, cols:number, side:'front'|'back') => {
        for (let s=0; s<storyY.length; s++) {
          for (let i=0;i<cols;i++) {
            const x = THREE.MathUtils.lerp(minX+0.22, maxX-0.22, (i+0.5)/cols)
            add(new THREE.Vector3(x, storyY[s], z), out, s, i, side)
          }
        }
      }
      addFace(CF.minX, CF.maxX, CF.maxZ+0.001, new THREE.Vector3(0,0, 1), 6, 'front')
      addFace(CF.minX, CF.maxX, CF.minZ-0.001, new THREE.Vector3(0,0,-1), 6, 'back')
      addFace(LW.minX, LW.maxX, LW.maxZ+0.001, new THREE.Vector3(0,0, 1), 4, 'front')
      addFace(LW.minX, LW.maxX, LW.minZ-0.001, new THREE.Vector3(0,0,-1), 4, 'back')
      addFace(RW.minX, RW.maxX, RW.maxZ+0.001, new THREE.Vector3(0,0, 1), 4, 'front')
      addFace(RW.minX, RW.maxX, RW.minZ-0.001, new THREE.Vector3(0,0,-1), 4, 'back')
      // sides
      for (let s=0; s<storyY.length; s++) {
        for (let i=0;i<4;i++) {
          const z = THREE.MathUtils.lerp(CF.minZ+0.1, CF.maxZ-0.1, (i+0.5)/4)
          add(new THREE.Vector3(-2.201, storyY[s], z), new THREE.Vector3(-1,0,0), s, i, 'left')
          add(new THREE.Vector3( 2.201, storyY[s], z), new THREE.Vector3( 1,0,0), s, i, 'right')
        }
      }
    }

    function createSoftCircleTexture(): THREE.Texture | null {
      try {
        const c = document.createElement('canvas')
        c.width = c.height = 64
        const g = c.getContext('2d')!
        const grd = g.createRadialGradient(32,32,2, 32,32,32)
        grd.addColorStop(0, 'rgba(255,255,255,0.9)')
        grd.addColorStop(0.5, 'rgba(255,255,255,0.25)')
        grd.addColorStop(1, 'rgba(255,255,255,0.0)')
        g.fillStyle = grd
        g.fillRect(0,0,64,64)
        const tex = new THREE.CanvasTexture(c)
        tex.colorSpace = THREE.SRGBColorSpace
        return tex
      } catch { return null }
    }

    function resetSmoke(s: THREE.Sprite, origin: THREE.Vector3, instant = false) {
      s.position.copy(origin)
      s.scale.setScalar(0.2 + Math.random()*0.2)
      const mat = s.material as THREE.SpriteMaterial
      mat.opacity = instant ? Math.random()*0.4 : 0
    }
  }, [cfg, quality.renderScale, quality.bloom, accessibility.epilepsySafe])

  return (
    <div data-visual="wireframe3d" style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} aria-label="Wireframe House 3D" />
      <Wire3DPanel open={panelOpen} cfg={cfg} onToggle={() => setPanelOpen(o => !o)} onChange={setCfg} />
    </div>
  )
}

/**
 * Lightweight in-component settings panel (local to 3D scene).
 * Keeps UI independent from WireframeHouse.tsx and persists to localStorage.
 */
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
    <div data-panel="wireframe3d" style={{
      position:'absolute', top:12, right:12, zIndex:10,
      userSelect:'none', pointerEvents:'auto'
    }}>
      <button onClick={(e) => { e.stopPropagation(); onToggle() }} style={{
        padding:'6px 10px', fontSize:12, borderRadius:6, border:'1px solid #2b2f3a',
        background:'rgba(10,12,16,0.75)', color:'#cfe7ff', cursor:'pointer'
      }}>
        {open ? 'Close 3D Settings' : '3D Settings'}
      </button>
      {open && (
        <div style={{
          width: 300, marginTop:8, padding:12, border:'1px solid #2b2f3a', borderRadius:8,
          background:'rgba(10,12,16,0.88)', color:'#e6f0ff', fontFamily:'system-ui, sans-serif', fontSize:12, lineHeight:1.4
        }}>
          <Card title="Camera">
            <Row label={`FOV: ${cfg.camera.fov.toFixed(0)}`}>
              <input type="range" min={30} max={95} step={1} value={cfg.camera.fov}
                     onChange={e => onChange(prev => ({ ...prev, camera: { ...prev.camera, fov: +e.target.value } }))} />
            </Row>
            <Row label={`Orbit speed: ${cfg.orbitSpeed.toFixed(2)}`}>
              <input type="range" min={0.05} max={2} step={0.01} value={cfg.orbitSpeed}
                     onChange={e => onChange({ ...cfg, orbitSpeed: +e.target.value })} />
            </Row>
            <Row label={`Orbit radius: ${cfg.orbitRadius.toFixed(1)}`}>
              <input type="range" min={5} max={13} step={0.1} value={cfg.orbitRadius}
                     onChange={e => onChange({ ...cfg, orbitRadius: +e.target.value })} />
            </Row>
            <Row label={`Elevation: ${cfg.orbitElev.toFixed(2)}`}>
              <input type="range" min={0.02} max={0.25} step={0.01} value={cfg.orbitElev}
                     onChange={e => onChange({ ...cfg, orbitElev: +e.target.value })} />
            </Row>
            <Row label={`Auto path`}>
              <input type="checkbox" checked={cfg.camera.autoPath}
                     onChange={e => onChange(prev => ({ ...prev, camera: { ...prev.camera, autoPath: e.target.checked } }))}/>
            </Row>
            <Row label={`Controls auto-rotate`}>
              <input type="checkbox" checked={cfg.camera.autoRotate}
                     onChange={e => onChange(prev => ({ ...prev, camera: { ...prev.camera, autoRotate: e.target.checked } }))}/>
            </Row>
          </Card>

          <Card title="Wireframe">
            <Row label={`Line width: ${cfg.lineWidthPx.toFixed(2)} px`}>
              <input type="range" min={0.5} max={6} step={0.1} value={cfg.lineWidthPx}
                     onChange={e => onChange({ ...cfg, lineWidthPx: +e.target.value })} />
            </Row>
          </Card>

          <Card title="Effects">
            <Row label="Beams"><input type="checkbox" checked={cfg.fx.beams} onChange={e => onChange({ ...cfg, fx: { ...cfg.fx, beams: e.target.checked } })}/></Row>
            <Row label="Ground rings"><input type="checkbox" checked={cfg.fx.groundRings} onChange={e => onChange({ ...cfg, fx: { ...cfg.fx, groundRings: e.target.checked } })}/></Row>
            <Row label="Floor ripple"><input type="checkbox" checked={cfg.fx.floorRipple} onChange={e => onChange({ ...cfg, fx: { ...cfg.fx, floorRipple: e.target.checked } })}/></Row>
            <Row label="Window EQ"><input type="checkbox" checked={cfg.fx.windowEQ} onChange={e => onChange({ ...cfg, fx: { ...cfg.fx, windowEQ: e.target.checked } })}/></Row>
            <Row label="Chimney smoke"><input type="checkbox" checked={cfg.fx.chimneySmoke} onChange={e => onChange({ ...cfg, fx: { ...cfg.fx, chimneySmoke: e.target.checked } })}/></Row>
            <Row label="Starfield"><input type="checkbox" checked={cfg.fx.starfield} onChange={e => onChange({ ...cfg, fx: { ...cfg.fx, starfield: e.target.checked } })}/></Row>
            <Row label="Bloom breathing"><input type="checkbox" checked={cfg.fx.bloomBreath} onChange={e => onChange({ ...cfg, fx: { ...cfg.fx, bloomBreath: e.target.checked } })}/></Row>
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
import React, { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { createRenderer, createComposer } from '../../three/Renderer'
import { reactivityBus, type ReactiveFrame } from '../../audio/ReactivityBus'
import type { AuthState } from '../../auth/token'
import { getPlaybackState } from '../../spotify/api'
import { cacheAlbumArt } from '../../utils/idb'

type Props = {
  auth: AuthState | null
  quality: { renderScale: 1 | 1.25 | 1.5 | 1.75 | 2, msaa: 0 | 2 | 4 | 8, bloom: boolean, motionBlur: boolean }
  accessibility: { epilepsySafe: boolean, reducedMotion: boolean, highContrast: boolean }
  settings: any
}

// A small 3‑story “mansion” made of a central block + two wings (wireframe), album cover as the floor.
export default function WireframeHouse3D({ quality, accessibility, settings }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (!canvasRef.current) return

    // Scene, camera
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 120)
    camera.position.set(0, 2.6, 9)
    camera.lookAt(0, 1.8, 0)

    // Renderer + composer
    const { renderer, dispose: disposeRenderer } = createRenderer(canvasRef.current, quality.renderScale)
    const comp = createComposer(renderer, scene, camera, {
      bloom: quality.bloom,
      bloomStrength: 0.9,
      bloomRadius: 0.28,
      bloomThreshold: 0.2,
      fxaa: true,
      vignette: true,
      vignetteStrength: 0.55,
      filmGrain: true,
      filmGrainStrength: 0.35
    })

    // CSS palette
    const cssColor = (name: string, fallback: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
    const accent = new THREE.Color(cssColor('--accent', '#00f0ff'))
    const accent2 = new THREE.Color(cssColor('--accent-2', '#ff00f0'))

    // Ground grid (subtle – mansion wires will dominate)
    const grid = new THREE.GridHelper(80, 80, accent2.clone().multiplyScalar(0.5), accent2.clone().multiplyScalar(0.2))
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.1
    grid.position.y = 0
    scene.add(grid)

    // Album floor (current album cover)
    const floorSize = 14 // big square
    const floorGeom = new THREE.PlaneGeometry(floorSize, floorSize)
    const floorMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: undefined,
      transparent: true,
      opacity: 0.96,
      depthWrite: false
    })
    const floorMesh = new THREE.Mesh(floorGeom, floorMat)
    floorMesh.rotation.x = -Math.PI / 2
    floorMesh.position.y = 0.001 // avoid z-fight with grid
    scene.add(floorMesh)

    // Mansion edges (fat lines)
    const mansionEdges = buildMansionEdges()
    const lineGeo = new LineSegmentsGeometry()
    lineGeo.setPositions(mansionEdges)

    const lineMat = new LineMaterial({
      color: accent.getHex(),
      linewidth: Math.max(0.0035, (settings.lineWidth || 1.8) / 700), // screen-space (rough mapping)
      transparent: true,
      opacity: 0.98,
      depthTest: true
    })
    {
      const draw = renderer.getDrawingBufferSize(new THREE.Vector2())
      lineMat.resolution.set(draw.x, draw.y)
    }
    const lines = new LineSegments2(lineGeo, lineMat)
    scene.add(lines)

    // Windows (lots)
    const windowGroup = new THREE.Group()
    {
      const winGeom = new THREE.PlaneGeometry(0.16, 0.12)
      const addWindow = (p: THREE.Vector3, outwards: THREE.Vector3) => {
        const m = new THREE.MeshBasicMaterial({ color: accent2, transparent: true, opacity: 0 })
        const mesh = new THREE.Mesh(winGeom, m)
        mesh.position.copy(p)
        mesh.lookAt(p.clone().add(outwards))
        windowGroup.add(mesh)
      }
      addMansionWindows(addWindow)
      scene.add(windowGroup)
    }

    // Light party beams (optional)
    const beamGroup = new THREE.Group()
    {
      const beamGeom = new THREE.PlaneGeometry(0.05, 5.5)
      for (let i = 0; i < 12; i++) {
        const mat = new THREE.MeshBasicMaterial({
          color: accent2,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        })
        const beam = new THREE.Mesh(beamGeom, mat)
        beam.position.set(0, 1.2, 0)
        beam.rotation.y = (i / 12) * Math.PI * 2
        beamGroup.add(beam)
      }
      scene.add(beamGroup)
    }

    // Cheap “haze” sheet for depth
    const fogSheet = (() => {
      const geom = new THREE.PlaneGeometry(22, 8)
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
          float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float noise(vec2 p){
            vec2 i=floor(p), f=fract(p);
            float a=hash(i), b=hash(i+vec2(1.0,0.0)), c=hash(i+vec2(0.0,1.0)), d=hash(i+vec2(1.0,1.0));
            vec2 u=f*f*(3.0-2.0*f);
            return mix(a,b,u.x)+ (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
          }
          void main(){
            float n = noise(vUv*3.0 + vec2(uTime*0.02, 0.0));
            float m = smoothstep(0.25, 0.8, n);
            float alpha = m * uIntensity * 0.5;
            gl_FragColor = vec4(uColor, alpha);
          }
        `
      })
      const mesh = new THREE.Mesh(geom, mat)
      mesh.position.set(0, 2.0, -0.8)
      mesh.rotation.x = -0.05
      scene.add(mesh)
      return mesh
    })()

    // Album cover loader – keeps floor synced to current track
    let floorTex: THREE.Texture | null = null
    const loadAlbumCover = async () => {
      try {
        const s = await getPlaybackState().catch(() => null)
        const url = (s?.item?.album?.images?.[0]?.url as string) || null
        if (!url) return
        const blobUrl = await cacheAlbumArt(url).catch(() => url)
        const loader = new THREE.TextureLoader()
        const tex = await new Promise<THREE.Texture>((resolve, reject) => {
          loader.load(blobUrl, (t) => resolve(t), undefined, reject)
        })
        tex.colorSpace = THREE.SRGBColorSpace
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
        // Assign
        floorTex?.dispose()
        floorTex = tex
        floorMat.map = tex
        floorMat.needsUpdate = true
      } catch {
        // ignore
      }
    }
    loadAlbumCover()
    const albumIv = window.setInterval(loadAlbumCover, 5000)

    // Reactivity hookup
    let latest: ReactiveFrame | null = null
    const offFrame = reactivityBus.on('frame', (f) => { latest = f })
    const offBeat = reactivityBus.on('beat', () => { /* could spawn particles later */ })
    const offBar = reactivityBus.on('bar', () => {})
    const offSec = reactivityBus.on('section', () => {})

    // Camera orbit/path
    type Path = 'Circle' | 'Ellipse' | 'Lemniscate' | 'Manual'
    const path: Path = (settings.path || 'Circle') as Path
    let angle = 0

    // Resize/resolution
    const updateSizes = () => {
      const draw = renderer.getDrawingBufferSize(new THREE.Vector2())
      const view = renderer.getSize(new THREE.Vector2())
      camera.aspect = view.x / Math.max(1, view.y)
      camera.updateProjectionMatrix()
      comp.onResize()
      lineMat.resolution.set(draw.x, draw.y)
      lineMat.needsUpdate = true
    }
    window.addEventListener('resize', updateSizes)
    updateSizes()

    // Animate
    const clock = new THREE.Clock()
    let raf = 0
    const animate = () => {
      raf = requestAnimationFrame(animate)
      const dt = Math.min(0.05, clock.getDelta())
      const now = performance.now()
      const stale = !latest || (now - (latest.t || 0)) > 220

      const high = latest?.bands.high ?? 0.12
      const mid = latest?.bands.mid ?? 0.12
      const low = latest?.bands.low ?? 0.12
      const loud = latest?.loudness ?? 0.2

      // Dynamic line tint
      const mixed = new THREE.Color().copy(accent).lerp(accent2, THREE.MathUtils.clamp(high * 0.9, 0, 1))
      lineMat.color = mixed
      lineMat.linewidth = THREE.MathUtils.lerp(lineMat.linewidth, Math.max(0.0025, (settings.lineWidth || 1.8) / 700 * (1 + (latest?.beat ? 0.5 : 0))), 0.2)
      lineMat.needsUpdate = true

      // Windows flicker by mid
      windowGroup.children.forEach((m, i) => {
        const mat = (m as THREE.Mesh).material as THREE.MeshBasicMaterial
        const flicker = 0.08 + 0.85 * mid * Math.abs(Math.sin((clock.elapsedTime + i * 0.21) * (3.5 + (i % 5))))
        mat.opacity = THREE.MathUtils.clamp(flicker, 0, 1)
        ;(mat.color as THREE.Color).copy(accent2)
      })

      // Beams spin/brightness
      beamGroup.rotation.y += dt * (0.35 + high * 2.6)
      beamGroup.children.forEach((b) => {
        const m = (b as THREE.Mesh).material as THREE.MeshBasicMaterial
        m.opacity = THREE.MathUtils.clamp(0.06 + high * 0.7, 0, 1)
        ;(m.color as THREE.Color).copy(accent2)
      })

      // Haze
      const fogMat = fogSheet.material as THREE.ShaderMaterial
      fogMat.uniforms.uTime.value = clock.elapsedTime
      fogMat.uniforms.uIntensity.value = THREE.MathUtils.clamp(0.22 + loud * 0.8 + (latest?.beat ? 0.6 : 0), 0, accessibility.epilepsySafe ? 0.6 : 1.0)
      ;(fogMat.uniforms.uColor.value as THREE.Color).copy(new THREE.Color().copy(accent2).lerp(accent, 0.45))

      // Camera
      const baseSpeed = (settings.orbitSpeed ?? 0.55) * (stale ? 0.15 : 1.0)
      angle += dt * (baseSpeed + low * 1.1 + (latest?.beatStrength ?? 0) * 1.4)
      const radius = THREE.MathUtils.clamp((settings.orbitRadius ?? 6.5) + Math.sin((latest?.phases.bar ?? 0) * Math.PI * 2) * 0.2, 4.5, 10.5)
      const elev = (settings.orbitElev ?? 0.08)

      const pos = pathPoint(path, angle, radius)
      camera.position.set(pos.x, Math.sin(elev) * (radius * 0.55) + 2.0 + (settings.camBob || 0) * (0.0 + low * 0.35), pos.z)
      camera.lookAt(0, 1.9, 0)

      // Adaptive budget when stale
      const budgetScale = stale ? 0.6 : 1.0
      ;(grid.material as THREE.Material).opacity = 0.1 * budgetScale

      comp.composer.render()
    }
    animate()

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', updateSizes)
      clearInterval(albumIv)
      offFrame?.(); offBeat?.(); offBar?.(); offSec?.()
      floorTex?.dispose()
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

    function pathPoint(path: 'Circle'|'Ellipse'|'Lemniscate'|'Manual', a: number, r: number) {
      if (path === 'Ellipse') return new THREE.Vector3(Math.sin(a) * r * 1.2, 0, Math.cos(a) * r * 0.8)
      if (path === 'Lemniscate') { const s = Math.sin(a), c = Math.cos(a), d = 1 + s*s; return new THREE.Vector3((r * c) / d, 0, (r * s * c) / d) }
      return new THREE.Vector3(Math.sin(a) * r, 0, Math.cos(a) * r)
    }

    // Build a 3‑story central block with two wings + gabled roofs
    function buildMansionEdges(): Float32Array {
      const edges: number[] = []
      const y0 = 0.0, y1 = 0.95, y2 = 1.9, y3 = 2.85 // floors
      const roofC = 3.55, roofW = 3.3 // apex heights

      // Central block (width 2.8, depth 1.6)
      addStackedBlock(-1.4, 1.4, -0.8, 0.8, [y0, y1, y2, y3])

      // Left wing (width 1.4, depth 2.0)
      addStackedBlock(-2.8, -1.4, -1.0, 1.0, [y0, y1, y2, y3])

      // Right wing
      addStackedBlock(1.4, 2.8, -1.0, 1.0, [y0, y1, y2, y3])

      // Roofs (gabled)
      // Central roof – ridge along Z at x = 0
      addGabledRoof(-1.4, 1.4, -0.8, 0.8, y3, roofC, 'z')

      // Left wing roof – ridge along Z at x = -2.1
      addGabledRoof(-2.8, -1.4, -1.0, 1.0, y3, roofW, 'z')

      // Right wing roof – ridge along Z at x = 2.1
      addGabledRoof(1.4, 2.8, -1.0, 1.0, y3, roofW, 'z')

      // Chimneys (simple prisms on central roof)
      addChimney(-0.6, 3.2, 0.3)
      addChimney(0.7, 3.25, -0.2)

      return new Float32Array(edges)

      function addEdge(a: THREE.Vector3, b: THREE.Vector3) {
        edges.push(a.x, a.y, a.z, b.x, b.y, b.z)
      }
      function addRectEdges(minX: number, maxX: number, minZ: number, maxZ: number, y: number) {
        const p = [
          new THREE.Vector3(minX, y, minZ),
          new THREE.Vector3(maxX, y, minZ),
          new THREE.Vector3(maxX, y, maxZ),
          new THREE.Vector3(minX, y, maxZ),
        ]
        addEdge(p[0], p[1]); addEdge(p[1], p[2]); addEdge(p[2], p[3]); addEdge(p[3], p[0])
      }
      function addStackedBlock(minX: number, maxX: number, minZ: number, maxZ: number, levels: number[]) {
        // Perimeter each level + verticals
        for (const y of levels) addRectEdges(minX, maxX, minZ, maxZ, y)
        const corners = [
          [minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]
        ]
        for (let i = 0; i < corners.length; i++) {
          for (let k = 0; k < levels.length - 1; k++) {
            const a = new THREE.Vector3(corners[i][0], levels[k], corners[i][1])
            const b = new THREE.Vector3(corners[i][0], levels[k + 1], corners[i][1])
            addEdge(a, b)
          }
        }
        // Some vertical mullions on faces for detail
        const spanX = maxX - minX, spanZ = maxZ - minZ
        const mY0 = levels[0], mY1 = levels[levels.length - 1]
        // Front face (z = maxZ)
        for (let t = 1; t <= 3; t++) {
          const x = minX + (spanX * t) / 4
          addEdge(new THREE.Vector3(x, mY0, maxZ), new THREE.Vector3(x, mY1, maxZ))
        }
        // Back face (z = minZ)
        for (let t = 1; t <= 3; t++) {
          const x = minX + (spanX * t) / 4
          addEdge(new THREE.Vector3(x, mY0, minZ), new THREE.Vector3(x, mY1, minZ))
        }
        // Left face (x = minX)
        for (let t = 1; t <= 3; t++) {
          const z = minZ + (spanZ * t) / 4
          addEdge(new THREE.Vector3(minX, mY0, z), new THREE.Vector3(minX, mY1, z))
        }
        // Right face (x = maxX)
        for (let t = 1; t <= 3; t++) {
          const z = minZ + (spanZ * t) / 4
          addEdge(new THREE.Vector3(maxX, mY0, z), new THREE.Vector3(maxX, mY1, z))
        }
      }
      function addGabledRoof(minX: number, maxX: number, minZ: number, maxZ: number, topY: number, apexY: number, ridgeAxis: 'x' | 'z') {
        const top = [
          new THREE.Vector3(minX, topY, minZ),
          new THREE.Vector3(maxX, topY, minZ),
          new THREE.Vector3(maxX, topY, maxZ),
          new THREE.Vector3(minX, topY, maxZ)
        ]
        // Ridge endpoints
        let r1: THREE.Vector3, r2: THREE.Vector3
        if (ridgeAxis === 'z') {
          const cx = (minX + maxX) * 0.5
          r1 = new THREE.Vector3(cx, apexY, minZ)
          r2 = new THREE.Vector3(cx, apexY, maxZ)
        } else {
          const cz = (minZ + maxZ) * 0.5
          r1 = new THREE.Vector3(minX, apexY, cz)
          r2 = new THREE.Vector3(maxX, apexY, cz)
        }
        // Ridge
        addEdge(r1, r2)
        // Slopes: connect top rectangle edges to ridge ends (approximate rafters)
        addEdge(top[0], r1); addEdge(top[1], r1)
        addEdge(top[2], r2); addEdge(top[3], r2)
        // Outline top perimeter to emphasize roof base
        addEdge(top[0], top[1]); addEdge(top[1], top[2]); addEdge(top[2], top[3]); addEdge(top[3], top[0])
      }
      function addChimney(x: number, y: number, z: number) {
        const w = 0.18, h = 0.6, d = 0.18
        const yb = y, yt = y + h
        const minX = x - w / 2, maxX = x + w / 2
        const minZ = z - d / 2, maxZ = z + d / 2
        addRectEdges(minX, maxX, minZ, maxZ, yb)
        addRectEdges(minX, maxX, minZ, maxZ, yt)
        const corners = [
          [minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]
        ]
        for (const [cx, cz] of corners) {
          addEdge(new THREE.Vector3(cx, yb, cz), new THREE.Vector3(cx, yt, cz))
        }
      }
    }

    // Generate windows across faces
    function addMansionWindows(add: (p: THREE.Vector3, out: THREE.Vector3) => void) {
      const storyY = [0.45, 1.4, 2.35] // midpoints of floors
      // Central front/back
      const central = { minX: -1.4, maxX: 1.4, minZ: -0.8, maxZ: 0.8 }
      for (const y of storyY) {
        for (let i = 0; i < 5; i++) {
          const x = THREE.MathUtils.lerp(central.minX + 0.2, central.maxX - 0.2, i / 4)
          add(new THREE.Vector3(x, y, central.maxZ + 0.001), new THREE.Vector3(0, 0, 1))
          add(new THREE.Vector3(x, y, central.minZ - 0.001), new THREE.Vector3(0, 0, -1))
        }
      }
      // Wings front/back
      const L = { minX: -2.8, maxX: -1.4, minZ: -1.0, maxZ: 1.0 }
      const R = { minX: 1.4, maxX: 2.8, minZ: -1.0, maxZ: 1.0 }
      const wings = [L, R]
      for (const w of wings) {
        for (const y of storyY) {
          for (let i = 0; i < 3; i++) {
            const x = THREE.MathUtils.lerp(w.minX + 0.2, w.maxX - 0.2, (i + 0.5) / 3)
            add(new THREE.Vector3(x, y, w.maxZ + 0.001), new THREE.Vector3(0, 0, 1))
            add(new THREE.Vector3(x, y, w.minZ - 0.001), new THREE.Vector3(0, 0, -1))
          }
        }
      }
      // Side windows (left/right faces)
      for (const y of storyY) {
        for (let i = 0; i < 3; i++) {
          const zC = THREE.MathUtils.lerp(central.minZ + 0.1, central.maxZ - 0.1, i / 2)
          add(new THREE.Vector3(central.minX - 0.001, y, zC), new THREE.Vector3(-1, 0, 0))
          add(new THREE.Vector3(central.maxX + 0.001, y, zC), new THREE.Vector3(1, 0, 0))
        }
      }
    }
  }, [quality.renderScale, quality.bloom, accessibility.epilepsySafe, settings])

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} aria-label="Wireframe House 3D" />
}
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

// Detailed 3‑story “small mansion” wireframe + album cover floor
export default function WireframeHouse3D({ quality, accessibility, settings }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (!canvasRef.current) return

    // Scene & Camera
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 200)
    camera.position.set(0, 3.0, 11.5)
    camera.lookAt(0, 2.2, 0)

    // Renderer + PostFX
    const { renderer, dispose: disposeRenderer } = createRenderer(canvasRef.current, quality.renderScale)
    const comp = createComposer(renderer, scene, camera, {
      bloom: quality.bloom,
      bloomStrength: 0.9,
      bloomRadius: 0.28,
      bloomThreshold: 0.25,
      fxaa: true,
      vignette: true,
      vignetteStrength: 0.5,
      filmGrain: true,
      filmGrainStrength: 0.35
    })

    // Palette from CSS
    const cssColor = (name: string, fallback: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
    const accent = new THREE.Color(cssColor('--accent', '#00f0ff'))
    const accent2 = new THREE.Color(cssColor('--accent-2', '#ff00f0'))

    // Subtle background fog color
    scene.fog = new THREE.Fog(new THREE.Color('#020406'), 30, 120)

    // Grid
    const grid = new THREE.GridHelper(120, 120, accent2.clone().multiplyScalar(0.35), accent2.clone().multiplyScalar(0.12))
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.12
    grid.position.y = 0
    scene.add(grid)

    // Album floor (current album cover)
    const floorSize = 18
    const floorGeom = new THREE.PlaneGeometry(floorSize, floorSize)
    const floorMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: undefined,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.98,
      depthWrite: false
    })
    const floorMesh = new THREE.Mesh(floorGeom, floorMat)
    floorMesh.rotation.x = -Math.PI / 2
    floorMesh.position.y = 0.002
    scene.add(floorMesh)

    // Mansion wireframe (fat lines)
    const mansionPositions = buildMansionEdges()
    const lineGeo = new LineSegmentsGeometry()
    lineGeo.setPositions(mansionPositions)

    const lineMat = new LineMaterial({
      color: accent.getHex(),
      linewidth: 0.003, // will be overwritten by setLineWidthPx()
      transparent: true,
      opacity: 0.98,
      depthTest: true
    })
    const setLineWidthPx = (px: number) => {
      const draw = renderer.getDrawingBufferSize(new THREE.Vector2())
      lineMat.linewidth = Math.max(0.00075, px / Math.max(1, draw.y)) // px → NDC-space line units
      lineMat.needsUpdate = true
    }
    {
      const draw = renderer.getDrawingBufferSize(new THREE.Vector2())
      lineMat.resolution.set(draw.x, draw.y)
      setLineWidthPx((settings.lineWidthPx ?? 2.0))
    }
    const lines = new LineSegments2(lineGeo, lineMat)
    scene.add(lines)

    // Windows group (emissive planes)
    const windowGroup = new THREE.Group()
    {
      const winGeom = new THREE.PlaneGeometry(0.18, 0.13)
      const addWindow = (p: THREE.Vector3, outwards: THREE.Vector3) => {
        const m = new THREE.MeshBasicMaterial({ color: accent2, transparent: true, opacity: 0 })
        const mesh = new THREE.Mesh(winGeom, m)
        mesh.position.copy(p)
        // face outward
        mesh.lookAt(p.clone().add(outwards))
        windowGroup.add(mesh)
      }
      addMansionWindows(addWindow)
      scene.add(windowGroup)
    }

    // Haze sheet (soft volumetric feel)
    const fogSheet = (() => {
      const geom = new THREE.PlaneGeometry(28, 10)
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
      mesh.position.set(0, 3.2, -1.2)
      mesh.rotation.x = -0.06
      scene.add(mesh)
      return mesh
    })()

    // Album cover loader (polls while playing)
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
        tex.minFilter = THREE.LinearMipmapLinearFilter
        tex.magFilter = THREE.LinearFilter
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
        tex.generateMipmaps = true
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

    // Reactivity
    let latest: ReactiveFrame | null = null
    const offFrame = reactivityBus.on('frame', (f) => { latest = f })

    // Camera path & animation
    type Path = 'Circle' | 'Ellipse' | 'Lemniscate' | 'Manual'
    const path: Path = (settings.path || 'Circle') as Path
    let angle = 0

    // Resize handling
    const updateSizes = () => {
      const draw = renderer.getDrawingBufferSize(new THREE.Vector2())
      const view = renderer.getSize(new THREE.Vector2())
      camera.aspect = view.x / Math.max(1, view.y)
      camera.updateProjectionMatrix()
      comp.onResize()
      lineMat.resolution.set(draw.x, draw.y)
      setLineWidthPx((settings.lineWidthPx ?? 2.0))
    }
    window.addEventListener('resize', updateSizes)
    updateSizes()

    const clock = new THREE.Clock()
    let raf = 0
    const animate = () => {
      raf = requestAnimationFrame(animate)
      const dt = Math.min(0.05, clock.getDelta())
      const now = performance.now()
      const stale = !latest || (now - (latest.t || 0)) > 240

      const low = latest?.bands.low ?? 0.12
      const mid = latest?.bands.mid ?? 0.12
      const high = latest?.bands.high ?? 0.12
      const loud = latest?.loudness ?? 0.2

      // Lines: hue mix + width punch
      const mixed = new THREE.Color().copy(accent).lerp(accent2, THREE.MathUtils.clamp(high * 0.9, 0, 1))
      lineMat.color.set(mixed)
      const targetPx = (settings.lineWidthPx ?? 2.0) * (latest?.beat ? 1.5 : 1.0)
      lineMat.linewidth = THREE.MathUtils.lerp(lineMat.linewidth, targetPx / Math.max(1, renderer.getDrawingBufferSize(new THREE.Vector2()).y), 0.2)
      lineMat.needsUpdate = true

      // Windows: flicker by mids
      windowGroup.children.forEach((m, i) => {
        const mat = (m as THREE.Mesh).material as THREE.MeshBasicMaterial
        const flicker = 0.06 + 0.9 * mid * Math.abs(Math.sin((clock.elapsedTime + i * 0.19) * (3.6 + (i % 5))))
        mat.opacity = THREE.MathUtils.clamp(flicker, 0, 1)
        ;(mat.color as THREE.Color).copy(accent2)
      })

      // Haze intensity
      const fogMat = fogSheet.material as THREE.ShaderMaterial
      fogMat.uniforms.uTime.value = clock.elapsedTime
      fogMat.uniforms.uIntensity.value = THREE.MathUtils.clamp(0.22 + loud * 0.8 + (latest?.beat ? 0.55 : 0), 0, accessibility.epilepsySafe ? 0.6 : 1.0)
      ;(fogMat.uniforms.uColor.value as THREE.Color).copy(new THREE.Color().copy(accent2).lerp(accent, 0.45))

      // Camera motion
      const baseSpeed = (settings.orbitSpeed ?? 0.55) * (stale ? 0.15 : 1.0)
      angle += dt * (baseSpeed + low * 1.1 + (latest?.beatStrength ?? 0) * 1.35)
      const radius = THREE.MathUtils.clamp((settings.orbitRadius ?? 7.5) + Math.sin((latest?.phases.bar ?? 0) * Math.PI * 2) * 0.25, 5.0, 11.5)
      const elev = (settings.orbitElev ?? 0.08)
      const pos = pathPoint(path, angle, radius)
      camera.position.set(pos.x, Math.sin(elev) * (radius * 0.55) + 2.4 + (settings.camBob || 0) * (0.0 + low * 0.35), pos.z)
      camera.lookAt(0, 2.1, 0)

      // Adaptive budget on stale
      const budgetScale = stale ? 0.6 : 1.0
      ;(grid.material as THREE.Material).opacity = 0.12 * budgetScale

      comp.composer.render()
    }
    animate()

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', updateSizes)
      clearInterval(albumIv)
      offFrame?.()
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
      if (path === 'Ellipse') return new THREE.Vector3(Math.sin(a) * r * 1.25, 0, Math.cos(a) * r * 0.85)
      if (path === 'Lemniscate') { const s = Math.sin(a), c = Math.cos(a), d = 1 + s*s; return new THREE.Vector3((r * c) / d, 0, (r * s * c) / d) }
      return new THREE.Vector3(Math.sin(a) * r, 0, Math.cos(a) * r)
    }

    // Build a detailed 3‑story mansion: central block + two wings, gabled roofs, porches, balcony rails, mullions
    function buildMansionEdges(): Float32Array {
      const out: number[] = []
      const y0 = 0.0, y1 = 1.15, y2 = 2.25, y3 = 3.35 // floor plates
      const roofCentral = 4.25, roofWing = 4.0

      // Blocks
      addStackedBlock(-2.0, 2.0, -1.2, 1.2, [y0, y1, y2, y3])       // central
      addStackedBlock(-3.8, -2.0, -1.4, 1.4, [y0, y1, y2, y3])     // left wing
      addStackedBlock(2.0, 3.8, -1.4, 1.4, [y0, y1, y2, y3])       // right wing

      // Entry porch (columns + roof frame)
      addPortico(-0.9, 0.9, 1.2, y0, y1, y1 + 0.55)

      // Balcony rail front (2nd story)
      addRailing(-1.5, 1.5, 1.2, y2 + 0.1, 'front')

      // Roofs (gabled along Z)
      addGabledRoof(-2.0, 2.0, -1.2, 1.2, y3, roofCentral, 'z')    // central
      addGabledRoof(-3.8, -2.0, -1.4, 1.4, y3, roofWing, 'z')      // left
      addGabledRoof(2.0, 3.8, -1.4, 1.4, y3, roofWing, 'z')        // right

      // Chimneys
      addChimney(-0.7, y3 + 0.25, 0.2)
      addChimney(0.8, y3 + 0.25, -0.25)

      // Door frame (front center)
      addDoor(-0.5, 0.5, 1.201, y0, y1 * 0.9)

      // Window mullions & frames on all faces (stories 1-3)
      addWindowFrames()

      return new Float32Array(out)

      // Edge helpers
      function pushEdge(ax:number, ay:number, az:number, bx:number, by:number, bz:number) {
        out.push(ax, ay, az, bx, by, bz)
      }
      function rect(minX:number, maxX:number, y:number, minZ:number, maxZ:number) {
        pushEdge(minX, y, minZ, maxX, y, minZ)
        pushEdge(maxX, y, minZ, maxX, y, maxZ)
        pushEdge(maxX, y, maxZ, minX, y, maxZ)
        pushEdge(minX, y, maxZ, minX, y, minZ)
      }
      function addStackedBlock(minX:number, maxX:number, minZ:number, maxZ:number, levels:number[]) {
        // Perimeter per level
        for (const y of levels) rect(minX, maxX, y, minZ, maxZ)
        // Vertical corners
        const corners: [number, number][] = [
          [minX, minZ],[maxX, minZ],[maxX, maxZ],[minX, maxZ]
        ]
        for (const [cx, cz] of corners) {
          for (let i=0;i<levels.length-1;i++) pushEdge(cx, levels[i], cz, cx, levels[i+1], cz)
        }
        // Vertical mullions: 3 per face
        const spanX = maxX - minX, spanZ = maxZ - minZ
        const yb = levels[0], yt = levels[levels.length-1]
        for (let t=1;t<=3;t++) {
          const x = minX + (spanX * t)/4
          pushEdge(x, yb, maxZ, x, yt, maxZ) // front
          pushEdge(x, yb, minZ, x, yt, minZ) // back
        }
        for (let t=1;t<=3;t++) {
          const z = minZ + (spanZ * t)/4
          pushEdge(minX, yb, z, minX, yt, z) // left
          pushEdge(maxX, yb, z, maxX, yt, z) // right
        }
      }
      function addGabledRoof(minX:number, maxX:number, minZ:number, maxZ:number, topY:number, apexY:number, ridgeAxis:'x'|'z') {
        // base top frame
        rect(minX, maxX, topY, minZ, maxZ)
        // ridge endpoints
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
        // ridge
        pushEdge(r1.x, r1.y, r1.z, r2.x, r2.y, r2.z)
        // rafters approximation
        const corners = [
          new THREE.Vector3(minX, topY, minZ), new THREE.Vector3(maxX, topY, minZ),
          new THREE.Vector3(maxX, topY, maxZ), new THREE.Vector3(minX, topY, maxZ),
        ]
        pushEdge(corners[0].x, corners[0].y, corners[0].z, r1.x, r1.y, r1.z)
        pushEdge(corners[1].x, corners[1].y, corners[1].z, r1.x, r1.y, r1.z)
        pushEdge(corners[2].x, corners[2].y, corners[2].z, r2.x, r2.y, r2.z)
        pushEdge(corners[3].x, corners[3].y, corners[3].z, r2.x, r2.y, r2.z)
      }
      function addChimney(x:number, y:number, z:number) {
        const w=0.22, d=0.22, h=0.7
        rect(x-w/2, x+w/2, y, z-d/2, z+d/2)
        rect(x-w/2, x+w/2, y+h, z-d/2, z+d/2)
        const pts: [number, number][] = [[x-w/2,z-d/2],[x+w/2,z-d/2],[x+w/2,z+d/2],[x-w/2,z+d/2]]
        for (const [cx,cz] of pts) pushEdge(cx,y,cz,cx,y+h,cz)
      }
      function addPortico(minX:number, maxX:number, zFront:number, yBase:number, yCap:number, yRoof:number) {
        // floor plate
        rect(minX, maxX, yBase+0.02, zFront-0.3, zFront+0.2)
        // roof plate
        rect(minX, maxX, yRoof, zFront-0.25, zFront+0.25)
        // columns (4)
        const cols = [
          [minX+0.1, zFront-0.22],[maxX-0.1, zFront-0.22],[minX+0.1, zFront+0.18],[maxX-0.1, zFront+0.18]
        ]
        for (const [cx, cz] of cols) {
          pushEdge(cx, yBase, cz, cx, yCap, cz)
          pushEdge(cx, yCap, cz, cx, yRoof, cz)
        }
      }
      function addRailing(minX:number, maxX:number, zFront:number, y:number, face:'front'|'back') {
        const z = face === 'front' ? zFront : -zFront
        // top and bottom rails
        pushEdge(minX, y, z, maxX, y, z)
        pushEdge(minX, y-0.1, z, maxX, y-0.1, z)
        // balusters
        for (let i=0;i<=12;i++) {
          const x = THREE.MathUtils.lerp(minX, maxX, i/12)
          pushEdge(x, y-0.1, z, x, y, z)
        }
      }
      function addDoor(minX:number, maxX:number, zFront:number, yb:number, yt:number) {
        pushEdge(minX, yb, zFront, minX, yt, zFront)
        pushEdge(maxX, yb, zFront, maxX, yt, zFront)
        pushEdge(minX, yt, zFront, maxX, yt, zFront)
      }
      function addWindowFrames() {
        const levels: [number, number, number][] = [
          [0.35, 0.75, 1],  // story 1: y bottom/top & rows
          [1.45, 1.9, 1],   // story 2
          [2.55, 3.0, 1],   // story 3
        ]
        // central front/back
        const cf = { minX:-2.0, maxX:2.0, minZ:-1.2, maxZ:1.2 }
        // wings
        const lw = { minX:-3.8, maxX:-2.0, minZ:-1.4, maxZ: 1.4 }
        const rw = { minX: 2.0, maxX: 3.8, minZ:-1.4, maxZ: 1.4 }

        const faces = [
          { side:'front', minX:cf.minX, maxX:cf.maxX, z:cf.maxZ },
          { side:'back',  minX:cf.minX, maxX:cf.maxX, z:cf.minZ },
          { side:'front', minX:lw.minX, maxX:lw.maxX, z:lw.maxZ },
          { side:'back',  minX:lw.minX, maxX:lw.maxX, z:lw.minZ },
          { side:'front', minX:rw.minX, maxX:rw.maxX, z:rw.maxZ },
          { side:'back',  minX:rw.minX, maxX:rw.maxX, z:rw.minZ },
        ] as const

        for (const face of faces) {
          for (const [yb, yt] of levels) {
            const cols = 6
            for (let c=0;c<cols;c++) {
              const pad = 0.15
              const x0 = THREE.MathUtils.lerp(face.minX+pad, face.maxX-pad, (c+0.1)/cols)
              const x1 = THREE.MathUtils.lerp(face.minX+pad, face.maxX-pad, (c+0.9)/cols)
              // frame
              pushEdge(x0, yb, face.z, x1, yb, face.z)
              pushEdge(x1, yb, face.z, x1, yt, face.z)
              pushEdge(x1, yt, face.z, x0, yt, face.z)
              pushEdge(x0, yt, face.z, x0, yb, face.z)
              // mullion (vertical)
              const xm = (x0+x1)/2
              pushEdge(xm, yb, face.z, xm, yt, face.z)
              // transom (horizontal)
              const ym = (yb+yt)/2
              pushEdge(x0, ym, face.z, x1, ym, face.z)
            }
          }
        }

        // Side faces (left/right)
        const sides = [
          { x:-2.0, minZ:-1.2, maxZ:1.2, dir:-1 },
          { x: 2.0, minZ:-1.2, maxZ:1.2, dir: 1 }
        ]
        for (const s of sides) {
          for (const [yb, yt] of levels) {
            const rows = 4
            for (let i=0;i<rows;i++) {
              const z0 = THREE.MathUtils.lerp(s.minZ+0.1, s.maxZ-0.1, (i+0.1)/rows)
              const z1 = THREE.MathUtils.lerp(s.minZ+0.1, s.maxZ-0.1, (i+0.9)/rows)
              // frame
              pushEdge(s.x, yb, z0, s.x, yb, z1)
              pushEdge(s.x, yb, z1, s.x, yt, z1)
              pushEdge(s.x, yt, z1, s.x, yt, z0)
              pushEdge(s.x, yt, z0, s.x, yb, z0)
              // mullion/transom
              const zm = (z0+z1)/2
              pushEdge(s.x, yb, zm, s.x, yt, zm)
              const ym = (yb+yt)/2
              pushEdge(s.x, ym, z0, s.x, ym, z1)
            }
          }
        }
      }
    }

    // Generate visible window planes to flicker/glow (aligns roughly with frames)
    function addMansionWindows(add: (p: THREE.Vector3, out: THREE.Vector3) => void) {
      const storyY = [0.55, 1.65, 2.75]
      const central = { minX:-1.8, maxX:1.8, minZ:-1.1, maxZ:1.1 }
      const L = { minX:-3.6, maxX:-2.2, minZ:-1.25, maxZ:1.25 }
      const R = { minX: 2.2, maxX: 3.6, minZ:-1.25, maxZ:1.25 }

      const addFaceWindows = (minX:number, maxX:number, z:number, outward:THREE.Vector3, cols:number) => {
        for (const y of storyY) {
          for (let i=0;i<cols;i++) {
            const x = THREE.MathUtils.lerp(minX+0.2, maxX-0.2, (i+0.5)/cols)
            add(new THREE.Vector3(x, y, z), outward)
          }
        }
      }

      // central front/back
      addFaceWindows(central.minX, central.maxX, central.maxZ+0.001, new THREE.Vector3(0,0, 1), 6)
      addFaceWindows(central.minX, central.maxX, central.minZ-0.001, new THREE.Vector3(0,0,-1), 6)
      // wings front/back
      addFaceWindows(L.minX, L.maxX, L.maxZ+0.001, new THREE.Vector3(0,0, 1), 4)
      addFaceWindows(L.minX, L.maxX, L.minZ-0.001, new THREE.Vector3(0,0,-1), 4)
      addFaceWindows(R.minX, R.maxX, R.maxZ+0.001, new THREE.Vector3(0,0, 1), 4)
      addFaceWindows(R.minX, R.maxX, R.minZ-0.001, new THREE.Vector3(0,0,-1), 4)

      // sides
      const sideCols = 4
      for (const y of storyY) {
        for (let i=0;i<sideCols;i++) {
          const zC = THREE.MathUtils.lerp(central.minZ+0.1, central.maxZ-0.1, (i+0.5)/sideCols)
          add(new THREE.Vector3(-2.001, y, zC), new THREE.Vector3(-1,0,0))
          add(new THREE.Vector3( 2.001, y, zC), new THREE.Vector3( 1,0,0))
        }
      }
    }
  }, [quality.renderScale, quality.bloom, accessibility.epilepsySafe, settings])

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} aria-label="Wireframe House 3D" />
}
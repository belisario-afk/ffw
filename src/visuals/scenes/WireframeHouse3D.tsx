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

// Detailed 3‑story small mansion wireframe + album cover floor
export default function WireframeHouse3D({ quality, accessibility, settings }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (!canvasRef.current) return

    // Scene & camera
    const scene = new THREE.Scene()
    scene.background = null
    const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 250)
    camera.position.set(0, 3.2, 14)
    camera.lookAt(0, 2.0, 0)

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

    // Palette from CSS
    const cssColor = (name: string, fallback: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
    const accent = new THREE.Color(cssColor('--accent', '#00f0ff'))
    const accent2 = new THREE.Color(cssColor('--accent-2', '#ff00f0'))

    // Subtle world fog for depth
    scene.fog = new THREE.Fog(new THREE.Color('#06080a'), 60, 180)

    // Grid
    const grid = new THREE.GridHelper(160, 160, accent2.clone().multiplyScalar(0.35), accent2.clone().multiplyScalar(0.12))
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.08
    grid.position.y = 0
    scene.add(grid)

    // Album floor (current album cover)
    const floorSize = 22
    const floorGeom = new THREE.PlaneGeometry(floorSize, floorSize)
    const floorMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: undefined,
      transparent: true,
      opacity: 1.0,
      depthWrite: false
    })
    const floorMesh = new THREE.Mesh(floorGeom, floorMat)
    floorMesh.rotation.x = -Math.PI / 2
    floorMesh.position.y = 0.001
    scene.add(floorMesh)

    // Mansion edges
    const mansionPositions = buildMansionEdges()
    const fatGeo = new LineSegmentsGeometry()
    fatGeo.setPositions(mansionPositions)
    // Ensure bounds (rare drivers)
    ;(fatGeo as any).computeBoundingBox?.()
    ;(fatGeo as any).computeBoundingSphere?.()

    // Fat line material (screen-space px)
    const fatMat = new LineMaterial({
      color: accent.getHex(),
      transparent: true,
      opacity: 0.98,
      depthTest: true
    })
    // Important: screen-space units
    ;(fatMat as any).worldUnits = false
    const setLinePixels = (px: number) => {
      const draw = renderer.getDrawingBufferSize(new THREE.Vector2())
      fatMat.linewidth = Math.max(0.0009, px / Math.max(1, draw.y)) // px -> normalized
      fatMat.needsUpdate = true
    }
    {
      const draw = renderer.getDrawingBufferSize(new THREE.Vector2())
      fatMat.resolution.set(draw.x, draw.y)
      setLinePixels((settings?.lineWidthPx ?? 2.5))
    }

    const fatLines = new LineSegments2(fatGeo, fatMat)
    scene.add(fatLines)

    // Thin-lines fallback (auto toggled if fat-lines misbehave)
    const thinGeo = new THREE.BufferGeometry()
    thinGeo.setAttribute('position', new THREE.BufferAttribute(mansionPositions, 3))
    const thinMat = new THREE.LineBasicMaterial({ color: accent.getHex(), transparent: true, opacity: 0.98, depthTest: true })
    const thinLines = new THREE.LineSegments(thinGeo, thinMat)
    thinLines.visible = false
    scene.add(thinLines)

    // Windows (emissive planes that flicker)
    const windowGroup = new THREE.Group()
    {
      const winGeom = new THREE.PlaneGeometry(0.22, 0.16)
      const addWindow = (p: THREE.Vector3, out: THREE.Vector3) => {
        const m = new THREE.MeshBasicMaterial({ color: accent2, transparent: true, opacity: 0 })
        const mesh = new THREE.Mesh(winGeom, m)
        mesh.position.copy(p)
        mesh.lookAt(p.clone().add(out))
        windowGroup.add(mesh)
      }
      addMansionWindows(addWindow)
      scene.add(windowGroup)
    }

    // Soft haze sheet
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

    // Album cover (poll)
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
    const offFrame = reactivityBus.on('frame', f => { latest = f })

    // Camera path
    type Path = 'Circle' | 'Ellipse' | 'Lemniscate' | 'Manual'
    const path: Path = (settings.path || 'Circle') as Path
    let angle = 0

    // Resize
    const updateSizes = () => {
      const draw = renderer.getDrawingBufferSize(new THREE.Vector2())
      const view = renderer.getSize(new THREE.Vector2())
      camera.aspect = view.x / Math.max(1, view.y)
      camera.updateProjectionMatrix()
      comp.onResize()
      fatMat.resolution.set(draw.x, draw.y)
      setLinePixels((settings?.lineWidthPx ?? 2.5))
    }
    window.addEventListener('resize', updateSizes)
    updateSizes()

    // Simple “is rendering” watchdog: if fat-lines produce degenerate output, fall back
    let frames = 0
    let fallbackArmed = false

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

      // Tint + width
      const mixed = new THREE.Color().copy(accent).lerp(accent2, THREE.MathUtils.clamp(high * 0.9, 0, 1))
      fatMat.color.set(mixed)
      thinMat.color.set(mixed)
      const px = (settings?.lineWidthPx ?? 2.5) * (latest?.beat ? 1.4 : 1.0)
      setLinePixels(px)

      // Windows flicker
      windowGroup.children.forEach((m, i) => {
        const mat = (m as THREE.Mesh).material as THREE.MeshBasicMaterial
        const flicker = 0.06 + 0.9 * mid * Math.abs(Math.sin((clock.elapsedTime + i * 0.19) * (3.6 + (i % 5))))
        mat.opacity = THREE.MathUtils.clamp(flicker, 0, 1)
        ;(mat.color as THREE.Color).copy(accent2)
      })

      // Haze
      const fz = fogSheet.material as THREE.ShaderMaterial
      fz.uniforms.uTime.value = clock.elapsedTime
      fz.uniforms.uIntensity.value = THREE.MathUtils.clamp(0.22 + loud * 0.8 + (latest?.beat ? 0.55 : 0), 0, accessibility.epilepsySafe ? 0.6 : 1.0)
      ;(fz.uniforms.uColor.value as THREE.Color).copy(new THREE.Color().copy(accent2).lerp(accent, 0.45))

      // Camera motion
      const baseSpeed = (settings.orbitSpeed ?? 0.5) * (stale ? 0.15 : 1.0)
      angle += dt * (baseSpeed + low * 1.0 + (latest?.beatStrength ?? 0) * 1.3)
      const radius = THREE.MathUtils.clamp((settings.orbitRadius ?? 8.0) + Math.sin((latest?.phases.bar ?? 0) * Math.PI * 2) * 0.25, 5.0, 13.0)
      const elev = (settings.orbitElev ?? 0.08)
      const pos = pathPoint(path, angle, radius)
      camera.position.set(pos.x, Math.sin(elev) * (radius * 0.6) + 2.6 + (settings.camBob || 0) * (0.0 + low * 0.35), pos.z)
      camera.lookAt(0, 2.2, 0)

      // Budget on stale
      const budgetScale = stale ? 0.6 : 1.0
      ;(grid.material as THREE.Material).opacity = 0.08 * budgetScale

      comp.composer.render()

      // Fallback if we keep seeing only a degenerate line (heuristic: few fragments)
      frames++
      if (!fallbackArmed && frames > 10) {
        // If canvas alpha histogram is too empty, we fall back (approximate via WebGL info draw calls)
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
      cancelAnimationFrame(raf)
      clearInterval(albumIv)
      window.removeEventListener('resize', updateSizes)
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
      if (path === 'Ellipse') return new THREE.Vector3(Math.sin(a) * r * 1.2, 0, Math.cos(a) * r * 0.85)
      if (path === 'Lemniscate') { const s = Math.sin(a), c = Math.cos(a), d = 1 + s*s; return new THREE.Vector3((r * c) / d, 0, (r * s * c) / d) }
      return new THREE.Vector3(Math.sin(a) * r, 0, Math.cos(a) * r)
    }

    // Mansion edges generator
    function buildMansionEdges(): Float32Array {
      const out: number[] = []
      const y0 = 0.0, y1 = 1.2, y2 = 2.35, y3 = 3.5 // floors
      const roofC = 4.5, roofW = 4.2

      // Blocks (central + two wings)
      addStackedBlock(-2.2, 2.2, -1.3, 1.3, [y0, y1, y2, y3])       // central
      addStackedBlock(-4.2, -2.2, -1.6, 1.6, [y0, y1, y2, y3])     // left wing
      addStackedBlock(2.2, 4.2, -1.6, 1.6, [y0, y1, y2, y3])       // right wing

      // Portico (front)
      addPortico(-1.0, 1.0, 1.3, y0, y1 * 0.85, y1 + 0.6)

      // Central balcony rail (2nd story)
      addRailing(-1.7, 1.7, 1.3, y2 + 0.12)

      // Gabled roofs
      addGabledRoof(-2.2, 2.2, -1.3, 1.3, y3, roofC, 'z')       // central
      addGabledRoof(-4.2, -2.2, -1.6, 1.6, y3, roofW, 'z')      // left
      addGabledRoof(2.2, 4.2, -1.6, 1.6, y3, roofW, 'z')        // right

      // Chimneys
      addChimney(-0.8, y3 + 0.25, 0.2)
      addChimney(0.9, y3 + 0.25, -0.25)

      // Front door
      addDoor(-0.55, 0.55, 1.301, y0, y1 * 0.88)

      // Window frames (all faces, all stories)
      addWindowFrames()

      return new Float32Array(out)

      // Edge helpers
      function E(ax:number, ay:number, az:number, bx:number, by:number, bz:number) {
        out.push(ax, ay, az, bx, by, bz)
      }
      function rect(minX:number, maxX:number, y:number, minZ:number, maxZ:number) {
        E(minX, y, minZ, maxX, y, minZ)
        E(maxX, y, minZ, maxX, y, maxZ)
        E(maxX, y, maxZ, minX, y, maxZ)
        E(minX, y, maxZ, minX, y, minZ)
      }
      function addStackedBlock(minX:number, maxX:number, minZ:number, maxZ:number, levels:number[]) {
        for (const y of levels) rect(minX, maxX, y, minZ, maxZ)
        const corners: [number, number][] = [
          [minX, minZ],[maxX, minZ],[maxX, maxZ],[minX, maxZ]
        ]
        for (const [cx, cz] of corners) {
          for (let i=0;i<levels.length-1;i++) E(cx, levels[i], cz, cx, levels[i+1], cz)
        }
        // Face mullions (3 per face)
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
        const cols = [
          [minX+0.1, zFront-0.22],[maxX-0.1, zFront-0.22],[minX+0.1, zFront+0.18],[maxX-0.1, zFront+0.18]
        ]
        for (const [cx, cz] of cols) {
          E(cx, yBase, cz, cx, yCap, cz)
          E(cx, yCap, cz, cx, yRoof, cz)
        }
      }
      function addRailing(minX:number, maxX:number, zFront:number, y:number) {
        E(minX, y, zFront, maxX, y, zFront)
        E(minX, y-0.1, zFront, maxX, y-0.1, zFront)
        for (let i=0;i<=14;i++) {
          const x = THREE.MathUtils.lerp(minX, maxX, i/14)
          E(x, y-0.1, zFront, x, y, zFront)
        }
      }
      function addDoor(minX:number, maxX:number, zFront:number, yb:number, yt:number) {
        E(minX, yb, zFront, minX, yt, zFront)
        E(maxX, yb, zFront, maxX, yt, zFront)
        E(minX, yt, zFront, maxX, yt, zFront)
      }
      function addWindowFrames() {
        const levels: [number, number][] = [
          [0.4, 0.95],  // story 1
          [1.55, 2.1],  // story 2
          [2.65, 3.2],  // story 3
        ]
        const CF = { minX:-2.2, maxX:2.2, minZ:-1.3, maxZ:1.3 }
        const LW = { minX:-4.2, maxX:-2.2, minZ:-1.6, maxZ:1.6 }
        const RW = { minX: 2.2, maxX: 4.2, minZ:-1.6, maxZ:1.6 }
        const faces = [
          { minX: CF.minX, maxX: CF.maxX, z: CF.maxZ }, // central front
          { minX: CF.minX, maxX: CF.maxX, z: CF.minZ }, // central back
          { minX: LW.minX, maxX: LW.maxX, z: LW.maxZ }, // left front
          { minX: LW.minX, maxX: LW.maxX, z: LW.minZ }, // left back
          { minX: RW.minX, maxX: RW.maxX, z: RW.maxZ }, // right front
          { minX: RW.minX, maxX: RW.maxX, z: RW.minZ }, // right back
        ]
        for (const f of faces) {
          for (const [yb, yt] of levels) {
            const cols = 6
            for (let c=0;c<cols;c++) {
              const pad = 0.18
              const x0 = THREE.MathUtils.lerp(f.minX+pad, f.maxX-pad, (c+0.1)/cols)
              const x1 = THREE.MathUtils.lerp(f.minX+pad, f.maxX-pad, (c+0.9)/cols)
              // frame
              E(x0, yb, f.z, x1, yb, f.z)
              E(x1, yb, f.z, x1, yt, f.z)
              E(x1, yt, f.z, x0, yt, f.z)
              E(x0, yt, f.z, x0, yb, f.z)
              // mullion + transom
              const xm = (x0+x1)/2, ym = (yb+yt)/2
              E(xm, yb, f.z, xm, yt, f.z)
              E(x0, ym, f.z, x1, ym, f.z)
            }
          }
        }
        // Side faces
        const sides = [
          { x:-2.2, minZ:CF.minZ, maxZ:CF.maxZ },
          { x: 2.2, minZ:CF.minZ, maxZ:CF.maxZ }
        ]
        for (const s of sides) {
          for (const [yb, yt] of levels) {
            const rows = 5
            for (let i=0;i<rows;i++) {
              const z0 = THREE.MathUtils.lerp(s.minZ+0.12, s.maxZ-0.12, (i+0.15)/rows)
              const z1 = THREE.MathUtils.lerp(s.minZ+0.12, s.maxZ-0.12, (i+0.85)/rows)
              E(s.x, yb, z0, s.x, yb, z1)
              E(s.x, yb, z1, s.x, yt, z1)
              E(s.x, yt, z1, s.x, yt, z0)
              E(s.x, yt, z0, s.x, yb, z0)
              const zm = (z0+z1)/2, ym = (yb+yt)/2
              E(s.x, yb, zm, s.x, yt, zm)
              E(s.x, ym, z0, s.x, ym, z1)
            }
          }
        }
      }
    }

    // Window planes (visual glow) aligned to frames, for flicker
    function addMansionWindows(add: (p: THREE.Vector3, out: THREE.Vector3) => void) {
      const storyY = [0.6, 1.7, 2.8]
      const CF = { minX:-2.0, maxX:2.0, minZ:-1.2, maxZ:1.2 }
      const LW = { minX:-4.0, maxX:-2.2, minZ:-1.4, maxZ:1.4 }
      const RW = { minX: 2.2, maxX: 4.0, minZ:-1.4, maxZ:1.4 }
      const addFace = (minX:number, maxX:number, z:number, out:THREE.Vector3, cols:number) => {
        for (const y of storyY) {
          for (let i=0;i<cols;i++) {
            const x = THREE.MathUtils.lerp(minX+0.22, maxX-0.22, (i+0.5)/cols)
            add(new THREE.Vector3(x, y, z), out)
          }
        }
      }
      addFace(CF.minX, CF.maxX, CF.maxZ+0.001, new THREE.Vector3(0,0, 1), 6)
      addFace(CF.minX, CF.maxX, CF.minZ-0.001, new THREE.Vector3(0,0,-1), 6)
      addFace(LW.minX, LW.maxX, LW.maxZ+0.001, new THREE.Vector3(0,0, 1), 4)
      addFace(LW.minX, LW.maxX, LW.minZ-0.001, new THREE.Vector3(0,0,-1), 4)
      addFace(RW.minX, RW.maxX, RW.maxZ+0.001, new THREE.Vector3(0,0, 1), 4)
      addFace(RW.minX, RW.maxX, RW.minZ-0.001, new THREE.Vector3(0,0,-1), 4)
      // sides
      for (const y of storyY) {
        for (let i=0;i<4;i++) {
          const z = THREE.MathUtils.lerp(CF.minZ+0.1, CF.maxZ-0.1, (i+0.5)/4)
          add(new THREE.Vector3(-2.201, y, z), new THREE.Vector3(-1,0,0))
          add(new THREE.Vector3( 2.201, y, z), new THREE.Vector3( 1,0,0))
        }
      }
    }
  }, [quality.renderScale, quality.bloom, accessibility.epilepsySafe, settings])

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} aria-label="Wireframe House 3D" />
}
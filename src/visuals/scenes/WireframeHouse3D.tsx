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

type Edge = [THREE.Vector3, THREE.Vector3]

export default function WireframeHouse3D({ quality, accessibility, settings }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (!canvasRef.current) return

    // Scene + camera
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 300)
    camera.position.set(0, 1.9, 8)

    // Renderer + composer
    const { renderer, dispose: disposeRenderer } = createRenderer(canvasRef.current, quality.renderScale)
    const comp = createComposer(renderer, scene, camera, {
      bloom: quality.bloom,
      bloomStrength: 0.9,
      bloomRadius: 0.35,
      bloomThreshold: 0.24,
      fxaa: true,
      vignette: true,
      vignetteStrength: 0.5,
      filmGrain: true,
      filmGrainStrength: 0.25
    })

    // CSS palette
    const cssColor = (name: string, fallback: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
    const accent = new THREE.Color(cssColor('--accent', '#00f0ff'))
    const accent2 = new THREE.Color(cssColor('--accent-2', '#ff00f0'))

    // Starfield "outer space" backdrop
    const stars = (() => {
      const COUNT = 2000
      const g = new THREE.BufferGeometry()
      const pos = new Float32Array(COUNT * 3)
      for (let i = 0; i < COUNT; i++) {
        const x = (Math.random() - 0.5) * 120
        const y = Math.random() * 30 + 1.5
        const z = -15 - Math.random() * 120
        pos[i * 3 + 0] = x
        pos[i * 3 + 1] = y
        pos[i * 3 + 2] = z
      }
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      const m = new THREE.PointsMaterial({
        color: 0xffffff,
        size: 1.0, // in pixels when sizeAttenuation=false
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending
      })
      const pts = new THREE.Points(g, m)
      pts.renderOrder = -20 // draw first
      scene.add(pts)
      return pts
    })()

    // Ground plane with current album cover
    const albumGroup = new THREE.Group()
    const albumPlane = (() => {
      const geom = new THREE.PlaneGeometry(18, 18, 1, 1)
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92 })
      const mesh = new THREE.Mesh(geom, mat)
      mesh.rotation.x = -Math.PI / 2
      mesh.position.set(0, 0.001, 0)
      albumGroup.add(mesh)
      scene.add(albumGroup)
      return mesh
    })()

    // Glow grid over the album floor (subtle)
    const grid = new THREE.GridHelper(36, 36, accent.clone().multiplyScalar(0.55), accent.clone().multiplyScalar(0.28))
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.16
    grid.position.y = 0.002
    scene.add(grid)

    // 3‑story detailed wireframe house using fat lines
    const edges3 = build3StoryHouseEdges()
    const lineGeo = new LineSegmentsGeometry()
    {
      const arr = new Float32Array(edges3.length * 6)
      for (let i = 0; i < edges3.length; i++) {
        const e = edges3[i]
        arr.set([e[0].x, e[0].y, e[0].z, e[1].x, e[1].y, e[1].z], i * 6)
      }
      lineGeo.setPositions(arr)
    }

    const lineMat = new LineMaterial({
      color: accent.getHex(),
      // LineMaterial uses pixel units — make it clearly visible
      linewidth: Math.max(2.5, Math.min(6, (settings.lineWidth || 2) * 2.4)),
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

    // Emissive windows across 3 floors on all faces
    const windowGroup = new THREE.Group()
    {
      const winGeom = new THREE.PlaneGeometry(0.18, 0.12)
      const positions = build3StoryWindowPositions()
      for (const p of positions) {
        const m = new THREE.MeshBasicMaterial({ color: accent2.clone(), transparent: true, opacity: 0 })
        const mesh = new THREE.Mesh(winGeom, m)
        mesh.position.copy(p)
        // Face outward from center on each side
        const outward = new THREE.Vector3(p.x, p.y, p.z).setLength(Math.max(Math.abs(p.z), Math.abs(p.x)) + 1).setY(p.y)
        mesh.lookAt(outward)
        windowGroup.add(mesh)
      }
      scene.add(windowGroup)
    }

    // OUTER BACKDROP REACTIVE BARS (arc wall far behind, like outer space)
    const backdropBars = (() => {
      const count = 96
      const arcSpan = THREE.MathUtils.degToRad(150) // wide arc
      const radius = 28 // far away
      const baseY = 0.2
      const geom = new THREE.BoxGeometry(0.22, 1, 0.12)
      const mat = new THREE.MeshBasicMaterial({
        color: accent2.clone(),
        transparent: true,
        opacity: 0.9,
        depthWrite: true,
        depthTest: true,
        blending: THREE.AdditiveBlending
      })
      const mesh = new THREE.InstancedMesh(geom, mat, count)
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.renderOrder = -10 // render early (behind)
      scene.add(mesh)
      return { mesh, count, arcSpan, radius, baseY, values: new Float32Array(count).fill(0) }
    })()

    // Lasers (additive planes) around house
    const beamGroup = new THREE.Group()
    {
      const beamGeom = new THREE.PlaneGeometry(0.05, 4)
      for (let i = 0; i < 12; i++) {
        const mat = new THREE.MeshBasicMaterial({
          color: accent2,
          transparent: true,
          opacity: 0.0,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        })
        const beam = new THREE.Mesh(beamGeom, mat)
        beam.position.set(0, 1.6, 0)
        beam.rotation.y = (i / 12) * Math.PI * 2
        beamGroup.add(beam)
      }
      scene.add(beamGroup)
    }

    // NOTE: Removed fog sheet ("weird screen behind the house") as requested.

    // Reactive state
    let latest: ReactiveFrame | null = null
    const offFrame = reactivityBus.on('frame', (f) => { latest = f })
    const offBeat = reactivityBus.on('beat', () => { beatPulse = 1 })
    const offBar = reactivityBus.on('bar', () => { barPulse = 1 })

    // Camera path
    type Path = 'Circle' | 'Ellipse' | 'Lemniscate' | 'Manual'
    const path: Path = (settings.path || 'Circle') as Path
    let angle = 0

    // Album cover loader to floor
    let currentTrackId: string | null = null
    const texLoader = new THREE.TextureLoader()
    texLoader.crossOrigin = 'anonymous'
    const maxAniso = renderer.capabilities.getMaxAnisotropy()
    async function loadAlbumToFloor() {
      const s = await getPlaybackState().catch(() => null as any)
      const id = s?.item?.id || null
      const url = (s?.item?.album?.images?.[0]?.url as string) || null
      if (!id || !url) return
      if (id === currentTrackId) return
      currentTrackId = id
      try {
        const blobUrl = await cacheAlbumArt(url).catch(() => url)
        texLoader.load(blobUrl, (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace
          tex.anisotropy = maxAniso
          const mat = albumPlane.material as THREE.MeshBasicMaterial
          mat.map?.dispose?.()
          mat.map = tex
          mat.needsUpdate = true
        })
      } catch {}
    }
    loadAlbumToFloor()
    const albumIv = window.setInterval(loadAlbumToFloor, 5000)

    // Size/line resolution updates
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

    // Animation loop
    const clock = new THREE.Clock()
    let raf = 0
    let beatPulse = 0
    let barPulse = 0

    const tmpMat = new THREE.Matrix4()
    const tmpQuat = new THREE.Quaternion()
    const tmpPos = new THREE.Vector3()
    const tmpScale = new THREE.Vector3()

    const animate = () => {
      raf = requestAnimationFrame(animate)
      const dt = Math.min(0.05, clock.getDelta())
      const now = performance.now()
      const stale = !latest || (now - (latest.t || 0)) > 220

      const low = latest?.bands.low ?? 0.15
      const mid = latest?.bands.mid ?? 0.15
      const high = latest?.bands.high ?? 0.15
      const loud = latest?.loudness ?? 0.2

      // Accent mix + beat line width pulse
      const mixed = new THREE.Color().copy(accent).lerp(accent2, THREE.MathUtils.clamp(high * 0.9, 0, 1))
      lineMat.color = mixed
      const basePx = Math.max(2.5, Math.min(6, (settings.lineWidth || 2) * 2.4))
      const pulse = beatPulse > 0 ? (1 + 0.55 * beatPulse) : 1
      lineMat.linewidth = basePx * pulse
      lineMat.needsUpdate = true

      // Windows flicker (mid)
      windowGroup.children.forEach((m, i) => {
        const mat = (m as THREE.Mesh).material as THREE.MeshBasicMaterial
        const flicker = 0.12 + 0.88 * mid * Math.abs(Math.sin((clock.elapsedTime + i * 0.13) * (4.5 + (i % 7))))
        mat.opacity = THREE.MathUtils.clamp(flicker, 0, 1)
        ;(mat.color as THREE.Color).copy(new THREE.Color().copy(accent2).lerp(accent, high * 0.25))
      })

      // Beams spin and brightness (high)
      beamGroup.rotation.y += dt * (0.35 + high * 2.8)
      beamGroup.children.forEach((b) => {
        const m = (b as THREE.Mesh).material as THREE.MeshBasicMaterial
        m.opacity = THREE.MathUtils.clamp(0.05 + high * 0.9, 0, 1)
      })

      // Reactive outer backdrop bars (far arc wall)
      {
        const { mesh, count, arcSpan, radius, baseY, values } = backdropBars
        const energy = 0.25 * low + 0.35 * mid + 0.4 * high
        for (let i = 0; i < count; i++) {
          const t = i / (count - 1)
          const ang = (t - 0.5) * arcSpan
          const noise = 0.5 * (1 + Math.sin(clock.elapsedTime * (1.2 + high * 2.0) + i * 0.37) * Math.cos(i * 0.11))
          const targetH = 0.15 + (3.2 + 2.0 * (barPulse > 0 ? barPulse : 0)) * energy * (0.65 + 0.35 * noise)
          values[i] += (targetH - values[i]) * 0.18

          const h = Math.max(0.05, values[i])
          tmpPos.set(Math.sin(ang) * radius, baseY + h * 0.5, -Math.cos(ang) * radius - 4)
          tmpQuat.setFromEuler(new THREE.Euler(0, ang, 0))
          tmpScale.set(0.22, h, 0.12)
          tmpMat.compose(tmpPos, tmpQuat, tmpScale)
          mesh.setMatrixAt(i, tmpMat)
        }
        mesh.instanceMatrix.needsUpdate = true
        const mat = mesh.material as THREE.MeshBasicMaterial
        mat.color.copy(new THREE.Color().copy(accent2).lerp(accent, THREE.MathUtils.clamp(high * 0.6, 0, 1)))
        mat.opacity = 0.7 + 0.2 * loud
      }

      // Album plane subtle pulsation on bar
      albumGroup.scale.setScalar(1 + 0.025 * (barPulse > 0 ? barPulse : 0))
      ;(grid.material as THREE.Material).opacity = (stale ? 0.12 : 0.16)

      // Camera motion
      const baseSpeed = (settings.orbitSpeed ?? 0.6) * (stale ? 0.15 : 1.0)
      angle += dt * (baseSpeed + low * 1.1 + (latest?.beatStrength ?? 0) * 1.3)
      const radiusCam = THREE.MathUtils.clamp((settings.orbitRadius ?? 6.2) + Math.sin((latest?.phases.bar ?? 0) * Math.PI * 2) * 0.2, 3.8, 9.0)
      const elev = (settings.orbitElev ?? 0.04)
      const pos = pathPoint(path, angle, radiusCam)
      const bob = (settings.camBob || 0.15) * (0.1 + low * 0.35)
      camera.position.set(pos.x, Math.sin(elev) * (radiusCam * 0.45) + 1.6 + bob * Math.sin(clock.elapsedTime * 1.6), pos.z)
      camera.lookAt(0, 1.4, 0)

      // decay pulses
      beatPulse *= accessibility.epilepsySafe ? 0.85 : 0.9
      barPulse *= 0.93

      // Render
      comp.composer.render()
    }

    animate()

    return () => {
      cancelAnimationFrame(raf)
      offFrame?.(); offBeat?.(); offBar?.()
      window.removeEventListener('resize', updateSizes)
      clearInterval(albumIv)
      scene.traverse(obj => {
        const any = obj as any
        if (any.geometry?.dispose) any.geometry.dispose()
        if (any.material) {
          if (Array.isArray(any.material)) any.material.forEach((m: any) => m?.dispose?.())
          else any.material?.dispose?.()
        }
        if (any.texture?.dispose) any.texture.dispose?.()
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

    function build3StoryHouseEdges(): Edge[] {
      // Dimensions
      const W = 2.2 // half width footprint
      const D = 1.4 // half depth
      const H = 0.9 // floor height
      const roofH = 1.0
      const y0 = 0
      const y1 = y0 + H
      const y2 = y1 + H
      const y3 = y2 + H
      const apexY = y3 + roofH

      // Corner columns each floor
      const corners = (y: number) => ([
        new THREE.Vector3(-W, y, -D), new THREE.Vector3(W, y, -D),
        new THREE.Vector3(W, y, D), new THREE.Vector3(-W, y, D)
      ])

      const e: Edge[] = []
      // Base rectangles per floor
      const floors = [y0, y1, y2, y3]
      for (let i = 0; i < floors.length; i++) {
        const c = corners(floors[i])
        e.push([c[0], c[1]],[c[1], c[2]],[c[2], c[3]],[c[3], c[0]])
        if (i < floors.length - 1) {
          const cUp = corners(floors[i+1])
          // vertical edges
          for (let k = 0; k < 4; k++) e.push([c[k], cUp[k]])
        }
      }
      // Mid-span horizontals for structural detail
      const addMidSpan = (y: number, inset = 0) => {
        e.push(
          [new THREE.Vector3(-W+inset, y, -D), new THREE.Vector3(W-inset, y, -D)],
          [new THREE.Vector3(-W+inset, y, D), new THREE.Vector3(W-inset, y, D)],
          [new THREE.Vector3(-W, y, -D+inset), new THREE.Vector3(-W, y, D-inset)],
          [new THREE.Vector3(W, y, -D+inset), new THREE.Vector3(W, y, D-inset)],
        )
      }
      addMidSpan((y0+y1)/2, 0.05)
      addMidSpan((y1+y2)/2, 0.05)
      addMidSpan((y2+y3)/2, 0.05)

      // Front door frame (front face z=+D) on ground floor
      const doorW = 0.5, doorH = 0.65
      const doorY0 = y0, doorY1 = y0 + doorH
      const doorX0 = -doorW/2, doorX1 = doorW/2
      e.push(
        [new THREE.Vector3(doorX0, doorY0, D+0.001), new THREE.Vector3(doorX1, doorY0, D+0.001)],
        [new THREE.Vector3(doorX0, doorY0, D+0.001), new THREE.Vector3(doorX0, doorY1, D+0.001)],
        [new THREE.Vector3(doorX1, doorY0, D+0.001), new THREE.Vector3(doorX1, doorY1, D+0.001)],
        [new THREE.Vector3(doorX0, doorY1, D+0.001), new THREE.Vector3(doorX1, doorY1, D+0.001)],
      )

      // Roof (gable front/back)
      const ridge = new THREE.Vector3(0, apexY, 0)
      const eavesFrontL = new THREE.Vector3(-W, y3, D)
      const eavesFrontR = new THREE.Vector3(W, y3, D)
      const eavesBackL = new THREE.Vector3(-W, y3, -D)
      const eavesBackR = new THREE.Vector3(W, y3, -D)
      e.push(
        [eavesFrontL, ridge],[eavesFrontR, ridge],[eavesBackL, ridge],[eavesBackR, ridge],
        [eavesFrontL, eavesFrontR],[eavesBackL, eavesBackR],
        [eavesFrontL, eavesBackL],[eavesFrontR, eavesBackR]
      )

      // Chimney
      const chX0 = -W*0.45, chZ0 = 0.2
      const chW = 0.25, chD = 0.18
      const chY0 = y3 + 0.2, chY1 = chY0 + 0.6
      const ch = [
        new THREE.Vector3(chX0, chY0, chZ0),
        new THREE.Vector3(chX0+chW, chY0, chZ0),
        new THREE.Vector3(chX0+chW, chY0, chZ0+chD),
        new THREE.Vector3(chX0, chY0, chZ0+chD),
        new THREE.Vector3(chX0, chY1, chZ0),
        new THREE.Vector3(chX0+chW, chY1, chZ0),
        new THREE.Vector3(chX0+chW, chY1, chZ0+chD),
        new THREE.Vector3(chX0, chY1, chZ0+chD)
      ]
      const idx: [number, number][] = [
        [0,1],[1,2],[2,3],[3,0],
        [4,5],[5,6],[6,7],[7,4],
        [0,4],[1,5],[2,6],[3,7]
      ]
      for (const [a,b] of idx) e.push([ch[a], ch[b]])

      return e
    }

    function build3StoryWindowPositions() {
      const W = 2.2, D = 1.4, H = 0.9
      const faces = [+D, -D]
      const floors = [0.3, 0.3 + H, 0.3 + 2*H] // baseline per floor
      const rowsPerFloor = 2
      const cols = 4
      const arr: THREE.Vector3[] = []
      for (const z of faces) {
        for (let f = 0; f < floors.length; f++) {
          for (let r = 0; r < rowsPerFloor; r++) {
            for (let c = 0; c < cols; c++) {
              const x = -W*0.75 + (c/(cols-1)) * (W*1.5)
              const y = floors[f] + r * (H*0.45)
              arr.push(new THREE.Vector3(x, y, z))
            }
          }
        }
      }
      // side faces
      const sides = [-W, W]
      for (const x of sides) {
        for (let f = 0; f < floors.length; f++) {
          for (let r = 0; r < rowsPerFloor; r++) {
            for (let c = 0; c < 3; c++) {
              const z = -D*0.8 + (c/2) * (D*1.6)
              const y = floors[f] + r * (H*0.45)
              arr.push(new THREE.Vector3(x, y, z))
            }
          }
        }
      }
      return arr
    }
  }, [quality.renderScale, quality.bloom, accessibility.epilepsySafe, settings])

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} aria-label="Wireframe House 3D" />
}
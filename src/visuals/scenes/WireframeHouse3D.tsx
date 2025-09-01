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
    const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 200)
    camera.position.set(0, 1.8, 7)

    // Renderer + composer
    const { renderer, dispose: disposeRenderer } = createRenderer(canvasRef.current, quality.renderScale)
    const comp = createComposer(renderer, scene, camera, {
      bloom: quality.bloom,
      bloomStrength: 0.9,
      bloomRadius: 0.35,
      bloomThreshold: 0.2,
      fxaa: true,
      vignette: true,
      vignetteStrength: 0.55,
      filmGrain: true,
      filmGrainStrength: 0.3
    })

    // CSS palette
    const cssColor = (name: string, fallback: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
    const accent = new THREE.Color(cssColor('--accent', '#00f0ff'))
    const accent2 = new THREE.Color(cssColor('--accent-2', '#ff00f0'))

    // Ground plane with album cover
    const albumGroup = new THREE.Group()
    const albumPlane = (() => {
      const geom = new THREE.PlaneGeometry(18, 18, 1, 1)
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 })
      const mesh = new THREE.Mesh(geom, mat)
      mesh.rotation.x = -Math.PI / 2
      mesh.position.set(0, 0.001, 0)
      albumGroup.add(mesh)
      scene.add(albumGroup)
      return mesh
    })()

    // Thin glow grid over the album floor
    const grid = new THREE.GridHelper(36, 36, accent.clone().multiplyScalar(0.6), accent.clone().multiplyScalar(0.3))
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.18
    grid.position.y = 0.002
    scene.add(grid)

    // 3-story house as fat-line wireframe
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
      linewidth: Math.max(2, Math.min(6, (settings.lineWidth || 2) * 2.2)), // pixels
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

    // Emissive windows across 3 floors on 4 faces
    const windowGroup = new THREE.Group()
    {
      const winGeom = new THREE.PlaneGeometry(0.18, 0.12)
      const positions = build3StoryWindowPositions()
      for (const p of positions) {
        const m = new THREE.MeshBasicMaterial({ color: accent2.clone(), transparent: true, opacity: 0 })
        const mesh = new THREE.Mesh(winGeom, m)
        mesh.position.copy(p)
        const outward = new THREE.Vector3(p.x, p.y, p.z).setLength(Math.abs(p.z) + 1).setY(p.y)
        mesh.lookAt(outward)
        windowGroup.add(mesh)
      }
      scene.add(windowGroup)
    }

    // Laser beams
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

    // Soft fog sheet
    const fogSheet = (() => {
      const geom = new THREE.PlaneGeometry(14, 4)
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uIntensity: { value: 0 },
          uColor: { value: new THREE.Color(0xaad1ff) }
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: `
          precision highp float;
          precision highp int;
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          precision highp float;
          precision highp int;
          varying vec2 vUv;
          uniform float uTime;
          uniform float uIntensity;
          uniform vec3 uColor;

          float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float noise(vec2 p){
            vec2 i=floor(p), f=fract(p);
            float a=hash(i);
            float b=hash(i+vec2(1.0,0.0));
            float c=hash(i+vec2(0.0,1.0));
            float d=hash(i+vec2(1.0,1.0));
            vec2 u=f*f*(3.0-2.0*f);
            return mix(a,b,u.x)+ (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
          }
          void main(){
            float n = noise(vUv*5.0 + vec2(uTime*0.035, 0.0));
            float m = smoothstep(0.25, 0.9, n);
            float alpha = m * uIntensity * 0.55;
            gl_FragColor = vec4(uColor, alpha);
          }
        `
      })
      const mesh = new THREE.Mesh(geom, mat)
      mesh.position.set(0, 1.5, -2.6)
      scene.add(mesh)
      return mesh
    })()

    // Reactive state
    let latest: ReactiveFrame | null = null
    const offFrame = reactivityBus.on('frame', (f) => { latest = f })
    const offBeat = reactivityBus.on('beat', () => { beatPulse = 1 })
    const offBar = reactivityBus.on('bar', () => { barPulse = 1 })

    // Camera path
    type Path = 'Circle' | 'Ellipse' | 'Lemniscate' | 'Manual'
    const path: Path = (settings.path || 'Circle') as Path
    let angle = 0

    // Album cover loader
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
          ;(albumPlane.material as THREE.MeshBasicMaterial).map?.dispose?.()
          const mat = albumPlane.material as THREE.MeshBasicMaterial
          mat.map = tex
          mat.needsUpdate = true
        })
      } catch {}
    }
    loadAlbumToFloor()
    const albumIv = window.setInterval(loadAlbumToFloor, 4000)

    // Sizing
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

    const animate = () => {
      raf = requestAnimationFrame(animate)
      const dt = Math.min(0.05, clock.getDelta())
      const now = performance.now()
      const stale = !latest || (now - (latest.t || 0)) > 220

      const low = latest?.bands.low ?? 0.15
      const mid = latest?.bands.mid ?? 0.15
      const high = latest?.bands.high ?? 0.15
      const loud = latest?.loudness ?? 0.2

      // Line color and width pulse
      const mixed = new THREE.Color().copy(accent).lerp(accent2, THREE.MathUtils.clamp(high * 0.9, 0, 1))
      lineMat.color = mixed
      const basePx = Math.max(2, Math.min(6, (settings.lineWidth || 2) * 2.2))
      const pulse = beatPulse > 0 ? (1 + 0.6 * beatPulse) : 1
      lineMat.linewidth = basePx * pulse
      lineMat.needsUpdate = true

      // Windows flicker
      windowGroup.children.forEach((m, i) => {
        const mat = (m as THREE.Mesh).material as THREE.MeshBasicMaterial
        const flicker = 0.15 + 0.85 * mid * Math.abs(Math.sin((clock.elapsedTime + i * 0.13) * (4.5 + (i % 7))))
        mat.opacity = THREE.MathUtils.clamp(flicker, 0, 1)
        ;(mat.color as THREE.Color).copy(new THREE.Color().copy(accent2).lerp(accent, high * 0.3))
      })

      // Beams spin and brightness
      beamGroup.rotation.y += dt * (0.35 + high * 2.8)
      beamGroup.children.forEach((b) => {
        const m = (b as THREE.Mesh).material as THREE.MeshBasicMaterial
        m.opacity = THREE.MathUtils.clamp(0.06 + high * 0.9, 0, 1)
      })

      // Fog
      const fogMat = (fogSheet.material as THREE.ShaderMaterial)
      fogMat.uniforms.uTime.value = clock.elapsedTime
      fogMat.uniforms.uIntensity.value = THREE.MathUtils.clamp(0.2 + loud * 0.9 + (beatPulse > 0 ? 0.5 : 0), 0, accessibility.epilepsySafe ? 0.65 : 1.0)

      // Album plane subtle pulsation on bar
      albumGroup.scale.setScalar(1 + 0.03 * (barPulse > 0 ? barPulse : 0))
      ;(grid.material as THREE.Material).opacity = (stale ? 0.12 : 0.18)

      // Camera motion
      const baseSpeed = (settings.orbitSpeed ?? 0.6) * (stale ? 0.15 : 1.0)
      angle += dt * (baseSpeed + low * 1.1 + (latest?.beatStrength ?? 0) * 1.3)
      const radius = THREE.MathUtils.clamp((settings.orbitRadius ?? 6.0) + Math.sin((latest?.phases.bar ?? 0) * Math.PI * 2) * 0.2, 3.8, 9.0)
      const elev = (settings.orbitElev ?? 0.04)
      const pos = pathPoint(path, angle, radius)
      const bob = (settings.camBob || 0.15) * (0.1 + low * 0.35)
      camera.position.set(pos.x, Math.sin(elev) * (radius * 0.45) + 1.6 + bob * Math.sin(clock.elapsedTime * 1.6), pos.z)
      camera.lookAt(0, 1.4, 0)

      // decay pulses
      beatPulse *= accessibility.epilepsySafe ? 0.85 : 0.9
      barPulse *= 0.93

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
      const W = 2.2, D = 1.4, H = 0.9, roofH = 1.0
      const y0 = 0, y1 = y0 + H, y2 = y1 + H, y3 = y2 + H, apexY = y3 + roofH
      const corners = (y: number) => ([
        new THREE.Vector3(-W, y, -D), new THREE.Vector3(W, y, -D),
        new THREE.Vector3(W, y, D), new THREE.Vector3(-W, y, D)
      ])
      const e: Edge[] = []
      const floors = [y0, y1, y2, y3]
      for (let i = 0; i < floors.length; i++) {
        const c = corners(floors[i])
        e.push([c[0], c[1]],[c[1], c[2]],[c[2], c[3]],[c[3], c[0]])
        if (i < floors.length - 1) {
          const cUp = corners(floors[i+1])
          for (let k = 0; k < 4; k++) e.push([c[k], cUp[k]])
        }
      }
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

      // Front door frame
      const doorW = 0.5, doorH = 0.65
      const doorY0 = y0, doorY1 = y0 + doorH
      const doorX0 = -doorW/2, doorX1 = doorW/2
      e.push(
        [new THREE.Vector3(doorX0, doorY0, D+0.001), new THREE.Vector3(doorX1, doorY0, D+0.001)],
        [new THREE.Vector3(doorX0, doorY0, D+0.001), new THREE.Vector3(doorX0, doorY1, D+0.001)],
        [new THREE.Vector3(doorX1, doorY0, D+0.001), new THREE.Vector3(doorX1, doorY1, D+0.001)],
        [new THREE.Vector3(doorX0, doorY1, D+0.001), new THREE.Vector3(doorX1, doorY1, D+0.001)],
      )

      // Roof (gable)
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
      const floors = [0.3, 0.3 + H, 0.3 + 2*H]
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
import React, { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { createRenderer, createComposer } from '../../three/Renderer'
import { reactivityBus, type ReactiveFrame } from '../../audio/ReactivityBus'
import type { AuthState } from '../../auth/token'

type Props = {
  auth: AuthState | null
  quality: { renderScale: 1 | 1.25 | 1.5 | 1.75 | 2, msaa: 0 | 2 | 4 | 8, bloom: boolean, motionBlur: boolean }
  accessibility: { epilepsySafe: boolean, reducedMotion: boolean, highContrast: boolean }
  // Reuses your HouseSettings; any missing fields default internally
  settings: any
}

type Edge = [THREE.Vector3, THREE.Vector3]

export default function WireframeHouse3D({ quality, accessibility, settings }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (!canvasRef.current) return

    // Scene + camera
    const scene = new THREE.Scene()
    scene.background = null
    const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 100)
    camera.position.set(0, 1.6, 6)

    // Renderer + composer
    const { renderer, dispose: disposeR } = createRenderer(canvasRef.current, quality.renderScale)
    const composer = createComposer(renderer, scene, camera, {
      bloom: quality.bloom,
      bloomStrength: 0.8,
      bloomRadius: 0.25,
      bloomThreshold: 0.2,
      fxaa: true,
      vignette: true,
      vignetteStrength: 0.65,
      filmGrain: true,
      filmGrainStrength: 0.35
    })
    const onResize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1) * quality.renderScale
      const w = Math.floor(canvasRef.current!.clientWidth * dpr)
      const h = Math.floor(canvasRef.current!.clientHeight * dpr)
      camera.aspect = w / Math.max(1, h)
      camera.updateProjectionMatrix()
      composer.onResize()
    }
    window.addEventListener('resize', onResize)
    onResize()

    // Palette via CSS vars
    const cssColor = (name: string, fallback: string) => {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
    }
    const accent = new THREE.Color(cssColor('--accent', '#00f0ff'))
    const accent2 = new THREE.Color(cssColor('--accent-2', '#ff00f0'))

    // Grid ground
    const grid = new THREE.GridHelper(40, 40, accent2.clone().multiplyScalar(0.5), accent2.clone().multiplyScalar(0.25))
    grid.material.opacity = 0.25
    ;(grid.material as THREE.Material).transparent = true
    grid.position.y = 0
    scene.add(grid)

    // House geometry (edges) using fat lines
    const houseEdges = buildHouseEdges()
    const lineGeo = new LineSegmentsGeometry()
    const linePositions = new Float32Array(houseEdges.length * 6)
    for (let i = 0; i < houseEdges.length; i++) {
      const e = houseEdges[i]
      linePositions.set([e[0].x, e[0].y, e[0].z, e[1].x, e[1].y, e[1].z], i * 6)
    }
    lineGeo.setPositions(linePositions)

    const lineMat = new LineMaterial({
      color: accent.getHex(),
      linewidth: Math.max(0.0025, (settings.lineWidth || 1.6) / 800), // screen-space
      transparent: true,
      opacity: 0.95,
      depthTest: true
    })
    lineMat.resolution.set(renderer.domElement.width, renderer.domElement.height)

    const lines = new LineSegments2(lineGeo, lineMat)
    scene.add(lines)

    // Windows as small planes emissive
    const windowGroup = new THREE.Group()
    {
      const planes = buildHouseWindows()
      const wGeom = new THREE.PlaneGeometry(0.12, 0.08)
      for (const p of planes) {
        const m = new THREE.MeshBasicMaterial({ color: accent2, transparent: true, opacity: 0.0 })
        const mesh = new THREE.Mesh(wGeom, m)
        mesh.position.copy(p)
        mesh.lookAt(new THREE.Vector3(p.x, p.y, p.z > 0 ? p.z + 1 : p.z - 1)) // face outwards
        windowGroup.add(mesh)
      }
      scene.add(windowGroup)
    }

    // Beams (laser planes), additive
    const beamGroup = new THREE.Group()
    {
      const beamGeom = new THREE.PlaneGeometry(0.04, 3.6)
      for (let i = 0; i < 10; i++) {
        const mat = new THREE.MeshBasicMaterial({
          color: accent2, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false
        })
        const beam = new THREE.Mesh(beamGeom, mat)
        beam.position.set(0, 1, 0)
        beam.rotation.y = (i / 10) * Math.PI * 2
        beamGroup.add(beam)
      }
      scene.add(beamGroup)
    }

    // Fog sheet (cheap volumetric)
    const fogSheet = (() => {
      const geom = new THREE.PlaneGeometry(12, 4, 1, 1)
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uIntensity: { value: 0 },
          uColor: { value: new THREE.Color(0x88aacc) }
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: /* glsl */`
          varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }
        `,
        fragmentShader: /* glsl */`
          varying vec2 vUv; uniform float uTime; uniform float uIntensity; uniform vec3 uColor;
          float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float noise(vec2 p){
            vec2 i=floor(p); vec2 f=fract(p);
            float a=hash(i);
            float b=hash(i+vec2(1.0,0.0));
            float c=hash(i+vec2(0.0,1.0));
            float d=hash(i+vec2(1.0,1.0));
            vec2 u=f*f*(3.0-2.0*f);
            return mix(a,b,u.x)+ (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
          }
          void main(){
            float n = noise(vUv*4.0 + vec2(uTime*0.03, 0.0));
            float m = smoothstep(0.2, 0.8, n);
            float alpha = m * uIntensity * 0.5;
            gl_FragColor = vec4(uColor, alpha);
          }
        `
      })
      const mesh = new THREE.Mesh(geom, mat)
      mesh.position.set(0, 1.2, -0.2)
      mesh.rotation.x = -0.08
      scene.add(mesh)
      return mesh
    })()

    // Particles (confetti/fireworks/weather) — GPU-friendly Points, CPU spawn/update
    const MAX_PARTICLES = 12000
    const pGeom = new THREE.BufferGeometry()
    const pPositions = new Float32Array(MAX_PARTICLES * 3)
    const pVelocities = new Float32Array(MAX_PARTICLES * 3)
    const pLife = new Float32Array(MAX_PARTICLES)
    const pHue = new Float32Array(MAX_PARTICLES)
    pGeom.setAttribute('position', new THREE.BufferAttribute(pPositions, 3))
    const pMat = new THREE.PointsMaterial({
      size: 0.03, color: accent, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending
    })
    const points = new THREE.Points(pGeom, pMat)
    scene.add(points)
    let alive = 0

    function spawnBurst(count: number, power = 1) {
      const spawnN = Math.min(count, MAX_PARTICLES - alive)
      for (let i = 0; i < spawnN; i++) {
        const idx = alive + i
        pPositions[idx*3+0] = (Math.random()-0.5) * 0.8
        pPositions[idx*3+1] = 1.0 + Math.random() * 0.6
        pPositions[idx*3+2] = (Math.random()-0.5) * 0.8
        pVelocities[idx*3+0] = (Math.random()-0.5) * 1.5 * power
        pVelocities[idx*3+1] = (Math.random()*1.8 + 1.0) * power
        pVelocities[idx*3+2] = (Math.random()-0.5) * 1.5 * power
        pLife[idx] = 1.0
        pHue[idx] = Math.random()
      }
      alive += spawnN
    }

    // Reactivity
    let latest: ReactiveFrame | null = null
    const offFrame = reactivityBus.on('frame', (f) => { latest = f })
    const offBeat = reactivityBus.on('beat', () => {
      spawnBurst(180, 1.0)
    })
    const offBar = reactivityBus.on('bar', () => {
      spawnBurst(60, 0.6)
    })
    const offSection = reactivityBus.on('section', () => {
      // small camera preset handled in tick
    })

    // Camera path system
    type Path = 'Circle' | 'Ellipse' | 'Lemniscate' | 'Manual'
    const path: Path = (settings.path || 'Circle') as Path
    let angle = 0

    const clock = new THREE.Clock()
    let raf = 0

    const animate = () => {
      raf = requestAnimationFrame(animate)
      const dt = Math.min(0.05, clock.getDelta())
      const now = performance.now()
      const stale = !latest || (now - (latest.t || 0)) > 220

      // Colors dynamic
      const high = latest?.bands.high ?? 0.15
      const mid = latest?.bands.mid ?? 0.15
      const low = latest?.bands.low ?? 0.15
      const loud = latest?.loudness ?? 0.15

      const accentMix = accent.clone().lerp(accent2, THREE.MathUtils.clamp(high * 0.9, 0, 1))
      ;(lineMat as any).color = accentMix

      // Windows flicker (mid)
      windowGroup.children.forEach((m, i) => {
        const mat = (m as THREE.Mesh).material as THREE.MeshBasicMaterial
        const flicker = 0.1 + 0.8 * mid * Math.abs(Math.sin((clock.elapsedTime + i * 0.17) * (4 + (i % 5))))
        mat.opacity = THREE.MathUtils.clamp(flicker, 0, 1)
        ;(mat.color as THREE.Color).copy(accent2)
      })

      // Beams spin and brightness (high)
      beamGroup.rotation.y += dt * (0.4 + high * 3.0)
      beamGroup.children.forEach((b, i) => {
        const m = (b as THREE.Mesh).material as THREE.MeshBasicMaterial
        m.opacity = THREE.MathUtils.clamp(0.08 + high * 0.8, 0, 1)
        ;(m.color as THREE.Color).copy(accent2)
      })

      // Fog sheet pulse on loudness/transient
      const fogMat = fogSheet.material as THREE.ShaderMaterial
      fogMat.uniforms.uTime.value = clock.elapsedTime
      const beatPush = latest?.beat ? 0.7 : 0.0
      fogMat.uniforms.uIntensity.value = THREE.MathUtils.clamp(0.2 + loud * 0.9 + beatPush, 0, accessibility.epilepsySafe ? 0.65 : 1.0)
      ;(fogMat.uniforms.uColor.value as THREE.Color).copy(accent2.clone().lerp(accent, 0.5))

      // Orbit camera from path + reactive speed
      const baseSpeed = (settings.orbitSpeed ?? 0.6) * (stale ? 0.15 : 1.0)
      angle += dt * (baseSpeed + low * 1.2 + (latest?.beatStrength ?? 0) * 1.6)
      const radius = THREE.MathUtils.clamp((settings.orbitRadius ?? 5.4) + Math.sin((latest?.phases.bar ?? 0) * Math.PI * 2) * 0.2, 3.5, 8.0)
      const elev = (settings.orbitElev ?? 0.04)

      const pos = pathPoint(path, angle, radius)
      camera.position.set(pos.x, Math.sin(elev) * (radius * 0.5) + 1.2 + (settings.camBob || 0) * (0.0 + low * 0.35), pos.z)
      camera.lookAt(0, 1.1, 0)

      // Beat punches: line width pulse
      const targetWidth = (settings.lineWidth || 1.6) * (1.0 + (latest?.beat ? 0.45 : 0.0))
      lineMat.linewidth = THREE.MathUtils.lerp(lineMat.linewidth, Math.max(0.0015, targetWidth / 800), 0.2)
      lineMat.resolution.set(renderer.domElement.width, renderer.domElement.height)
      lineMat.needsUpdate = true

      // Particles update (simple CPU — adaptive density with FPS)
      for (let i = 0; i < alive; i++) {
        pLife[i] -= dt * 0.6
        pVelocities[i*3+1] -= 2.8 * dt
        pPositions[i*3+0] += pVelocities[i*3+0] * dt
        pPositions[i*3+1] += pVelocities[i*3+1] * dt
        pPositions[i*3+2] += pVelocities[i*3+2] * dt
        // ground bounce
        if (pPositions[i*3+1] < 0) { pPositions[i*3+1] = 0; pVelocities[i*3+1] *= -0.3; pVelocities[i*3+0]*=0.7; pVelocities[i*3+2]*=0.7 }
        if (pLife[i] <= 0) {
          // swap with last alive
          const last = alive - 1
          pPositions[i*3+0] = pPositions[last*3+0]
          pPositions[i*3+1] = pPositions[last*3+1]
          pPositions[i*3+2] = pPositions[last*3+2]
          pVelocities[i*3+0] = pVelocities[last*3+0]
          pVelocities[i*3+1] = pVelocities[last*3+1]
          pVelocities[i*3+2] = pVelocities[last*3+2]
          pLife[i] = pLife[last]
          pHue[i] = pHue[last]
          alive--
        }
      }
      ;(pGeom.attributes.position as THREE.BufferAttribute).needsUpdate = true

      // Adaptive FX budget: if stale or too heavy, reduce opacity/density subtly
      const budgetScale = stale ? 0.6 : 1.0
      ;(grid.material as THREE.Material).opacity = 0.18 * budgetScale
      pMat.opacity = 0.9 * budgetScale

      // Draw
      composer.composer.render()
    }

    animate()

    return () => {
      cancelAnimationFrame(raf)
      offFrame?.(); offBeat?.(); offBar?.(); offSection?.()
      scene.traverse(obj => {
        if ((obj as any).geometry) (obj as any).geometry.dispose?.()
        if ((obj as any).material) {
          const m = (obj as any).material
          if (Array.isArray(m)) m.forEach(mm => mm.dispose?.()); else m.dispose?.()
        }
      })
      composer.dispose()
      disposeR()
      window.removeEventListener('resize', onResize)
      renderer.dispose()
    }

    // Helpers
    function pathPoint(path: 'Circle'|'Ellipse'|'Lemniscate'|'Manual', a: number, r: number) {
      if (path === 'Ellipse') {
        return new THREE.Vector3(Math.sin(a) * r * 1.2, 0, Math.cos(a) * r * 0.8)
      }
      if (path === 'Lemniscate') {
        const s = Math.sin(a), c = Math.cos(a)
        const denom = 1 + s*s
        return new THREE.Vector3((r * c) / denom, 0, (r * s * c) / denom)
      }
      // Circle or Manual (use orbit controls analogue if you add)
      return new THREE.Vector3(Math.sin(a) * r, 0, Math.cos(a) * r)
    }

    function buildHouseEdges(): Edge[] {
      const base = 1.2, h = 0.9, roofH = 0.95
      const v = [
        new THREE.Vector3(-base, 0, -base), new THREE.Vector3(base, 0, -base),
        new THREE.Vector3(base, 0, base), new THREE.Vector3(-base, 0, base),
        new THREE.Vector3(-base, h, -base), new THREE.Vector3(base, h, -base),
        new THREE.Vector3(base, h, base), new THREE.Vector3(-base, h, base),
        new THREE.Vector3(0, h + roofH, 0)
      ]
      const idx: [number, number][] = [
        [0,1],[1,2],[2,3],[3,0],
        [4,5],[5,6],[6,7],[7,4],
        [0,4],[1,5],[2,6],[3,7],
        [4,8],[5,8],[6,8],[7,8],
        [4,6],[5,7]
      ]
      return idx.map(([a,b]) => [v[a], v[b]])
    }

    function buildHouseWindows() {
      const base = 1.2, h = 0.9
      const pts: THREE.Vector3[] = []
      const rows = 3, cols = 4
      for (let face = -1; face <= 1; face += 2) {
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
          const x = -base*0.75 + (c/(cols-1)) * (base*1.5)
          const y = h*0.25 + (r/(rows-1)) * (h*0.6)
          const z = face * base
          pts.push(new THREE.Vector3(x, y, z))
        }
      }
      return pts
    }
  }, [quality.renderScale, quality.bloom, accessibility.epilepsySafe, settings])

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} aria-label="Wireframe House 3D" />
}
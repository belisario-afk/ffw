import React, { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { createRenderer, createComposer } from '../../three/Renderer'
import { reactivityBus, type ReactiveFrame } from '../../audio/ReactivityBus'
import { getPlaybackState } from '../../spotify/api'
import { cacheAlbumArt } from '../../utils/idb'

type Props = {
  auth: any
  quality: { renderScale: 1 | 1.25 | 1.5 | 1.75 | 2, msaa: 0 | 2 | 4 | 8, bloom: boolean, motionBlur: boolean }
  accessibility: { epilepsySafe: boolean, reducedMotion: boolean, highContrast: boolean }
}

type Cfg = {
  intensity: number
  speed: number
  slices: number
  chroma: number
  particleDensity: number
  exposure: number
}

const LS_KEY = 'ffw.kaleido.cfg.safe.v1'

export default function PsyKaleidoTunnel({ quality, accessibility }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // Strong refs so we never read a uniform.value directly (avoids "reading 'value' of null")
  const matRef = useRef<THREE.ShaderMaterial | null>(null)
  const particlesRef = useRef<THREE.Points | null>(null)
  const scrollRef = useRef(0)

  const [panelOpen, setPanelOpen] = useState(false)
  const [cfg, setCfg] = useState<Cfg>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}')
      return { intensity: 0.7, speed: 0.5, slices: 10, chroma: 0.28, particleDensity: 0.9, exposure: 0.7, ...saved }
    } catch {
      return { intensity: 0.7, speed: 0.5, slices: 10, chroma: 0.28, particleDensity: 0.9, exposure: 0.7 }
    }
  })
  const cfgRef = useRef(cfg)
  useEffect(() => { cfgRef.current = cfg; try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)) } catch {} }, [cfg])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#05070b')

    const camera = new THREE.PerspectiveCamera(62, 1, 0.05, 500)
    camera.position.set(0, 0, 0)

    const { renderer, dispose: disposeRenderer } = createRenderer(canvas, quality.renderScale)
    const comp = createComposer(renderer, scene, camera, {
      bloom: quality.bloom,
      bloomStrength: 0.6,
      bloomRadius: 0.35,
      bloomThreshold: 0.6,
      fxaa: true,
      vignette: true,
      vignetteStrength: 0.45,
      filmGrain: false,
      filmGrainStrength: 0.0,
      motionBlur: false
    })

    // Guard flags
    let running = true
    let disposed = false

    // Audio frame
    let latest: ReactiveFrame | null = null
    const offFrame = reactivityBus.on('frame', f => { latest = f })

    // Album tint via cache (avoids CORS), stored as Color
    const albumTint = new THREE.Color(0.55, 0.7, 1.0)
    const sampleAlbumTint = async () => {
      try {
        const s = await getPlaybackState().catch(() => null)
        const url = (s?.item?.album?.images?.[0]?.url as string) || ''
        if (!url) return
        const blobUrl = await cacheAlbumArt(url).catch(() => url)
        const img = await new Promise<HTMLImageElement>((res, rej) => {
          const im = new Image()
          im.onload = () => res(im)
          im.onerror = rej
          im.src = blobUrl
        })
        const c = document.createElement('canvas'); c.width = 32; c.height = 32
        const g = c.getContext('2d'); if (!g) return
        g.drawImage(img, 0, 0, 32, 32)
        const data = g.getImageData(0, 0, 32, 32).data
        let r = 0, gr = 0, b = 0
        for (let i = 0; i < data.length; i += 4) { r += data[i]; gr += data[i + 1]; b += data[i + 2] }
        const n = data.length / 4 || 1
        albumTint.setRGB((r / n) / 255, (gr / n) / 255, (b / n) / 255)
        const maxc = Math.max(albumTint.r, albumTint.g, albumTint.b) || 1
        albumTint.multiplyScalar(0.9 / maxc).lerp(new THREE.Color('#77d0ff'), 0.22)
      } catch {}
    }
    sampleAlbumTint()
    const albumIv = window.setInterval(sampleAlbumTint, 8000)

    // Geometry: inside a BackSide cylinder
    const radius = 14
    const tunnelLen = 160
    const tunnel = new THREE.CylinderGeometry(radius, radius, tunnelLen, 256, 1, true)
    tunnel.rotateZ(Math.PI * 0.5)

    // Build material with uniforms (we WON'T store direct pointers to uniform values)
    const uniforms = {
      uTime: { value: 0.0 },
      uAudio: { value: new THREE.Vector3(0.1, 0.1, 0.1) },
      uLoud: { value: 0.15 },
      uBeat: { value: 0.0 },
      uSlices: { value: Math.max(1, Math.round(cfgRef.current.slices)) },
      uIntensity: { value: cfgRef.current.intensity },
      uChroma: { value: cfgRef.current.chroma },
      uScroll: { value: 0.0 },
      uSafe: { value: (accessibility.epilepsySafe || accessibility.reducedMotion) ? 1.0 : 0.0 },
      uContrastBoost: { value: accessibility.highContrast ? 1.0 : 0.0 },
      uAlbumTint: { value: new THREE.Color().copy(albumTint) },
      uExposure: { value: cfgRef.current.exposure }
    }
    const mat = new THREE.ShaderMaterial({
      uniforms,
      side: THREE.BackSide,
      transparent: false,
      depthWrite: true,
      vertexShader: `
        varying vec2 vUv;
        void main(){
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
        }
      `,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform float uTime;
        uniform vec3 uAudio;
        uniform float uLoud;
        uniform float uBeat;
        uniform float uIntensity;
        uniform float uChroma;
        uniform float uScroll;
        uniform float uSafe;
        uniform float uContrastBoost;
        uniform float uSlices;
        uniform vec3 uAlbumTint;
        uniform float uExposure;

        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float noise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          float a = hash(i), b = hash(i+vec2(1.,0.)), c = hash(i+vec2(0.,1.)), d = hash(i+vec2(1.,1.));
          vec2 u = f*f*(3.-2.*f);
          return mix(a,b,u.x) + (c-a)*u.y*(1.-u.x) + (d-b)*u.x*u.y;
        }
        float fbm(vec2 p){
          float v=0.0, a=0.5;
          for(int i=0;i<5;i++){ v += a * noise(p); p *= 2.02; a *= 0.52; }
          return v;
        }

        float foldKaleido(float x, float slices){
          float seg = 1.0 / max(1.0, slices);
          float xf = fract(x + 1.0);
          float m = mod(xf, seg) / seg;
          m = abs(m - 0.5) * 2.0;
          return m * seg + floor(xf/seg)*seg;
        }

        vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d){ return a + b*cos(6.28318*(c*t + d)); }

        vec3 psychedelic(vec2 uv, float time, vec3 audio, float loud, float intensity, float slices, float chroma, float safe, float cboost, vec3 album, float exposure) {
          uv.y = fract(uv.y - time*0.035 - uScroll);
          uv.x = foldKaleido(uv.x, slices);

          float warp = fbm(uv * (2.3 + 3.2*intensity) + vec2(time*0.12, -time*0.09));
          float rings = sin((uv.y*32.0 + warp*7.0) - time*7.0 * (0.6 + 0.8*loud));
          float spokes = sin((uv.x*56.0 + warp*8.0) + time*4.5 * (0.4 + 0.9*audio.z));
          float field = smoothstep(-1.0, 1.0, rings*spokes);

          float sat = clamp(0.45 + intensity*0.30 + audio.z*0.3 + cboost*0.2, 0.0, 1.25);
          float brt = clamp(0.34 + loud*0.4 + audio.x*0.18, 0.0, 1.5);
          float hueShift = 0.12*intensity + 0.10*audio.y + 0.04*loud + 0.06*sin(time*0.3);

          vec3 colA = palette(fract(field*0.25 + hueShift), vec3(0.52,0.32,0.89), vec3(0.45,0.55,0.45), vec3(1.0,0.7,0.4), vec3(0.0,0.2,0.4));
          vec3 colB = palette(fract(field*0.5 + hueShift*1.4), vec3(0.18,0.45,0.96), vec3(0.55,0.45,0.45), vec3(0.8,0.9,0.5), vec3(0.2,0.0,0.6));
          vec3 col = mix(colA, colB, 0.45 + 0.25*audio.y);

          float off = 0.002 * chroma * (0.4 + 0.6*intensity);
          float fR = smoothstep(0.25, 0.75, fbm((uv + vec2(off,0.0))*4.0 + time*0.06));
          float fG = smoothstep(0.25, 0.75, fbm((uv + vec2(0.0,off))*4.0 - time*0.04));
          float fB = smoothstep(0.25, 0.75, fbm((uv + vec2(-off,off))*4.0 + time*0.02));
          vec3 chrom = vec3(fR, fG, fB);
          col = mix(col, chrom, 0.2 * chroma);

          float flash = 0.3*loud + 0.38*audio.z + 0.2*audio.y;
          float maxFlash = mix(1.0, 0.35, safe);
          flash = min(flash, maxFlash);
          col *= (0.8 + 0.55*flash);

          col = mix(col, album, 0.18 + 0.16*audio.y);

          col *= mix(0.6, 1.35, clamp(exposure, 0.0, 1.2));
          col = col / (1.0 + col);  // Reinhard
          col = pow(col, vec3(0.95));
          return clamp(col, 0.0, 1.0);
        }

        void main(){
          vec2 uv = vUv;
          vec3 col = psychedelic(uv, uTime, uAudio, uLoud, uIntensity, max(1.0,uSlices), uChroma, uSafe, uContrastBoost, uAlbumTint, uExposure);
          gl_FragColor = vec4(col, 1.0);
        }
      `
    })
    matRef.current = mat

    const tunnelMesh = new THREE.Mesh(tunnel, mat)
    scene.add(tunnelMesh)

    // Particles
    const makeParticles = (density: number) => {
      const count = Math.floor(1500 * THREE.MathUtils.clamp(density, 0.1, 2.0))
      const geo = new THREE.BufferGeometry()
      const positions = new Float32Array(count * 3)
      const speeds = new Float32Array(count)
      for (let i = 0; i < count; i++) {
        const theta = Math.random() * Math.PI * 2
        const r = radius * (0.92 + Math.random() * 0.2)
        const x = Math.cos(theta) * r
        const y = Math.sin(theta) * r
        const z = -Math.random() * tunnelLen
        positions.set([x, y, z], i * 3)
        speeds[i] = 4 + Math.random() * 14
      }
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geo.setAttribute('speed', new THREE.BufferAttribute(speeds, 1))
      const pm = new THREE.PointsMaterial({ color: 0xaad8ff, size: 0.045, sizeAttenuation: true, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending })
      const pts = new THREE.Points(geo, pm)
      pts.name = 'kaleido_particles'
      return pts
    }
    particlesRef.current = makeParticles(cfgRef.current.particleDensity)
    scene.add(particlesRef.current)

    // Uniform helpers (never read uniform.value; only set if present)
    const setF = (name: string, v: number) => {
      const m = matRef.current; if (!m) return
      const u = (m.uniforms as any)[name]; if (!u || typeof u.value === 'undefined' || u.value === null) return
      u.value = v
    }
    const setV3 = (name: string, x: number, y: number, z: number) => {
      const m = matRef.current; if (!m) return
      const u = (m.uniforms as any)[name]; if (!u) return
      const val = u.value
      if (val && val.isVector3) { val.set(x, y, z) }
    }
    const setColor = (name: string, col: THREE.Color) => {
      const m = matRef.current; if (!m) return
      const u = (m.uniforms as any)[name]; if (!u) return
      const val = u.value
      if (val && val.isColor) { val.copy(col) } else { u.value = col.clone() }
    }

    // Resize
    const onResize = () => {
      if (disposed) return
      const view = renderer.getSize(new THREE.Vector2())
      camera.aspect = view.x / Math.max(1, view.y)
      camera.updateProjectionMatrix()
      comp.onResize()
    }
    window.addEventListener('resize', onResize)
    onResize()

    // Animate
    const clock = new THREE.Clock()
    let raf = 0
    const animate = () => {
      raf = requestAnimationFrame(animate)
      if (!running || disposed) return

      const dt = Math.min(0.05, clock.getDelta())

      // Audio snapshot with fallbacks
      const low = latest?.bands.low ?? 0.06
      const mid = latest?.bands.mid ?? 0.06
      const high = latest?.bands.high ?? 0.06
      const loud = latest?.loudness ?? 0.12
      const beat = latest?.beat ? 1.0 : 0.0

      // Safety + cfg clamps
      const safe = (accessibility.epilepsySafe || accessibility.reducedMotion) ? 1.0 : 0.0
      const rawIntensity = THREE.MathUtils.clamp(cfgRef.current.intensity ?? 0, 0, 1.2)
      const rawSpeed = THREE.MathUtils.clamp(cfgRef.current.speed ?? 0, 0, 1.5)
      const kIntensity = THREE.MathUtils.lerp(rawIntensity, Math.min(rawIntensity, 0.55), safe)
      const kSpeed = THREE.MathUtils.lerp(rawSpeed, Math.min(rawSpeed, 0.35), safe)
      const slices = Math.max(1, Math.round(cfgRef.current.slices ?? 1))
      const chroma = THREE.MathUtils.clamp(cfgRef.current.chroma ?? 0, 0, 1)
      const exposure = THREE.MathUtils.clamp(cfgRef.current.exposure ?? 0.7, 0, 1.2)

      // Set uniforms safely
      setF('uTime', clock.elapsedTime)
      setV3('uAudio', low, mid, high)
      setF('uLoud', loud)
      setF('uBeat', beat)
      setF('uSafe', safe)
      setF('uContrastBoost', accessibility.highContrast ? 1.0 : 0.0)
      setF('uSlices', slices)
      setF('uIntensity', kIntensity)
      setF('uChroma', chroma)
      setF('uExposure', exposure)
      scrollRef.current += dt * (0.18 + 0.8 * kSpeed + 0.35 * loud)
      setF('uScroll', scrollRef.current)
      setColor('uAlbumTint', albumTint)

      // Particles
      const pts = particlesRef.current
      if (pts) {
        const pos = pts.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
        const spd = pts.geometry.getAttribute('speed') as THREE.BufferAttribute | undefined
        if (pos && spd) {
          const base = (0.75 + 1.6 * kSpeed) + (loud * 1.4)
          for (let i = 0; i < spd.count; i++) {
            const speed = spd.getX(i) * (0.55 + 0.65 * kSpeed) * (1.0 + 0.45 * high)
            const z = pos.getZ(i) + dt * (base + speed)
            if (z > 2.0) {
              const theta = Math.random() * Math.PI * 2
              const r = radius * (0.9 + Math.random() * 0.25)
              const x = Math.cos(theta) * r
              const y = Math.sin(theta) * r
              pos.setXYZ(i, x, y, -tunnelLen)
            } else {
              pos.setZ(i, z)
            }
          }
          pos.needsUpdate = true
        }
      }

      // Rebuild particles only if density changed a lot
      const desired = Math.floor(1500 * THREE.MathUtils.clamp(cfgRef.current.particleDensity ?? 0.9, 0.1, 2.0))
      const current = (particlesRef.current?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined)?.count ?? desired
      if (Math.abs(desired - current) > 400) {
        if (particlesRef.current) {
          scene.remove(particlesRef.current)
          particlesRef.current.geometry.dispose()
          ;(particlesRef.current.material as THREE.Material).dispose()
        }
        particlesRef.current = makeParticles(cfgRef.current.particleDensity)
        scene.add(particlesRef.current)
      }

      comp.composer.render()
    }

    animate()

    // Cleanup
    return () => {
      running = false
      disposed = true
      window.removeEventListener('resize', onResize)
      cancelAnimationFrame(raf)
      window.clearInterval(albumIv)
      offFrame?.()

      if (particlesRef.current) {
        scene.remove(particlesRef.current)
        particlesRef.current.geometry?.dispose()
        ;(particlesRef.current.material as THREE.Material)?.dispose()
        particlesRef.current = null
      }

      matRef.current = null
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quality.renderScale, quality.bloom, accessibility.epilepsySafe, accessibility.reducedMotion, accessibility.highContrast])

  return (
    <div data-visual="psy-kaleido" style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} aria-label="Psychedelic Kaleido Tunnel" />
      <Panel open={panelOpen} cfg={cfg} onToggle={() => setPanelOpen(o => !o)} onChange={setCfg} />
    </div>
  )
}

function Panel(props: { open: boolean, cfg: Cfg, onToggle: () => void, onChange: (u: (p: Cfg) => Cfg | Cfg) => void }) {
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
  const btnStyle: React.CSSProperties = {
    padding:'6px 10px', fontSize:12, borderRadius:6, border:'1px solid #2b2f3a',
    background:'rgba(16,18,22,0.8)', color:'#cfe7ff', cursor:'pointer'
  }

  return (
    <div style={{ position:'absolute', top:12, right:12, zIndex:10, userSelect:'none', pointerEvents:'auto' }}>
      <button onClick={(e) => { e.stopPropagation(); onToggle() }} style={btnStyle}>
        {open ? 'Close Psy Settings' : 'Psy Settings'}
      </button>
      {open && (
        <div style={{ width: 300, marginTop:8, padding:12, border:'1px solid #2b2f3a', borderRadius:8,
          background:'rgba(10,12,16,0.88)', color:'#e6f0ff', fontFamily:'system-ui, sans-serif', fontSize:12, lineHeight:1.4 }}>
          <Card title="Intensity & Speed">
            <Row label={`Intensity: ${cfg.intensity.toFixed(2)}`}>
              <input type="range" min={0} max={1.2} step={0.01} value={cfg.intensity}
                     onChange={e => onChange(prev => ({ ...prev, intensity: Math.max(0, Math.min(1.2, +e.currentTarget.value || 0)) }))}/>
            </Row>
            <Row label={`Speed: ${cfg.speed.toFixed(2)}`}>
              <input type="range" min={0} max={1.5} step={0.01} value={cfg.speed}
                     onChange={e => onChange(prev => ({ ...prev, speed: Math.max(0, Math.min(1.5, +e.currentTarget.value || 0)) }))}/>
            </Row>
            <Row label={`Exposure: ${cfg.exposure.toFixed(2)}`}>
              <input type="range" min={0} max={1.2} step={0.01} value={cfg.exposure}
                     onChange={e => onChange(prev => ({ ...prev, exposure: Math.max(0, Math.min(1.2, +e.currentTarget.value || 0.7)) }))}/>
            </Row>
          </Card>
          <Card title="Kaleidoscope">
            <Row label={`Slices: ${cfg.slices}`}>
              <input type="range" min={1} max={24} step={1} value={cfg.slices}
                     onChange={e => onChange(prev => ({ ...prev, slices: Math.max(1, Math.round(+e.currentTarget.value || 1)) }))}/>
            </Row>
            <Row label={`Chroma: ${cfg.chroma.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.chroma}
                     onChange={e => onChange(prev => ({ ...prev, chroma: Math.max(0, Math.min(1, +e.currentTarget.value || 0)) }))}/>
            </Row>
          </Card>
          <Card title="Particles">
            <Row label={`Density: ${cfg.particleDensity.toFixed(2)}`}>
              <input type="range" min={0.2} max={2} step={0.01} value={cfg.particleDensity}
                     onChange={e => onChange(prev => ({ ...prev, particleDensity: Math.max(0.2, Math.min(2, +e.currentTarget.value || 0.9)) }))}/>
            </Row>
          </Card>
          <div style={{ display:'flex', gap:8, marginTop:10, justifyContent:'flex-end' }}>
            <button onClick={() => onChange({ intensity: 0.7, speed: 0.5, slices: 10, chroma: 0.28, particleDensity: 0.9, exposure: 0.7 })} style={btnStyle}>Reset</button>
            <button onClick={onToggle} style={btnStyle}>Close</button>
          </div>
        </div>
      )}
    </div>
  )
}
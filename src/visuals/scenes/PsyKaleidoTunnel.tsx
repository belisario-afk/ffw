import React, { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { createRenderer, createComposer } from '../../three/Renderer'
import { reactivityBus, type ReactiveFrame } from '../../audio/ReactivityBus'

type Props = {
  auth: any
  quality: { renderScale: 1 | 1.25 | 1.5 | 1.75 | 2, msaa: 0 | 2 | 4 | 8, bloom: boolean, motionBlur: boolean }
  accessibility: { epilepsySafe: boolean, reducedMotion: boolean, highContrast: boolean }
}

type Cfg = {
  intensity: number // overall effect strength
  speed: number     // forward scroll speed
  slices: number    // kaleidoscope slices
  chroma: number    // pseudo chromatic aberration
  particleDensity: number
}

const LS_KEY = 'ffw.kaleido.cfg.v1'

export default function PsyKaleidoTunnel({ quality, accessibility }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [cfg, setCfg] = useState<Cfg>(() => {
    try { const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); return { intensity: 0.9, speed: 0.55, slices: 8, chroma: 0.4, particleDensity: 0.8, ...saved } } catch { return { intensity: 0.9, speed: 0.55, slices: 8, chroma: 0.4, particleDensity: 0.8 } }
  })
  const cfgRef = useRef(cfg)
  useEffect(() => { cfgRef.current = cfg; try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)) } catch {} }, [cfg])

  useEffect(() => {
    if (!canvasRef.current) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#05070b')

    const camera = new THREE.PerspectiveCamera(60, 1, 0.02, 200)
    camera.position.set(0, 0, 0.4)

    const { renderer, dispose: disposeRenderer } = createRenderer(canvasRef.current, quality.renderScale)
    const comp = createComposer(renderer, scene, camera, {
      bloom: quality.bloom,
      bloomStrength: 0.85,
      bloomRadius: 0.42,
      bloomThreshold: 0.25,
      fxaa: true,
      vignette: true,
      vignetteStrength: 0.5,
      filmGrain: false,
      filmGrainStrength: 0.0,
      motionBlur: false
    })

    const clock = new THREE.Clock()

    // Audio frame
    let latest: ReactiveFrame | null = null
    const offFrame = reactivityBus.on('frame', f => { latest = f })

    // Tunnel geometry (inside-out cylinder so we see interior)
    const radius = 6
    const tunnelLen = 80
    const tunnel = new THREE.CylinderGeometry(radius, radius, tunnelLen, 256, 1, true)
    tunnel.rotateZ(Math.PI) // flip UV seam orientation slightly
    const uniforms = {
      uTime: { value: 0 },
      uAudio: { value: new THREE.Vector3(0.1, 0.1, 0.1) }, // low, mid, high
      uLoud: { value: 0.15 },
      uBeat: { value: 0.0 },
      uSlices: { value: cfgRef.current.slices },
      uIntensity: { value: cfgRef.current.intensity },
      uChroma: { value: cfgRef.current.chroma },
      uScroll: { value: 0.0 },
      uSafe: { value: (accessibility.epilepsySafe || accessibility.reducedMotion) ? 1.0 : 0.0 },
      uContrastBoost: { value: accessibility.highContrast ? 1.0 : 0.0 }
    }
    const mat = new THREE.ShaderMaterial({
      uniforms,
      side: THREE.BackSide,
      transparent: false,
      depthWrite: true,
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vPos;
        void main(){
          vUv = uv;
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
        }
      `,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        varying vec3 vPos;
        uniform float uTime;
        uniform vec3 uAudio; // low, mid, high
        uniform float uLoud;
        uniform float uBeat;
        uniform float uIntensity;
        uniform float uChroma;
        uniform float uScroll;
        uniform float uSafe;
        uniform float uContrastBoost;
        uniform float uSlices;
        const float PI = 3.141592653589793;

        // hash/noise
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float noise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          float a = hash(i), b = hash(i+vec2(1.,0.)), c = hash(i+vec2(0.,1.)), d = hash(i+vec2(1.,1.));
          vec2 u = f*f*(3.-2.*f);
          return mix(a,b,u.x) + (c-a)*u.y*(1.-u.x) + (d-b)*u.x*u.y;
        }
        float fbm(vec2 p){
          float v=0.0, a=0.5;
          for(int i=0;i<5;i++){
            v += a * noise(p); p *= 2.02; a *= 0.52;
          }
          return v;
        }

        // kaleidoscope fold across X (around tunnel)
        float foldKaleido(float x, float slices){
          float seg = 1.0 / max(1.0, slices);
          float xf = fract(x);
          float m = mod(xf, seg) / seg; // 0..1 within segment
          m = abs(m - 0.5) * 2.0;       // mirror
          return m * seg + floor(xf/seg)*seg;
        }

        vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d){
          return a + b*cos(6.28318*(c*t + d));
        }

        vec3 psychedelic(vec2 uv, float time, vec3 audio, float loud, float intensity, float slices, float chroma, float safe, float cboost){
          // uv.x around tunnel, uv.y along depth; add scroll
          uv.y = fract(uv.y - time*0.035 - uScroll);
          // kaleido on x
          uv.x = foldKaleido(uv.x, slices);

          // base field
          float warp = fbm(uv * (2.5 + 3.5*intensity) + vec2(time*0.12, -time*0.09));
          float rings = sin((uv.y*36.0 + warp*8.0) - time*8.0 * (0.6 + 0.8*loud));
          float spokes = sin((uv.x*64.0 + warp*9.0) + time*5.0 * (0.4 + 0.9*audio.z));
          float field = smoothstep(-1.0, 1.0, rings*spokes);

          // audio pushes saturation/contrast
          float sat = clamp(0.55 + intensity*0.35 + audio.z*0.35 + cboost*0.25, 0.0, 1.5);
          float brt = clamp(0.42 + loud*0.45 + audio.x*0.2, 0.0, 2.0);
          float hueShift = 0.15*intensity + 0.12*audio.y + 0.05*loud + 0.07*sin(time*0.3);

          // base palette
          vec3 colA = palette(fract(field*0.25 + hueShift), vec3(0.52,0.32,0.89), vec3(0.45,0.55,0.45), vec3(1.0,0.7,0.4), vec3(0.0,0.2,0.4));
          vec3 colB = palette(fract(field*0.5 + hueShift*1.4), vec3(0.18,0.45,0.96), vec3(0.55,0.45,0.45), vec3(0.8,0.9,0.5), vec3(0.2,0.0,0.6));
          vec3 col = mix(colA, colB, 0.45 + 0.25*audio.y);

          // chromatic split by sampling offset variants
          float off = 0.002 * chroma * (0.4 + 0.6*intensity);
          float fR = smoothstep(0.25, 0.75, fbm((uv + vec2(off,0.0))*4.0 + time*0.06));
          float fG = smoothstep(0.25, 0.75, fbm((uv + vec2(0.0,off))*4.0 - time*0.04));
          float fB = smoothstep(0.25, 0.75, fbm((uv + vec2(-off,off))*4.0 + time*0.02));
          vec3 chrom = vec3(fR, fG, fB);

          // combine with brightness and safety clamp for flashes
          float flash = 0.35*loud + 0.45*audio.z + 0.25*audio.y;
          float maxFlash = mix(1.0, 0.35, safe); // reduce flash if safe
          flash = min(flash, maxFlash);
          col *= (0.8 + 0.7*flash);
          col = mix(col, chrom, 0.25 * chroma);

          // final contrast/saturation
          col = mix(vec3(dot(col, vec3(0.2126,0.7152,0.0722))), col, sat);
          col = pow(col, vec3(0.95));
          return col;
        }

        void main(){
          vec2 uv = vUv;
          vec3 col = psychedelic(uv, uTime, uAudio, uLoud, uIntensity, max(1.0,uSlices), uChroma, uSafe, uContrastBoost);
          gl_FragColor = vec4(col, 1.0);
        }
      `
    })
    const tunnelMesh = new THREE.Mesh(tunnel, mat)
    tunnelMesh.position.z = -tunnelLen*0.35
    scene.add(tunnelMesh)

    // Particles (comet flecks rushing by)
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
      const mat = new THREE.PointsMaterial({ color: 0xaad8ff, size: 0.045, sizeAttenuation: true, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending })
      const pts = new THREE.Points(geo, mat)
      pts.name = 'kaleido_particles'
      return pts
    }

    let particles = makeParticles(cfgRef.current.particleDensity)
    scene.add(particles)

    // Resize
    const onResize = () => {
      const view = renderer.getSize(new THREE.Vector2())
      camera.aspect = view.x / Math.max(1, view.y)
      camera.updateProjectionMatrix()
      comp.onResize()
    }
    window.addEventListener('resize', onResize)
    onResize()

    let raf = 0
    const animate = () => {
      raf = requestAnimationFrame(animate)
      const dt = Math.min(0.05, clock.getDelta())
      uniforms.uTime.value = clock.elapsedTime

      // Audio
      const low = latest?.bands.low ?? 0.06
      const mid = latest?.bands.mid ?? 0.06
      const high = latest?.bands.high ?? 0.06
      const loud = latest?.loudness ?? 0.12
      const beat = latest?.beat ? 1.0 : 0.0

      // Safety clamps
      const safe = (accessibility.epilepsySafe || accessibility.reducedMotion) ? 1.0 : 0.0
      uniforms.uSafe.value = safe
      const kIntensity = THREE.MathUtils.lerp(cfgRef.current.intensity, Math.min(cfgRef.current.intensity, 0.6), safe)
      const kSpeed = THREE.MathUtils.lerp(cfgRef.current.speed, Math.min(cfgRef.current.speed, 0.35), safe)

      uniforms.uAudio.value.set(low, mid, high)
      uniforms.uLoud.value = loud
      uniforms.uBeat.value = beat
      uniforms.uSlices.value = Math.max(1, Math.round(cfgRef.current.slices))
      uniforms.uIntensity.value = kIntensity
      uniforms.uChroma.value = THREE.MathUtils.lerp(cfgRef.current.chroma, Math.min(cfgRef.current.chroma, 0.2), safe)
      uniforms.uScroll.value += dt * (0.25 + 0.9 * kSpeed + 0.4 * loud)

      // Particle motion toward camera
      const pos = (particles.geometry.getAttribute('position') as THREE.BufferAttribute)
      const spd = (particles.geometry.getAttribute('speed') as THREE.BufferAttribute)
      const v = new THREE.Vector3()
      const base = (0.8 + 1.8 * kSpeed) + (loud * 1.6)
      for (let i = 0; i < spd.count; i++) {
        const speed = spd.getX(i) * (0.6 + 0.7 * kSpeed) * (1.0 + 0.5 * high)
        const z = pos.getZ(i) + dt * (base + speed)
        if (z > 2.0) {
          // respawn far away at random theta/r
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

      comp.composer.render()
    }

    animate()

    // react to cfg changes that affect geometry/material immediately
    const cfgIv = setInterval(() => {
      uniforms.uSlices.value = Math.max(1, Math.round(cfgRef.current.slices))
      uniforms.uIntensity.value = cfgRef.current.intensity
      uniforms.uChroma.value = cfgRef.current.chroma
      // Rebuild particles if density changes significantly (cheap guard)
      const desired = Math.floor(1500 * THREE.MathUtils.clamp(cfgRef.current.particleDensity, 0.1, 2.0))
      const current = (particles.geometry.getAttribute('position') as THREE.BufferAttribute).count
      if (Math.abs(desired - current) > 200) {
        scene.remove(particles)
        particles.geometry.dispose(); (particles.material as THREE.Material).dispose()
        particles = makeParticles(cfgRef.current.particleDensity)
        scene.add(particles)
      }
    }, 300)

    return () => {
      cancelAnimationFrame(raf)
      clearInterval(cfgIv)
      offFrame?.()
      window.removeEventListener('resize', onResize)
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
          <Card title="Intensity">
            <Row label={`Overall: ${cfg.intensity.toFixed(2)}`}>
              <input type="range" min={0} max={1.2} step={0.01} value={cfg.intensity}
                     onChange={e => onChange(prev => ({ ...prev, intensity: +e.currentTarget.value }))}/>
            </Row>
            <Row label={`Speed: ${cfg.speed.toFixed(2)}`}>
              <input type="range" min={0} max={1.5} step={0.01} value={cfg.speed}
                     onChange={e => onChange(prev => ({ ...prev, speed: +e.currentTarget.value }))}/>
            </Row>
          </Card>
          <Card title="Kaleidoscope">
            <Row label={`Slices: ${cfg.slices}`}>
              <input type="range" min={1} max={24} step={1} value={cfg.slices}
                     onChange={e => onChange(prev => ({ ...prev, slices: Math.max(1, Math.round(+e.currentTarget.value)) }))}/>
            </Row>
            <Row label={`Chroma: ${cfg.chroma.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.01} value={cfg.chroma}
                     onChange={e => onChange(prev => ({ ...prev, chroma: +e.currentTarget.value }))}/>
            </Row>
          </Card>
          <Card title="Particles">
            <Row label={`Density: ${cfg.particleDensity.toFixed(2)}`}>
              <input type="range" min={0.2} max={2} step={0.01} value={cfg.particleDensity}
                     onChange={e => onChange(prev => ({ ...prev, particleDensity: +e.currentTarget.value }))}/>
            </Row>
          </Card>
          <div style={{ display:'flex', gap:8, marginTop:10, justifyContent:'flex-end' }}>
            <button onClick={() => onChange({ intensity: 0.9, speed: 0.55, slices: 8, chroma: 0.4, particleDensity: 0.8 })} style={btnStyle}>Reset</button>
            <button onClick={onToggle} style={btnStyle}>Close</button>
          </div>
        </div>
      )}
    </div>
  )
}
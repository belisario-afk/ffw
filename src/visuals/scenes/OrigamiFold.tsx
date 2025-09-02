import React, { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { createRenderer, createComposer } from '../../three/Renderer'
import { reactivityBus, type ReactiveFrame } from '../../audio/ReactivityBus'
import { getPlaybackState } from '../../spotify/api'

type Props = {
  quality: { renderScale: 1 | 1.25 | 1.5 | 1.75 | 2; bloom: boolean }
  accessibility: { epilepsySafe: boolean; reducedMotion: boolean; highContrast: boolean }
}

type Cfg = {
  exposure: number
  saturation: number
  gamma: number
  vignette: number
  fresnelStrength: number
  edgeTintStrength: number
  paperGloss: number
  autoPlay: boolean
  foldSpeed: number
  foldPause: number
  tileIntensity: number
  backsideDarken: number
}

const LS_KEY = 'ffw.origami.v1'
const DEFAULT_CFG: Cfg = {
  exposure: 1.06,
  saturation: 1.08,
  gamma: 0.95,
  vignette: 0.54,
  fresnelStrength: 0.45,
  edgeTintStrength: 0.35,
  paperGloss: 0.15,
  autoPlay: true,
  foldSpeed: 0.9,
  foldPause: 0.7,
  tileIntensity: 0.35,
  backsideDarken: 0.22
}

// Live-uniform setters bound to the material; no caching.
function makeUniformSetters(matRef: React.MutableRefObject<THREE.ShaderMaterial | null>) {
  const getTable = () => {
    const m = matRef.current
    if (!m) return null
    if (!m.uniforms) (m as any).uniforms = {}
    return m.uniforms as Record<string, { value: any }>
  }
  const ensure = (name: string, init: any) => {
    const tbl = getTable()
    if (!tbl) return null
    const u = tbl[name]
    if (!u || typeof u !== 'object' || !('value' in u)) {
      tbl[name] = { value: init }
      return tbl[name]
    }
    return u
  }
  const setF = (name: string, v: number) => { const u = ensure(name, v); if (u) u.value = v }
  const setV3 = (name: string, x: number, y: number, z: number) => {
    const u = ensure(name, new THREE.Vector3(x, y, z)); if (!u) return
    if (u.value?.isVector3) { u.value.set(x, y, z) } else { u.value = new THREE.Vector3(x, y, z) }
  }
  const setColor = (name: string, col: THREE.Color) => {
    const u = ensure(name, col.clone()); if (!u) return
    if (u.value?.isColor) { u.value.copy(col) } else { u.value = col.clone() }
  }
  const setTex = (name: string, tex: THREE.Texture | null) => { const u = ensure(name, tex); if (u) u.value = tex }
  return { setF, setV3, setColor, setTex }
}

export default function OrigamiFold({ quality, accessibility }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const matRef = useRef<THREE.ShaderMaterial | null>(null)
  const disposedRef = useRef(false)

  // Album cover + palette (swatches)
  const texRef = useRef<THREE.Texture | null>(null)
  const albAvg = useRef(new THREE.Color('#808080'))
  const albC1 = useRef(new THREE.Color('#77d0ff'))
  const albC2 = useRef(new THREE.Color('#b47bff'))
  const albC3 = useRef(new THREE.Color('#ffd077'))

  // HUD
  const [hudVisible, setHudVisible] = useState(true)
  const hudHideTimer = useRef<number | null>(null)
  const [hoverTop, setHoverTop] = useState(false)

  // UI
  const [panelOpen, setPanelOpen] = useState(false)
  const [cfg, setCfg] = useState<Cfg>(() => {
    try { return { ...DEFAULT_CFG, ...(JSON.parse(localStorage.getItem(LS_KEY) || '{}')) } }
    catch { return { ...DEFAULT_CFG } }
  })
  useEffect(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)) } catch {} }, [cfg])

  // HUD auto-hide near top-middle
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onMove = (e: MouseEvent) => {
      const r = el.getBoundingClientRect(), y = e.clientY - r.top, x = e.clientX - r.left
      const nearTop = y < 90
      const nearCenterX = Math.abs(x - r.width / 2) < r.width * 0.35
      if (nearTop && nearCenterX) {
        setHudVisible(true); setHoverTop(true)
        if (hudHideTimer.current) { window.clearTimeout(hudHideTimer.current); hudHideTimer.current = null }
      } else {
        setHoverTop(false)
        if (!panelOpen && hudHideTimer.current == null) {
          hudHideTimer.current = window.setTimeout(() => { setHudVisible(false); hudHideTimer.current = null }, 1400)
        }
      }
    }
    const onLeave = () => { setHoverTop(false); if (!panelOpen) setHudVisible(false) }
    el.addEventListener('mousemove', onMove)
    el.addEventListener('mouseleave', onLeave)
    return () => {
      el.removeEventListener('mousemove', onMove)
      el.removeEventListener('mouseleave', onLeave)
      if (hudHideTimer.current) { window.clearTimeout(hudHideTimer.current); hudHideTimer.current = null }
    }
  }, [panelOpen])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    disposedRef.current = false

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#05070b')

    const camera = new THREE.PerspectiveCamera(58, 1, 0.05, 50)
    camera.position.set(0, 0, 2.2)

    const { renderer, dispose: disposeRenderer } = createRenderer(canvas, quality.renderScale)
    const comp = createComposer(renderer, scene, camera, {
      bloom: quality.bloom, bloomStrength: 0.6, bloomRadius: 0.36, bloomThreshold: 0.56,
      fxaa: true, vignette: true, vignetteStrength: cfg.vignette, filmGrain: false, motionBlur: false
    })

    // Audio bus
    let latest: ReactiveFrame | null = null
    const offFrame = reactivityBus.on('frame', (f) => { latest = f })

    const setters = makeUniformSetters(matRef)

    // Load album cover + palette
    async function loadAlbum() {
      try {
        const s = await getPlaybackState().catch(() => null)
        const url = (s?.item?.album?.images?.[0]?.url as string) || ''
        if (!url) return

        // Texture (CORS + fallback)
        const loader = new THREE.TextureLoader()
        loader.setCrossOrigin('anonymous' as any)
        const tex = await new Promise<THREE.Texture>((resolve, reject) => {
          loader.load(url, (t) => resolve(t), undefined, async () => {
            const resp = await fetch(url); const blob = await resp.blob(); const obj = URL.createObjectURL(blob)
            loader.load(obj, (t) => resolve(t), undefined, reject)
          })
        })
        tex.colorSpace = THREE.SRGBColorSpace
        tex.minFilter = THREE.LinearMipmapLinearFilter
        tex.magFilter = THREE.LinearFilter
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
        try { tex.anisotropy = (renderer.capabilities as any).getMaxAnisotropy?.() ?? tex.anisotropy } catch {}

        texRef.current?.dispose()
        texRef.current = tex
        setters.setTex('tAlbum', tex)

        // Palette (fast 40x40 sample)
        const img = new Image()
        await new Promise<void>((res, rej) => { img.crossOrigin = 'anonymous'; img.onload = () => res(); img.onerror = rej; img.src = url })
        const c = document.createElement('canvas'); c.width = 40; c.height = 40
        const g = c.getContext('2d'); if (g) {
          g.drawImage(img, 0, 0, 40, 40)
          const data = g.getImageData(0, 0, 40, 40).data
          quantizeTopN(data, 3)
          setters.setColor('uC0', albAvg.current)
          setters.setColor('uC1', albC1.current)
          setters.setColor('uC2', albC2.current)
          setters.setColor('uC3', albC3.current)
        }
      } catch { /* ignore */ }
    }

    function quantizeTopN(data: Uint8ClampedArray, nPick = 3) {
      const bins = new Map<number, number>()
      const toBin = (r: number, g: number, b: number) => {
        const R = Math.min(5, Math.floor(r / 43))
        const G = Math.min(5, Math.floor(g / 43))
        const B = Math.min(5, Math.floor(b / 43))
        return (R << 10) | (G << 5) | B
      }
      let ar = 0, ag = 0, ab = 0, n = 0
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3]; if (a < 16) continue
        const r = data[i], g = data[i + 1], b = data[i + 2]
        const key = toBin(r, g, b)
        bins.set(key, (bins.get(key) || 0) + 1)
        ar += r; ag += g; ab += b; n++
      }
      albAvg.current.setRGB(ar / Math.max(1, n) / 255, ag / Math.max(1, n) / 255, ab / Math.max(1, n) / 255)
      const sorted = [...bins.entries()].sort((a, b) => b[1] - a[1]).slice(0, nPick)
      const decode = (bin: number) => {
        const R = ((bin >> 10) & 0x1f) * 43 + 21
        const G = ((bin >> 5) & 0x1f) * 43 + 21
        const B = (bin & 0x1f) * 43 + 21
        return new THREE.Color(R / 255, G / 255, B / 255)
      }
      const picks = sorted.map(([bin]) => decode(bin))
      albC1.current.copy(picks[0] || new THREE.Color('#ffffff'))
      albC2.current.copy(picks[1] || albC1.current)
      albC3.current.copy(picks[2] || albC2.current)
    }

    // Geometry: a square sheet of "paper" (plane) to fold
    const segs = 80
    const plane = new THREE.PlaneGeometry(1.4, 1.4, segs, segs) // centered at 0
    const uniforms: Record<string, { value: any }> = {
      uTime: { value: 0 },
      uAudio: { value: new THREE.Vector3(0.1, 0.1, 0.1) },
      uBeat: { value: 0 },
      uLoud: { value: 0.1 },

      tAlbum: { value: null },

      uC0: { value: albAvg.current.clone() },
      uC1: { value: albC1.current.clone() },
      uC2: { value: albC2.current.clone() },
      uC3: { value: albC3.current.clone() },

      uExposure: { value: cfg.exposure },
      uSaturation: { value: cfg.saturation },
      uGamma: { value: cfg.gamma },
      uVignette: { value: cfg.vignette },

      // fold progress [0..1]
      uFold1: { value: 0 },
      uFold2: { value: 0 },
      uFold3: { value: 0 },
      // tiling mix
      uTileMix: { value: 0 },
      uTileIntensity: { value: cfg.tileIntensity },

      // shading
      uFresnel: { value: cfg.fresnelStrength },
      uEdgeTint: { value: cfg.edgeTintStrength },
      uGloss: { value: cfg.paperGloss },
      uBackDark: { value: cfg.backsideDarken },

      uSafe: { value: (accessibility.epilepsySafe || accessibility.reducedMotion) ? 1.0 : 0.0 },
      uContrastBoost: { value: accessibility.highContrast ? 1.0 : 0.0 }
    }

    const mat = new THREE.ShaderMaterial({
      uniforms,
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: true,
      vertexShader: `
        precision highp float;
        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vWorldPos;

        uniform float uFold1;
        uniform float uFold2;
        uniform float uFold3;

        vec3 rotateVec(vec3 v, vec3 axis, float ang){
          float c = cos(ang), s = sin(ang);
          return v*c + cross(axis, v)*s + axis*dot(axis, v)*(1.0 - c);
        }
        vec3 rotateAroundLine(vec3 p, vec3 axis, vec3 q, float ang){
          vec3 d = p - q;
          d = rotateVec(d, axis, ang);
          return q + d;
        }

        void main(){
          vUv = uv;
          vec3 pos = position;
          vec3 nrm = normal;

          if (pos.x > 0.0){
            float ang1 = 3.14159265 * uFold1;
            vec3 axis1 = vec3(0.0, 1.0, 0.0);
            vec3 q1 = vec3(0.0, pos.y, 0.0);
            pos = rotateAroundLine(pos, axis1, q1, ang1);
            nrm = rotateVec(nrm, axis1, ang1);
          }
          if (pos.y > 0.0){
            float ang2 = 3.14159265 * uFold2;
            vec3 axis2 = vec3(1.0, 0.0, 0.0);
            vec3 q2 = vec3(pos.x, 0.0, 0.0);
            pos = rotateAroundLine(pos, axis2, q2, ang2);
            nrm = rotateVec(nrm, axis2, ang2);
          }
          if (pos.x + pos.y > 0.0){
            float ang3 = 3.14159265 * uFold3;
            vec3 axis3 = normalize(vec3(1.0, 1.0, 0.0));
            float t = dot(pos, axis3);
            vec3 q3 = axis3 * t;
            pos = rotateAroundLine(pos, axis3, q3, ang3);
            nrm = rotateVec(nrm, axis3, ang3);
          }

          vNormal = normalize(nrm);
          vec4 wp = modelMatrix * vec4(pos, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vWorldPos;

        uniform sampler2D tAlbum;

        uniform vec3 uC0, uC1, uC2, uC3;
        uniform float uExposure, uSaturation, uGamma, uVignette;

        uniform float uFresnel, uEdgeTint, uGloss, uBackDark;
        uniform float uTileMix, uTileIntensity;

        uniform vec3 uAudio; // low, mid, high
        uniform float uSafe;

        vec3 sat(vec3 c, float s){ float l=dot(c, vec3(0.299,0.587,0.114)); return mix(vec3(l), c, s); }

        void main(){
          // Base UV (album cover)
          vec2 uv = vUv * 0.98 + 0.01; // slight inset to avoid border sampling
          vec3 texCol = texture2D(tAlbum, uv).rgb;

          // Optional tiling mix (unfold into mosaic)
          vec2 tuv = fract(vUv * (1.0 + uTileMix * 6.0));
          vec3 tileCol = texture2D(tAlbum, tuv).rgb;
          texCol = mix(texCol, tileCol, clamp(uTileMix * uTileIntensity, 0.0, 1.0));

          // Backside darken/tint
          if (!gl_FrontFacing) {
            texCol = mix(texCol * (1.0 - uBackDark), texCol * uC0, 0.25);
          }

          // Lighting proxies
          vec3 N = normalize(vNormal);
          vec3 V = normalize(cameraPosition - vWorldPos);
          float NdotV = clamp(dot(N, V), 0.0, 1.0);

          // Fresnel shimmer (highs boost, safe caps)
          float fres = pow(1.0 - NdotV, 3.0);
          float highs = uAudio.z;
          float fresAmt = mix(uFresnel, min(uFresnel, 0.22), uSafe) + highs * 0.25;
          vec3 fresCol = mix(uC2, uC3, 0.5 + 0.4*sin(highs*6.0));
          vec3 shimmer = fresCol * fres * fresAmt;

          // Edge tint (rim + slight paper-gloss)
          float rim = pow(1.0 - NdotV, 1.6);
          float gloss = pow(NdotV, 32.0) * uGloss;
          vec3 edgeCol = mix(uC1, uC2, 0.5 + 0.3*sin(highs*8.0));
          vec3 edge = edgeCol * (rim * uEdgeTint + gloss * 0.6);

          vec3 col = texCol;
          col += shimmer;
          col = mix(col, col + edge, 0.6);

          // Color finishing
          col = sat(col, mix(uSaturation, 1.0, uSafe*0.3));
          col *= uExposure;
          col = col / (1.0 + col); // simple tonemap
          col = pow(clamp(col, 0.0, 1.0), vec3(uGamma));

          gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        }
      `
    })
    matRef.current = mat

    const mesh = new THREE.Mesh(plane, mat)
    scene.add(mesh)

    // Resize
    const onResize = () => {
      if (disposedRef.current) return
      const size = renderer.getSize(new THREE.Vector2())
      camera.aspect = size.x / Math.max(1, size.y)
      camera.updateProjectionMatrix()
      comp.onResize()
    }
    window.addEventListener('resize', onResize)
    onResize()

    // Initial album
    loadAlbum()
    const albumIv = window.setInterval(loadAlbum, 8000)

    // Animation timeline
    type Phase = 'fold1' | 'pause1' | 'fold2' | 'pause2' | 'fold3' | 'pause3' | 'unfold' | 'tile' | 'rest'
    let phase: Phase = 'fold1'
    let phaseT = 0 // seconds in current phase

    const nextPhase = () => {
      phaseT = 0
      switch (phase) {
        case 'fold1': phase = 'pause1'; break
        case 'pause1': phase = 'fold2'; break
        case 'fold2': phase = 'pause2'; break
        case 'pause2': phase = 'fold3'; break
        case 'fold3': phase = 'pause3'; break
        case 'pause3': phase = 'tile'; break
        case 'tile': phase = 'unfold'; break
        case 'unfold': phase = 'rest'; break
        case 'rest': phase = 'fold1'; break
      }
    }

    const clock = new THREE.Clock()
    let raf = 0

    const animate = () => {
      raf = requestAnimationFrame(animate)
      if (disposedRef.current || !matRef.current) return

      const dt = Math.min(0.05, clock.getDelta())
      const t = clock.elapsedTime
      phaseT += dt

      // Use the latest frame captured via reactivityBus.on
      const low = latest?.bands?.low ?? 0.06
      const mid = latest?.bands?.mid ?? 0.06
      const high = latest?.bands?.high ?? 0.06
      const loud = latest?.loudness ?? 0.12
      const beat = latest?.beat ? 1.0 : 0.0

      const safe = (accessibility.epilepsySafe || accessibility.reducedMotion) ? 1.0 : 0.0
      const setters = makeUniformSetters(matRef)
      setters.setF('uTime', t)
      setters.setV3('uAudio', low, mid, high)
      setters.setF('uBeat', beat)
      setters.setF('uLoud', loud)
      setters.setF('uSafe', safe)

      // Settings to uniforms
      setters.setF('uExposure', cfg.exposure)
      setters.setF('uSaturation', cfg.saturation)
      setters.setF('uGamma', cfg.gamma)
      setters.setF('uVignette', cfg.vignette)
      setters.setF('uFresnel', THREE.MathUtils.lerp(cfg.fresnelStrength, Math.min(cfg.fresnelStrength, 0.22), safe))
      setters.setF('uEdgeTint', cfg.edgeTintStrength)
      setters.setF('uGloss', cfg.paperGloss)
      setters.setF('uBackDark', cfg.backsideDarken)
      setters.setF('uTileIntensity', cfg.tileIntensity)

      // Auto timeline
      let fold1 = (matRef.current.uniforms.uFold1.value as number) || 0
      let fold2 = (matRef.current.uniforms.uFold2.value as number) || 0
      let fold3 = (matRef.current.uniforms.uFold3.value as number) || 0
      let tileMix = (matRef.current.uniforms.uTileMix.value as number) || 0

      const speed = THREE.MathUtils.lerp(cfg.foldSpeed, Math.min(cfg.foldSpeed, 0.5), safe)
      const pause = cfg.foldPause
      const beatSnap = beat > 0.5 ? 0.12 : 0.0 // small snap on beat

      if (cfg.autoPlay) {
        switch (phase) {
          case 'fold1':
            fold1 = Math.min(1, fold1 + dt * (speed * (1.0 + low*1.2) + beatSnap))
            if (fold1 >= 1 && phaseT > 0.2) nextPhase()
            break
          case 'pause1':
            if (phaseT > pause) nextPhase()
            break
          case 'fold2':
            fold2 = Math.min(1, fold2 + dt * (speed * (1.0 + low) + beatSnap))
            if (fold2 >= 1 && phaseT > 0.2) nextPhase()
            break
          case 'pause2':
            if (phaseT > pause) nextPhase()
            break
          case 'fold3':
            fold3 = Math.min(1, fold3 + dt * (speed * (1.0 + low) + beatSnap))
            if (fold3 >= 1 && phaseT > 0.3) nextPhase()
            break
          case 'pause3':
            if (phaseT > Math.max(0.3, pause*0.7)) nextPhase()
            break
          case 'tile':
            tileMix = Math.min(1, tileMix + dt * 0.35)
            if (tileMix >= 1 && phaseT > 1.2) nextPhase()
            break
          case 'unfold':
            // reverse folds
            fold3 = Math.max(0, fold3 - dt * speed)
            if (fold3 <= 0) fold2 = Math.max(0, fold2 - dt * speed * 1.1)
            if (fold2 <= 0 && fold3 <= 0) fold1 = Math.max(0, fold1 - dt * speed * 1.15)
            tileMix = Math.max(0, tileMix - dt * 0.45)
            if (fold1 <= 0 && fold2 <= 0 && fold3 <= 0 && tileMix <= 0 && phaseT > 0.5) nextPhase()
            break
          case 'rest':
            if (phaseT > 0.8 + pause) nextPhase()
            break
        }
      } else {
        // React-only: gentle fold pulsing with bass
        const react = low * 0.65
        fold1 = THREE.MathUtils.lerp(fold1, react, 1 - Math.pow(0.001, dt))
        fold2 = THREE.MathUtils.lerp(fold2, react * 0.8, 1 - Math.pow(0.001, dt))
        fold3 = THREE.MathUtils.lerp(fold3, react * 0.6, 1 - Math.pow(0.001, dt))
        tileMix = THREE.MathUtils.lerp(tileMix, 0.0, 1 - Math.pow(0.01, dt))
      }

      setters.setF('uFold1', fold1)
      setters.setF('uFold2', fold2)
      setters.setF('uFold3', fold3)
      setters.setF('uTileMix', tileMix)

      comp.composer.render()
    }

    animate()

    // Cleanup
    return () => {
      disposedRef.current = true
      window.removeEventListener('resize', onResize)
      cancelAnimationFrame(raf)
      window.clearInterval(albumIv)
      offFrame?.()
      texRef.current?.dispose(); texRef.current = null
      matRef.current = null
      scene.traverse((o: any) => {
        o.geometry?.dispose?.()
        if (Array.isArray(o.material)) o.material.forEach((m: any) => m?.dispose?.())
        else o.material?.dispose?.()
      })
      comp.dispose()
      disposeRenderer()
      renderer.dispose()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quality.renderScale, quality.bloom, accessibility.epilepsySafe, accessibility.reducedMotion, accessibility.highContrast, cfg.vignette, cfg.exposure, cfg.saturation, cfg.gamma])

  const requestPlayInBrowser = () => {
    window.dispatchEvent(new CustomEvent('ffw:play-in-browser'))
  }

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* Top-center HUD */}
      <div
        style={{
          position: 'absolute',
          top: 8, left: '50%', transform: 'translateX(-50%)',
          zIndex: 10, display: 'flex', gap: 8, alignItems: 'center',
          padding: '6px 10px', borderRadius: 10, border: '1px solid rgba(43,47,58,0.9)',
          background: 'rgba(10,12,16,0.82)', color: '#e6f0ff',
          fontFamily: 'system-ui, sans-serif', fontSize: 12, lineHeight: 1.2,
          transition: 'opacity 200ms ease', opacity: (hudVisible || panelOpen) ? 1 : 0,
          pointerEvents: (hudVisible || panelOpen) ? 'auto' : 'none',
          boxShadow: hoverTop ? '0 2px 16px rgba(0,0,0,0.35)' : '0 2px 10px rgba(0,0,0,0.25)'
        }}
        onMouseEnter={() => setHudVisible(true)}
      >
        <button onClick={() => setPanelOpen(o => !o)} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #2b2f3a', background: '#0f1218', color: '#cfe7ff', cursor: 'pointer' }}>
          {panelOpen ? 'Close Visual Settings' : 'Visual Settings'}
        </button>
        <button onClick={requestPlayInBrowser} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #2b2f3a', background: '#0f1218', color: '#b7ffbf', cursor: 'pointer' }}>
          Play in browser
        </button>
      </div>

      <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} aria-label="Origami Fold Visual" />

      {panelOpen && (
        <div style={{ position: 'absolute', top: 56, right: 12, zIndex: 11, width: 360, padding: 12, borderRadius: 8, border: '1px solid #2b2f3a', background: 'rgba(10,12,16,0.94)', color: '#e6f0ff', fontFamily: 'system-ui, sans-serif', fontSize: 12 }}>
          <Section title="Core">
            <Row label="Auto Play">
              <input type="checkbox" checked={cfg.autoPlay} onChange={e => setCfg({ ...cfg, autoPlay: e.currentTarget.checked })} />
            </Row>
            <Slider label={`Fold Speed ${cfg.foldSpeed.toFixed(2)}`} min={0.2} max={2.0} step={0.01} value={cfg.foldSpeed} onChange={(v) => setCfg({ ...cfg, foldSpeed: v })} />
            <Slider label={`Fold Pause ${cfg.foldPause.toFixed(2)}s`} min={0.2} max={2.0} step={0.01} value={cfg.foldPause} onChange={(v) => setCfg({ ...cfg, foldPause: v })} />
            <Slider label={`Tile Intensity ${cfg.tileIntensity.toFixed(2)}`} min={0.0} max={1.0} step={0.01} value={cfg.tileIntensity} onChange={(v) => setCfg({ ...cfg, tileIntensity: v })} />
          </Section>
          <Section title="Look">
            <Slider label={`Exposure ${cfg.exposure.toFixed(2)}`} min={0.6} max={1.6} step={0.01} value={cfg.exposure} onChange={(v) => setCfg({ ...cfg, exposure: v })} />
            <Slider label={`Saturation ${cfg.saturation.toFixed(2)}`} min={0.6} max={1.6} step={0.01} value={cfg.saturation} onChange={(v) => setCfg({ ...cfg, saturation: v })} />
            <Slider label={`Gamma ${cfg.gamma.toFixed(2)}`} min={0.85} max={1.15} step={0.01} value={cfg.gamma} onChange={(v) => setCfg({ ...cfg, gamma: v })} />
            <Slider label={`Vignette ${cfg.vignette.toFixed(2)}`} min={0.0} max={1.0} step={0.01} value={cfg.vignette} onChange={(v) => setCfg({ ...cfg, vignette: v })} />
            <Slider label={`Fresnel ${cfg.fresnelStrength.toFixed(2)}`} min={0.0} max={1.0} step={0.01} value={cfg.fresnelStrength} onChange={(v) => setCfg({ ...cfg, fresnelStrength: v })} />
            <Slider label={`Edge Tint ${cfg.edgeTintStrength.toFixed(2)}`} min={0.0} max={1.0} step={0.01} value={cfg.edgeTintStrength} onChange={(v) => setCfg({ ...cfg, edgeTintStrength: v })} />
            <Slider label={`Paper Gloss ${cfg.paperGloss.toFixed(2)}`} min={0.0} max={0.6} step={0.01} value={cfg.paperGloss} onChange={(v) => setCfg({ ...cfg, paperGloss: v })} />
            <Slider label={`Backside Darken ${cfg.backsideDarken.toFixed(2)}`} min={0.0} max={0.6} step={0.01} value={cfg.backsideDarken} onChange={(v) => setCfg({ ...cfg, backsideDarken: v })} />
          </Section>
        </div>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid #2b2f3a', borderRadius: 8, padding: 10, marginTop: 8 }}>
      <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  )
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, margin: '6px 0' }}>
      <label style={{ fontSize: 12, opacity: 0.9, minWidth: 160 }}>{label}</label>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  )
}
function Slider({ label, min, max, step, value, onChange }: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <Row label={label}>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => {
        const v = Number(e.currentTarget.value)
        if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)))
      }} />
    </Row>
  )
}
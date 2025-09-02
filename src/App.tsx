import React, { Suspense, useEffect, useState } from 'react'
import { Route, Routes, useNavigate } from 'react-router-dom'
import Callback from './auth/Callback'
import PlayerController from './controllers/PlayerController'
const WireframeHouse3D = React.lazy(() => import('./visuals/scenes/WireframeHouse3D'))
const PsyKaleidoTunnel = React.lazy(() => import('./visuals/scenes/PsyKaleidoTunnel'))
import Popup from './ui/Popup'
import QualityPanel from './ui/QualityPanel'
import VJPanel from './ui/VJPanel'
import DevicePicker from './ui/DevicePicker'
import { ThemeManager, setTheme, getTheme, ThemeName, setAlbumSkinEnabled, isAlbumSkinEnabled } from './ui/ThemeManager'
import AlbumSkinWatcher from './ui/AlbumSkinWatcher'
import { getFPS } from './utils/fps'
import { detectGPUInfo } from './utils/gpu'
import { HousePanel, defaultHouseSettings, type HouseSettings } from './ui/HousePanel'
import { startReactivityOrchestrator } from './audio/ReactivityOrchestrator'
import { startFallbackTicker } from './audio/FallbackTicker'
import { PlaybackProvider } from './playback/PlaybackProvider'
import GlobalTopBar from './ui/GlobalTopBar'

type Panel = 'quality' | 'vj' | 'devices' | 'scene' | null

export default function App() {
  const [panel, setPanel] = useState<Panel>(null)
  const [gpu, setGpu] = useState<string>('Detecting GPU...')
  const [fps, setFps] = useState<number>(0)
  const [quality, setQuality] = useState({
    renderScale: 1.0 as 1 | 1.25 | 1.5 | 1.75 | 2,
    msaa: 0 as 0 | 2 | 4 | 8,
    bloom: true,
    motionBlur: false
  })
  const [accessibility, setAccessibility] = useState({
    epilepsySafe: true,
    reducedMotion: false,
    highContrast: false,
    albumSkin: isAlbumSkinEnabled()
  })
  const [theme, setThemeState] = useState<ThemeName>(getTheme())
  const [scene, setScene] = useState<string>(() => {
    const saved = localStorage.getItem('ffw_scene') || 'Wireframe House 3D'
    if (saved === 'Blank' || saved === 'Origami Fold' || saved === 'Wireframe House') return 'Wireframe House 3D'
    return saved
  })
  const [houseSettings, setHouseSettings] = useState<HouseSettings>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('ffw_house_settings') || '{}')
      return { ...defaultHouseSettings, ...saved }
    } catch {
      return defaultHouseSettings
    }
  })

  const navigate = useNavigate()

  useEffect(() => {
    detectGPUInfo().then(setGpu)
    let cancel = false
    const loop = () => { setFps(getFPS()); if (!cancel) requestAnimationFrame(loop) }
    requestAnimationFrame(loop)
    return () => { cancel = true }
  }, [])

  useEffect(() => {
    const stop = startReactivityOrchestrator()
    const stopFallback = startFallbackTicker()
    return () => { stop?.(); stopFallback?.() }
  }, [])

  useEffect(() => {
    setTheme(theme)
  }, [theme])

  function onThemeChange(t: ThemeName) {
    setThemeState(t)
    setTheme(t)
  }

  function onSceneChange(s: string) {
    setScene(s)
    try { localStorage.setItem('ffw_scene', s) } catch {}
  }

  return (
    <PlaybackProvider>
      <GlobalTopBar />
      <PlayerController onOpenDevices={() => setPanel('devices')} />

      <div className="app-root">
        <div className="status-bar">
          <span className="badge">{gpu}</span>
          <span className="badge">{Math.round(fps)} FPS</span>
        </div>
        <ThemeManager />
        <AlbumSkinWatcher />
        <Routes>
          <Route path="/callback" element={<Callback />} />
          <Route path="/*" element={
            <Suspense fallback={<div className="badge" style={{ position: 'absolute', left: 16, top: 72 }}>Loading scene…</div>}>
              {scene === 'Wireframe House 3D' ? (
                <WireframeHouse3D
                  quality={quality}
                  accessibility={{
                    epilepsySafe: accessibility.epilepsySafe,
                    reducedMotion: accessibility.reducedMotion,
                    highContrast: accessibility.highContrast
                  }}
                  settings={houseSettings}
                />
              ) : (
                <PsyKaleidoTunnel
                  quality={quality}
                  accessibility={accessibility}
                />
              )}
            </Suspense>
          } />
        </Routes>

        <div className="cyber-panel" aria-hidden={false}>
          <strong>FFW</strong> — <span style={{ color: 'var(--accent)' }}>Cyber</span> Visualizer
          <span style={{ marginLeft: 8, color: 'var(--muted)' }}>(Q Quality • V VJ • D Devices • S Scene)</span>
          <div style={{ display: 'inline-flex', gap: 8, marginLeft: 10, alignItems: 'center' }}>
            <label htmlFor="scene" style={{ fontSize: 11, color: 'var(--muted)' }}>Scene</label>
            <select id="scene" value={scene} onChange={(e) => onSceneChange(e.currentTarget.value)} title="Scene selector" aria-label="Scene selector">
              <option value="Wireframe House 3D">Wireframe House 3D (Three)</option>
              <option value="Psychedelic Tunnel">Psychedelic Kaleido Tunnel</option>
            </select>

            {scene === 'Wireframe House 3D' && (
              <button className="btn" onClick={() => setPanel('scene')} title="Scene settings" aria-label="Scene settings">⚙️</button>
            )}

            <label htmlFor="theme" style={{ fontSize: 11, color: 'var(--muted)' }}>Theme</label>
            <select id="theme" value={theme} onChange={(e) => onThemeChange(e.currentTarget.value as any)} title="Theme" aria-label="Theme">
              <option value="album">Album (auto)</option>
              <option value="neon">Neon Aqua</option>
              <option value="magenta">Magenta</option>
              <option value="matrix">Matrix</option>
              <option value="sunset">Sunset</option>
              <option value="slate">Slate (readable dark)</option>
              <option value="light">Light (high legibility)</option>
            </select>

            <button className="btn" onClick={() => setPanel('quality')} title="Quality" aria-label="Quality">Q</button>
            <button className="btn" onClick={() => setPanel('vj')} title="VJ / Accessibility" aria-label="VJ / Accessibility">V</button>
            <button className="btn" onClick={() => setPanel('devices')} title="Devices" aria-label="Devices">D</button>
          </div>
        </div>

        <Popup open={panel === 'quality'} onClose={() => setPanel(null)} title="Quality">
          <QualityPanel value={quality} onChange={setQuality as any} />
        </Popup>
        <Popup open={panel === 'vj'} onClose={() => setPanel(null)} title="VJ / Accessibility">
          <VJPanel
            value={{
              epilepsySafe: accessibility.epilepsySafe,
              reducedMotion: accessibility.reducedMotion,
              highContrast: accessibility.highContrast,
              albumSkin: accessibility.albumSkin
            }}
            onChange={(v) => {
              setAccessibility(v)
              setAlbumSkinEnabled(v.albumSkin)
            }}
          />
        </Popup>
        <Popup open={panel === 'devices'} onClose={() => setPanel(null)} title="Spotify Devices">
          <DevicePicker />
        </Popup>
        <Popup open={panel === 'scene'} onClose={() => setPanel(null)} title="House Settings">
          <HousePanel value={houseSettings} onChange={(v) => {
            setHouseSettings(v)
            try { localStorage.setItem('ffw_house_settings', JSON.stringify(v)) } catch {}
          }} />
        </Popup>
      </div>
    </PlaybackProvider>
  )
}
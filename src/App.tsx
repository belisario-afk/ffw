import React, { Suspense, useEffect, useState } from 'react'
import { Route, Routes, useNavigate } from 'react-router-dom'
import { loginWithSpotify, restoreFromStorage, type AuthState, signOut } from './auth/token'
import Callback from './auth/Callback'
import PlayerController from './controllers/PlayerController'
import BlankScene from './visuals/scenes/BlankScene'
const WireframeHouse = React.lazy(() => import('./visuals/scenes/WireframeHouse'))
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

type Panel = 'quality' | 'vj' | 'devices' | 'scene' | null

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(restoreFromStorage())
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
  const [scene, setScene] = useState<string>(() => localStorage.getItem('ffw_scene') || 'Blank')
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
    document.documentElement.style.setProperty('--contrast', accessibility.highContrast ? '1.2' : '1')
    document.documentElement.classList.toggle('album-skin', accessibility.albumSkin)
    setAlbumSkinEnabled(accessibility.albumSkin)
  }, [accessibility.highContrast, accessibility.albumSkin])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'q') setPanel(p => p === 'quality' ? null : 'quality')
      if (e.key === 'v') setPanel(p => p === 'vj' ? null : 'vj')
      if (e.key === 'd') setPanel(p => p === 'devices' ? null : 'devices')
      if (e.key === 's') setPanel(p => p === 'scene' ? null : 'scene')
      if (e.key === 'Escape') setPanel(null)
      if (e.key === 'l' && !auth) handleLogin()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [auth])

  useEffect(() => {
    localStorage.setItem('ffw_house_settings', JSON.stringify(houseSettings))
  }, [houseSettings])

  // Start reactivity engines
  useEffect(() => {
    const stopOrch = startReactivityOrchestrator()
    const stopFallback = startFallbackTicker({ maxStaleMs: 250, fps: 60 })
    return () => { stopOrch(); stopFallback() }
  }, [])

  function handleLogin() { loginWithSpotify({ scopes: defaultScopes() }) }
  function handleSignOut() { signOut(); setAuth(null); navigate('/'); location.reload() }

  function onThemeChange(t: ThemeName) {
    setThemeState(t)
    setTheme(t)
    // If picking "album" theme, auto-enable album skin; otherwise keep the user's toggle
    if (t === 'album' && !accessibility.albumSkin) {
      setAccessibility(a => ({ ...a, albumSkin: true }))
    }
  }

  function onSceneChange(v: string) {
    setScene(v)
    localStorage.setItem('ffw_scene', v)
  }

  return (
    <div className="app-shell" role="application" aria-label="FFW Visualizer">
      <div className="canvas-wrap">
        <div className="hud">
          <div className="badge" aria-live="polite">FPS: {Math.round(fps)}</div>
          <div className="badge" title="GPU info">{gpu}</div>
        </div>
        <ThemeManager />
        <AlbumSkinWatcher />
        <Routes>
          <Route path="/callback" element={<Callback onAuth={a => setAuth(a)} />} />
          <Route path="/*" element={
            <Suspense fallback={<div className="badge" style={{ position: 'absolute', left: 16, top: 72 }}>Loading scene…</div>}>
              {scene === 'Wireframe House' ? (
                <WireframeHouse
                  auth={auth}
                  quality={quality}
                  accessibility={{
                    epilepsySafe: accessibility.epilepsySafe,
                    reducedMotion: accessibility.reducedMotion,
                    highContrast: accessibility.highContrast
                  }}
                  settings={houseSettings}
                />
              ) : (
                <BlankScene auth={auth} quality={quality} accessibility={accessibility} />
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
              <option value="Blank">Blank</option>
              <option value="Wireframe House">Wireframe House</option>
            </select>

            {scene === 'Wireframe House' && (
              <button className="btn" onClick={() => setPanel('scene')} title="Scene settings" aria-label="Scene settings">⚙️</button>
            )}

            <label htmlFor="theme" style={{ fontSize: 11, color: 'var(--muted)' }}>Theme</label>
            <select id="theme" value={theme} onChange={(e) => onThemeChange(e.currentTarget.value as ThemeName)} title="Theme" aria-label="Theme">
              <option value="album">Album (auto)</option>
              <option value="neon">Neon Aqua</option>
              <option value="magenta">Magenta</option>
              <option value="matrix">Matrix</option>
              <option value="sunset">Sunset</option>
              <option value="slate">Slate (readable dark)</option>
              <option value="light">Light (high legibility)</option>
              <option value="hcpro">High Contrast Pro</option>
            </select>

            {!auth ? (
              <button className="btn primary" onClick={handleLogin} aria-label="Login with Spotify">Login</button>
            ) : (
              <button className="btn" onClick={handleSignOut} aria-label="Sign out">Sign out</button>
            )}
          </div>
        </div>
      </div>

      <PlayerController auth={auth} onOpenDevices={() => setPanel('devices')} />

      <Popup open={panel === 'quality'} title="Quality" onClose={() => setPanel(null)}>
        <QualityPanel value={quality} onChange={setQuality} />
      </Popup>

      <Popup open={panel === 'vj'} title="VJ / Accessibility" onClose={() => setPanel(null)}>
        <VJPanel value={accessibility} onChange={setAccessibility} />
      </Popup>

      <Popup open={panel === 'scene'} title="Wireframe House" onClose={() => setPanel(null)}>
        <HousePanel value={houseSettings} onChange={setHouseSettings} />
      </Popup>

      <Popup open={panel === 'devices'} title="Devices" onClose={() => setPanel(null)}>
        <DevicePicker auth={auth} onDone={() => setPanel(null)} />
      </Popup>
    </div>
  )
}

function defaultScopes(): string[] {
  return [
    'streaming',
    'user-read-email',
    'user-read-private',
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing'
  ]
}
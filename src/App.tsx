import React, { useEffect, useMemo, useState } from 'react'
import { Route, Routes, useNavigate } from 'react-router-dom'
import { loginWithSpotify, restoreFromStorage, type AuthState, signOut } from './auth/token'
import Callback from './auth/Callback'
import PlayerController from './controllers/PlayerController'
import BlankScene from './visuals/scenes/BlankScene'
import Popup from './ui/Popup'
import QualityPanel from './ui/QualityPanel'
import VJPanel from './ui/VJPanel'
import DevicePicker from './ui/DevicePicker'
import { ThemeManager } from './ui/ThemeManager'
import { getFPS } from './utils/fps'
import { detectGPUInfo } from './utils/gpu'

type Panel = 'quality' | 'vj' | 'devices' | null

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
    highContrast: false
  })

  const navigate = useNavigate()

  useEffect(() => {
    detectGPUInfo().then(setGpu)
    let cancel = false
    const loop = () => {
      setFps(getFPS())
      if (!cancel) requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
    return () => { cancel = true }
  }, [])

  useEffect(() => {
    document.documentElement.style.setProperty('--contrast', accessibility.highContrast ? '1.2' : '1')
    document.documentElement.style.setProperty('--motion-scale', accessibility.reducedMotion ? '0.5' : '1')
  }, [accessibility])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'q') setPanel(p => p === 'quality' ? null : 'quality')
      if (e.key === 'v') setPanel(p => p === 'vj' ? null : 'vj')
      if (e.key === 'd') setPanel(p => p === 'devices' ? null : 'devices')
      if (e.key === 'Escape') setPanel(null)
      if (e.key === 'l' && !auth) handleLogin()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [auth])

  function handleLogin() {
    loginWithSpotify({ scopes: defaultScopes() })
  }

  function handleSignOut() {
    signOut()
    setAuth(null)
    navigate('/')
    location.reload()
  }

  return (
    <div className="app-shell" role="application" aria-label="FFW Visualizer">
      <div className="canvas-wrap">
        <div className="hud">
          <div className="badge" aria-live="polite">FPS: {Math.round(fps)}</div>
          <div className="badge" title="GPU info">{gpu}</div>
        </div>
        <ThemeManager />
        <Routes>
          <Route path="/callback" element={<Callback onAuth={a => setAuth(a)} />} />
          <Route path="/*" element={
            <BlankScene
              auth={auth}
              quality={quality}
              accessibility={accessibility}
            />
          } />
        </Routes>
        <div className="cyber-panel" aria-hidden={false}>
          <strong>FFW</strong> — <span style={{ color: 'var(--accent)' }}>Cyber</span> Visualizer
          {!auth ? (
            <button className="btn primary" style={{ marginLeft: 10 }} onClick={handleLogin} aria-label="Login with Spotify">Login</button>
          ) : (
            <button className="btn" style={{ marginLeft: 10 }} onClick={handleSignOut} aria-label="Sign out">Sign out</button>
          )}
          <span style={{ marginLeft: 8, color: 'var(--muted)' }}>(Press Q, V, D)</span>
        </div>
      </div>

      <PlayerController auth={auth} onOpenDevices={() => setPanel('devices')} />

      <Popup open={panel === 'quality'} title="Quality" onClose={() => setPanel(null)}>
        <QualityPanel
          value={quality}
          onChange={setQuality}
        />
      </Popup>

      <Popup open={panel === 'vj'} title="VJ / Accessibility" onClose={() => setPanel(null)}>
        <VJPanel
          value={accessibility}
          onChange={setAccessibility}
        />
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
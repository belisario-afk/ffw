import React, { useEffect, useState } from 'react'
import { bootstrapAuthFromHash, getAccessToken, ensureAuth } from '../auth/spotifyAuth'
import { loadWebPlaybackSDK } from '../spotify/sdk'
import { ensurePlayerConnected } from '../spotify/player'
import { transferPlaybackToDevice } from '../spotify/connect'

type Props = { activeVisualKey?: string }

export default function TopBar({ activeVisualKey = 'wireframe3d' }: Props) {
  const [token, setToken] = useState<string | null>(null)
  const [status, setStatus] = useState<string>('')

  useEffect(() => {
    bootstrapAuthFromHash()
    setToken(getAccessToken())
  }, [])

  const signIn = () => {
    setStatus('')
    ensureAuth()
  }

  const playInBrowser = async () => {
    setStatus('')
    try {
      const t = getAccessToken()
      if (!t) { setStatus('Sign in first'); return }
      await loadWebPlaybackSDK()
      const { player, deviceId } = await ensurePlayerConnected({ deviceName: 'FFw visualizer', setInitialVolume: true })
      try { await (player as any).activateElement?.() } catch {}
      let id = deviceId as string | null
      if (!id) {
        id = await new Promise<string | null>((resolve) => {
          const onReady = ({ device_id }: any) => resolve(device_id || null)
          try { (player as any).addListener?.('ready', onReady) } catch { resolve(null) }
          setTimeout(() => resolve(null), 5000)
        })
      }
      if (!id) { setStatus('Player connected. Select “FFw visualizer” in Spotify app.'); return }
      await transferPlaybackToDevice({ deviceId: id, play: true })
      setStatus('Playing in browser.')
    } catch (e: any) {
      console.error(e)
      setStatus(e?.message || 'Failed to enable browser playback')
    }
  }

  const openSettings = () => {
    const evt = activeVisualKey === 'wireframe3d'
      ? 'ffw:open-wireframe3d-settings'
      : 'ffw:open-wireframe-settings'
    window.dispatchEvent(new CustomEvent(evt))
  }

  return (
    <div style={{
      position: 'absolute', top: 0, left: 0, right: 0, height: 44,
      display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
      gap: 8, padding: '0 12px', pointerEvents: 'none', zIndex: 50
    }}>
      {!token ? (
        <button onClick={signIn} style={btn}>Sign in with Spotify</button>
      ) : (
        <button onClick={playInBrowser} style={btn}>▶ Play in Browser</button>
      )}
      <button onClick={openSettings} style={btn}>⚙︎ Settings</button>
      {!!status && <div style={{ pointerEvents: 'none', color: '#b9d6ff', fontSize: 12, marginLeft: 8 }}>{status}</div>}
    </div>
  )
}

const btn: React.CSSProperties = {
  pointerEvents: 'auto',
  height: 28,
  padding: '0 10px',
  borderRadius: 6,
  border: '1px solid #2b2f3a',
  background: 'rgba(10,12,16,0.8)',
  color: '#cfe7ff',
  cursor: 'pointer',
  fontSize: 13,
}
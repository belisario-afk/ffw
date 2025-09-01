import React, { useState } from 'react'
import { loadWebPlaybackSDK } from '../spotify/sdk'
import { ensurePlayerConnected, hasSpotifyTokenProvider } from '../spotify/player'
import { transferPlaybackToDevice } from '../spotify/connect'

type Props = {
  activeVisualKey: string // e.g., 'wireframehouse' | 'wireframe3d'
  className?: string
}

export default function TopBar({ activeVisualKey, className }: Props) {
  const [status, setStatus] = useState<string>('')

  const openSettings = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (activeVisualKey === 'wireframe3d') {
      window.dispatchEvent(new CustomEvent('ffw:open-wireframe3d-settings'))
    } else {
      window.dispatchEvent(new CustomEvent('ffw:open-wireframe-settings'))
    }
  }

  const enableBrowserPlayback = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setStatus('')

    try {
      if (!hasSpotifyTokenProvider()) {
        setStatus('Sign in required: no Spotify token provider.')
        console.warn('TopBar: Missing Spotify token provider.')
        return
      }

      // Load SDK if needed
      setStatus('Loading Spotify SDK…')
      await loadWebPlaybackSDK()

      // Connect player
      setStatus('Connecting player…')
      const { player, deviceId } = await ensurePlayerConnected({
        deviceName: 'FFw visualizer',
        setInitialVolume: false
      })

      // Activate audio element (user gesture requirement)
      try {
        // Newer SDKs require activation to comply with autoplay policy
        await (player as any).activateElement?.()
      } catch (err) {
        console.warn('activateElement failed or not supported:', err)
      }

      // Wait for deviceId if not present yet
      let id = deviceId as string | null
      if (!id) {
        id = await new Promise<string | null>((resolve) => {
          const onReady = ({ device_id }: any) => {
            try { (player as any).removeListener?.('ready', onReady) } catch {}
            resolve(device_id || null)
          }
          try { (player as any).addListener?.('ready', onReady) } catch { resolve(null) }
          setTimeout(() => resolve(null), 5000)
        })
      }

      if (!id) {
        setStatus('Player connected, but device ID not available yet. Open Spotify device picker to select “FFw visualizer”.')
        return
      }

      // Transfer playback to the browser device
      setStatus('Transferring playback…')
      await transferPlaybackToDevice({ deviceId: id, play: true })

      setStatus('Browser playback enabled on “FFw visualizer”.')
    } catch (err: any) {
      console.error('Enable browser playback failed:', err)
      setStatus(err?.message || 'Failed to enable browser playback')
    }
  }

  return (
    <div
      className={className}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 44,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 8,
        padding: '0 12px',
        pointerEvents: 'none',
        zIndex: 20,
      }}
    >
      <button
        onClick={enableBrowserPlayback}
        aria-label="Enable browser playback"
        style={btn}
      >
        ▶ Play in Browser
      </button>
      <button
        onClick={openSettings}
        aria-label="Open settings"
        style={btn}
      >
        ⚙︎ Settings
      </button>
      {!!status && (
        <div style={{ pointerEvents: 'none', color: '#b9d6ff', fontSize: 12, marginLeft: 8 }}>
          {status}
        </div>
      )}
    </div>
  )
}

const btn: React.CSSProperties = {
  pointerEvents: 'auto',
  height: 28,
  padding: '0 10px',
  borderRadius: 6,
  border: '1px solid #2b2f3a',
  background: 'rgba(10,12,16,0.75)',
  color: '#cfe7ff',
  cursor: 'pointer',
  fontSize: 13,
}
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { loginWithSpotify, type AuthState } from '../auth/token'
import { ensurePlayerConnected, hasSpotifyTokenProvider } from '../spotify/player'

type Props = {
  auth: AuthState | null
}

/**
Safe transport controller:
- If no token: disable transport, prompt to sign in.
- If token: call Spotify Web API directly with fetch (avoids throwing from api.ts when token is missing).
- Throttle clicks to reduce double-requests and "delayed" feel.
- Listens for 'ffw:play-in-browser' to connect the Web Playback SDK device.
*/

export default function PlayerController({ auth }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastClickRef = useRef(0)
  const hasToken = !!auth?.access_token

  // Prefer the freshest token each call
  const token = auth?.access_token || ''

  const throttle = (ms: number) => {
    const now = performance.now()
    if (now - lastClickRef.current < ms) return false
    lastClickRef.current = now
    return true
  }

  function guard(): string | null {
    if (!hasToken) return 'You are not signed in with Spotify'
    return null
  }

  async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: any) {
    if (!token) throw new Error('No access token')
    const res = await fetch(`https://api.spotify.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    })
    if (res.status === 204) return null
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Spotify API ${res.status}: ${text || res.statusText}`)
    }
    return await res.json().catch(() => null)
  }

  const onPlayPause = async () => {
    if (!throttle(250)) return
    const g = guard()
    if (g) { setError(g); return }
    setBusy(true); setError(null)
    try {
      // Check current state to toggle
      const me = await call('GET', '/me/player').catch(() => null)
      const isPlaying = !!me?.is_playing
      if (isPlaying) await call('PUT', '/me/player/pause')
      else await call('PUT', '/me/player/play')
    } catch (e: any) {
      setError(humanizeError(e))
    } finally {
      setBusy(false)
    }
  }
  const onPrev = async () => {
    if (!throttle(250)) return
    const g = guard()
    if (g) { setError(g); return }
    setBusy(true); setError(null)
    try {
      await call('POST', '/me/player/previous')
    } catch (e: any) {
      setError(humanizeError(e))
    } finally {
      setBusy(false)
    }
  }
  const onNext = async () => {
    if (!throttle(250)) return
    const g = guard()
    if (g) { setError(g); return }
    setBusy(true); setError(null)
    try {
      await call('POST', '/me/player/next')
    } catch (e: any) {
      setError(humanizeError(e))
    } finally {
      setBusy(false)
    }
  }

  // Handle "Play in browser" requests coming from scenes
  useEffect(() => {
    const onPlayInBrowser = async () => {
      if (!hasToken) {
        setError('Sign in with Spotify to enable Web Playback')
        return
      }
      try {
        await ensurePlayerConnected({ deviceName: 'FFW Visualizer', setInitialVolume: true })
        // Transfer to the in-page device (the helper may already do this in your implementation)
        // If you need explicit transfer, you can add it here by fetching /me/player with device_id.
      } catch (e: any) {
        console.warn('ensurePlayerConnected failed:', e)
        setError('Could not start Web Playback in browser')
      }
    }
    window.addEventListener('ffw:play-in-browser', onPlayInBrowser as EventListener)
    return () => window.removeEventListener('ffw:play-in-browser', onPlayInBrowser as EventListener)
  }, [hasToken])

  // Small floating control strip (optional). If you already have transport elsewhere, keep this hidden or adapt.
  return (
    <div
      aria-hidden={false}
      style={{
        position: 'absolute',
        bottom: 12,
        left: 12,
        zIndex: 20,
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        padding: '8px 10px',
        borderRadius: 10,
        border: '1px solid rgba(43,47,58,0.9)',
        background: 'rgba(10,12,16,0.75)',
        color: '#e6f0ff',
        fontFamily: 'system-ui, sans-serif',
        fontSize: 12,
        lineHeight: 1.2,
        pointerEvents: 'auto'
      }}
    >
      {!hasToken ? (
        <>
          <span style={{ opacity: 0.8 }}>Not signed in</span>
          <button
            onClick={() => loginWithSpotify().catch(e => setError(humanizeError(e)))}
            style={btnStyle('#b7ffbf')}
          >
            Sign in to Spotify
          </button>
        </>
      ) : (
        <>
          <button onClick={onPrev} disabled={busy} style={btnStyle('#cfe7ff')}>⏮ Prev</button>
          <button onClick={onPlayPause} disabled={busy} style={btnStyle('#b7ffbf')}>{busy ? 'Working…' : '⏯ Play/Pause'}</button>
          <button onClick={onNext} disabled={busy} style={btnStyle('#cfe7ff')}>⏭ Next</button>
        </>
      )}
      {error && <span style={{ color: '#ffb3b3', marginLeft: 8, maxWidth: 260, textWrap: 'pretty' }}>{error}</span>}
    </div>
  )
}

function btnStyle(color: string): React.CSSProperties {
  return {
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid #2b2f3a',
    background: '#0f1218',
    color,
    cursor: 'pointer'
  }
}

function humanizeError(e: any): string {
  const msg = (e && (e.message || e.toString?.())) || 'Unexpected error'
  // Common causes
  if (/No access token/i.test(msg)) return 'Not signed in with Spotify'
  if (/401/.test(msg)) return 'Spotify session expired — please sign in again'
  if (/403/.test(msg)) return 'Spotify refused the action (check Premium / device)'
  if (/404/.test(msg)) return 'No active Spotify device found'
  return msg
}
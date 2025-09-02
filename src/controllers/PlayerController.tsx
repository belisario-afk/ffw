import React, { useEffect, useRef, useState } from 'react'
import { usePlayback } from '../playback/PlaybackProvider'

type Props = {
  onOpenDevices: () => void
}

type RepeatMode = 'off' | 'context' | 'track'

function mmss(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const ss = s % 60
  return `${m}:${ss.toString().padStart(2, '0')}`
}

export default function PlayerController({ onOpenDevices }: Props) {
  const { token, isSignedIn, signIn, playInBrowser } = usePlayback()
  const hasToken = !!token
  const bearer = token || ''

  // Playback state
  const [state, setState] = useState<any | null>(null)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [shuffle, setShuffle] = useState(false)
  const [repeat, setRepeat] = useState<RepeatMode>('off')
  const [volume, setVolume] = useState(70)

  // UI
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scrubbing, setScrubbing] = useState(false)

  const lastClickRef = useRef(0)
  const throttle = (ms: number) => {
    const now = performance.now()
    if (now - lastClickRef.current < ms) return false
    lastClickRef.current = now
    return true
  }

  async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: any) {
    if (!bearer) throw new Error('No access token')
    const url = `https://api.spotify.com/v1${path}`
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    })
    if (res.status === 204) return null
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Spotify API ${res.status}: ${text || res.statusText}`)
    }
    return await res.json().catch(() => null)
  }

  async function refresh() {
    if (!hasToken) return
    try {
      const me = await call('GET', '/me/player').catch(() => null)
      if (!me) return
      setState(me)
      const pos = me.progress_ms || 0
      const dur = me.item?.duration_ms || 0
      setDuration(dur)
      if (!scrubbing) setPosition(pos)
      if (typeof me.shuffle_state === 'boolean') setShuffle(!!me.shuffle_state)
      if (me.repeat_state) setRepeat(me.repeat_state as RepeatMode)
      if (typeof me.device?.volume_percent === 'number') setVolume(me.device.volume_percent)
    } catch (e: any) {
      if (!/401/.test(String(e))) setError(humanizeError(e))
    }
  }

  // Initial and periodic refresh
  useEffect(() => { refresh() }, [hasToken])
  useEffect(() => {
    if (!hasToken) return
    const id = setInterval(refresh, 5000)
    return () => clearInterval(id)
  }, [hasToken])

  // Progress tick while playing
  useEffect(() => {
    if (!state?.is_playing || scrubbing) return
    const id = setInterval(() => {
      setPosition(p => Math.min(duration, p + 1000))
    }, 1000)
    return () => clearInterval(id)
  }, [state?.is_playing, scrubbing, duration])

  // Actions
  const doTogglePlay = async () => {
    if (!hasToken || !throttle(250)) return
    setBusy(true); setError(null)
    try {
      const me = await call('GET', '/me/player').catch(() => null)
      const isPlaying = !!me?.is_playing
      if (isPlaying) await call('PUT', '/me/player/pause')
      else await call('PUT', '/me/player/play')
      await refresh()
    } catch (e: any) { setError(humanizeError(e)) } finally { setBusy(false) }
  }
  const doPrev = async () => {
    if (!hasToken || !throttle(250)) return
    setBusy(true); setError(null)
    try { await call('POST', '/me/player/previous'); await refresh() }
    catch (e: any) { setError(humanizeError(e)) } finally { setBusy(false) }
  }
  const doNext = async () => {
    if (!hasToken || !throttle(250)) return
    setBusy(true); setError(null)
    try { await call('POST', '/me/player/next'); await refresh() }
    catch (e: any) { setError(humanizeError(e)) } finally { setBusy(false) }
  }
  const doSeek = async (ms: number) => {
    if (!hasToken) return
    setPosition(ms)
    try { await call('PUT', `/me/player/seek?position_ms=${Math.max(0, Math.min(duration, Math.floor(ms)))}`) }
    catch (e: any) { setError(humanizeError(e)) }
  }
  const doShuffle = async (val: boolean) => {
    if (!hasToken) return
    setShuffle(val)
    try { await call('PUT', `/me/player/shuffle?state=${val ? 'true' : 'false'}`) }
    catch (e: any) { setError(humanizeError(e)) }
  }
  const doRepeat = async () => {
    if (!hasToken) return
    const order: RepeatMode[] = ['off', 'context', 'track']
    const next = order[(order.indexOf(repeat) + 1) % order.length]
    setRepeat(next)
    try { await call('PUT', `/me/player/repeat?state=${next}`) }
    catch (e: any) { setError(humanizeError(e)) }
  }
  const doVol = async (vol: number) => {
    if (!hasToken) return
    setVolume(vol)
    try { await call('PUT', `/me/player/volume?volume_percent=${Math.max(0, Math.min(100, Math.round(vol)))}`) }
    catch (e: any) { setError(humanizeError(e)) }
  }

  const cover = state?.item?.album?.images?.[0]?.url as string | undefined
  const title = state?.item?.name as string | undefined
  const artist = (state?.item?.artists?.map((a: any) => a.name)?.join(', ')) as string | undefined
  const isPlaying = !!state?.is_playing

  return (
    <div
      role="region"
      aria-label="Spotify transport"
      style={{
        position: 'absolute',
        left: 0, right: 0, bottom: 0,
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 12px',
        background: 'linear-gradient(180deg, rgba(8,10,14,0.0), rgba(8,10,14,0.85))',
        color: '#e6f0ff',
        fontFamily: 'system-ui, sans-serif',
        pointerEvents: 'auto'
      }}
    >
      {/* Album art */}
      <div style={{ width: 54, height: 54, borderRadius: 8, overflow: 'hidden', background: '#0f1218', border: '1px solid #2b2f3a', flex: '0 0 auto' }}>
        {cover ? (
          <img alt="Album cover" src={cover} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', color: '#6b7e99' }}>No cover</div>
        )}
      </div>

      {/* Title/artist and progress */}
      <div style={{ minWidth: 0, flex: '1 1 auto' }}>
        <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {title || '—'}
        </div>
        <div style={{ fontSize: 12, opacity: 0.8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {artist || '—'}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <span style={{ fontSize: 11, color: '#9bb3cc', minWidth: 36, textAlign: 'right' }}>{mmss(position)}</span>
          <input
            type="range"
            min={0}
            max={Math.max(1, duration)}
            step={500}
            value={Math.min(position, duration)}
            onMouseDown={() => setScrubbing(true)}
            onMouseUp={() => setScrubbing(false)}
            onChange={(e) => setPosition(Number(e.currentTarget.value))}
            onBlur={() => setScrubbing(false)}
            onKeyUp={(e) => { if (e.key === 'Enter') doSeek(position) }}
            onPointerUp={() => doSeek(position)}
            style={{ flex: 1 }}
            disabled={!hasToken}
            aria-label="Seek"
          />
          <span style={{ fontSize: 11, color: '#9bb3cc', minWidth: 36 }}>{mmss(duration)}</span>
        </div>
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }}>
        {!isSignedIn ? (
          <button onClick={signIn} style={btnStyle('#b7ffbf')}>Sign in to Spotify</button>
        ) : (
          <>
            <button onClick={doPrev} disabled={busy} style={btnStyle('#cfe7ff')} title="Previous">⏮</button>
            <button onClick={doTogglePlay} disabled={busy} style={btnStyle('#b7ffbf')} title="Play/Pause">
              {isPlaying ? '⏸' : '▶️'}
            </button>
            <button onClick={doNext} disabled={busy} style={btnStyle('#cfe7ff')} title="Next">⏭</button>

            <button onClick={() => doShuffle(!shuffle)} disabled={busy} style={btnToggle(shuffle)} title="Shuffle">🔀</button>
            <button onClick={doRepeat} disabled={busy} style={btnToggle(repeat !== 'off')} title={`Repeat: ${repeat}`}>🔁</button>

            <button onClick={onOpenDevices} style={btnStyle('#cfe7ff')} title="Devices">🖧</button>
            <button onClick={playInBrowser} style={btnStyle('#cfe7ff')} title="Play in browser">▶</button>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 180 }}>
              <span title="Volume">🔊</span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={volume}
                onChange={(e) => setVolume(Number(e.currentTarget.value))}
                onPointerUp={() => doVol(volume)}
                onKeyUp={(e) => { if (e.key === 'Enter') doVol(volume) }}
                disabled={!hasToken}
                aria-label="Volume"
                style={{ width: 140 }}
              />
              <span style={{ width: 28, textAlign: 'right', fontSize: 12, color: '#9bb3cc' }}>{Math.round(volume)}%</span>
            </div>
          </>
        )}
      </div>

      {error && <div style={{ color: '#ffb3b3', marginLeft: 8, maxWidth: 320, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{error}</div>}
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
function btnToggle(active: boolean): React.CSSProperties {
  return {
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid #2b2f3a',
    background: active ? '#16202e' : '#0f1218',
    color: active ? '#b7ffbf' : '#cfe7ff',
    cursor: 'pointer'
  }
}
function humanizeError(e: any): string {
  const msg = (e && (e.message || e.toString?.())) || 'Unexpected error'
  if (/No access token/i.test(msg)) return 'Not signed in with Spotify'
  if (/401/.test(msg)) return 'Spotify session expired — please sign in again'
  if (/403/.test(msg)) return 'Spotify refused the action (check Premium / device)'
  if (/404/.test(msg)) return 'No active Spotify device found'
  return msg
}
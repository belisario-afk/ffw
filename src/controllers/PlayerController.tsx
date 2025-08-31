import React, { useEffect, useRef, useState } from 'react'
import type { AuthState } from '../auth/token'
import { getPlaybackState, nextTrack, pause, prevTrack, resume, seek, setRepeat, setShuffle, setVolume } from '../spotify/api'
import { mmss } from '../utils/time'
import { useInterval } from '../utils/useInterval'

// expose SDK player if available (set by spotify/player.ts)
function getSDKPlayer(): Spotify.Player | null {
  return (window as any).__ffwPlayer?.player || null
}

export default function PlayerController({ auth, onOpenDevices }: { auth: AuthState | null, onOpenDevices: () => void }) {
  const [state, setState] = useState<any | null>(null)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVol] = useState(70)
  const [shuffle, setShuf] = useState(false)
  const [repeat, setRep] = useState<'off' | 'context' | 'track'>('off')

  const [isScrubbing, setIsScrubbing] = useState(false)
  const [scrubValue, setScrubValue] = useState(0)
  const scrubCommitRef = useRef<number | null>(null)

  async function refresh() {
    if (!auth) return
    const s = await getPlaybackState().catch(() => null)
    if (s) {
      setState(s)
      const pos = s.progress_ms || 0
      const dur = s.item?.duration_ms || 0
      setDuration(dur)
      if (!isScrubbing) setPosition(pos)
      if (typeof s.shuffle_state === 'boolean') setShuf(!!s.shuffle_state)
      if (s.repeat_state) setRep(s.repeat_state)
      if (typeof s.device?.volume_percent === 'number') setVol(s.device.volume_percent)
    }
  }

  useEffect(() => { refresh() }, [auth])

  // Progress timer while playing
  useInterval(() => {
    if (!state?.is_playing || isScrubbing) return
    setPosition(p => Math.min(duration, p + 1000))
  }, state?.is_playing ? 1000 : null)

  // Periodic refresh to stay in sync
  useInterval(() => { refresh() }, auth ? 5000 : null)

  useEffect(() => {
    const onVis = () => { if (!document.hidden) refresh() }
    document.addEventListener('visibilitychange', onVis)
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) { e.preventDefault(); togglePlay() }
      if (e.key === 'ArrowLeft') doSeek(Math.max(0, position - 5000))
      if (e.key === 'ArrowRight') doSeek(Math.min(duration, position + 5000))
      if (e.key === '+' || e.key === '=') changeVolumeUI(Math.min(100, volume + 5))
      if (e.key === '-' || e.key === '_') changeVolumeUI(Math.max(0, volume - 5))
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('keydown', onKey)
    }
  }, [position, duration, volume, state])

  async function togglePlay() {
    if (!state) { await refresh(); return }
    try {
      const sdk = getSDKPlayer()
      if (sdk) {
        await sdk.togglePlay()
      } else {
        if (state.is_playing) await pause()
        else await resume()
      }
    } catch {
      try {
        if (state.is_playing) await pause()
        else await resume()
      } catch {}
    } finally {
      await sleep(300)
      await refresh()
    }
  }

  async function doSeek(ms: number) {
    setPosition(ms)
    try {
      const sdk = getSDKPlayer()
      if (sdk) await sdk.seek(ms)
      else await seek(ms)
    } finally {
      await sleep(150)
      refresh()
    }
  }

  async function commitSeek(ms: number) {
    if (scrubCommitRef.current) {
      clearTimeout(scrubCommitRef.current)
      scrubCommitRef.current = null
    }
    scrubCommitRef.current = window.setTimeout(() => doSeek(ms), 80)
  }

  async function changeVolumeUI(v: number) {
    setVol(v)
    try {
      const sdk = getSDKPlayer()
      if (sdk) await sdk.setVolume(Math.max(0, Math.min(1, v / 100)))
      else await setVolume(v)
    } catch {}
  }

  async function toggleShuffle() {
    const ns = !shuffle
    await setShuffle(ns).catch(() => {})
    setShuf(ns)
    await refresh()
  }

  async function cycleRepeat() {
    const order: Array<'off' | 'context' | 'track'> = ['off', 'context', 'track']
    const idx = (order.indexOf(repeat) + 1) % order.length
    const next = order[idx]
    await setRepeat(next).catch(() => {})
    setRep(next)
    await refresh()
  }

  const progressValue = isScrubbing ? scrubValue : position

  return (
    <div className="control-bar" role="region" aria-label="Player controls">
      <div className="track-meta">
        {state?.item?.album?.images?.[2]?.url ? (
          <img src={state.item.album.images[2].url} alt="" />
        ) : <div style={{ width: 48, height: 48, borderRadius: 8, background: 'rgba(255,255,255,0.06)', border: '1px solid var(--panel-border)' }} />}
        <div>
          <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {state?.item?.name || 'Not playing'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {(state?.item?.artists || []).map((a: any) => a.name).join(', ')}
          </div>
        </div>
      </div>

      <div className="controls" role="group" aria-label="Transport">
        <button className="btn" onClick={() => prevTrack().then(() => sleep(200)).then(refresh)} aria-label="Previous track">⏮</button>
        <button className="btn primary" onClick={togglePlay} aria-label={state?.is_playing ? 'Pause' : 'Play'}>{state?.is_playing ? '⏸' : '▶️'}</button>
        <button className="btn" onClick={() => nextTrack().then(() => sleep(200)).then(refresh)} aria-label="Next track">⏭</button>
        <button className="btn" onClick={toggleShuffle} aria-pressed={shuffle} aria-label="Toggle shuffle">🔀</button>
        <button className="btn" onClick={cycleRepeat} aria-label={`Repeat: ${repeat}`}>🔁 {repeat === 'track' ? '1' : repeat === 'context' ? '∞' : ''}</button>
      </div>

      <div className="progress-wrap" style={{ minWidth: 300 }}>
        <input
          className="slider"
          type="range"
          min={0}
          max={duration || 1}
          step={500}
          value={progressValue}
          onChange={(e) => { const v = Number(e.currentTarget.value); setIsScrubbing(true); setScrubValue(v) }}
          onMouseUp={() => { setIsScrubbing(false); commitSeek(scrubValue) }}
          onTouchEnd={() => { setIsScrubbing(false); commitSeek(scrubValue) }}
          aria-label="Seek"
        />
        <div className="progress-labels">
          <span>{mmss(progressValue)}</span>
          <span>{mmss(duration)}</span>
        </div>
      </div>

      <div className="right-controls">
        <span aria-label="Volume" title="Volume">🔊</span>
        <input
          className="slider"
          type="range"
          min={0}
          max={100}
          step={1}
          value={volume}
          onChange={(e) => changeVolumeUI(Number(e.currentTarget.value))}
        />
        <button className="btn" onClick={onOpenDevices} aria-label="Pick device">🖥️</button>
        <button className="btn" onClick={() => toggleFullscreen()} aria-label="Fullscreen">⛶</button>
      </div>
    </div>
  )
}

function toggleFullscreen() {
  const elem = document.documentElement
  if (!document.fullscreenElement) {
    elem.requestFullscreen?.().catch(() => {})
  } else {
    document.exitFullscreen?.().catch(() => {})
  }
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}
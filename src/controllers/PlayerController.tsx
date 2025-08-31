import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { AuthState } from '../auth/token'
import { getDevices, setVolume, seek, setRepeat, setShuffle, pause, resume, nextTrack, prevTrack, getPlaybackState } from '../spotify/api'
import { mmss } from '../utils/time'
import { useInterval } from '../utils/useInterval'

export default function PlayerController({ auth, onOpenDevices }: { auth: AuthState | null, onOpenDevices: () => void }) {
  const [state, setState] = useState<any | null>(null)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVol] = useState(70)
  const [shuffle, setShuf] = useState(false)
  const [repeat, setRep] = useState<'off' | 'context' | 'track'>('off')

  async function refresh() {
    if (!auth) return
    const s = await getPlaybackState().catch(() => null)
    if (s) {
      setState(s)
      setPosition(s.progress_ms || 0)
      setDuration(s.item?.duration_ms || 0)
      if (typeof s.shuffle_state === 'boolean') setShuf(!!s.shuffle_state)
      if (s.repeat_state) setRep(s.repeat_state)
      if (typeof s.device?.volume_percent === 'number') setVol(s.device.volume_percent)
    }
  }

  useEffect(() => { refresh() }, [auth])
  useInterval(() => {
    if (!state) return
    setPosition(p => Math.min(duration, p + 1000))
  }, state?.is_playing ? 1000 : null)

  async function togglePlay() {
    if (!state) return
    if (state.is_playing) {
      await pause().catch(() => {})
    } else {
      await resume().catch(() => {})
    }
    await refresh()
  }

  async function doSeek(ms: number) {
    await seek(ms)
    setPosition(ms)
  }

  async function changeVolume(v: number) {
    setVol(v)
    await setVolume(v).catch(() => {})
  }

  async function toggleShuffle() {
    const ns = !shuffle
    await setShuffle(ns).catch(() => {})
    setShuf(ns)
  }

  async function cycleRepeat() {
    const order: Array<'off' | 'context' | 'track'> = ['off', 'context', 'track']
    const idx = (order.indexOf(repeat) + 1) % order.length
    const next = order[idx]
    await setRepeat(next).catch(() => {})
    setRep(next)
  }

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
        <button className="btn" onClick={() => prevTrack().then(refresh)} aria-label="Previous track">⏮</button>
        <button className="btn primary" onClick={togglePlay} aria-label={state?.is_playing ? 'Pause' : 'Play'}>{state?.is_playing ? '⏸' : '▶️'}</button>
        <button className="btn" onClick={() => nextTrack().then(refresh)} aria-label="Next track">⏭</button>
        <button className="btn" onClick={toggleShuffle} aria-pressed={shuffle} aria-label="Toggle shuffle">🔀</button>
        <button className="btn" onClick={cycleRepeat} aria-label={`Repeat: ${repeat}`}>🔁 {repeat === 'track' ? '1' : repeat === 'context' ? '∞' : ''}</button>
      </div>

      <div className="progress-wrap" style={{ minWidth: 300 }}>
        <input
          className="slider"
          type="range" min={0} max={duration || 1} step={1000}
          value={position}
          onChange={(e) => doSeek(Number(e.currentTarget.value))}
          aria-label="Seek"
        />
        <div className="progress-labels">
          <span>{mmss(position)}</span>
          <span>{mmss(duration)}</span>
        </div>
      </div>

      <div className="right-controls">
        <span aria-label="Volume" title="Volume">🔊</span>
        <input className="slider" type="range" min={0} max={100} step={1} value={volume} onChange={e => changeVolume(Number(e.currentTarget.value))} />
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
import React, { useEffect, useState } from 'react'
import type { AuthState } from '../auth/token'
import { Device, getDevices, transferPlayback } from '../spotify/api'

export default function DevicePicker({ auth, onDone }: { auth: AuthState | null, onDone: () => void }) {
  const [devices, setDevices] = useState<Device[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    setLoading(true)
    try {
      const d = await getDevices()
      setDevices(d)
    } catch (e: any) {
      setError(e?.message || 'Failed to load devices')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { refresh() }, [auth])

  async function pick(d: Device) {
    if (!d.id) return
    setLoading(true)
    setError(null)
    try {
      await transferPlayback(d.id, true)
      onDone()
    } catch (e: any) {
      setError(e?.message || 'Failed to transfer playback')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <div className="row">
        <button className="btn" onClick={refresh} aria-label="Refresh devices">Refresh</button>
      </div>
      {loading && <div className="badge">Loading devices...</div>}
      {error && <div className="badge" style={{ color: 'var(--warn)' }}>{error}</div>}
      <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0', display: 'grid', gap: 6 }}>
        {devices.map(d => (
          <li key={d.id || d.name}>
            <button className="btn" style={{ width: '100%', display: 'flex', justifyContent: 'space-between' }} onClick={() => pick(d)}>
              <span>{d.name} <small style={{ color: 'var(--muted)' }}>({d.type})</small></span>
              {d.is_active && <span style={{ color: 'var(--good)' }}>Active</span>}
            </button>
          </li>
        ))}
      </ul>
      {!devices.length && !loading && <div className="badge">No devices found. Open Spotify on a device to appear here.</div>}
    </div>
  )
}
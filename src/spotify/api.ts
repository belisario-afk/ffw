import { getAccessToken, refreshToken, restoreFromStorage } from '../auth/token'

const API = 'https://api.spotify.com/v1'

export async function api<T>(path: string, init?: RequestInit, query?: Record<string, string | number | boolean | undefined | null>): Promise<T> {
  let token = await getAccessToken()
  if (!token) throw new Error('No access token')
  const url = new URL(API + path)
  if (query) {
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    })
  }

  const res = await fetch(url.toString(), {
    ...init,
    headers: {
      ...(init?.headers || {}),
      'Authorization': `Bearer ${token}`,
      'Content-Type': init?.body instanceof FormData ? undefined as any : 'application/json'
    }
  })
  if (res.status === 401) {
    const s = restoreFromStorage()
    if (s) {
      await refreshToken(s.refreshToken)
      token = await getAccessToken()
      if (!token) throw new Error('Unable to refresh token')
      return api<T>(path, init, query)
    }
  }
  if (res.status === 429) {
    const retry = parseInt(res.headers.get('Retry-After') || '1', 10)
    await new Promise(r => setTimeout(r, (retry + 0.1) * 1000))
    return api<T>(path, init, query)
  }
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Spotify API error ${res.status}: ${text}`)
  }
  if (res.status === 204) return undefined as unknown as T
  return res.json() as Promise<T>
}

export type Device = {
  id: string | null
  is_active: boolean
  is_restricted: boolean
  name: string
  type: string
  volume_percent: number | null
}

export async function getDevices() {
  const r = await api<{ devices: Device[] }>('/me/player/devices')
  return r.devices
}

export async function transferPlayback(deviceId: string, play = true) {
  return api<void>('/me/player', {
    method: 'PUT',
    body: JSON.stringify({ device_ids: [deviceId], play })
  })
}

export async function getPlaybackState() {
  return api('/me/player')
}

export async function playUris(uris: string[]) {
  return api<void>('/me/player/play', {
    method: 'PUT',
    body: JSON.stringify({ uris })
  })
}

export async function pause() {
  return api<void>('/me/player/pause', { method: 'PUT' })
}

export async function resume() {
  return api<void>('/me/player/play', { method: 'PUT' })
}

export async function nextTrack() {
  return api<void>('/me/player/next', { method: 'POST' })
}

export async function prevTrack() {
  return api<void>('/me/player/previous', { method: 'POST' })
}

export async function seek(positionMs: number) {
  return api<void>('/me/player/seek', { method: 'PUT' }, { position_ms: positionMs })
}

export async function setVolume(volumePercent: number) {
  return api<void>('/me/player/volume', { method: 'PUT' }, { volume_percent: Math.round(volumePercent) })
}

export async function setShuffle(shuffle: boolean) {
  return api<void>('/me/player/shuffle', { method: 'PUT' }, { state: shuffle })
}

export async function setRepeat(mode: 'track' | 'context' | 'off') {
  return api<void>('/me/player/repeat', { method: 'PUT' }, { state: mode })
}
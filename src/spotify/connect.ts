// Transfer playback to a Spotify device ID via Web API.
type Features = {
  deviceId: string
  play?: boolean
}

async function getToken(): Promise<string> {
  const fn = (window as any).__ffw__getSpotifyToken
  if (typeof fn === 'function') return await fn()
  throw new Error('No Spotify token provider. Set window.__ffw__getSpotifyToken or app provider.')
}

export async function transferPlaybackToDevice({ deviceId, play = true }: Features): Promise<void> {
  const token = await getToken()
  const res = await fetch('https://api.spotify.com/v1/me/player', {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ device_ids: [deviceId], play })
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Transfer playback failed (${res.status}): ${text || res.statusText}`)
  }
}
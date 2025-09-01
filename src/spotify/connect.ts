type Params = { deviceId: string; play?: boolean }
async function getToken(): Promise<string> {
  const fn = (window as any).__ffw__getSpotifyToken
  if (typeof fn === 'function') return await fn()
  throw new Error('No Spotify token provider')
}
export async function transferPlaybackToDevice({ deviceId, play = true }: Params): Promise<void> {
  const token = await getToken()
  const res = await fetch('https://api.spotify.com/v1/me/player', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_ids: [deviceId], play })
  })
  if (!res.ok) throw new Error(`Transfer failed (${res.status})`)
}
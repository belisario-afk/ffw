import { getAccessToken } from '../auth/token'
import { transferPlayback } from './api'

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void
    Spotify: any
    __ffwPlayer?: { player: Spotify.Player | null, deviceId: string | null }
  }
}

export type PlayerHandle = {
  deviceId: string | null
  player: Spotify.Player | null
  connect: () => Promise<void>
  disconnect: () => void
  hasInPagePlayback: boolean
}

export async function loadWebPlaybackSDK(): Promise<void> {
  if (window.Spotify) return
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://sdk.scdn.co/spotify-player.js'
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Spotify SDK'))
    document.head.appendChild(script)
  })
  await new Promise<void>((resolve) => {
    window.onSpotifyWebPlaybackSDKReady = () => resolve()
  })
}

export async function initPlayer(name = 'FFW Visualizer'): Promise<PlayerHandle> {
  await loadWebPlaybackSDK()
  const token = await getAccessToken()
  if (!token) throw new Error('No token for Web Playback SDK')
  const player = new window.Spotify.Player({
    name,
    getOAuthToken: async (cb: (token: string) => void) => {
      const t = await getAccessToken()
      if (t) cb(t)
    },
    volume: 0.7
  })

  let deviceId: string | null = null
  let readyResolve: (value: unknown) => void
  const ready = new Promise((r) => (readyResolve = r))

  player.addListener('ready', ({ device_id }: any) => {
    deviceId = device_id
    window.__ffwPlayer = { player, deviceId }
    readyResolve!(true)
  })

  player.addListener('not_ready', ({ device_id }: any) => {
    if (deviceId === device_id) deviceId = null
    window.__ffwPlayer = { player, deviceId }
  })

  player.addListener('initialization_error', ({ message }: any) => console.error('init error', message))
  player.addListener('authentication_error', ({ message }: any) => console.error('auth error', message))
  player.addListener('account_error', ({ message }: any) => console.error('account error', message))
  player.addListener('playback_error', ({ message }: any) => console.error('playback error', message))

  const connect = async () => {
    const ok = await player.connect()
    if (!ok) throw new Error('Could not connect to player')
    await ready
    if (deviceId) {
      try {
        await transferPlayback(deviceId, true)
      } catch {
        // Not premium or cannot transfer; ignore
      }
    }
  }

  const disconnect = () => { try { player.disconnect() } catch {} }

  const hasInPagePlayback = true

  // expose globally for controller UX
  window.__ffwPlayer = { player, deviceId }

  return { deviceId, player, connect, disconnect, hasInPagePlayback }
}
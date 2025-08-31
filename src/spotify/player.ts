import { getAccessToken } from '../auth/token'
import { transferPlayback } from './api'

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void
    Spotify: any
    __ffwPlayer?: { player: Spotify.Player | null, deviceId: string | null }
    __ffwSdkLoading?: Promise<void>
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
  // If SDK is already present, we're done.
  if (window.Spotify) return

  // Share a single loader promise across calls.
  if (window.__ffwSdkLoading) return window.__ffwSdkLoading

  window.__ffwSdkLoading = new Promise<void>((resolve, reject) => {
    try {
      // Define the global callback BEFORE injecting the script.
      window.onSpotifyWebPlaybackSDKReady = () => {
        resolve()
      }

      // Reuse an existing tag if present, otherwise create one.
      const existing = document.querySelector('script[src="https://sdk.scdn.co/spotify-player.js"]') as HTMLScriptElement | null
      const script = existing || document.createElement('script')
      script.src = 'https://sdk.scdn.co/spotify-player.js'
      script.async = true
      script.defer = true
      script.onerror = () => reject(new Error('Failed to load Spotify Web Playback SDK'))
      if (!existing) document.head.appendChild(script)

      // Extra safety: if Spotify appears synchronously, resolve.
      if ((window as any).Spotify) resolve()
    } catch (e) {
      reject(e as Error)
    }
  })

  return window.__ffwSdkLoading
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

  player.addListener('initialization_error', ({ message }: any) => console.error('Spotify SDK init error', message))
  player.addListener('authentication_error', ({ message }: any) => console.error('Spotify SDK auth error', message))
  player.addListener('account_error', ({ message }: any) => console.error('Spotify SDK account error', message))
  player.addListener('playback_error', ({ message }: any) => console.error('Spotify SDK playback error', message))

  const connect = async () => {
    const ok = await player.connect()
    if (!ok) throw new Error('Could not connect to Spotify player')
    await ready
    if (deviceId) {
      try {
        // Transfer playback to this in-page device if possible (Premium requirement).
        await transferPlayback(deviceId, true)
      } catch {
        // Ignore if not permitted; remote control will still work.
      }
    }
  }

  const disconnect = () => { try { player.disconnect() } catch {} }

  // Expose global for controller operations
  window.__ffwPlayer = { player, deviceId }

  // Assume we can attempt in-page playback; analyzer will probe for audio element.
  const hasInPagePlayback = true

  return { deviceId, player, connect, disconnect, hasInPagePlayback }
}
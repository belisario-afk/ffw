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

let playerHandlePromise: Promise<PlayerHandle> | null = null
let connectedOnce = false

export async function loadWebPlaybackSDK(): Promise<void> {
  if (window.Spotify) return
  if (window.__ffwSdkLoading) return window.__ffwSdkLoading

  window.__ffwSdkLoading = new Promise<void>((resolve, reject) => {
    try {
      // Define the global callback BEFORE injecting the script.
      window.onSpotifyWebPlaybackSDKReady = () => resolve()

      const existing = document.querySelector('script[src="https://sdk.scdn.co/spotify-player.js"]') as HTMLScriptElement | null
      const script = existing || document.createElement('script')
      script.src = 'https://sdk.scdn.co/spotify-player.js'
      script.async = true
      script.defer = true
      script.onerror = () => reject(new Error('Failed to load Spotify Web Playback SDK'))
      if (!existing) document.head.appendChild(script)

      if ((window as any).Spotify) resolve()
    } catch (e) {
      reject(e as Error)
    }
  })

  return window.__ffwSdkLoading
}

async function createPlayer(name = 'FFW Visualizer'): Promise<PlayerHandle> {
  await loadWebPlaybackSDK()
  const token = await getAccessToken()
  if (!token) throw new Error('No token for Web Playback SDK')

  // Do not force default volume here to avoid volume resets when scenes switch
  const player = new window.Spotify.Player({
    name,
    getOAuthToken: async (cb: (token: string) => void) => {
      const t = await getAccessToken()
      if (t) cb(t)
    }
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
    if (connectedOnce) return
    const ok = await player.connect()
    if (!ok) throw new Error('Could not connect to Spotify player')
    await ready
    connectedOnce = true
    if (deviceId) {
      try {
        await transferPlayback(deviceId, true)
      } catch {
        // Not premium or cannot transfer; ignore. Remote control still works.
      }
    }
  }

  const disconnect = () => { /* singleton — do not disconnect */ }

  window.__ffwPlayer = { player, deviceId }
  const hasInPagePlayback = true

  return { deviceId, player, connect, disconnect, hasInPagePlayback }
}

export async function initPlayer(name = 'FFW Visualizer'): Promise<PlayerHandle> {
  if (!playerHandlePromise) {
    playerHandlePromise = createPlayer(name)
  }
  return playerHandlePromise
}

/**
 * Ensures the singleton player exists and is connected (only once).
 */
export async function ensurePlayerConnected(): Promise<PlayerHandle> {
  const handle = await initPlayer()
  await handle.connect()
  return handle
}
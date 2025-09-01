// Idempotent Web Playback SDK connect with persistent device name and volume.
// Only sets initial volume on the FIRST successful connect. Subsequent calls won't change volume.
// Keeps the player alive across scene switches.

let singleton: Spotify.Player | null = null
let connected = false
let initialVolumeSet = false
let currentDeviceId: string | null = null
let pendingConnect: Promise<Spotify.Player> | null = null

const DEVICE_NAME = 'FFw visualizer'
const VOL_KEY = 'ffw.spotify.volume' // persist last known volume [0..1]

type EnsureOpts = {
  deviceName?: string
  setInitialVolume?: boolean // default true on first connect; ignored afterwards
}

export async function ensurePlayerConnected(opts: EnsureOpts = {}): Promise<{ player: Spotify.Player, deviceId: string | null }> {
  const name = opts.deviceName ?? DEVICE_NAME

  // If we already have an in-flight connect, return that.
  if (pendingConnect) {
    const player = await pendingConnect
    return { player, deviceId: currentDeviceId }
  }

  // If already connected, no-op.
  if (singleton && connected) {
    return { player: singleton, deviceId: currentDeviceId }
  }

  // If a player exists but got disconnected, reuse it.
  if (singleton && !connected) {
    pendingConnect = connectInternal(singleton, name, opts)
    const player = await pendingConnect.finally(() => { pendingConnect = null })
    return { player, deviceId: currentDeviceId }
  }

  // Create a fresh player
  const token = await getSpotifyToken()
  const SpotifySDK = await waitForSpotifySDK()

  singleton = new SpotifySDK.Player({
    name,
    getOAuthToken: (cb: (token: string) => void) => cb(token),
    volume: clamp01(readStoredVolume() ?? 0.8) // volume here only seeds player object; we'll also apply below once
  })

  wirePlayerEvents(singleton)

  pendingConnect = connectInternal(singleton, name, opts)
  const player = await pendingConnect.finally(() => { pendingConnect = null })
  return { player, deviceId: currentDeviceId }
}

async function connectInternal(player: Spotify.Player, name: string, opts: EnsureOpts) {
  const ok = await player.connect()
  if (!ok) throw new Error('Spotify player failed to connect')
  connected = true

  // Set the device name if SDK allows (some SDKs infer from constructor)
  try { (player as any)._options.name = name } catch {}

  // Only set initial volume once in the app’s lifetime
  if (!initialVolumeSet && (opts.setInitialVolume ?? true)) {
    const v = clamp01(readStoredVolume() ?? 0.8)
    try { await player.setVolume(v) } catch {}
    initialVolumeSet = true
  }

  // Poll device id once ready
  try {
    const state = await player.getCurrentState()
    // If playing on this device, it will exist in state; otherwise device id will be provided on transfer
    currentDeviceId = (state as any)?.device_id ?? currentDeviceId ?? null
  } catch {
    // ignore
  }

  // Patch setVolume to persist
  const origSetVolume = player.setVolume.bind(player)
  player.setVolume = async (v: number) => {
    const vv = clamp01(v)
    writeStoredVolume(vv)
    return origSetVolume(vv)
  }

  // Ensure we don’t accidentally disconnect on scene change — only on page unload
  if (!(window as any).__ffw__playerUnloadHook) {
    (window as any).__ffw__playerUnloadHook = true
    window.addEventListener('beforeunload', () => {
      try { player.disconnect() } catch {}
    })
  }

  return player
}

function wirePlayerEvents(player: Spotify.Player) {
  player.addListener('ready', ({ device_id }) => { currentDeviceId = device_id || currentDeviceId })
  player.addListener('not_ready', ({ device_id }) => {
    if (currentDeviceId === device_id) currentDeviceId = null
  })
  player.addListener('initialization_error', ({ message }) => console.warn('Spotify init error:', message))
  player.addListener('account_error', ({ message }) => console.warn('Spotify account error:', message))
  player.addListener('playback_error', ({ message }) => console.warn('Spotify playback error:', message))
}

function readStoredVolume(): number | null {
  try {
    const s = localStorage.getItem(VOL_KEY)
    if (!s) return null
    const v = parseFloat(s)
    return Number.isFinite(v) ? clamp01(v) : null
  } catch { return null }
}
function writeStoredVolume(v: number) {
  try { localStorage.setItem(VOL_KEY, String(clamp01(v))) } catch {}
}

function clamp01(x: number) { return Math.max(0, Math.min(1, x)) }

// Wait for window.Spotify to be available (Web Playback SDK)
function waitForSpotifySDK(): Promise<typeof Spotify> {
  return new Promise((resolve) => {
    if ((window as any).Spotify) return resolve((window as any).Spotify)
    (window as any).onSpotifyWebPlaybackSDKReady = () => resolve((window as any).Spotify)
  })
}

// Replace this with your app’s token sourcing.
// Must return a valid user OAuth token (not client-credentials).
async function getSpotifyToken(): Promise<string> {
  // If your app already has a token function, import and use it instead.
  // This placeholder throws to surface missing wiring during dev.
  if ((window as any).__ffw__getSpotifyToken) {
    return await (window as any).__ffw__getSpotifyToken()
  }
  throw new Error('getSpotifyToken() not wired. Expose window.__ffw__getSpotifyToken to supply a user token.')
}

// Optional helpers exposed for diagnostics
export function getPlayer(): Spotify.Player | null { return singleton }
export function getDeviceId(): string | null { return currentDeviceId }
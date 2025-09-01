// Idempotent Web Playback SDK connect with persistent device name and volume.
// Adds a pluggable token provider so visuals can share the same user token.
// If no provider is set, ensurePlayerConnected will throw unless you guard it via hasSpotifyTokenProvider().

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

type TokenProvider = () => Promise<string>
let _tokenProvider: TokenProvider | null = null

export function setSpotifyTokenProvider(fn: TokenProvider) {
  _tokenProvider = fn
}
export function hasSpotifyTokenProvider() {
  return !!_tokenProvider || typeof (window as any).__ffw__getSpotifyToken === 'function'
}

export async function ensurePlayerConnected(opts: EnsureOpts = {}): Promise<{ player: Spotify.Player, deviceId: string | null }> {
  const name = opts.deviceName ?? DEVICE_NAME

  if (pendingConnect) {
    const player = await pendingConnect
    return { player, deviceId: currentDeviceId }
  }

  if (singleton && connected) {
    return { player: singleton, deviceId: currentDeviceId }
  }

  if (!singleton) {
    const token = await getSpotifyToken()
    const SpotifySDK = await waitForSpotifySDK()

    singleton = new SpotifySDK.Player({
      name,
      getOAuthToken: (cb: (token: string) => void) => {
        getSpotifyToken().then(cb).catch(() => cb(token))
      },
      volume: clamp01(readStoredVolume() ?? 0.8)
    })
    wirePlayerEvents(singleton)
  }

  pendingConnect = connectInternal(singleton, name, opts)
  const player = await pendingConnect.finally(() => { pendingConnect = null })
  return { player, deviceId: currentDeviceId }
}

async function connectInternal(player: Spotify.Player, name: string, opts: EnsureOpts) {
  const ok = await player.connect()
  if (!ok) throw new Error('Spotify player failed to connect')
  connected = true

  try { (player as any)._options.name = name } catch {}

  if (!initialVolumeSet && (opts.setInitialVolume ?? true)) {
    const v = clamp01(readStoredVolume() ?? 0.8)
    try { await player.setVolume(v) } catch {}
    initialVolumeSet = true
  }

  try {
    const state = await player.getCurrentState()
    currentDeviceId = (state as any)?.device_id ?? currentDeviceId ?? null
  } catch {}

  const origSetVolume = player.setVolume.bind(player)
  player.setVolume = async (v: number) => {
    const vv = clamp01(v)
    writeStoredVolume(vv)
    return origSetVolume(vv)
  }

  if (!(window as any).__ffw__playerUnloadHook) {
    (window as any).__ffw__playerUnloadHook = true
    window.addEventListener('beforeunload', () => {
      try { player.disconnect() } catch {}
    })
  }

  // Try to activate the audio element once on connect (no-op if not supported).
  try { await (player as any).activateElement?.() } catch {}

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

async function getSpotifyToken(): Promise<string> {
  if (_tokenProvider) return _tokenProvider()
  const globalFn = (window as any).__ffw__getSpotifyToken
  if (typeof globalFn === 'function') return await globalFn()
  throw new Error('getSpotifyToken() not wired. Set setSpotifyTokenProvider(fn) or window.__ffw__getSpotifyToken.')
}

// Wait for window.Spotify to be available (Web Playback SDK)
function waitForSpotifySDK(): Promise<typeof Spotify> {
  return new Promise((resolve) => {
    if ((window as any).Spotify) return resolve((window as any).Spotify)
    ;(window as any).onSpotifyWebPlaybackSDKReady = () => resolve((window as any).Spotify)
  })
}

// Optional helpers exposed for diagnostics
export function getPlayer(): Spotify.Player | null { return singleton }
export function getDeviceId(): string | null { return currentDeviceId }
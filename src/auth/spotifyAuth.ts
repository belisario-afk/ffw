// Spotify OAuth (Implicit Grant) for client-side apps (no server secret needed).
// This sets window.__ffw__getSpotifyToken so the rest of the app (player/transfer) can use it.

const CLIENT_ID = '927fda6918514f96903e828fcd6bb576' // your Spotify client ID
const REDIRECT_URI = 'https://belisario-afk.github.io/ffw/' // must match exactly in your Spotify app settings
const SCOPES = [
  'streaming',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing'
].join(' ')

const TOKEN_KEY = 'ffw.spotify.token'
const EXPIRES_AT_KEY = 'ffw.spotify.expires_at'

export function bootstrapAuthFromHash() {
  // Capture token from the URL hash on redirect back from Spotify
  if (window.location.hash.includes('access_token=')) {
    const hash = new URLSearchParams(window.location.hash.slice(1))
    const token = hash.get('access_token') || ''
    const expiresIn = parseInt(hash.get('expires_in') || '3600', 10)
    const expiresAt = Date.now() + (expiresIn * 1000 - 30_000) // refresh a bit early

    if (token) {
      try {
        localStorage.setItem(TOKEN_KEY, token)
        localStorage.setItem(EXPIRES_AT_KEY, String(expiresAt))
        ;(window as any).__ffw__getSpotifyToken = async () => token
      } catch {}
    }

    // Clean the hash so refreshes don’t re-run this branch
    history.replaceState(null, document.title, window.location.pathname + window.location.search)
  } else {
    // If already signed in, expose the provider on load
    const t = getAccessToken()
    if (t) (window as any).__ffw__getSpotifyToken = async () => t
  }
}

export function getAccessToken(): string | null {
  try {
    const token = localStorage.getItem(TOKEN_KEY)
    const exp = parseInt(localStorage.getItem(EXPIRES_AT_KEY) || '0', 10)
    if (!token || !exp || Date.now() >= exp) return null
    return token
  } catch {
    return null
  }
}

export function ensureAuth() {
  const token = getAccessToken()
  if (token) return

  const authUrl = new URL('https://accounts.spotify.com/authorize')
  authUrl.searchParams.set('client_id', CLIENT_ID)
  authUrl.searchParams.set('response_type', 'token') // Implicit Grant
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
  authUrl.searchParams.set('scope', SCOPES)
  authUrl.searchParams.set('show_dialog', 'true')

  window.location.href = authUrl.toString()
}
// Spotify OAuth for client-only apps.
// Provides both a popup flow (no page refresh) and a redirect fallback.
//
// This module stores the access token in localStorage and exposes a window global
// so other parts of the app (player/transfer) can retrieve it without props.

const CLIENT_ID = '927fda6918514f96903e828fcd6bb576' // your Spotify client ID
const REDIRECT_URI = 'https://belisario-afk.github.io/ffw/' // must match exactly in your Spotify app settings
const SCOPES = [
  'streaming',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-email',
  'user-read-private'
].join(' ')

const TOKEN_KEY = 'ffw.spotify.token'
const EXPIRES_AT_KEY = 'ffw.spotify.expires_at'

// Build the authorize URL
export function getAuthUrl(): string {
  const authUrl = new URL('https://accounts.spotify.com/authorize')
  authUrl.searchParams.set('client_id', CLIENT_ID)
  authUrl.searchParams.set('response_type', 'token') // Implicit Grant
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
  authUrl.searchParams.set('scope', SCOPES)
  authUrl.searchParams.set('show_dialog', 'true')
  return authUrl.toString()
}

// Capture token from URL hash after redirect (either main window or popup)
export function bootstrapAuthFromHash() {
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

// Full-page redirect fallback (will refresh the app)
export function ensureAuth() {
  const token = getAccessToken()
  if (token) return
  window.location.href = getAuthUrl()
}

// Preferred: popup auth (no page refresh). Resolves with token when granted.
// If the popup is blocked or user closes it, the promise rejects.
export function signInWithPopup(): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = getAuthUrl()
    const w = 520
    const h = 680
    const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2)
    const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2)
    const popup = window.open(
      url,
      'spotify-auth',
      `toolbar=0,menubar=0,status=0,scrollbars=1,resizable=1,width=${w},height=${h},left=${left},top=${top}`
    )
    if (!popup) {
      reject(new Error('Popup blocked'))
      return
    }

    const timer = setInterval(() => {
      try {
        if (popup.closed) {
          clearInterval(timer)
          reject(new Error('Sign-in popup closed'))
          return
        }
        // Once redirected back to our origin, we can read its URL/hash
        const href = popup.location.href
        if (href && href.startsWith(REDIRECT_URI) && popup.location.hash.includes('access_token=')) {
          const hash = new URLSearchParams(popup.location.hash.slice(1))
          const token = hash.get('access_token') || ''
          const expiresIn = parseInt(hash.get('expires_in') || '3600', 10)
          const expiresAt = Date.now() + (expiresIn * 1000 - 30_000)
          if (token) {
            try {
              localStorage.setItem(TOKEN_KEY, token)
              localStorage.setItem(EXPIRES_AT_KEY, String(expiresAt))
              ;(window as any).__ffw__getSpotifyToken = async () => token
            } catch {}
            clearInterval(timer)
            popup.close()
            resolve(token)
          } else {
            clearInterval(timer)
            popup.close()
            reject(new Error('No access token returned'))
          }
        }
      } catch {
        // While on accounts.spotify.com (cross-origin), reading popup.location throws.
        // We silently wait until it redirects back to our origin.
      }
    }, 250)
  })
}
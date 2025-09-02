import { pkceChallengeFromVerifier, randomString } from './pkce'
import { CONFIG } from '../config'

const ACCOUNTS = 'https://accounts.spotify.com'
const TOKEN_URL = `${ACCOUNTS}/api/token`
const AUTH_URL = `${ACCOUNTS}/authorize`

type Stored = {
  access_token: string
  refresh_token: string
  expires_at: number
  scope: string
}

export type AuthState = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope: string
}

const storageKey = 'ffw_auth'
const verifierKey = 'ffw_pkce_verifier'
const stateKey = 'ffw_auth_state'

export function restoreFromStorage(): AuthState | null {
  const raw = localStorage.getItem(storageKey)
  if (!raw) return null
  if (raw.trim().charAt(0) !== '{') {
    try { localStorage.removeItem(storageKey) } catch {}
    return null
  }
  try {
    const s = JSON.parse(raw) as Partial<Stored>
    if (!s || typeof s.access_token !== 'string' || typeof s.refresh_token !== 'string' || typeof s.expires_at !== 'number') {
      try { localStorage.removeItem(storageKey) } catch {}
      return null
    }
    return {
      accessToken: s.access_token,
      refreshToken: s.refresh_token,
      expiresAt: s.expires_at,
      scope: s.scope || ''
    }
  } catch {
    try { localStorage.removeItem(storageKey) } catch {}
    return null
  }
}

export function persistAuth(s: AuthState) {
  const stored: Stored = {
    access_token: s.accessToken,
    refresh_token: s.refreshToken,
    expires_at: s.expiresAt,
    scope: s.scope
  }
  localStorage.setItem(storageKey, JSON.stringify(stored))
}

export function loginWithSpotify(opts: { scopes: string[] }) {
  const clientId = CONFIG.clientId
  const redirectUri = CONFIG.redirectUri
  const verifier = randomString(64)
  const state = randomString(16)
  sessionStorage.setItem(verifierKey, verifier)
  sessionStorage.setItem(stateKey, state)
  pkceChallengeFromVerifier(verifier).then(challenge => {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      scope: opts.scopes.join(' '),
      state
    })
    location.assign(`${AUTH_URL}?${params.toString()}`)
  })
}

export function signOut() {
  localStorage.removeItem(storageKey)
  sessionStorage.removeItem(verifierKey)
  sessionStorage.removeItem(stateKey)
}

/**
 * Handle Spotify callback parameters (search or hash) and exchange code for tokens.
 */
export async function handleAuthCodeCallback(url: string): Promise<AuthState> {
  const u = new URL(url)

  let params = u.searchParams
  if (!params.get('code') && u.hash) {
    const hash = u.hash.startsWith('#') ? u.hash.slice(1) : u.hash
    const qIndex = hash.indexOf('?')
    if (qIndex >= 0) {
      const qs = hash.slice(qIndex + 1)
      params = new URLSearchParams(qs)
    }
  }

  const code = params.get('code')
  const state = params.get('state')
  const err = params.get('error')

  if (err) throw new Error(err)
  if (!code) throw new Error('Missing authorization code')
  const expectedState = sessionStorage.getItem(stateKey)
  if (!state || state !== expectedState) throw new Error('Invalid auth state')
  const verifier = sessionStorage.getItem(verifierKey)
  if (!verifier) throw new Error('Missing PKCE verifier')

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: CONFIG.redirectUri,
    client_id: CONFIG.clientId,
    code_verifier: verifier
  })

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Token exchange failed: ${text || res.statusText}`)
  }
  const json = await res.json()
  const accessToken = json.access_token as string
  const refreshToken = json.refresh_token as string
  const expiresIn = (json.expires_in as number) || 3600
  const scope = (json.scope as string) || ''
  if (!accessToken || !refreshToken) throw new Error('Invalid token response')

  const expiresAt = Date.now() + expiresIn * 1000 - 30_000

  const a: AuthState = { accessToken, refreshToken, expiresAt, scope }

  // Cleanup sensitive values after use
  sessionStorage.removeItem(verifierKey)
  sessionStorage.removeItem(stateKey)

  return a
}

/**
 * Refresh the access token using the stored refresh token.
 */
export async function refreshAccessToken(prev: AuthState): Promise<AuthState> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: prev.refreshToken,
    client_id: CONFIG.clientId
  })

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Token refresh failed: ${text || res.statusText}`)
  }
  const json = await res.json()
  const accessToken = (json.access_token as string) || prev.accessToken
  const refreshToken = (json.refresh_token as string) || prev.refreshToken
  const expiresIn = (json.expires_in as number) || 3600
  const scope = (json.scope as string) || prev.scope
  const expiresAt = Date.now() + expiresIn * 1000 - 30_000
  return { accessToken, refreshToken, expiresAt, scope }
}

/**
 * Compatibility helpers for existing imports in src/spotify/api.ts
 * - getAccessToken(): returns the current access token if present, otherwise null.
 * - refreshToken(): refreshes and persists, returning the full updated AuthState.
 */
export function getAccessToken(): string | null {
  const s = restoreFromStorage()
  if (!s) return null
  // If token is close to expiring, let callers decide to refresh via refreshToken()
  return s.accessToken
}

export async function refreshToken(): Promise<AuthState> {
  const s = restoreFromStorage()
  if (!s) throw new Error('No stored auth to refresh')
  const next = await refreshAccessToken(s)
  persistAuth(next)
  return next
}
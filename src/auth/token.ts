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
  try {
    const s = JSON.parse(raw) as Stored
    return {
      accessToken: s.access_token,
      refreshToken: s.refresh_token,
      expiresAt: s.expires_at,
      scope: s.scope
    }
  } catch {
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
 * Robustly handle Spotify callback parameters whether they appear in:
 * - /callback?code=...&state=...
 * - /#/(callback)?code=...&state=...
 */
export async function handleAuthCodeCallback(url: string): Promise<AuthState> {
  const u = new URL(url)

  // Prefer search params
  let params = u.searchParams

  // If no code in search, try to parse from hash fragment
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

  if (err) throw new Error(`Spotify auth error: ${err}`)
  if (!code) throw new Error('No authorization code in callback')

  const expectedState = sessionStorage.getItem(stateKey)
  if (!expectedState || expectedState !== state) throw new Error('State mismatch')
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
    body
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Token exchange failed: ${res.status} ${text}`)
  }
  const data = await res.json() as any
  const auth: AuthState = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in * 1000 - 30_000),
    scope: data.scope
  }
  persistAuth(auth)
  return auth
}

let refreshing: Promise<AuthState> | null = null

export async function getAccessToken(): Promise<string | null> {
  const curr = restoreFromStorage()
  if (!curr) return null
  if (Date.now() < curr.expiresAt - 15_000) return curr.accessToken
  if (!refreshing) refreshing = refreshToken(curr.refreshToken)
  const next = await refreshing
  refreshing = null
  return next.accessToken
}

export async function refreshToken(refreshTokenStr: string): Promise<AuthState> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshTokenStr,
    client_id: CONFIG.clientId
  })
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!res.ok) {
    signOut()
    const text = await res.text()
    throw new Error(`Refresh failed: ${res.status} ${text}`)
  }
  const data = await res.json()
  const prev = restoreFromStorage()
  const auth: AuthState = {
    accessToken: data.access_token,
    refreshToken: prev?.refreshToken || refreshTokenStr,
    expiresAt: Date.now() + (data.expires_in * 1000 - 30_000),
    scope: data.scope || prev?.scope || ''
  }
  persistAuth(auth)
  return auth
}
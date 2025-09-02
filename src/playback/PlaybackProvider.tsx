import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { bootstrapAuthFromHash, ensureAuth, getAccessToken, signInWithPopup } from '../auth/spotifyAuth'
import { loadWebPlaybackSDK } from '../spotify/sdk'
import { ensurePlayerConnected, setSpotifyTokenProvider } from '../spotify/player'
import { transferPlaybackToDevice } from '../spotify/connect'

type PlaybackCtx = {
  token: string | null
  isSignedIn: boolean
  deviceId: string | null
  isDeviceReady: boolean
  status: string
  // Returns true if a token is available after the call (popup success or already signed in).
  // If it falls back to full-page redirect, the promise resolves false before navigation.
  signIn: () => Promise<boolean>
  // Ensures SDK playback in browser; will sign in first if needed.
  playInBrowser: () => Promise<void>
  // One-click: Sign in (if needed) and enable SDK playback/transfer.
  signInAndPlay: () => Promise<void>
  transferToBrowser: (opts?: { play?: boolean }) => Promise<void>
}

const Ctx = createContext<PlaybackCtx | null>(null)

export function PlaybackProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null)
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [isDeviceReady, setIsDeviceReady] = useState(false)
  const [status, setStatus] = useState('')

  // On load: restore token (hash or storage) and expose token provider globally
  useEffect(() => {
    bootstrapAuthFromHash()
    const t = getAccessToken()
    if (t) {
      setToken(t)
      try {
        setSpotifyTokenProvider(async () => t)
        ;(window as any).__ffw__getSpotifyToken = async () => t
      } catch {}
    }
  }, [])

  // Keep window token provider updated
  useEffect(() => {
    if (token) {
      try {
        setSpotifyTokenProvider(async () => token)
        ;(window as any).__ffw__getSpotifyToken = async () => token
      } catch {}
    }
  }, [token])

  const signIn = useCallback(async (): Promise<boolean> => {
    setStatus('Signing in…')
    const existing = getAccessToken()
    if (existing) {
      setToken(existing)
      setStatus('')
      return true
    }
    try {
      const t = await signInWithPopup()
      setToken(t)
      setStatus('')
      return true
    } catch {
      // If popup blocked or user closed it, fall back to redirect
      setStatus('Opening Spotify…')
      try { ensureAuth() } catch {}
      return false
    }
  }, [])

  // Create/connect player and transfer playback to it
  const playInBrowser = useCallback(async () => {
    // Ensure token (sign in if needed, via popup when possible)
    let t = getAccessToken()
    if (!t) {
      const ok = await signIn()
      if (!ok) return // redirected away, or failed
      t = getAccessToken()
      if (!t) return
    }

    setStatus('Connecting player...')
    try {
      await loadWebPlaybackSDK()
      const { player, deviceId: did } = await ensurePlayerConnected({ deviceName: 'FFW Visualizer', setInitialVolume: true })
      try { await (player as any).activateElement?.() } catch {}
      setDeviceId(did || null)
      setIsDeviceReady(true)
      setStatus('Transferring playback...')
      if (did) {
        await transferPlaybackToDevice({ deviceId: did, play: true })
        setStatus('Playing in browser')
      } else {
        setStatus('Player ready. Select “FFW Visualizer” in Spotify app if it did not auto-transfer.')
      }
    } catch (e: any) {
      console.error(e)
      setStatus(e?.message || 'Failed to enable browser playback')
    }
  }, [signIn])

  const signInAndPlay = useCallback(async () => {
    // Single entrypoint: signs in (popup preferred) and starts SDK playback
    const ok = await signIn()
    if (!ok) return
    await playInBrowser()
  }, [signIn, playInBrowser])

  const transferToBrowser = useCallback(async ({ play = true }: { play?: boolean } = {}) => {
    const t = getAccessToken()
    if (!t) { setStatus('Sign in first'); return }
    if (!deviceId) { setStatus('Player not ready. Click the login button to enable playback.'); return }
    try {
      setStatus('Transferring playback...')
      await transferPlaybackToDevice({ deviceId, play })
      setStatus('Playback transferred')
    } catch (e: any) {
      console.error(e)
      setStatus(e?.message || 'Transfer failed')
    }
  }, [deviceId])

  const value = useMemo<PlaybackCtx>(() => ({
    token,
    isSignedIn: !!token,
    deviceId,
    isDeviceReady,
    status,
    signIn,
    playInBrowser,
    signInAndPlay,
    transferToBrowser
  }), [token, deviceId, isDeviceReady, status, signIn, playInBrowser, signInAndPlay, transferToBrowser])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function usePlayback(): PlaybackCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('usePlayback must be used within PlaybackProvider')
  return ctx
}
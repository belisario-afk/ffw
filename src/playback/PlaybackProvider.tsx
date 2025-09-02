import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { bootstrapAuthFromHash, ensureAuth, getAccessToken } from '../auth/spotifyAuth'
import { loadWebPlaybackSDK } from '../spotify/sdk'
import { ensurePlayerConnected, setSpotifyTokenProvider } from '../spotify/player'
import { transferPlaybackToDevice } from '../spotify/connect'

type PlaybackCtx = {
  token: string | null
  isSignedIn: boolean
  deviceId: string | null
  isDeviceReady: boolean
  status: string
  signIn: () => void
  playInBrowser: () => Promise<void>
  transferToBrowser: (opts?: { play?: boolean }) => Promise<void>
}

const Ctx = createContext<PlaybackCtx | null>(null)

export function PlaybackProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null)
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [isDeviceReady, setIsDeviceReady] = useState(false)
  const [status, setStatus] = useState('')

  // 1) Pick up token from redirect hash or localStorage and expose provider globally
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

  // 2) Keep window token provider updated if token changes
  useEffect(() => {
    if (token) {
      try {
        setSpotifyTokenProvider(async () => token)
        ;(window as any).__ffw__getSpotifyToken = async () => token
      } catch {}
    }
  }, [token])

  const signIn = useCallback(() => {
    setStatus('Redirecting to Spotify…')
    ensureAuth() // Navigates to Spotify and back; token is restored on return (above)
  }, [])

  // 3) Create/connect player and transfer playback to it (user gesture)
  const playInBrowser = useCallback(async () => {
    setStatus('Connecting player...')
    const t = getAccessToken()
    if (!t) { setStatus('Sign in first'); return }
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
  }, [])

  const transferToBrowser = useCallback(async ({ play = true }: { play?: boolean } = {}) => {
    const t = getAccessToken()
    if (!t) { setStatus('Sign in first'); return }
    if (!deviceId) { setStatus('Player not ready. Click Play in Browser.'); return }
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
    transferToBrowser
  }), [token, deviceId, isDeviceReady, status, signIn, playInBrowser, transferToBrowser])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function usePlayback(): PlaybackCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('usePlayback must be used within PlaybackProvider')
  return ctx
}
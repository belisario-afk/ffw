import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { restoreFromStorage, loginWithSpotify, type AuthState } from '../auth/token'
import { loadWebPlaybackSDK } from '../spotify/sdk'
import { ensurePlayerConnected, setSpotifyTokenProvider } from '../spotify/player'
import { transferPlaybackToDevice } from '../spotify/connect'

type PlaybackCtx = {
  token: string | null
  isSignedIn: boolean
  status: string
  // Single login button: Spotify PKCE login (redirect). On return, SDK playback is enabled automatically.
  signIn: () => void
}

const Ctx = createContext<PlaybackCtx | null>(null)

const SCOPES = [
  'streaming',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing'
]

export function PlaybackProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const sdkReadyRef = useRef(false)

  // Expose a way for the callback page to set auth without reloading
  useEffect(() => {
    ;(window as any).__ffw__setAuth = (a: AuthState) => {
      setToken(a.accessToken)
      setStatus('')
    }
    return () => { try { delete (window as any).__ffw__setAuth } catch {} }
  }, [])

  // On load: restore token and set provider
  useEffect(() => {
    const s = restoreFromStorage()
    if (s?.accessToken) {
      setToken(s.accessToken)
      try {
        setSpotifyTokenProvider(async () => s.accessToken)
        ;(window as any).__ffw__getSpotifyToken = async () => s.accessToken
      } catch {}
    } else {
      setToken(null)
    }
  }, [])

  // Keep token provider updated
  useEffect(() => {
    if (token) {
      try {
        setSpotifyTokenProvider(async () => token)
        ;(window as any).__ffw__getSpotifyToken = async () => token
      } catch {}
    }
  }, [token])

  // After login: initialize Web Playback SDK once and transfer playback
  useEffect(() => {
    if (!token || sdkReadyRef.current) return
    sdkReadyRef.current = true
    ;(async () => {
      try {
        setStatus('Setting up playback…')
        await loadWebPlaybackSDK()
        const { player, deviceId } = await ensurePlayerConnected({ deviceName: 'FFW Visualizer', setInitialVolume: true })
        try { await (player as any).activateElement?.() } catch {}
        if (deviceId) {
          await transferPlaybackToDevice({ deviceId, play: true })
          setStatus('Playback enabled in browser')
        } else {
          setStatus('Player ready — select “FFW Visualizer” in Spotify app if it did not auto-transfer.')
        }
      } catch (e: any) {
        console.error(e)
        setStatus(e?.message || 'Failed to enable browser playback')
      }
    })()
  }, [token])

  const signIn = useCallback(() => {
    setStatus('Redirecting to Spotify…')
    loginWithSpotify({ scopes: SCOPES })
  }, [])

  const value = useMemo<PlaybackCtx>(() => ({
    token,
    isSignedIn: !!token,
    status,
    signIn
  }), [token, status, signIn])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function usePlayback(): PlaybackCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('usePlayback must be used within PlaybackProvider')
  return ctx
}
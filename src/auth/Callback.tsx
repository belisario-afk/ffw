import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { handleAuthCodeCallback, persistAuth, type AuthState } from './token'

export default function Callback() {
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    handleAuthCodeCallback(window.location.href).then((a: AuthState) => {
      // Persist and notify app
      persistAuth(a)
      try { (window as any).__ffw__setAuth?.(a) } catch {}
      navigate('/', { replace: true })
    }).catch((e) => {
      setError(e?.message || 'Authentication failed')
    })
  }, [])

  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
      {!error ? (
        <div className="badge">Completing login...</div>
      ) : (
        <div className="badge" style={{ color: 'var(--warn)' }}>Auth error: {error}</div>
      )}
    </div>
  )
}
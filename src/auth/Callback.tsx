import React, { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { handleAuthCodeCallback, type AuthState } from './token'

export default function Callback({ onAuth }: { onAuth: (a: AuthState) => void }) {
  const [error, setError] = useState<string | null>(null)
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    handleAuthCodeCallback(window.location.href).then((a) => {
      onAuth(a)
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
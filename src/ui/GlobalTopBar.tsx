import React from 'react'
import { usePlayback } from '../playback/PlaybackProvider'

export default function GlobalTopBar() {
  const { isSignedIn, status, signIn } = usePlayback()

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: 44,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 12px',
        justifyContent: 'flex-end',
        zIndex: 100,
        pointerEvents: 'none'
      }}
    >
      {!isSignedIn && (
        <button onClick={signIn} style={btn} aria-label="Log in">
          Log in
        </button>
      )}
      {!!status && (
        <div style={{ color: '#b9d6ff', fontSize: 12, pointerEvents: 'none' }}>{status}</div>
      )}
    </div>
  )
}

const btn: React.CSSProperties = {
  pointerEvents: 'auto',
  height: 28,
  padding: '0 10px',
  borderRadius: 6,
  border: '1px solid #2b2f3a',
  background: 'rgba(10,12,16,0.8)',
  color: '#cfe7ff',
  cursor: 'pointer',
  fontSize: 13
}
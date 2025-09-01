import React from 'react'

type Props = {
  // Current visual route/key, e.g. 'wireframehouse' | 'wireframe3d' | etc.
  activeVisualKey: string
  className?: string
}

export default function TopBar({ activeVisualKey, className }: Props) {
  const openSettings = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (activeVisualKey === 'wireframe3d') {
      window.dispatchEvent(new CustomEvent('ffw:open-wireframe3d-settings'))
    } else {
      // Fallback for other visuals (e.g., 2D wireframe)
      window.dispatchEvent(new CustomEvent('ffw:open-wireframe-settings'))
    }
  }

  return (
    <div
      className={className}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 44,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 8,
        padding: '0 12px',
        pointerEvents: 'none', // let canvas receive events except buttons
        zIndex: 20,
      }}
    >
      <button
        onClick={openSettings}
        aria-label="Open settings"
        style={{
          pointerEvents: 'auto',
          height: 28,
          padding: '0 10px',
          borderRadius: 6,
          border: '1px solid #2b2f3a',
          background: 'rgba(10,12,16,0.75)',
          color: '#cfe7ff',
          cursor: 'pointer',
          fontSize: 13,
        }}
      >
        ⚙︎ Settings
      </button>
    </div>
  )
}
import React from 'react'
import { openSettingsForActiveVisual } from '../utils/visualSettingsEvents'

type Props = {
  // Whatever your app uses to track the current visual key
  activeVisualKey: string // e.g., 'wireframehouse', 'wireframe3d', etc.
  className?: string
}

export default function SettingsButton({ activeVisualKey, className }: Props) {
  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    openSettingsForActiveVisual(activeVisualKey)
  }

  return (
    <button className={className} onClick={onClick} aria-label="Open settings">
      ⚙︎
    </button>
  )
}
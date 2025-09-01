import React from 'react'
import TopBar from './ui/TopBar'
import WireframeHouse3D from './visuals/scenes/WireframeHouse3D'

export default function AppShell() {
  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>
      <TopBar activeVisualKey="wireframe3d" />
      <WireframeHouse3D auth={null} quality={{ renderScale: 1, msaa: 0, bloom: true, motionBlur: false }} accessibility={{ epilepsySafe: true, reducedMotion: false, highContrast: false }} />
    </div>
  )
}
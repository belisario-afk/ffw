import React from 'react'

export type HouseSettings = {
  // Dynamics
  beatPower: number      // 0.05..1
  stiffness: number      // 1..12
  damping: number        // 0.6..0.98

  // Rendering
  lineWidth: number      // 0.8..3
  glow: number           // 0..1.5
  edgeJitter: number     // 0..1  (px jitter scale)

  // Camera
  camBob: number         // 0..1  (subtle bob)
  camShake: number       // 0..1  (beat shake)
  orbit: boolean
  orbitSpeed: number     // 0..3 rad/s base
  orbitRadius: number    // 3.5..8
  orbitElev: number      // -0.4..0.4 rad

  // World
  grid: boolean
  windows: boolean
  beams: boolean
  partyRings: boolean
  confetti: boolean
  stars: number          // 100..2000

  // Color
  colorMode: 'album' | 'preset' | 'reactive'
  eqEdges: boolean       // color edges by EQ bands
  windowIntensity: number // 0..1
}

export const defaultHouseSettings: HouseSettings = {
  // Dynamics
  beatPower: 0.5,
  stiffness: 7.2,
  damping: 0.86,

  // Rendering
  lineWidth: 1.8,
  glow: 1.2,
  edgeJitter: 0.25,

  // Camera
  camBob: 0.55,
  camShake: 0.6,
  orbit: true,
  orbitSpeed: 0.9,
  orbitRadius: 5.8,
  orbitElev: -0.08,

  // World
  grid: true,
  windows: true,
  beams: true,
  partyRings: true,
  confetti: true,
  stars: 1000,

  // Color
  colorMode: 'album',
  eqEdges: true,
  windowIntensity: 0.75
}

export function HousePanel({ value, onChange }: {
  value: HouseSettings,
  onChange: (v: HouseSettings) => void
}) {
  const set = <K extends keyof HouseSettings>(k: K, v: HouseSettings[K]) =>
    onChange({ ...value, [k]: v })

  return (
    <div className="grid">
      <div className="row"><strong>Wireframe House Settings</strong></div>

      <div className="row"><label>Explode power</label>
        <input type="range" min={0.05} max={1} step={0.01} value={value.beatPower}
          onChange={e => set('beatPower', Number(e.currentTarget.value))} /></div>
      <div className="row"><label>Spring stiffness</label>
        <input type="range" min={1} max={12} step={0.1} value={value.stiffness}
          onChange={e => set('stiffness', Number(e.currentTarget.value))} /></div>
      <div className="row"><label>Damping</label>
        <input type="range" min={0.6} max={0.98} step={0.01} value={value.damping}
          onChange={e => set('damping', Number(e.currentTarget.value))} /></div>

      <div className="row"><label>Line width</label>
        <input type="range" min={0.8} max={3} step={0.1} value={value.lineWidth}
          onChange={e => set('lineWidth', Number(e.currentTarget.value))} /></div>
      <div className="row"><label>Glow</label>
        <input type="range" min={0} max={1.5} step={0.05} value={value.glow}
          onChange={e => set('glow', Number(e.currentTarget.value))} /></div>
      <div className="row"><label>Edge jitter</label>
        <input type="range" min={0} max={1} step={0.01} value={value.edgeJitter}
          onChange={e => set('edgeJitter', Number(e.currentTarget.value))} /></div>

      <div className="row"><strong>Camera (orbit)</strong></div>
      <div className="row"><label>Enable orbit</label>
        <input type="checkbox" checked={value.orbit} onChange={e => set('orbit', e.currentTarget.checked)} /></div>
      <div className="row"><label>Orbit speed</label>
        <input type="range" min={0} max={3} step={0.05} value={value.orbitSpeed}
          onChange={e => set('orbitSpeed', Number(e.currentTarget.value))} /></div>
      <div className="row"><label>Orbit radius</label>
        <input type="range" min={3.5} max={8} step={0.1} value={value.orbitRadius}
          onChange={e => set('orbitRadius', Number(e.currentTarget.value))} /></div>
      <div className="row"><label>Orbit elevation</label>
        <input type="range" min={-0.4} max={0.4} step={0.01} value={value.orbitElev}
          onChange={e => set('orbitElev', Number(e.currentTarget.value))} /></div>
      <div className="row"><label>Camera bob</label>
        <input type="range" min={0} max={1} step={0.05} value={value.camBob}
          onChange={e => set('camBob', Number(e.currentTarget.value))} /></div>
      <div className="row"><label>Camera shake</label>
        <input type="range" min={0} max={1} step={0.05} value={value.camShake}
          onChange={e => set('camShake', Number(e.currentTarget.value))} /></div>

      <div className="row"><strong>World & FX</strong></div>
      <div className="row"><label>Grid</label>
        <input type="checkbox" checked={value.grid} onChange={e => set('grid', e.currentTarget.checked)} /></div>
      <div className="row"><label>Beams</label>
        <input type="checkbox" checked={value.beams} onChange={e => set('beams', e.currentTarget.checked)} /></div>
      <div className="row"><label>Floor rings</label>
        <input type="checkbox" checked={value.partyRings} onChange={e => set('partyRings', e.currentTarget.checked)} /></div>
      <div className="row"><label>Confetti</label>
        <input type="checkbox" checked={value.confetti} onChange={e => set('confetti', e.currentTarget.checked)} /></div>
      <div className="row"><label>Stars</label>
        <input type="range" min={100} max={2000} step={50} value={value.stars}
          onChange={e => set('stars', Number(e.currentTarget.value))} /></div>

      <div className="row"><strong>Color & Reactivity</strong></div>
      <div className="row"><label>Color mode</label>
        <select value={value.colorMode} onChange={e => set('colorMode', e.currentTarget.value as any)}>
          <option value="album">Album (auto)</option>
          <option value="preset">Preset (Theme)</option>
          <option value="reactive">Audio‑Reactive</option>
        </select>
      </div>
      <div className="row"><label>EQ edges</label>
        <input type="checkbox" checked={value.eqEdges} onChange={e => set('eqEdges', e.currentTarget.checked)} /></div>
      <div className="row"><label>Window intensity</label>
        <input type="range" min={0} max={1} step={0.01} value={value.windowIntensity}
          onChange={e => set('windowIntensity', Number(e.currentTarget.value))} /></div>

      <div style={{ gridColumn: '1 / -1', color: 'var(--muted)', fontSize: 12 }}>
        Suggested vibe: Orbit speed 1.0, radius 6.0, glow 1.2, stiffness 7.5, damping 0.86, EQ edges ON.
      </div>
    </div>
  )
}
import React from 'react'

export type HouseSettings = {
  beatPower: number      // 0.05..1
  stiffness: number      // 1..12
  damping: number        // 0.6..0.98
  lineWidth: number      // 0.8..3
  glow: number           // 0..1.5
  camBob: number         // 0..1
  camShake: number       // 0..1
  grid: boolean
  gridParallax: number   // 0..1
  windows: boolean
  stars: number          // 100..2000
  colorMode: 'album' | 'preset' | 'reactive'

  // NEW: Orbiting camera (houseparty)
  orbit: boolean
  orbitSpeed: number     // 0..3 rad/s
  orbitRadius: number    // 3.5..8 (camera distance)
  orbitElev: number      // -0.4..0.4 rad
}

export const defaultHouseSettings: HouseSettings = {
  beatPower: 0.45,
  stiffness: 7.0,
  damping: 0.86,
  lineWidth: 1.8,
  glow: 1.15,
  camBob: 0.6,
  camShake: 0.6,
  grid: true,
  gridParallax: 0.7,
  windows: true,
  stars: 900,
  colorMode: 'album',
  orbit: true,
  orbitSpeed: 0.6,
  orbitRadius: 5.2,
  orbitElev: -0.12
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

      <div className="row">
        <label>Explode power</label>
        <input type="range" min={0.05} max={1} step={0.01} value={value.beatPower}
          onChange={e => set('beatPower', Number(e.currentTarget.value))} />
      </div>
      <div className="row">
        <label>Spring stiffness</label>
        <input type="range" min={1} max={12} step={0.1} value={value.stiffness}
          onChange={e => set('stiffness', Number(e.currentTarget.value))} />
      </div>
      <div className="row">
        <label>Damping</label>
        <input type="range" min={0.6} max={0.98} step={0.01} value={value.damping}
          onChange={e => set('damping', Number(e.currentTarget.value))} />
      </div>

      <div className="row">
        <label>Line width</label>
        <input type="range" min={0.8} max={3} step={0.1} value={value.lineWidth}
          onChange={e => set('lineWidth', Number(e.currentTarget.value))} />
      </div>
      <div className="row">
        <label>Glow</label>
        <input type="range" min={0} max={1.5} step={0.05} value={value.glow}
          onChange={e => set('glow', Number(e.currentTarget.value))} />
      </div>

      <div className="row">
        <label>Camera bob</label>
        <input type="range" min={0} max={1} step={0.05} value={value.camBob}
          onChange={e => set('camBob', Number(e.currentTarget.value))} />
      </div>
      <div className="row">
        <label>Camera shake</label>
        <input type="range" min={0} max={1} step={0.05} value={value.camShake}
          onChange={e => set('camShake', Number(e.currentTarget.value))} />
      </div>

      <div className="row">
        <label>Grid</label>
        <input type="checkbox" checked={value.grid} onChange={e => set('grid', e.currentTarget.checked)} />
      </div>
      {value.grid && (
        <div className="row">
          <label>Grid parallax</label>
          <input type="range" min={0} max={1} step={0.05} value={value.gridParallax}
            onChange={e => set('gridParallax', Number(e.currentTarget.value))} />
        </div>
      )}

      <div className="row">
        <label>Windows flicker</label>
        <input type="checkbox" checked={value.windows} onChange={e => set('windows', e.currentTarget.checked)} />
      </div>

      <div className="row">
        <label>Stars</label>
        <input type="range" min={100} max={2000} step={50} value={value.stars}
          onChange={e => set('stars', Number(e.currentTarget.value))} />
      </div>

      <div className="row">
        <label>Color mode</label>
        <select value={value.colorMode} onChange={e => set('colorMode', e.currentTarget.value as any)}>
          <option value="album">Album (auto)</option>
          <option value="preset">Preset (Theme)</option>
          <option value="reactive">Audio‑Reactive</option>
        </select>
      </div>

      <div className="row"><strong>Orbit camera (houseparty)</strong></div>
      <div className="row">
        <label>Enable orbit</label>
        <input type="checkbox" checked={value.orbit} onChange={e => set('orbit', e.currentTarget.checked)} />
      </div>
      <div className="row">
        <label>Orbit speed</label>
        <input type="range" min={0} max={3} step={0.05} value={value.orbitSpeed}
          onChange={e => set('orbitSpeed', Number(e.currentTarget.value))} />
      </div>
      <div className="row">
        <label>Orbit radius</label>
        <input type="range" min={3.5} max={8} step={0.1} value={value.orbitRadius}
          onChange={e => set('orbitRadius', Number(e.currentTarget.value))} />
      </div>
      <div className="row">
        <label>Orbit elevation</label>
        <input type="range" min={-0.4} max={0.4} step={0.01} value={value.orbitElev}
          onChange={e => set('orbitElev', Number(e.currentTarget.value))} />
      </div>

      <div style={{ gridColumn: '1 / -1', color: 'var(--muted)', fontSize: 12 }}>
        Tip: Orbit speed ~0.6–1.2 with beatPower ~0.5 feels like a houseparty.
      </div>
    </div>
  )
}
import React from 'react'

type V = { epilepsySafe: boolean, reducedMotion: boolean, highContrast: boolean, albumSkin: boolean }

export default function VJPanel({ value, onChange }: {
  value: V,
  onChange: (v: V) => void
}) {
  return (
    <div className="grid">
      <div className="row">
        <label htmlFor="epilepsy">Epilepsy-safe mode</label>
        <input id="epilepsy" type="checkbox" checked={value.epilepsySafe} onChange={e => onChange({ ...value, epilepsySafe: e.currentTarget.checked })} />
      </div>
      <div className="row">
        <label htmlFor="reduced">Reduced motion</label>
        <input id="reduced" type="checkbox" checked={value.reducedMotion} onChange={e => onChange({ ...value, reducedMotion: e.currentTarget.checked })} />
      </div>
      <div className="row">
        <label htmlFor="contrast">High contrast</label>
        <input id="contrast" type="checkbox" checked={value.highContrast} onChange={e => onChange({ ...value, highContrast: e.currentTarget.checked })} />
      </div>
      <div className="row">
        <label htmlFor="albumSkin">Album cover skin (panels)</label>
        <input id="albumSkin" type="checkbox" checked={value.albumSkin} onChange={e => onChange({ ...value, albumSkin: e.currentTarget.checked })} />
      </div>
      <div style={{ gridColumn: '1 / -1', color: 'var(--muted)' }}>
        Keyboard: Space play/pause, ←/→ seek, +/- volume, F fullscreen, D devices.
      </div>
    </div>
  )
}
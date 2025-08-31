import React from 'react'

export default function VJPanel({ value, onChange }: {
  value: { epilepsySafe: boolean, reducedMotion: boolean, highContrast: boolean },
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
      <div style={{ gridColumn: '1 / -1', color: 'var(--muted)' }}>
        Keyboard: <kbd>Space</kbd> play/pause, <kbd>←/→</kbd> seek, <kbd>+/−</kbd> volume, <kbd>F</kbd> fullscreen, <kbd>D</kbd> devices.
      </div>
    </div>
  )
}
type V = { epilepsySafe: boolean, reducedMotion: boolean, highContrast: boolean }
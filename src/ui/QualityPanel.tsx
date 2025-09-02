import React from 'react'

export default function QualityPanel({ value, onChange }: {
  value: { renderScale: 1 | 1.25 | 1.5 | 1.75 | 2, msaa: 0 | 2 | 4 | 8, bloom: boolean, motionBlur: boolean },
  onChange: (v: QualityPanelProps['value']) => void
}) {
  return (
    <div className="grid">
      <div className="row">
        <label htmlFor="renderscale">Render Scale</label>
        <select id="renderscale" value={value.renderScale} onChange={e => onChange({ ...value, renderScale: Number(e.currentTarget.value) as any })}>
          <option value="1">1.0x</option>
          <option value="1.25">1.25x</option>
          <option value="1.5">1.5x</option>
          <option value="1.75">1.75x</option>
          <option value="2">2.0x</option>
        </select>
      </div>
      <div className="row">
        <label htmlFor="msaa">MSAA</label>
        <select id="msaa" value={value.msaa} onChange={e => onChange({ ...value, msaa: Number(e.currentTarget.value) as any })}>
          <option value="0">Off</option>
          <option value="2">2x</option>
          <option value="4">4x</option>
          <option value="8">8x</option>
        </select>
      </div>
      <div className="row">
        <label htmlFor="bloom">Bloom</label>
        <input id="bloom" type="checkbox" checked={value.bloom} onChange={e => onChange({ ...value, bloom: e.currentTarget.checked })} />
      </div>
      <div className="row">
        <label htmlFor="mblur">Motion Blur</label>
        <input id="mblur" type="checkbox" checked={value.motionBlur} onChange={e => onChange({ ...value, motionBlur: e.currentTarget.checked })} />
      </div>
      <div style={{ gridColumn: '1 / -1', color: 'var(--muted)' }}>
        Changes affect rendering. Use <kbd>Q</kbd> to toggle this panel.
      </div>
    </div>
  )
}
type QualityPanelProps = React.ComponentProps<typeof QualityPanel>
import React, { useEffect, useRef } from 'react'

export default function Popup({ open, title, onClose, children }: { open: boolean, title: string, onClose: () => void, children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const el = ref.current
    const focusable = el?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    focusable?.[0]?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Tab' && focusable && focusable.length > 0) {
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      <div className="popup-backdrop" aria-hidden={String(!open)} onClick={onClose} />
      {open && (
        <div className="popup" role="dialog" aria-modal="true" aria-labelledby="popup-title" ref={ref}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 id="popup-title">{title}</h2>
            <button className="btn" onClick={onClose} aria-label="Close">✕</button>
          </div>
          <div>{children}</div>
        </div>
      )}
    </>
  )
}
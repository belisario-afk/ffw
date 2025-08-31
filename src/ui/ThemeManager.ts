import React, { useEffect } from 'react'

export function ThemeManager() {
  useEffect(() => {
    // Keep <meta name="theme-color"> in sync with accent
    const meta = document.getElementById('theme-color-meta') as HTMLMetaElement | null
    const update = () => {
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#00ffff'
      if (meta) meta.content = accent
    }
    const obs = new MutationObserver(update)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    update()
    return () => obs.disconnect()
  }, [])
  return null
}
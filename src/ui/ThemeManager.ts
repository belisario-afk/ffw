import React, { useEffect } from 'react'

export type ThemeName = 'album' | 'neon' | 'magenta' | 'matrix' | 'sunset'

const THEME_KEY = 'ffw_theme'
const SKIN_KEY = 'ffw_album_skin' // '1' or '0'

export function getTheme(): ThemeName {
  const t = (localStorage.getItem(THEME_KEY) as ThemeName | null) || 'album'
  return t
}

export function setTheme(name: ThemeName) {
  localStorage.setItem(THEME_KEY, name)
  applyTheme(name)
}

export function isAlbumSkinEnabled(): boolean {
  return localStorage.getItem(SKIN_KEY) === '1'
}

export function setAlbumSkinEnabled(enabled: boolean) {
  localStorage.setItem(SKIN_KEY, enabled ? '1' : '0')
  const root = document.documentElement
  root.classList.toggle('album-skin', enabled)
}

export function setAlbumSkin(url: string | null) {
  // URL should be a blob or remote image. We store as CSS var used by panels.
  const root = document.documentElement
  root.style.setProperty('--album-art-url', url ? `url("${url}")` : 'none')
}

function applyTheme(name: ThemeName) {
  const root = document.documentElement
  const presets: Record<Exclude<ThemeName, 'album'>, Record<string, string>> = {
    neon: { '--accent': '#00ffff', '--accent-2': '#ff00d4' },
    magenta: { '--accent': '#ff00d4', '--accent-2': '#00ffff' },
    matrix: { '--accent': '#00ff88', '--accent-2': '#00ffaa' },
    sunset: { '--accent': '#ff7a18', '--accent-2': '#af002d' }
  }
  if (name !== 'album') {
    const map = presets[name]
    Object.entries(map).forEach(([k, v]) => root.style.setProperty(k, v))
  }
  const meta = document.getElementById('theme-color-meta') as HTMLMetaElement | null
  if (meta) meta.content = getComputedStyle(root).getPropertyValue('--accent').trim() || '#00ffff'
}

export function ThemeManager() {
  useEffect(() => {
    // Apply stored presets on boot
    applyTheme(getTheme())
    setAlbumSkinEnabled(isAlbumSkinEnabled())
    // Keep <meta name="theme-color"> in sync with accent changes
    const meta = document.getElementById('theme-color-meta') as HTMLMetaElement | null
    const update = () => {
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#00ffff'
      if (meta) meta.content = accent
    }
    const obs = new MutationObserver(update)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
    update()
    return () => obs.disconnect()
  }, [])
  return null
}
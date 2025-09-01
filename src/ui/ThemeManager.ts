import React, { useEffect } from 'react'

export type ThemeName =
  | 'album'
  | 'neon'
  | 'magenta'
  | 'matrix'
  | 'sunset'
  | 'slate'
  | 'light'
  | 'hcpro'

const THEME_KEY = 'ffw_theme'
const ALBUM_SKIN_KEY = 'ffw_album_skin'

let albumSkinUrlCurrent: string | null = null
let albumSkinStyleEl: HTMLStyleElement | null = null

const themes: Record<ThemeName, Record<string, string>> = {
  album: { '--bg': '#060a0e', '--fg': '#e7f0f7', '--muted': '#8fa1b3', '--accent': '#00f0ff', '--accent-2': '#ff00f0', '--grid': '#0b1220' },
  neon: { '--bg': '#051018', '--fg': '#e8fcff', '--muted': '#90a7b4', '--accent': '#00f0ff', '--accent-2': '#28ff86', '--grid': '#0b2030' },
  magenta: { '--bg': '#140613', '--fg': '#fde8fb', '--muted': '#c8a5c5', '--accent': '#ff00f0', '--accent-2': '#ffb300', '--grid': '#2a0f29' },
  matrix: { '--bg': '#040b07', '--fg': '#d9ffe8', '--muted': '#9fceae', '--accent': '#1aff6d', '--accent-2': '#00f0ff', '--grid': '#0a1e14' },
  sunset: { '--bg': '#10080f', '--fg': '#ffeae5', '--muted': '#f3aa96', '--accent': '#ff7a59', '--accent-2': '#ffd166', '--grid': '#2b131f' },
  slate: { '--bg': '#0b0f14', '--fg': '#f0f3f7', '--muted': '#a8b3c2', '--accent': '#66a3ff', '--accent-2': '#ff66a3', '--grid': '#111827' },
  light: { '--bg': '#f8fafc', '--fg': '#0a0c0f', '--muted': '#5b6169', '--accent': '#0066ff', '--accent-2': '#ff0088', '--grid': '#e5eaf0' },
  hcpro: { '--bg': '#000000', '--fg': '#ffffff', '--muted': '#bfbfbf', '--accent': '#00ffff', '--accent-2': '#ff00ff', '--grid': '#161616' }
}

export function getTheme(): ThemeName {
  const t = (localStorage.getItem(THEME_KEY) as ThemeName | null) || 'album'
  return t in themes ? t : 'album'
}

export function setTheme(t: ThemeName) {
  localStorage.setItem(THEME_KEY, t)
  applyTheme(t)
}

export function isAlbumSkinEnabled(): boolean {
  const v = localStorage.getItem(ALBUM_SKIN_KEY)
  if (v === 'true') return true
  if (v === 'false') return false
  return getTheme() === 'album'
}

export function setAlbumSkinEnabled(on: boolean) {
  localStorage.setItem(ALBUM_SKIN_KEY, String(on))
  document.documentElement.classList.toggle('album-skin', on)
  if (!on) {
    setAlbumSkin(null)
  } else if (albumSkinUrlCurrent) {
    // Reapply last known album image immediately on re-enable
    setAlbumSkin(albumSkinUrlCurrent)
  }
}

export function setAlbumSkin(url: string | null) {
  albumSkinUrlCurrent = url
  ensureAlbumSkinStyle()
  if (!albumSkinStyleEl) return
  if (!url) {
    albumSkinStyleEl.textContent = `.album-skin body::before { content: none !important; }`
    return
  }
  albumSkinStyleEl.textContent = `
    .album-skin body::before {
      content: '';
      position: fixed;
      inset: 0;
      background-image: url("${cssEscape(url)}");
      background-size: cover;
      background-position: center;
      opacity: 0.18;
      filter: saturate(1.1) brightness(0.9) blur(6px);
      z-index: -1;
      pointer-events: none;
      transition: opacity 280ms ease;
    }
  `
}

function ensureAlbumSkinStyle() {
  if (albumSkinStyleEl) return
  albumSkinStyleEl = document.createElement('style')
  albumSkinStyleEl.setAttribute('id', 'ffw-album-skin-style')
  document.head.appendChild(albumSkinStyleEl)
}

function applyTheme(t: ThemeName) {
  const root = document.documentElement
  const palette = themes[t]
  Object.entries(palette).forEach(([k, v]) => root.style.setProperty(k, v))
  root.setAttribute('data-theme', t)
  root.classList.toggle('album-skin', isAlbumSkinEnabled())
}

export function ThemeManager() {
  useEffect(() => {
    applyTheme(getTheme())
    ensureAlbumSkinStyle()
    document.documentElement.classList.toggle('album-skin', isAlbumSkinEnabled())
  }, [])
  return null
}

function cssEscape(s: string) {
  return s.replace(/["\\]/g, '\\$&')
}
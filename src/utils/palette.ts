export type Palette = { accent: string; accent2: string; bg: string }

// Legacy helper used by AlbumSkinWatcher
export function extractPaletteFromImage(img: HTMLImageElement): Palette {
  // Downscale and pick dominant + secondary colors via simple histogram
  const w = 32, h = 32
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h).data
  const hist = new Map<string, number>()
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]]
    if (a < 128) continue
    // Quantize to reduce buckets
    const qr = Math.round(r / 32) * 32
    const qg = Math.round(g / 32) * 32
    const qb = Math.round(b / 32) * 32
    const key = `${qr},${qg},${qb}`
    hist.set(key, (hist.get(key) || 0) + 1)
  }
  const sorted = [...hist.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
  const accent = sorted[0] || '0,255,255'
  const accent2 = sorted[1] || '255,0,212'
  const toHex = (rgb: string) => {
    const [r, g, b] = rgb.split(',').map(Number)
    const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
    return `#${hex(r)}${hex(g)}${hex(b)}`
  }
  return { accent: toHex(accent), accent2: toHex(accent2), bg: '#0a0f14' }
}

// Legacy helper used by AlbumSkinWatcher
export function applyPaletteToCss(p: Palette) {
  // Only apply when theme is 'album'
  const theme = localStorage.getItem('ffw_theme') || 'album'
  if (theme !== 'album') return
  const root = document.documentElement
  root.style.setProperty('--accent', p.accent)
  root.style.setProperty('--accent-2', p.accent2)
  // Intentionally do not override background CSS variable globally here
}

// Newer async helper used by some scenes (e.g., Particle Galaxy)
export async function extractPalette(imageUrl: string): Promise<{ primary: string; accent: string; background: string } | null> {
  try {
    const img = await loadImage(imageUrl)
    const pal = extractPaletteFromImage(img)
    // Map legacy palette to new naming
    return {
      primary: pal.accent,          // treat dominant as primary color
      accent: pal.accent2,          // secondary as accent
      background: pal.bg || '#04070c'
    }
  } catch {
    return null
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}
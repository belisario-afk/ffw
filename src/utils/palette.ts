export type Palette = { accent: string, accent2: string, bg: string }

export function extractPaletteFromImage(img: HTMLImageElement): Palette {
  // Quick and simple: downscale and pick dominant + secondary colors via histogram
  const w = 32, h = 32
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h).data
  const hist = new Map<string, number>()
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i], data[i+1], data[i+2], data[i+3]]
    if (a < 128) continue
    // Quantize
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
    const hex = (n: number) => n.toString(16).padStart(2, '0')
    return `#${hex(r)}${hex(g)}${hex(b)}`
  }
  return { accent: toHex(accent), accent2: toHex(accent2), bg: '#0a0f14' }
}

export function applyPaletteToCss(p: Palette) {
  const root = document.documentElement
  root.style.setProperty('--accent', p.accent)
  root.style.setProperty('--accent-2', p.accent2)
  // Keep background subtle
}
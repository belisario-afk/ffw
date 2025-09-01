// Lightweight lyrics helper (best-effort).
// 1) If window.__ffw__getLyrics is provided, use it.
//    Expected return: string | string[] | { text?: string; lines?: string[] }.
// 2) Else try LRCLIB (no auth) by title/artist.
// Returns a "plain" marquee-friendly string (no timestamps).

export type LyricsQuery = { title: string; artist: string }

export async function fetchLyrics(q: LyricsQuery): Promise<{ plain: string } | null> {
  // Try user hook first
  try {
    const hook = (window as any).__ffw__getLyrics
    if (typeof hook === 'function') {
      const res = await hook(q)
      const plain = normalize(res)
      if (plain) return { plain }
    }
  } catch {}

  // LRCLIB (free): https://lrclib.net/api/get?track_name=...&artist_name=...
  try {
    if (!q.title && !q.artist) return null
    const url = new URL('https://lrclib.net/api/get')
    if (q.title) url.searchParams.set('track_name', q.title)
    if (q.artist) url.searchParams.set('artist_name', q.artist)
    const r = await fetch(url.toString(), { method: 'GET', mode: 'cors' })
    if (!r.ok) return null
    const data = await r.json().catch(() => null)
    if (!data) return null
    // Prefer synced if available, else plain
    const synced: string = data.syncedLyrics || ''
    const plain: string = data.plainLyrics || ''
    const out = normalize(synced || plain)
    return out ? { plain: out } : null
  } catch {
    return null
  }
}

function normalize(input: any): string {
  if (!input) return ''
  if (typeof input === 'string') return collapse(input)
  if (Array.isArray(input)) return input.map(String).join('  •  ')
  if (typeof input === 'object') {
    if (input.text) return collapse(String(input.text))
    if (Array.isArray(input.lines)) return input.lines.map(String).join('  •  ')
  }
  return ''
}

function collapse(s: string): string {
  // Remove timestamps like [mm:ss.xx], condense whitespace/newlines
  return s
    .replace(/\[[0-9:.]+\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
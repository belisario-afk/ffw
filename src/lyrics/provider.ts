// Lyrics provider with synced (LRC) support + plain fallback.
// Order:
// 1) If window.__ffw__getLyrics is provided, use it (string | string[] | {text|lines}).
// 2) Else try LRCLIB (no auth) by title/artist.
// Returns both plain (for marquee) and synced lines when available.

export type LyricsQuery = { title: string; artist: string }
export type SyncedLine = { timeMs: number; text: string }

export async function fetchLyrics(q: LyricsQuery): Promise<{ plain: string; synced?: SyncedLine[] } | null> {
  // Custom hook first
  try {
    const hook = (window as any).__ffw__getLyrics
    if (typeof hook === 'function') {
      const res = await hook(q)
      const plain = normalize(res)
      const synced = tryParseSynced(res)
      return plain || synced ? { plain, synced } : null
    }
  } catch {}

  // LRCLIB
  try {
    if (!q.title && !q.artist) return null
    const url = new URL('https://lrclib.net/api/get')
    if (q.title) url.searchParams.set('track_name', q.title)
    if (q.artist) url.searchParams.set('artist_name', q.artist)
    const r = await fetch(url.toString(), { method: 'GET', mode: 'cors' })
    if (!r.ok) return null
    const data = await r.json().catch(() => null)
    if (!data) return null
    const syncedRaw: string = data.syncedLyrics || ''
    const plainRaw: string = data.plainLyrics || ''
    const synced = parseLRC(syncedRaw)
    const plain = synced.length ? synced.map(s => s.text).join('  •  ') : collapse(plainRaw)
    return plain ? { plain, synced: synced.length ? synced : undefined } : null
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

function tryParseSynced(input: any): SyncedLine[] | undefined {
  if (!input) return
  if (typeof input === 'string') return parseLRC(input)
  if (typeof input === 'object' && typeof input.synced === 'string') return parseLRC(input.synced)
  return
}

function collapse(s: string): string {
  return String(s).replace(/\[[0-9:.]+\]/g, ' ').replace(/\s+/g, ' ').trim()
}

export function parseLRC(src: string): SyncedLine[] {
  if (!src) return []
  const lines = String(src).split(/\r?\n/)
  const out: SyncedLine[] = []
  const tag = /\[([0-9]{1,2}):([0-9]{2})(?:\.([0-9]{1,3}))?]/g
  for (const line of lines) {
    let lastIndex = 0
    let match: RegExpExecArray | null
    const stamps: number[] = []
    while ((match = tag.exec(line)) !== null) {
      lastIndex = match.index + match[0].length
      const m = parseInt(match[1], 10)
      const s = parseInt(match[2], 10)
      const f = match[3] ? parseInt(match[3].padEnd(3, '0'), 10) : 0
      stamps.push((m * 60 + s) * 1000 + f)
    }
    const text = line.slice(lastIndex).trim()
    if (text && stamps.length) {
      stamps.forEach(ms => out.push({ timeMs: ms, text }))
    }
  }
  out.sort((a, b) => a.timeMs - b.timeMs)
  return out
}
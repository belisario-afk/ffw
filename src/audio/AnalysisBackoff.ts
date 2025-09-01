/**
 * Centralized backoff and blocklist for audio-analysis fetches.
 * - Tracks that return 403 are marked "unanalyzable" and will be skipped.
 * - Transient failures (network/5xx/etc.) get exponential backoff (per track).
 */
const unanalyzable = new Set<string>() // trackId -> skip permanently for this track
const retryNextAt = new Map<string, number>() // trackId -> timestamp ms
const retryDelayMs = new Map<string, number>() // trackId -> last delay used

const NOW = () => Date.now()

export function markUnanalyzable(trackId: string, reason: string = '403'): void {
  if (!trackId) return
  if (!unanalyzable.has(trackId)) {
    // eslint-disable-next-line no-console
    console.warn(`[analysis] Marking track as unanalyzable (${reason}): ${trackId}`)
  }
  unanalyzable.add(trackId)
  // Clear any retry schedules
  retryNextAt.delete(trackId)
  retryDelayMs.delete(trackId)
}

export function isUnanalyzable(trackId: string | null | undefined): boolean {
  if (!trackId) return false
  return unanalyzable.has(trackId)
}

export function clearUnanalyzable(trackId: string | null | undefined): void {
  if (!trackId) return
  unanalyzable.delete(trackId)
}

export function shouldRetryNow(trackId: string | null | undefined): boolean {
  if (!trackId) return false
  const nextAt = retryNextAt.get(trackId)
  if (!nextAt) return true
  return NOW() >= nextAt
}

export function scheduleBackoff(trackId: string, baseMs: number = 2000, maxMs: number = 60000): number {
  const prev = retryDelayMs.get(trackId) ?? 0
  const next = prev ? Math.min(prev * 2, maxMs) : baseMs
  retryDelayMs.set(trackId, next)
  retryNextAt.set(trackId, NOW() + next)
  // eslint-disable-next-line no-console
  console.warn(`[analysis] Backing off track ${trackId} for ${Math.round(next)}ms`)
  return next
}

export function clearBackoff(trackId: string | null | undefined): void {
  if (!trackId) return
  retryNextAt.delete(trackId)
  retryDelayMs.delete(trackId)
}

/**
 * When track changes, you may want to drop old state for previous tracks.
 * This is optional, but keeps memory tidy.
 */
export function onTrackChangeReset(prevTrackId: string | null | undefined) {
  clearBackoff(prevTrackId)
  // Note: we intentionally DO NOT clear "unanalyzable" here to keep that mark
  // if user seeks around the same track. It will naturally clear when a new
  // trackId arrives and the old one is no longer queried.
}
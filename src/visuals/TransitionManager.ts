// Minimal beat-synced scene switcher using the ReactivityBus.
// Usage in App:
//   useEffect(() => initTransitionManager(setScene), [setScene])
//   onSceneChange(v) => requestSceneChange(v, { waitForBeat: true })
import { reactivityBus } from '../audio/ReactivityBus'

let setter: ((scene: string) => void) | null = null

export function initTransitionManager(setScene: (scene: string) => void) {
  setter = setScene
}

export function requestSceneChange(scene: string, opts?: { waitForBeat?: boolean; timeoutMs?: number }) {
  if (!setter) return
  const wait = opts?.waitForBeat ?? true
  const timeoutMs = opts?.timeoutMs ?? 1200

  if (!wait) {
    setter(scene)
    return
  }

  let done = false
  const off = reactivityBus.on('beat', () => {
    if (done) return
    done = true
    off?.()
    setter!(scene)
  })
  // fallback in case no beats arrive (paused or silent)
  setTimeout(() => {
    if (done) return
    done = true
    off?.()
    setter!(scene)
  }, timeoutMs)
}
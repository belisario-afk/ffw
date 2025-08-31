let last = performance.now()
let frames = 0
let fps = 0

export function getFPS() {
  const now = performance.now()
  frames++
  if (now - last > 1000) {
    fps = Math.round((frames * 1000) / (now - last))
    frames = 0
    last = now
  }
  return fps
}

export function useFPS() {
  return fps
}
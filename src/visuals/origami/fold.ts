// Minimal FOLD loader -> crease list for OrigamiFold
import * as THREE from 'three'

export type FoldFile = {
  file_spec?: string
  file_creator?: string
  vertices_coords: number[][]
  edges_vertices: number[][]
  edges_assignment?: string[] // 'M','V','F','B'
  edges_foldAngle?: number[]  // degrees, optional
}

export type FoldPatternCreases = {
  name: string
  creases: Array<{
    id: string
    p: { x: number, y: number }   // point on line
    d: { x: number, y: number }   // unit direction
    side: 1 | -1                  // 1 for "mountain side", -1 for "valley side"
    angle: number                 // radians
  }>
}

function normalizeSquare(vertices: number[][]) {
  // Map source bounds to [-0.7, +0.7] square, preserving aspect
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of vertices) {
    if (x < minX) minX = x; if (y < minY) minY = y
    if (x > maxX) maxX = x; if (y > maxY) maxY = y
  }
  const sx = maxX - minX || 1, sy = maxY - minY || 1
  const s = Math.max(sx, sy)
  const half = 0.7
  return vertices.map(([x, y]) => {
    const nx = ((x - minX) / s) * (2 * half) - half
    const ny = ((y - minY) / s) * (2 * half) - half
    return [nx, ny]
  })
}

function baseName(url: string) {
  try { const u = new URL(url, location.origin); const fn = u.pathname.split('/').pop() || 'FOLD'; return fn }
  catch { return 'FOLD' }
}

export async function loadFoldPattern(url: string): Promise<FoldPatternCreases> {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`Failed to load FOLD: ${resp.status}`)
  const json = await resp.json() as FoldFile
  const { vertices_coords, edges_vertices, edges_assignment, edges_foldAngle } = json
  const verts = normalizeSquare(vertices_coords)
  const creases: FoldPatternCreases['creases'] = []

  for (let i = 0; i < edges_vertices.length; i++) {
    const [aIdx, bIdx] = edges_vertices[i]
    const a = verts[aIdx], b = verts[bIdx]
    if (!a || !b) continue

    const assign = (edges_assignment?.[i] || 'F').toUpperCase()
    let angleDeg = edges_foldAngle?.[i]
    // Skip borders and flat edges
    if (assign === 'B' || assign === 'F') continue
    // If no angle, default moderately strong fold (works better with our CPU engine)
    if (angleDeg == null) angleDeg = (assign === 'M' || assign === 'V') ? 150 : 0
    if (!Number.isFinite(angleDeg) || Math.abs(angleDeg) < 0.1) continue

    // Direction and anchor
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const len = Math.hypot(dx, dy) || 1
    const d = { x: dx / len, y: dy / len }
    const p = { x: (a[0] + b[0]) * 0.5, y: (a[1] + b[1]) * 0.5 }

    // Side convention: treat mountains as side +1, valleys as -1
    const side: 1 | -1 = assign === 'M' ? 1 : -1
    const angle = (angleDeg * Math.PI) / 180

    creases.push({ id: `fold_${i}`, p, d, side, angle })
  }

  return { name: baseName(url), creases }
}
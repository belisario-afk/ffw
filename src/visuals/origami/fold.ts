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
    p: { x: number, y: number }
    d: { x: number, y: number }
    side: 1 | -1
    angle: number // radians
  }>
}

function normalizeSquare(vertices: number[][]) {
  // Map [min..max] to [-0.7..+0.7] preserving aspect (assume square-ish)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of vertices) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y }
  const sx = maxX - minX || 1, sy = maxY - minY || 1
  const s = Math.max(sx, sy)
  const half = 0.7
  return vertices.map(([x, y]) => {
    const nx = ((x - minX) / s) * (2 * half) - half
    const ny = ((y - minY) / s) * (2 * half) - half
    return [nx, ny]
  })
}

export async function loadFoldPattern(url: string): Promise<FoldPatternCreases> {
  const resp = await fetch(url)
  const json = await resp.json() as FoldFile
  const { vertices_coords, edges_vertices, edges_assignment, edges_foldAngle } = json
  const verts = normalizeSquare(vertices_coords)
  const creases: FoldPatternCreases['creases'] = []
  for (let i = 0; i < edges_vertices.length; i++) {
    const [aIdx, bIdx] = edges_vertices[i]
    const a = verts[aIdx], b = verts[bIdx]
    if (!a || !b) continue
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const len = Math.hypot(dx, dy) || 1
    const d = { x: dx / len, y: dy / len }
    const p = { x: (a[0] + b[0]) * 0.5, y: (a[1] + b[1]) * 0.5 } // mid as line point
    const asg = edges_assignment?.[i] || 'F'
    // angle: use foldAngle if present else default
    let angleDeg = edges_foldAngle?.[i]
    if (angleDeg == null) angleDeg = (asg === 'M' || asg === 'V') ? 150 : 180
    const angle = (angleDeg * Math.PI) / 180
    // side: choose based on assignment (M/V) to spread layers symmetrically
    const side: 1 | -1 = asg === 'M' ? 1 : asg === 'V' ? -1 : 1
    creases.push({
      id: `fold_${i}`,
      p, d, side, angle
    })
  }
  return { name: 'FOLD Pattern', creases }
}
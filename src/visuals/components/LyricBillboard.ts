import * as THREE from 'three'
import { Text } from 'troika-three-text'

type Layer = {
  group: THREE.Group
  base: Text
  hi: Text
  bounds: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number }
  underline: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  centerX: number
  opacity: number
}

export class LyricBillboard {
  group = new THREE.Group()
  private current: Layer | null = null
  private next: Layer | null = null
  private swapT = 0
  private swapping = false

  private baseColor = new THREE.Color(0xffffff)
  private outlineColor = new THREE.Color(0xa7b8ff)
  private highlightColor = new THREE.Color(0x77d0ff)
  private font = undefined as string | undefined
  private fontSize = 0.36

  // Pop effect state (decays over time)
  private pop = 0

  constructor(opts?: {
    baseColor?: THREE.ColorRepresentation
    outlineColor?: THREE.ColorRepresentation
    highlightColor?: THREE.ColorRepresentation
    font?: string
    fontSize?: number
  }) {
    if (opts?.baseColor) this.baseColor.set(opts.baseColor)
    if (opts?.outlineColor) this.outlineColor.set(opts.outlineColor)
    if (opts?.highlightColor) this.highlightColor.set(opts.highlightColor)
    if (opts?.font) this.font = opts.font
    if (opts?.fontSize) this.fontSize = opts.fontSize

    this.group.renderOrder = 2
    this.group.visible = true
  }

  async setLineNow(text: string) {
    // Replace current immediately (no transition)
    const layer = await this.createLayer(text)
    this.disposeLayer(this.current)
    this.current = layer
    this.group.add(layer.group)
    this.resetProgress()
  }

  async prepareNext(text: string) {
    // Pre-create 'next' offscreen to the right
    const layer = await this.createLayer(text)
    layer.group.position.x = 2.0
    layer.opacity = 0
    this.applyOpacity(layer)
    this.disposeLayer(this.next)
    this.next = layer
    this.group.add(layer.group)
  }

  beginSwap() {
    if (!this.next) return
    // If no current, promote next immediately
    if (!this.current) {
      this.current = this.next
      this.next = null
      this.resetProgress()
      return
    }
    this.swapT = 0
    this.swapping = true
  }

  // Brief scale/glow pop (0..1.5 recommended). Effect decays in update().
  triggerPop(strength = 1) {
    this.pop = Math.min(1.5, this.pop + Math.max(0, strength))
  }

  setProgress(p: number) {
    // Reveal highlight in current layer [0..1] and grow underline accordingly
    if (!this.current) return
    const c = this.current
    const { minX, minY, maxY, width } = c.bounds
    const prog = THREE.MathUtils.clamp(p, 0, 1)
    const right = minX + prog * width
    c.hi.clipRect = [minX, minY, right, maxY]
    c.hi.needsUpdate = true
    this.updateUnderline(c, prog)
  }

  resetProgress() {
    if (!this.current) return
    const c = this.current
    const { minX, minY, maxY } = c.bounds
    c.hi.clipRect = [minX, minY, minX, maxY]
    c.hi.needsUpdate = true
    this.updateUnderline(c, 0)
  }

  setColors(base: THREE.Color, outline: THREE.Color, highlight: THREE.Color) {
    this.baseColor.copy(base)
    this.outlineColor.copy(outline)
    this.highlightColor.copy(highlight)
    if (this.current) this.applyColors(this.current)
    if (this.next) this.applyColors(this.next)
  }

  setVisible(v: boolean) {
    this.group.visible = v
  }

  update(dt: number) {
    // Pop effect (scale + glow) decays regardless of swapping
    if (this.pop > 0) {
      this.pop = Math.max(0, this.pop - dt * 3.5)
    }
    const popT = easeOutQuad(Math.min(1, this.pop))
    const scale = 1 + 0.06 * popT
    this.group.scale.setScalar(scale)

    // Increase highlight outline while popping
    if (this.current) {
      const baseW = 0.008, baseB = 0.004
      this.current.hi.outlineWidth = baseW + 0.012 * popT
      this.current.hi.outlineBlur = baseB + 0.010 * popT
      this.current.hi.needsUpdate = true
    }

    if (!this.swapping) return
    // Smooth slide: current -> left(-2), next -> center(0)
    this.swapT = Math.min(1, this.swapT + dt * 2.0)
    const t = easeInOutCubic(this.swapT)

    if (this.current) {
      this.current.group.position.x = THREE.MathUtils.lerp(0, -2.0, t)
      this.current.opacity = 1 - t
      this.applyOpacity(this.current)
    }
    if (this.next) {
      this.next.group.position.x = THREE.MathUtils.lerp(2.0, 0, t)
      this.next.opacity = t
      this.applyOpacity(this.next)
    }

    if (this.swapT >= 1) {
      // Promote next to current
      this.disposeLayer(this.current)
      this.current = this.next
      this.next = null
      this.swapping = false
      this.swapT = 0
      this.resetProgress()
    }
  }

  dispose() {
    this.disposeLayer(this.current)
    this.disposeLayer(this.next)
    this.current = null
    this.next = null
    this.group.clear()
  }

  // Internal helpers

  private async createLayer(textStr: string): Promise<Layer> {
  const group = new THREE.Group()

  const base = new Text()
  base.text = textStr || ''
  base.font = this.font
  base.fontSize = this.fontSize
  base.anchorX = 'center'
  base.anchorY = 'middle'
  base.color = this.baseColor.getHex()
  base.outlineColor = this.outlineColor.getHex()
  base.outlineWidth = 0.005
  base.outlineBlur = 0.002
  base.maxWidth = 6
  base.overflowWrap = 'break-word'
  base.depthOffset = -1
  base.frustumCulled = true
  base.renderOrder = 3
  base.material.transparent = true
  base.material.depthWrite = false

  const hi = new Text()
  hi.text = textStr || ''
  hi.font = this.font
  hi.fontSize = this.fontSize
  hi.anchorX = 'center'
  hi.anchorY = 'middle'
  hi.color = this.highlightColor.getHex()
  hi.outlineColor = this.highlightColor.clone().multiplyScalar(1.05).getHex()
  hi.outlineWidth = 0.008
  hi.outlineBlur = 0.004
  hi.maxWidth = 6
  hi.overflowWrap = 'break-word'
  hi.depthOffset = 0
  hi.frustumCulled = true
  hi.renderOrder = 4
  hi.material.transparent = true
  hi.material.depthWrite = false

  // Ensure geometries are built to get bounds
  await new Promise<void>(res => base.sync(() => res()))
  await new Promise<void>(res => hi.sync(() => res()))

  const bounds = getBounds(base)
  const centerX = (bounds.minX + bounds.maxX) * 0.5

  // Start with zero-width highlight
  hi.clipRect = [bounds.minX, bounds.minY, bounds.minX, bounds.maxY]

  // Underline (grows with progress). Keep it invisible until progress > 0.
  const underlineGeom = new THREE.PlaneGeometry(bounds.width, 0.012, 1, 1)
  const underlineMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, // set below
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    toneMapped: false
  })
  const underline = new THREE.Mesh(underlineGeom, underlineMat)
  underline.renderOrder = 2
  underline.position.y = bounds.minY - 0.06
  underline.scale.x = 0
  underline.visible = false

  group.add(base)
  group.add(hi)
  group.add(underline)

  const layer: Layer = { group, base, hi, bounds, underline, centerX, opacity: 1 }
  this.applyColors(layer)
  this.applyOpacity(layer)
  return layer
}

private applyColors(layer: Layer) {
  layer.base.color = this.baseColor.getHex()
  layer.base.outlineColor = this.outlineColor.getHex()
  layer.hi.color = this.highlightColor.getHex()
  layer.hi.outlineColor = this.highlightColor.clone().multiplyScalar(1.05).getHex()
  // IMPORTANT: use .set() on MeshBasicMaterial.color
  layer.underline.material.color.set(this.highlightColor)
  layer.base.needsUpdate = true
  layer.hi.needsUpdate = true
}

private updateUnderline(layer: Layer, prog: number) {
  const p = THREE.MathUtils.clamp(prog, 0, 1)
  const w = layer.bounds.width
  const widthNow = Math.max(0.0001, w * p)
  const targetCenterX = layer.bounds.minX + widthNow * 0.5
  layer.underline.scale.x = p
  layer.underline.position.x = targetCenterX - layer.centerX
  layer.underline.visible = p > 0.001
}

  private disposeLayer(layer: Layer | null) {
    if (!layer) return
    layer.group.removeFromParent()
    layer.base.dispose()
    layer.hi.dispose()
    ;(layer.base.material as any)?.dispose?.()
    ;(layer.hi.material as any)?.dispose?.()
    layer.underline.geometry.dispose()
    layer.underline.material.dispose()
  }
}

function getBounds(t: Text): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } {
  // troika exposes textRenderInfo.blockBounds as [minX, minY, maxX, maxY]
  const info = (t as any).textRenderInfo
  const bb: [number, number, number, number] = info?.blockBounds || [-0.5, -0.5, 0.5, 0.5]
  const [minX, minY, maxX, maxY] = bb
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
}

function easeInOutCubic(x: number) {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

function easeOutQuad(x: number) {
  return 1 - (1 - x) * (1 - x)
}
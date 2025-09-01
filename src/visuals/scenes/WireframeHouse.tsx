// Updated to consume precise bar/section events for camera presets.
// Only the new/changed parts versus your current file are relevant.

import React, { useEffect, useRef, useState } from 'react'
import type { AuthState } from '../../auth/token'
import { ensurePlayerConnected } from '../../spotify/player'
import { AudioAnalyzer } from '../../audio/AudioAnalyzer'
import { CONFIG } from '../../config'
import { getPlaybackState } from '../../spotify/api'
import { extractPaletteFromImage, applyPaletteToCss } from '../../utils/palette'
import { cacheAlbumArt } from '../../utils/idb'
import { setAlbumSkin } from '../../ui/ThemeManager'
import type { HouseSettings } from '../../ui/HousePanel'
import { reactivityBus, type ReactiveFrame } from '../../audio/ReactivityBus'

// ... keep previous types (Vec3, Edge, Ring, Confetti)

export default function WireframeHouse({ auth, quality, accessibility, settings }: Props) {
  // ... existing refs/state ...

  // Camera preset director (reacts to sections)
  const camRadiusRef = useRef(settings.orbitRadius)
  const camElevRef = useRef(settings.orbitElev)
  const camSpeedMulRef = useRef(1)
  const presetRef = useRef<number>(0)

  // Subscribe to bar/section events for cinematic cuts
  useEffect(() => {
    const offBar = reactivityBus.on('bar', () => {
      // subtle punch on bar
      beatIntensityRef.current = Math.min(1, beatIntensityRef.current + 0.25)
    })
    const offSec = reactivityBus.on('section', (_name) => {
      // Cycle camera presets on section changes
      presetRef.current = (presetRef.current + 1) % 3
      if (presetRef.current === 0) {
        // Wide slow orbit
        targetCam(camRadiusRef, 6.2, 0.08)
        targetElev(camElevRef, -0.08)
        camSpeedMulRef.current = 0.8
      } else if (presetRef.current === 1) {
        // Close low sweep
        targetCam(camRadiusRef, 4.6, 0.12)
        targetElev(camElevRef, -0.02)
        camSpeedMulRef.current = 1.2
      } else {
        // Medium high angle
        targetCam(camRadiusRef, 5.4, 0.1)
        targetElev(camElevRef, 0.04)
        camSpeedMulRef.current = 1.0
      }
    })
    return () => { offBar?.(); offSec?.() }
  }, [])

  // ... analyzer boot, reactivityBus frame subscription, render loop, etc.

  function stepPhysics(f: ReactiveFrame | null, dt: number) {
    // ... existing beat/explosion/rings/confetti logic ...

    // Orbit angle (use preset speed multiplier)
    if (settings.orbit) {
      const low = f?.bands.low ?? 0.1
      const speed = (settings.orbitSpeed * camSpeedMulRef.current) + low * 0.8 + beatIntensityRef.current * 1.2
      orbitAngleRef.current += speed * dt
    }

    // Smooth camera preset lerps
    camRadiusRef.current = lerp(camRadiusRef.current, clamp(settings.orbitRadius, 3.5, 8) /* base */,
      0.04) // ease toward base to respect user setting
  }

  function drawScene(g: CanvasRenderingContext2D, canvas: HTMLCanvasElement, f: ReactiveFrame | null) {
    // ... background, colors, stars, horizon ...

    // Camera (use directed radius/elev, smoothed)
    const radius = camRadiusRef.current
    const angle = settings.orbit ? orbitAngleRef.current : 0
    const elev = camElevRef.current
    // ... build cam vec and project ...

    // Optional: use precise bar/section phases for subtle scale changes
    const barPhase = f?.phases.bar ?? 0
    const scale = 1 + beatIntensityRef.current * 0.06 + (f?.bands.low ?? 0) * 0.02 + Math.sin(barPhase * Math.PI) * 0.015

    // ... wireframe/FX drawing with 'scale' ...
  }

  // --- small helpers for camera ---
  function targetCam(ref: React.MutableRefObject<number>, target: number, strength = 0.1) {
    // jump a bit, then lerp in stepPhysics
    ref.current = ref.current * (1 - strength) + target * strength
  }
  function targetElev(ref: React.MutableRefObject<number>, target: number) { ref.current = target }
  function lerp(a: number, b: number, t: number) { return a + (b - a) * t }
  function clamp(x: number, a: number, b: number) { return Math.max(a, Math.min(b, x)) }
}
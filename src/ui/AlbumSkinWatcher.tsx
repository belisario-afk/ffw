import React, { useEffect, useRef } from 'react'
import { getPlaybackState } from '../spotify/api'
import { cacheAlbumArt } from '../utils/idb'
import { extractPaletteFromImage, applyPaletteToCss } from '../utils/palette'
import { setAlbumSkin, isAlbumSkinEnabled } from './ThemeManager'

export default function AlbumSkinWatcher() {
  const lastTrackIdRef = useRef<string | null>(null)
  const lastUrlRef = useRef<string | null>(null)

  useEffect(() => {
    let stopped = false
    const applyForUrl = (url: string) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.src = url
      img.onload = () => {
        if (stopped) return
        applyPaletteToCss(extractPaletteFromImage(img))
        if (isAlbumSkinEnabled()) setAlbumSkin(url)
      }
    }

    async function tick() {
      try {
        const s = await getPlaybackState().catch(() => null)
        const id = s?.item?.id || null
        if (id && id !== lastTrackIdRef.current) {
          lastTrackIdRef.current = id
          const artUrl: string | null = (s?.item?.album?.images?.[0]?.url as string) || null
          if (artUrl) {
            const blobUrl = await cacheAlbumArt(artUrl).catch(() => artUrl)
            lastUrlRef.current = blobUrl
            applyForUrl(blobUrl)
          }
        }
        if (!isAlbumSkinEnabled() && lastUrlRef.current) setAlbumSkin(null)
      } catch {}
    }

    tick()
    const iv = window.setInterval(tick, 4000)
    return () => { stopped = true; clearInterval(iv) }
  }, [])

  return null
}
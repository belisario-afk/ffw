import { useEffect } from 'react'
import { usePlayback } from './PlaybackProvider'
export function useEnsurePlaybackReady() {
  const { token } = usePlayback()
  useEffect(() => {
    if (token) (window as any).__ffw__getSpotifyToken = async () => token
  }, [token])
}
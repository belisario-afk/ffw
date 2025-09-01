export async function loadWebPlaybackSDK(): Promise<void> {
  if ((window as any).Spotify) return
  if (!document.getElementById('spotify-web-playback-sdk')) {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script')
      s.id = 'spotify-web-playback-sdk'
      s.src = 'https://sdk.scdn.co/spotify-player.js'
      s.async = true
      s.defer = true
      s.onload = () => resolve()
      s.onerror = () => reject(new Error('Failed to load Spotify Web Playback SDK'))
      document.head.appendChild(s)
    })
  }
  await new Promise<void>((resolve) => {
    if ((window as any).Spotify) resolve()
    ;(window as any).onSpotifyWebPlaybackSDKReady = () => resolve()
  })
}
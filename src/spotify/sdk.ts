// Load Spotify Web Playback SDK if it's not present.
export async function loadWebPlaybackSDK(): Promise<void> {
  if ((window as any).Spotify) return

  const existing = document.getElementById('spotify-web-playback-sdk')
  if (!existing) {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.id = 'spotify-web-playback-sdk'
      script.src = 'https://sdk.scdn.co/spotify-player.js'
      script.async = true
      script.defer = true
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('Failed to load Spotify Web Playback SDK'))
      document.head.appendChild(script)
    })
  }

  await new Promise<void>((resolve) => {
    if ((window as any).Spotify) return resolve()
    ;(window as any).onSpotifyWebPlaybackSDKReady = () => resolve()
  })
}
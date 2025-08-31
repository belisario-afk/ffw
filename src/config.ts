export const CONFIG = {
  clientId: import.meta.env.VITE_SPOTIFY_CLIENT_ID as string,
  redirectUri: (import.meta.env.VITE_REDIRECT_URI as string) || `${location.origin}${import.meta.env.BASE_URL}callback`,
  appBase: (import.meta.env.VITE_APP_BASE as string) || '/ffw/',
  // Analysis defaults
  fftSize: 4096 as 4096 | 8192,
}
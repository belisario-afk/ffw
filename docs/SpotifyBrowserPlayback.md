Quick checklist to get “FFw visualizer” playing in the browser

1) Spotify account and scopes
- Premium account required for Web Playback SDK playback.
- Token needs scopes:
  - streaming
  - user-read-playback-state
  - user-modify-playback-state
  - user-read-currently-playing

2) Provide a token to the app
- Easiest for testing (in DevTools):
  window.__ffw__getSpotifyToken = async () => 'YOUR_BEARER_TOKEN'
- Or pass auth to WireframeHouse3D; it sets the player token provider from props.auth.accessToken.

3) Enable browser playback
- Click ▶ Play in Browser in the TopBar.
  - Loads SDK
  - Connects player
  - Activates audio element
  - Transfers playback to the “FFw visualizer” device

4) If device doesn’t appear
- Ensure site is HTTPS (or localhost).
- Unblock https://sdk.scdn.co in extensions.
- Token must be fresh (403s often mean expired/insufficient scopes).
- Open Spotify app and pick the “FFw visualizer” device from the device picker.

Console quick test
(async () => {
  const token = await window.__ffw__getSpotifyToken();
  const r = await fetch('https://api.spotify.com/v1/me/player/devices', { headers: { Authorization: `Bearer ${token}` }});
  console.log('Devices', await r.json());
})();
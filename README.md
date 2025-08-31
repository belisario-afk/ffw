# FFW — Minimal Cyber-Punk Spotify Visualizer

Production-ready single-page app built with Vite + React + TypeScript. Deploys to GitHub Pages and supports local development.

Focus: one Blank scene (audio-reactive), clean popup panels, and advanced player controls.

Important: Security and Spotify PKCE
- Uses Spotify Authorization Code Flow with PKCE.
- No client secret is used or stored anywhere (frontend only).
- Spotify Client ID in this demo: `927fda6918514f96903e828fcd6bb576`
- Redirect URI (register in Spotify dashboard): `https://belisario-afk.github.io/ffw/callback`

Never commit or expose client secrets in this repo. If a secret is exposed, rotate it immediately in the Spotify Dashboard.

## Features

- Login with Spotify (PKCE)
- Web Playback SDK support (in-page playback for Premium users)
- Fallback to remote device control (play/pause, next/prev, seek, volume, device picker)
- Advanced player controls: transport, seek scrub bar, volume, device picker, repeat, shuffle, track metadata + progress
- Single BlankScene visual that:
  - Starts/stops with the app
  - Reacts to FFT (real-time), beat events, and a chroma vector
  - Accepts theme palette extracted from album art (CSS variables)
  - Responds to QualityPanel changes (render scale, bloom, motion blur, MSAA placeholder)
- Audio analysis:
  - Real-time FFT (4096/8192)
  - Log-frequency bands, spectral flux beat detection
  - Output: FFT bins, beat boolean + timestamp, tempo estimate (approx), chroma (12 bins), loudness trend
- UI & VJ panels:
  - Control bar
  - Popup panels (scene picker omitted by design; only Blank)
  - Quality panel (renderScale, MSAA, bloom, motion blur)
  - VJ/Accessibility panel (epilepsy-safe, reduced-motion, high-contrast)
  - FPS and GPU label overlay
- Performance:
  - Lazy-loaded analysis after auth
  - Adaptive frame-time approach in visuals
- Album art & theme:
  - Album color palette extraction; CSS variables updated to tint the UI
  - IndexedDB caching of album art blobs with ETags
- Accessibility & safety:
  - Epilepsy-safe mode caps strobe-like effects
  - Reduced motion and high contrast modes
  - Keyboard accessible controls and focus-trapped popups

## Repo and structure

Repository: `belisario-afk/ffw`

Directory layout:
```
/auth
/spotify
/audio
/visuals/scenes
/controllers
/ui
/utils
/assets (optional)
/public
```

## Local development

1. In the Spotify Developer Dashboard:
   - Create an app (or use your existing one).
   - Add Redirect URIs:
     - `http://localhost:5173/callback`
     - `https://belisario-afk.github.io/ffw/callback`

2. Configure `.env.local` for local overrides (do not commit this file):
   ```
   VITE_SPOTIFY_CLIENT_ID=YOUR_CLIENT_ID
   VITE_REDIRECT_URI=http://localhost:5173/callback
   VITE_APP_BASE=/
   ```

3. Install and run:
   ```
   npm install
   npm run dev
   ```

   Open http://localhost:5173. Login with Spotify; you must grant the following scopes:
   - streaming
   - user-read-email
   - user-read-private
   - user-read-playback-state
   - user-modify-playback-state
   - user-read-currently-playing

Note: For in-page playback, you need a Premium account. Otherwise, use the Device Picker to control an external device.

## Build and deploy to GitHub Pages

This repo is configured for Pages deployment:

- Vite base is set to `/ffw/`.
- SPA fallback is provided via `public/404.html`.
- Workflow located at `.github/workflows/deploy.yml`.

To build locally:
```
npm run build
npm run preview
```

To deploy via GitHub Actions: push to `main`. The workflow builds and deploys `dist/` to GitHub Pages.

## Security notes

- This project uses PKCE. No client secret is ever used.
- The client ID is public. Treat it as an identifier, not a secret.
- NEVER embed secrets in frontend code or in your repo.
- If a secret is compromised or committed accidentally, rotate it immediately.

## Keyboard shortcuts

- Space: Play/Pause
- ←/→: Seek
- +/-: Volume
- F: Fullscreen
- Q: Quality panel
- V: VJ/Accessibility panel
- D: Device Picker
- Esc: Close popups

## Adding new scenes (next steps)

- Create a new component in `src/visuals/scenes/` implementing the same props as `BlankScene`.
- Wire it in with a scene picker panel (currently omitted to enforce “exactly one scene”).
- Use the `AudioAnalyzer` frame data for your effects.

## Troubleshooting

- If Web Playback SDK fails to start: ensure Premium, scopes granted, and the page had user interaction to allow audio.
- If visuals don't react: the app tries to connect a MediaElementSource to the SDK’s audio; some browsers/devices prevent this. The visual will still run with limited responsiveness. Remote control remains available.
- For local dev: remember to add `http://localhost:5173/callback` to your Spotify Redirect URIs.

## License

MIT
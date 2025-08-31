import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react-swc'

// Copy public/404.html into dist/404.html is handled by Vite automatically for files in public.
// We also ensure base path for GitHub Pages project site.
export default defineConfig({
  base: process.env.VITE_APP_BASE || '/ffw/',
  plugins: [react()],
  build: {
    target: 'es2020',
    sourcemap: true
  },
  server: {
    port: 5173,
    open: false
  }
})
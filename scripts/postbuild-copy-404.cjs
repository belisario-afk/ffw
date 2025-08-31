// Ensure 404.html exists in dist in case public wasn't included (defense-in-depth).
// Vite copies /public automatically, but this keeps CI robust.
const fs = require('fs');
const path = require('path');
const dist = path.join(__dirname, '..', 'dist');
const fallback = path.join(__dirname, '..', 'public', '404.html');
const out = path.join(dist, '404.html');
if (fs.existsSync(fallback) && fs.existsSync(dist) && !fs.existsSync(out)) {
  fs.copyFileSync(fallback, out);
  console.log('Copied 404.html to dist/');
}
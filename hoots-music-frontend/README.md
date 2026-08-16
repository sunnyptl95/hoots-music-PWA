# Hoots Music — Frontend (PWA)

Vanilla HTML/CSS/JS installable web app. Dark glassmorphism, violet glow,
with a signature "owl-eye" equalizer in the player bar that glows/pulses
while a track plays.

## Setup

1. Open `js/app.js` and set `API_BASE` to your backend URL:
   ```js
   const API_BASE = "http://localhost:8000";   // change after deploying
   ```

2. Serve the folder over HTTP (service workers require a proper origin,
   not `file://`). Easiest for local testing:
   ```bash
   python -m http.server 3000
   ```
   Then open http://localhost:3000

3. Make sure the backend's `.env` has:
   ```
   FRONTEND_URL=http://localhost:3000
   GOOGLE_REDIRECT_URI=http://localhost:8000/auth/google/callback
   ```
   (CORS + Google OAuth handoff both depend on `FRONTEND_URL` matching
   wherever this frontend is actually running.)

## What's wired up

- **Auth** — login/signup tabs, Google OAuth button (redirects to backend,
  comes back with a token in the URL hash, frontend picks it up automatically)
- **Search** — debounced, hits `/search`, click any result to play
- **Player** — persistent bottom bar, play/pause/skip, seek bar, the
  owl-eye equalizer glows while playing and "blinks" periodically
- **Ad-gating** — on song end, calls `/song-ended`; if the backend says
  `show_ad: true`, a simple overlay appears before the next track
  (currently a placeholder card — swap in a real ad network's embed code
  in `showAd()` in `app.js` once you have one)
- **Playlists** — create in the sidebar, "+" on any song to add it to one,
  click a playlist to view/play it
- **Admin panel** — only visible if your account has `role: admin`; lets
  you set the daily ad cap/type and ban/unban users

## Installing as an app

Once served over HTTPS (Netlify/Vercel/Render all give you this for free),
open it in Chrome/Edge on desktop or Android and you'll get an install
prompt — or manually via the browser menu → "Install app" / "Add to Home Screen".
On iOS Safari: Share → "Add to Home Screen".

## Notes

- Icons were generated as a simple owl-eye mark in violet — swap
  `icons/icon-192.png` / `icons/icon-512.png` for your own OWLEST branding
  whenever you want.
- The service worker only caches the app shell (HTML/CSS/JS/icons) — it
  deliberately never caches `/search`, `/stream`, `/playlists`, `/admin`,
  or `/auth` calls, since those need to always hit the network fresh.
- No build step — this is plain JS, easy to hand off to any static host.

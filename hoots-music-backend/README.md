# OWLEST Music — Backend (Phase 1: Auth)

FastAPI + MongoDB backend with email/password auth, Google OAuth, JWT sessions,
and role-based access (user/admin). This is Phase 1 from the blueprint —
search/stream/ads/playlists come next.

## Setup

1. Copy `.env.example` to `.env` and fill in:
   - `MONGO_URI` — MongoDB Atlas connection string (or local Mongo)
   - `JWT_SECRET` — any long random string
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from Google Cloud Console →
     Credentials → OAuth 2.0 Client ID (Web application). Add
     `http://localhost:8000/auth/google/callback` as an authorized redirect URI.
   - `FIRST_ADMIN_EMAIL` — set this to your own email *before* you sign up,
     so your first account is auto-promoted to `admin`.

2. Install dependencies:
   ```bash
   python3 -m venv venv
   source venv/bin/activate          # Windows: venv\Scripts\activate
   pip install -r requirements.txt
   ```

3. Run the server:
   ```bash
   uvicorn app.main:app --reload
   ```

4. Open the interactive docs: http://localhost:8000/docs
   - Try `POST /auth/signup` with an email + password
   - Then `POST /auth/login` to get a token
   - Use the "Authorize" button in `/docs` (paste the token) to call `GET /auth/me`

## Endpoints in this phase

| Method | Route | Auth needed | Description |
|---|---|---|---|
| POST | `/auth/signup` | no | Email+password signup, returns JWT |
| POST | `/auth/login` | no | Email+password login, returns JWT |
| POST | `/auth/logout` | yes | Closes the current login session |
| GET | `/auth/me` | yes | Current user info |
| GET | `/auth/google` | no | Redirects to Google consent screen |
| GET | `/auth/google/callback` | no | Google redirects here; creates/links account, sends JWT to frontend |

## Notes

- Password hashing: bcrypt (via passlib)
- JWT: 7-day expiry by default (`JWT_EXPIRE_MINUTES` in `.env`)
- Every login/logout writes a row in `login_sessions` — this is what will
  power the "playtime/login history" profile screen later
- Google login and email/password login on the same email are linked to one
  account automatically (matched by email)
- `role` field (`user`/`admin`) is on the user document — admin routes will
  use `get_current_admin` from `app/auth.py` as a dependency

## Next (Phase 2)

- `/search` — yt-dlp search endpoint
- `/stream/{yt_id}` — extract playable stream URL
- Cache extracted URLs briefly to avoid re-extracting on every play

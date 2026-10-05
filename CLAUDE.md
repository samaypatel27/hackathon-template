# Project rules

Hackathon starter: React + Vite + TS frontend (`frontend/`), FastAPI backend (`backend/`), Claude via the `anthropic` SDK, Supabase Auth + Postgres, Google sign-in.

## Setup wizard (`setup/`)

- `node setup/server.js` serves a one-time setup wizard at http://localhost:4000. It writes `backend/.env` + `frontend/.env`, runs `npm install` and the backend venv + `pip install` (streamed to the page over SSE), and tests the Anthropic, Supabase and Google credentials before anything is saved.
- **Dev-only tool, never deployed.** It can write files and run commands, so it binds to `127.0.0.1` and rejects requests from other hosts and origins. Don't add it to any deployment, and don't relax those checks.
- It deliberately has **zero npm dependencies** (Node built-ins only, plain HTML/JS UI in `setup/public/`), because it has to run on a fresh clone before anything is installed. Don't add a `package.json`, Express, or a build step to it.
- **Keep it in sync with the env vars.** When you add a new env var to the project, also add it to the env schema at the top of `setup/server.js` (`BACKEND_KEYS` / `FRONTEND_KEYS`, plus `USER_FIELDS` and a field in `setup/public/index.html` + `FIELDS` in `setup/public/app.js` if the user has to type it), and to the matching `.env.example`. Otherwise the wizard writes incomplete `.env` files.
- The wizard's Claude test model (`ANTHROPIC_MODEL` in `setup/server.js`) should match the backend's default model.

## Running

- Backend (port 5000): `cd backend && source venv/bin/activate` (Windows: `venv\Scripts\activate`) then `uvicorn main:app --reload --port 5000`. Swagger UI at http://localhost:5000/docs.
- Frontend (port 5173): `cd frontend && npm run dev`. Vite uses `strictPort`, so it fails instead of drifting to 5174.
- Both must run at once. Keep the ports fixed: CORS allows exactly `FRONTEND_URL`, and the OAuth redirect URI is hard-registered with Google.
- Use `localhost` everywhere, never `127.0.0.1`. The session cookie is per-host, so mixing the two makes sign-in look broken.

## OAuth: where the URLs and IDs have to match

The flow is backend-driven: `/auth/login/google` → Google → `GOOGLE_REDIRECT_URI` (`/auth/callback`) → the backend exchanges the code for a Google ID token → `supabase.auth.sign_in_with_id_token` → an httpOnly `session` cookie holding the Supabase access token.

- **Google Cloud Console** → Credentials → OAuth client → *Authorized redirect URIs* must contain the exact `GOOGLE_REDIRECT_URI` (default `http://localhost:5000/auth/callback`), including scheme, port, and path, with no trailing slash.
- **Supabase dashboard** → Authentication → Sign In / Providers → Google must be enabled, and its *Client ID* must be the same `GOOGLE_CLIENT_ID` as the backend, or Supabase rejects the ID token. Supabase's own callback URL (`https://<ref>.supabase.co/auth/v1/callback`) is not used by this flow.
- For deployment, add the production callback URL in Google and update `GOOGLE_REDIRECT_URI` and `FRONTEND_URL` to match.

## API conventions

- Every backend JSON response has `ok: true|false`. Errors look like `{"ok": false, "error": "<readable message>"}` with a non-2xx status. The frontend's `callBackend()` in `frontend/src/lib/api.ts` relies on this shape.
- Default Claude model is `claude-opus-5` (can be overridden with `ANTHROPIC_MODEL`).

## Secrets

- **Never commit real `.env` files.** Only `.env.example` files with placeholder values go in git (`.gitignore` already excludes `.env`).
- `SUPABASE_SERVICE_ROLE_KEY` bypasses Row Level Security. It stays in the backend and must never go in a `VITE_*` variable, because everything with that prefix is shipped to the browser.
- When you add a new env var, add a placeholder for it to the matching `.env.example`.

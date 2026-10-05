# Hackathon Starter: React + FastAPI + Claude + Supabase

## Quick start (already set up?)

If setup is already complete, run these in two terminals from the repo root:

**Terminal 1 (backend):**
```powershell
cd backend; .\venv\Scripts\python -m uvicorn main:app --reload --port 5000
```

**Terminal 2 (frontend):**
```powershell
cd frontend; npm run dev
```

Then open http://localhost:5173 (app) and http://localhost:5000/docs (API docs).

**Not set up yet?** Skip to [Quickstart (setup wizard)](#3-quickstart-setup-wizard) below.

## 1. What this is

A ready-to-run full-stack template: a React (Vite + TypeScript) frontend, a FastAPI backend that calls Claude through the Anthropic API, and Google sign-in backed by Supabase Auth. A setup wizard writes your config and installs everything. Then the app's home page checks your environment: when every row shows a green ✓, you're ready to build.

```
hackathon-template/
├── setup/            one-time setup wizard (node setup/server.js → http://localhost:4000)
├── backend/          FastAPI app (main.py), requirements.txt, .env.example
├── frontend/         Vite + React + TS app, .env.example
├── CLAUDE.md         project rules for Claude Code / AI assistants
└── README.md
```

## 2. Prerequisites

- **Node.js 20.19+ or 22.12+** (`node -v`)
- **Python 3.10+** (`python --version`)
- An **Anthropic API key**: https://console.anthropic.com → API Keys
- A **Supabase account** (free tier is fine): https://supabase.com
- A **Google Cloud project** where you can create OAuth credentials: https://console.cloud.google.com

## 3. Quickstart (setup wizard)

```bash
git clone <repo-url>
cd <repo-name>
node setup/server.js
```

Then open **http://localhost:4000** and follow the on-screen steps:

1. **Anthropic:** paste your API key and click **Test Key**.
2. **Supabase:** paste the Project URL, anon key and service role key, then click **Test Connection**. The page says where to find each one.
3. **Google OAuth:** copy the redirect URI the page shows into Google Cloud Console, paste your Client ID and Secret, and click **Validate**. **Test redirect URI** runs a real Google sign-in to confirm the URI is registered correctly.
4. **Write & Install:** check the summary, click **Generate .env files**, then **Install dependencies**. You'll see `npm install` and the Python venv + `pip install` run in a live log.
5. **Done:** the page shows the two commands that start the app.

The wizard has no dependencies of its own (just Node built-ins), so `node setup/server.js` is the only command to run before it. It only listens on `localhost`, is never deployed, and can be stopped with Ctrl+C when you're finished. If you close the tab, reopening http://localhost:4000 shows what's already done.

## 4. Verify it's working

Start the app with two terminals, both from the repo folder:

```bash
# Terminal 1: backend
cd backend && source venv/bin/activate && uvicorn main:app --reload --port 5000
# Windows PowerShell:  cd backend; .\venv\Scripts\python -m uvicorn main:app --reload --port 5000

# Terminal 2: frontend
cd frontend && npm run dev
```

1. Open **http://localhost:5173**.
2. Click **Run** on each row. You want a green ✓ on all of them:
   - **Test Backend Health:** FastAPI is up and CORS is working.
   - **Test Anthropic API:** your API key works. You'll see Claude's 5-word hello.
   - **Test Random Endpoint:** the backend can make outbound HTTP calls (it fetches a random joke).
3. Click **Sign in with Google**, pick your account, and you'll land back on the page with your name and email shown. That means Google, Supabase, and the session cookie all work. You'll also see your user under **Supabase → Authentication → Users**.
4. Open **http://localhost:5000/docs** for the Swagger UI. Expand any route (for example `GET /test-anthropic`), click **Try it out → Execute**, and look at the raw JSON.
   - Exception: `/auth/login/google` is a browser redirect, so open it directly in a tab instead of using "Try it out".

Every response has the shape `{"ok": true, ...}` or `{"ok": false, "error": "..."}`. Now build your app: add routes in `backend/main.py` and UI in `frontend/src/`.

## 5. Troubleshooting

**Start with the wizard.** Most problems are a wrong or mistyped key. Run `node setup/server.js`, open http://localhost:4000, and click the test buttons. It reloads your saved values, and each test explains exactly what's wrong (bad key, no credits, wrong Supabase key in the wrong field, unregistered redirect URI, …). Fix the value, click **Generate .env files** again, and restart the backend.

If the wizard's tests pass but the app still fails:

| Symptom | Fix |
|---|---|
| Every test shows ✗ "Could not reach http://localhost:5000" | The backend isn't running, or it's on a different port. Start it with `--port 5000`. If it *is* running, it's CORS: `FRONTEND_URL` in `backend/.env` must exactly equal the URL in your browser bar (`http://localhost:5173`). Restart uvicorn after editing `.env`. |
| CORS error in the browser console | Same as above. Ports and hosts must match exactly. `localhost` and `127.0.0.1` count as different origins. |
| `npm run dev` says port 5173 is in use | Another Vite app is running. Stop it. The port is pinned on purpose, because a different port breaks CORS. |
| "Missing env var(s) in backend/.env: …" | That variable is empty or still has its `...` placeholder. Re-run the wizard (or edit `backend/.env`), then restart uvicorn. |
| Google: **Error 400: redirect_uri_mismatch** | The Authorized redirect URI in Google Cloud doesn't exactly match `GOOGLE_REDIRECT_URI`. Copy it from wizard step 3. Changes can take a few minutes to apply. |
| Google: **Access blocked / app not verified** | Add your account as a **Test user** on the OAuth consent screen. |
| "Supabase sign-in failed: … audience / client id …" | The Supabase Google provider isn't enabled, or its Client ID isn't the same as `GOOGLE_CLIENT_ID`. The wizard's Supabase test warns if Google isn't enabled. |
| Signed in, but the page still says "Not signed in" | You started on `127.0.0.1` but were redirected to `localhost` (or the reverse), so the cookie belongs to the other host. Use `localhost` everywhere. |
| "OAuth state mismatch" | You opened the callback in a different browser or after more than 10 minutes. Click Sign in again. |
| Wizard: "Port 5000 is already in use" on Test redirect URI | The backend is running. Stop it for the check, or just test sign-in from the app. |
| Wizard install: "Could not find Python" | Install Python 3.10+. On Windows, tick "Add python.exe to PATH". On Debian/Ubuntu, also run `sudo apt install python3-venv`. Then click Install again. |
| Wizard: "Port 4000 is already in use" | The wizard is already running in another terminal, or run it on another port: `SETUP_PORT=4001 node setup/server.js`. |
| Test Random Endpoint fails | The free public API (`official-joke-api.appspot.com`) may be down, or you're on a network that blocks it. Your setup is probably fine. |
| Changed `frontend/.env` but nothing happened | Restart `npm run dev`. Vite only reads `.env` at startup. |

<details>
<summary><b>Manual setup (without the wizard)</b></summary>

Use this if you'd rather edit the `.env` files yourself. It does the same thing the wizard does.

> Do the Google step before you finish the Supabase step, because Supabase needs the Google Client ID. It's simplest to keep both dashboards open in tabs.

### Supabase

1. Go to https://supabase.com/dashboard → **New project**. Pick a name and a database password, then wait about a minute for it to provision.
2. **Enable Google sign-in:** **Authentication → Sign In / Providers → Google** → turn it on.
   - **Client IDs:** paste your Google **Client ID** from the Google step. It must be the same value as `GOOGLE_CLIENT_ID`.
   - **Client Secret:** paste your Google **Client Secret**.
   - Save.
   - You can ignore the "Callback URL (for OAuth)" Supabase shows on that page. This template's backend talks to Google directly and then hands the verified Google token to Supabase.
3. **Copy your keys:** go to **Project Settings → API** (or the **Connect** button at the top of the dashboard):
   - **Project URL** → `SUPABASE_URL` (backend) and `VITE_SUPABASE_URL` (frontend)
   - **anon / public** key → `SUPABASE_ANON_KEY` (backend) and `VITE_SUPABASE_ANON_KEY` (frontend)
   - **service_role** key → `SUPABASE_SERVICE_ROLE_KEY` (**backend only**, never the frontend)

### Google OAuth

1. In https://console.cloud.google.com, select or create a project.
2. **APIs & Services → OAuth consent screen** (also called "Google Auth Platform"): choose **External**, then fill in the app name and your email. While the app is in *Testing* mode, add your own Google account under **Test users** or sign-in will be blocked.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - **Authorized redirect URIs** → add exactly:
     ```
     http://localhost:5000/auth/callback
     ```
     This must match `GOOGLE_REDIRECT_URI` in `backend/.env` character for character: `http` not `https`, `localhost` not `127.0.0.1`, and no trailing slash.
   - You don't need any Authorized JavaScript origins.
4. Click **Create**. The dialog shows the **Client ID** and **Client secret**. Copy both. You can find them again later under Credentials → your OAuth client.
   - Client ID → `GOOGLE_CLIENT_ID` in `backend/.env` **and** the Supabase Google provider
   - Client secret → `GOOGLE_CLIENT_SECRET` in `backend/.env` (and Supabase)

### Backend

```bash
cd backend

python -m venv venv
# macOS / Linux:
source venv/bin/activate
# Windows (PowerShell):
venv\Scripts\Activate.ps1

pip install -r requirements.txt

cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
```

Open `backend/.env` and replace every placeholder with real values:

| Variable | Where it comes from |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Cloud → Credentials → your OAuth client |
| `GOOGLE_REDIRECT_URI` | Leave as `http://localhost:5000/auth/callback` |
| `FRONTEND_URL` | Leave as `http://localhost:5173` |

Run the server with `uvicorn main:app --reload --port 5000`.

### Frontend

In a second terminal:

```bash
cd frontend
npm install
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
```

Fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `frontend/.env`. Leave `VITE_BACKEND_URL=http://localhost:5000`. Then run `npm run dev`.

</details>

"""
Hackathon starter backend.

Routes (all visible + testable at http://localhost:5000/docs):
  GET /                    -> alias of /health
  GET /health              -> "is the server alive" check
  GET /test-anthropic      -> calls Claude with a tiny prompt to verify ANTHROPIC_API_KEY
  GET /test-random         -> calls a free public API (no key) as an outbound-request example
  GET /auth/login/google   -> redirects to Google's OAuth consent screen
  GET /auth/callback       -> Google redirects here; we sign the user into Supabase and set a cookie
  GET /auth/me             -> current user (401 if not signed in)
  POST /auth/logout        -> clears the session cookie

Response shape: every JSON response has an "ok" boolean.
  success -> {"ok": true, ...data}
  failure -> {"ok": false, "error": "human readable message"}  (with a non-2xx status code)

Auth flow (Google OAuth + Supabase Auth):
  1. /auth/login/google redirects the browser to Google.
  2. Google redirects back to GOOGLE_REDIRECT_URI (/auth/callback) with a one-time code.
  3. We exchange the code with Google for an ID token, then hand that ID token to
     Supabase (`sign_in_with_id_token`). Supabase verifies it, creates/updates the
     user in auth.users, and returns a Supabase session.
  4. We store the Supabase access token in an httpOnly cookie and redirect to the frontend.
  5. /auth/me reads the cookie and asks Supabase who it belongs to.
"""

import os
import secrets
from typing import Any
from urllib.parse import urlencode

import anthropic
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from supabase import Client, create_client

load_dotenv()

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-opus-5")
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
GOOGLE_REDIRECT_URI = os.getenv("GOOGLE_REDIRECT_URI", "http://localhost:5000/auth/callback")
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5173").rstrip("/")

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
RANDOM_API_URL = "https://official-joke-api.appspot.com/random_joke"

SESSION_COOKIE = "session"
STATE_COOKIE = "oauth_state"

# Cookies are only marked Secure when the backend is served over https.
COOKIE_SECURE = GOOGLE_REDIRECT_URI.startswith("https://")

PLACEHOLDER_MARKERS = ("...", "xxxx", "sk-ant-...")


app = FastAPI(
    title="Hackathon Starter API",
    description="FastAPI + Claude + Supabase + Google OAuth. Try the routes below.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_URL],
    allow_credentials=True,  # needed so the browser sends the session cookie
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- helpers ----------


def ok(**data: Any) -> dict[str, Any]:
    return {"ok": True, **data}


def fail(error: str, status_code: int = 500, **extra: Any) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"ok": False, "error": error, **extra})


def missing_env(*names: str) -> list[str]:
    """Return env var names that are unset or still contain .env.example placeholder text."""
    missing = []
    for name in names:
        value = os.getenv(name, "")
        if not value or any(marker in value for marker in PLACEHOLDER_MARKERS):
            missing.append(name)
    return missing


def supabase_client() -> Client:
    # A fresh client per request keeps auth state from leaking between users.
    key = SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY
    return create_client(SUPABASE_URL, key)


def frontend_redirect(**params: str) -> RedirectResponse:
    query = f"?{urlencode(params)}" if params else ""
    return RedirectResponse(f"{FRONTEND_URL}/{query}", status_code=302)


# ---------- basic routes ----------


@app.get("/", tags=["health"], summary="Alias of /health")
@app.get("/health", tags=["health"], summary="Is the server alive?")
def health():
    return ok(status="ok", message="Hello from FastAPI")


@app.get("/test-anthropic", tags=["tests"], summary="Verify ANTHROPIC_API_KEY works")
async def test_anthropic():
    if missing := missing_env("ANTHROPIC_API_KEY"):
        return fail(f"Missing env var(s) in backend/.env: {', '.join(missing)}", 500)

    client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
    try:
        response = await client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=1024,
            output_config={"effort": "low"},  # trivial prompt -> keep it fast and cheap
            messages=[{"role": "user", "content": "Say hello in exactly 5 words."}],
        )
    except anthropic.AuthenticationError:
        return fail("Anthropic rejected the API key (401). Check ANTHROPIC_API_KEY.", 401)
    except anthropic.PermissionDeniedError:
        return fail("API key lacks permission for this model (403).", 403)
    except anthropic.NotFoundError:
        return fail(f"Model '{ANTHROPIC_MODEL}' not found (404). Check ANTHROPIC_MODEL.", 404)
    except anthropic.RateLimitError:
        return fail("Rate limited by Anthropic (429). Wait a moment and retry.", 429)
    except anthropic.APIStatusError as e:
        return fail(f"Anthropic API error {e.status_code}: {e.message}", 502)
    except anthropic.APIConnectionError:
        return fail("Could not reach the Anthropic API. Check your internet connection.", 502)

    if response.stop_reason == "refusal":
        return fail("The model declined to answer.", 502)

    text = "".join(block.text for block in response.content if block.type == "text").strip()
    return ok(model=response.model, response=text)


@app.get("/test-random", tags=["tests"], summary="Call a free public API (no key needed)")
async def test_random():
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(RANDOM_API_URL)
            r.raise_for_status()
            data = r.json()
    except httpx.HTTPStatusError as e:
        return fail(f"Public API returned {e.response.status_code}", 502)
    except httpx.HTTPError as e:
        return fail(f"Could not reach public API: {e.__class__.__name__}", 502)

    return ok(source=RANDOM_API_URL, data=data)


# ---------- auth routes ----------


@app.get("/auth/login/google", tags=["auth"], summary="Start Google sign-in (open in browser)")
def login_google():
    if missing := missing_env("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SUPABASE_URL", "SUPABASE_ANON_KEY"):
        return fail(f"Missing env var(s) in backend/.env: {', '.join(missing)}", 500)

    state = secrets.token_urlsafe(32)
    params = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "prompt": "select_account",
    }
    response = RedirectResponse(f"{GOOGLE_AUTH_URL}?{urlencode(params)}", status_code=302)
    # CSRF protection: the callback must echo back the same state.
    response.set_cookie(
        STATE_COOKIE, state, max_age=600, httponly=True, samesite="lax", secure=COOKIE_SECURE
    )
    return response


@app.get("/auth/callback", tags=["auth"], summary="Google redirects here after consent")
async def auth_callback(request: Request, code: str | None = None, state: str | None = None, error: str | None = None):
    if error:
        return frontend_redirect(auth_error=f"Google returned: {error}")
    if not code:
        return frontend_redirect(auth_error="Missing ?code from Google")
    if not state or state != request.cookies.get(STATE_COOKIE):
        return frontend_redirect(auth_error="OAuth state mismatch - start the sign-in again")

    # 1. Exchange the one-time code for Google tokens.
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            token_res = await client.post(
                GOOGLE_TOKEN_URL,
                data={
                    "code": code,
                    "client_id": GOOGLE_CLIENT_ID,
                    "client_secret": GOOGLE_CLIENT_SECRET,
                    "redirect_uri": GOOGLE_REDIRECT_URI,
                    "grant_type": "authorization_code",
                },
            )
    except httpx.HTTPError as e:
        return frontend_redirect(auth_error=f"Could not reach Google: {e.__class__.__name__}")

    tokens = token_res.json()
    id_token = tokens.get("id_token")
    if token_res.status_code != 200 or not id_token:
        detail = tokens.get("error_description") or tokens.get("error") or "unknown error"
        return frontend_redirect(auth_error=f"Google token exchange failed: {detail}")

    # 2. Hand the Google ID token to Supabase, which verifies it and creates/updates the user.
    try:
        auth = supabase_client().auth.sign_in_with_id_token(
            {"provider": "google", "token": id_token}
        )
    except Exception as e:  # supabase raises AuthApiError with a readable message
        return frontend_redirect(auth_error=f"Supabase sign-in failed: {e}")

    if not auth.session:
        return frontend_redirect(auth_error="Supabase did not return a session")

    # 3. Store the Supabase access token in an httpOnly cookie and go back to the app.
    response = frontend_redirect(login="success")
    response.set_cookie(
        SESSION_COOKIE,
        auth.session.access_token,
        max_age=auth.session.expires_in or 3600,
        httponly=True,
        samesite="lax",
        secure=COOKIE_SECURE,
    )
    response.delete_cookie(STATE_COOKIE)
    return response


@app.get("/auth/me", tags=["auth"], summary="Current user, or 401")
def auth_me(request: Request):
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return fail("Not signed in", 401)
    if missing := missing_env("SUPABASE_URL", "SUPABASE_ANON_KEY"):
        return fail(f"Missing env var(s) in backend/.env: {', '.join(missing)}", 500)

    try:
        result = supabase_client().auth.get_user(token)
    except Exception:
        return fail("Session expired or invalid - sign in again", 401)
    if not result or not result.user:
        return fail("Session expired or invalid - sign in again", 401)

    user = result.user
    meta = user.user_metadata or {}
    return ok(
        user={
            "id": user.id,
            "email": user.email,
            "name": meta.get("full_name") or meta.get("name"),
            "avatar_url": meta.get("avatar_url") or meta.get("picture"),
        }
    )


@app.post("/auth/logout", tags=["auth"], summary="Clear the session cookie")
def auth_logout():
    response = JSONResponse(content=ok(message="Signed out"))
    response.delete_cookie(SESSION_COOKIE)
    return response

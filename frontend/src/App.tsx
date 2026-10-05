import { useEffect, useState } from "react";
import { BACKEND_URL, callBackend, type ApiResult } from "./lib/api";

type TestState = { phase: "idle" } | { phase: "loading" } | { phase: "done"; result: ApiResult };

type User = { id: string; email: string | null; name: string | null; avatar_url: string | null };

const TESTS = [
  { key: "health", label: "Test Backend Health", path: "/health", hint: "Is FastAPI running and reachable?" },
  { key: "anthropic", label: "Test Anthropic API", path: "/test-anthropic", hint: "Is ANTHROPIC_API_KEY valid?" },
  { key: "random", label: "Test Random Endpoint", path: "/test-random", hint: "Can the backend make outbound calls?" },
] as const;

function snippet(result: ApiResult): string {
  if (!result.ok) return result.error;
  const text = JSON.stringify(result.data, null, 2);
  return text.length > 600 ? `${text.slice(0, 600)}\n…` : text;
}

function StatusIcon({ state }: { state: TestState }) {
  if (state.phase === "loading") return <span className="spinner" aria-label="Loading" />;
  if (state.phase === "done")
    return state.result.ok ? (
      <span className="icon pass" aria-label="Passed">✓</span>
    ) : (
      <span className="icon fail" aria-label="Failed">✗</span>
    );
  return <span className="icon idle" aria-label="Not run">•</span>;
}

function TestCard({ label, path, hint }: { label: string; path: string; hint: string }) {
  const [state, setState] = useState<TestState>({ phase: "idle" });

  async function run() {
    setState({ phase: "loading" });
    setState({ phase: "done", result: await callBackend(path) });
  }

  return (
    <section className="card">
      <div className="card-head">
        <StatusIcon state={state} />
        <div className="card-title">
          <h2>{label}</h2>
          <p className="muted">
            <code>GET {path}</code> — {hint}
          </p>
        </div>
        <button onClick={run} disabled={state.phase === "loading"}>
          {state.phase === "loading" ? "Testing…" : "Run"}
        </button>
      </div>
      {state.phase === "done" && (
        <pre className={state.result.ok ? "out pass" : "out fail"}>{snippet(state.result)}</pre>
      )}
    </section>
  );
}

function AuthCard() {
  const [user, setUser] = useState<User | null>(null);
  const [state, setState] = useState<TestState>({ phase: "loading" });
  const [authError, setAuthError] = useState<string | null>(null);

  async function loadMe() {
    setState({ phase: "loading" });
    const result = await callBackend("/auth/me");
    setUser(result.ok ? (result.data.user as User) : null);
    setState({ phase: "done", result });
  }

  useEffect(() => {
    // After the OAuth round-trip the backend redirects here with ?login=success or ?auth_error=...
    const params = new URLSearchParams(window.location.search);
    const err = params.get("auth_error");
    if (err) setAuthError(err);
    if (params.has("auth_error") || params.has("login")) {
      window.history.replaceState({}, "", window.location.pathname);
    }
    loadMe();
  }, []);

  async function signOut() {
    await callBackend("/auth/logout", { method: "POST" });
    setAuthError(null);
    loadMe();
  }

  // "Not signed in" (401) is a normal state, not a failure, until the user tries to sign in.
  const notSignedIn = state.phase === "done" && !state.result.ok && state.result.status === 401;
  const iconState: TestState = authError
    ? { phase: "done", result: { ok: false, status: null, error: authError } }
    : notSignedIn
      ? { phase: "idle" }
      : state;

  return (
    <section className="card">
      <div className="card-head">
        <StatusIcon state={iconState} />
        <div className="card-title">
          <h2>Sign in with Google</h2>
          <p className="muted">
            <code>/auth/login/google</code> → Google → <code>/auth/callback</code> → <code>/auth/me</code>
          </p>
        </div>
        {user ? (
          <button className="secondary" onClick={signOut}>
            Sign out
          </button>
        ) : (
          <a className="button" href={`${BACKEND_URL}/auth/login/google`}>
            Sign in with Google
          </a>
        )}
      </div>

      {user && (
        <div className="user">
          {user.avatar_url && <img src={user.avatar_url} alt="" referrerPolicy="no-referrer" />}
          <div>
            <strong>{user.name ?? "(no name)"}</strong>
            <div className="muted">{user.email}</div>
          </div>
        </div>
      )}
      {authError && <pre className="out fail">{authError}</pre>}
      {!authError && state.phase === "done" && !state.result.ok && !notSignedIn && (
        <pre className="out fail">{state.result.error}</pre>
      )}
      {!user && notSignedIn && !authError && <p className="muted small">Not signed in yet.</p>}
    </section>
  );
}

export default function App() {
  return (
    <main>
      <header>
        <h1>Hackathon Starter</h1>
        <p className="muted">
          One-glance environment check. Backend: <code>{BACKEND_URL}</code> ·{" "}
          <a href={`${BACKEND_URL}/docs`} target="_blank" rel="noreferrer">
            Swagger UI
          </a>
        </p>
      </header>
      {TESTS.map((t) => (
        <TestCard key={t.key} label={t.label} path={t.path} hint={t.hint} />
      ))}
      <AuthCard />
    </main>
  );
}

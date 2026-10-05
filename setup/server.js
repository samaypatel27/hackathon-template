#!/usr/bin/env node
/**
 * One-time setup wizard server (dev-only, never deployed).
 *
 *   node setup/server.js   ->   open http://localhost:4000
 *
 * Zero dependencies on purpose: it only uses Node built-ins, so it runs on a fresh
 * clone before anything has been installed. It writes backend/.env + frontend/.env
 * and runs the dependency installs, which a browser page can't do by itself.
 *
 * API (all JSON responses have `ok: true|false`, errors carry `error`):
 *   GET  /api/status                -> which setup steps are already done + saved values
 *   POST /api/write-env             -> writes backend/.env and frontend/.env
 *   POST /api/install               -> npm install + venv + pip install, streamed as Server-Sent Events
 *   POST /api/test-anthropic        -> tiny Claude call with the given key
 *   POST /api/test-supabase         -> checks URL + anon key (+ service role key) against Supabase
 *   POST /api/test-google-oauth     -> checks client ID/secret format and asks Google if the pair is valid
 *   POST /api/test-google-redirect  -> starts a temporary listener on the redirect URI for a real sign-in test
 *   GET  /api/test-google-redirect  -> result of that sign-in test
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split(".").map(Number);
if (NODE_MAJOR < 18) {
  console.error(`Node ${process.versions.node} is too old. Install Node 20.19+ (https://nodejs.org) and retry.`);
  process.exit(1);
}

const PORT = Number(process.env.SETUP_PORT) || 4000;
const ROOT = path.resolve(__dirname, "..");
const BACKEND_DIR = path.join(ROOT, "backend");
const FRONTEND_DIR = path.join(ROOT, "frontend");
const PUBLIC_DIR = path.join(__dirname, "public");
const IS_WIN = process.platform === "win32";

const VENV_DIR = path.join(BACKEND_DIR, "venv");
const VENV_PYTHON = IS_WIN ? path.join(VENV_DIR, "Scripts", "python.exe") : path.join(VENV_DIR, "bin", "python");

// Must match the default model in backend/main.py.
const ANTHROPIC_MODEL = "claude-opus-5";

const DEFAULTS = {
  GOOGLE_REDIRECT_URI: "http://localhost:5000/auth/callback",
  FRONTEND_URL: "http://localhost:5173",
  VITE_BACKEND_URL: "http://localhost:5000",
};

/*
 * ENV SCHEMA: the single list of env vars the wizard writes.
 * When the project gains a new env var, add it here (and a field in public/index.html
 * if the user has to supply it) so the wizard never writes an incomplete .env.
 */
const BACKEND_KEYS = [
  "ANTHROPIC_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "FRONTEND_URL",
];
const FRONTEND_KEYS = ["VITE_BACKEND_URL", "VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"];
// Fields the user types in the wizard (everything else is derived or defaulted).
const USER_FIELDS = [
  "ANTHROPIC_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
];

const PLACEHOLDER_RE = /^(\.\.\.|sk-ant-\.\.\.|https:\/\/xxxx\.supabase\.co)$/;

// ---------- small utilities ----------

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const fail = (res, status, error, extra = {}) => sendJson(res, status, { ok: false, error, ...extra });

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error("Body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const str = (v) => (typeof v === "string" ? v.trim() : "");

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (/^"(.*)"$/.test(value)) value = JSON.parse(value);
    else if (/^'(.*)'$/.test(value)) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

function readEnvFile(file) {
  try {
    return parseEnv(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const isRealValue = (v) => typeof v === "string" && v !== "" && !PLACEHOLDER_RE.test(v);

function formatEnvValue(value) {
  // Quote anything dotenv could misread (spaces, #, quotes).
  return /[\s#"'\\]/.test(value) ? JSON.stringify(value) : value;
}

/**
 * Update KEY=value lines in place, keeping comments and any extra vars the user added
 * (e.g. ANTHROPIC_MODEL). Starts from .env.example when no .env exists yet.
 */
function mergeEnv(baseText, values) {
  const seen = new Set();
  const lines = [];
  for (const line of baseText ? baseText.split(/\r?\n/) : []) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && Object.hasOwn(values, m[1])) {
      if (seen.has(m[1])) continue; // drop duplicate definitions
      seen.add(m[1]);
      lines.push(`${m[1]}=${formatEnvValue(values[m[1]])}`);
    } else {
      lines.push(line);
    }
  }
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) lines.push(`${key}=${formatEnvValue(value)}`);
  }
  return lines.join("\n") + "\n";
}

function writeEnvFile(dir, values) {
  const target = path.join(dir, ".env");
  const base = fs.existsSync(target)
    ? fs.readFileSync(target, "utf8")
    : fs.existsSync(path.join(dir, ".env.example"))
      ? fs.readFileSync(path.join(dir, ".env.example"), "utf8")
      : "";
  fs.writeFileSync(target, mergeEnv(base, values), "utf8");
  return target;
}

function normalizeSupabaseUrl(raw) {
  return str(raw)
    .replace(/\/+$/, "")
    .replace(/\/(rest|auth)\/v1$/, "");
}

/** Read the `role` claim from a legacy JWT-style Supabase key, or null for new-style keys. */
function jwtRole(key) {
  const parts = key.split(".");
  if (parts.length !== 3 || !key.startsWith("eyJ")) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")).role ?? null;
  } catch {
    return null;
  }
}

function supabaseHeaders(key) {
  // Legacy keys are JWTs and go in both headers; new sb_publishable_/sb_secret_ keys only in `apikey`.
  return key.startsWith("eyJ") ? { apikey: key, authorization: `Bearer ${key}` } : { apikey: key };
}

async function fetchJson(url, init = {}, timeoutMs = 15000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  let body = {};
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { res, body };
}

function networkError(err, what) {
  if (err?.name === "TimeoutError") return `Timed out reaching ${what}.`;
  return `Could not reach ${what} (${err?.cause?.code || err?.message || "network error"}). Check the URL and your internet connection.`;
}

// ---------- status ----------

function sitePackagesDirs() {
  if (IS_WIN) return [path.join(VENV_DIR, "Lib", "site-packages")];
  const lib = path.join(VENV_DIR, "lib");
  try {
    return fs
      .readdirSync(lib)
      .filter((d) => d.startsWith("python"))
      .map((d) => path.join(lib, d, "site-packages"));
  } catch {
    return [];
  }
}

function backendDepsInstalled() {
  if (!fs.existsSync(VENV_PYTHON)) return false;
  return sitePackagesDirs().some((sp) =>
    ["fastapi", "uvicorn", "anthropic", "supabase", "dotenv", "httpx"].every((pkg) => fs.existsSync(path.join(sp, pkg))),
  );
}

function getStatus() {
  const backendEnv = readEnvFile(path.join(BACKEND_DIR, ".env"));
  const frontendEnv = readEnvFile(path.join(FRONTEND_DIR, ".env"));
  const envComplete =
    !!backendEnv &&
    !!frontendEnv &&
    BACKEND_KEYS.every((k) => isRealValue(backendEnv[k])) &&
    FRONTEND_KEYS.every((k) => isRealValue(frontendEnv[k]));

  // Pre-fill the wizard with whatever real values are already saved.
  const values = {};
  for (const k of USER_FIELDS) if (backendEnv && isRealValue(backendEnv[k])) values[k] = backendEnv[k];

  return {
    ok: true,
    platform: process.platform,
    nodeVersion: process.versions.node,
    nodeTooOldForVite: NODE_MAJOR < 20 || (NODE_MAJOR === 20 && NODE_MINOR < 19) || (NODE_MAJOR === 22 && NODE_MINOR < 12),
    defaults: DEFAULTS,
    values,
    steps: {
      backendEnvExists: !!backendEnv,
      frontendEnvExists: !!frontendEnv,
      envComplete,
      frontendDepsInstalled: fs.existsSync(path.join(FRONTEND_DIR, "node_modules", "vite", "package.json")),
      venvExists: fs.existsSync(VENV_PYTHON),
      backendDepsInstalled: backendDepsInstalled(),
    },
    installRunning: installState.running,
  };
}

// ---------- write-env ----------

function handleWriteEnv(res, body) {
  const v = {};
  for (const k of USER_FIELDS) v[k] = str(body[k]);
  v.SUPABASE_URL = normalizeSupabaseUrl(v.SUPABASE_URL);

  const missing = USER_FIELDS.filter((k) => !v[k]);
  if (missing.length) return fail(res, 400, `Missing values: ${missing.join(", ")}`, { missing });

  const all = { ...v, ...DEFAULTS };
  const bad = Object.entries(all).filter(([, val]) => /[\r\n\0]/.test(val));
  if (bad.length) return fail(res, 400, `Values can't contain line breaks: ${bad.map(([k]) => k).join(", ")}`);

  const backend = Object.fromEntries(BACKEND_KEYS.map((k) => [k, all[k]]));
  const frontend = {
    VITE_BACKEND_URL: DEFAULTS.VITE_BACKEND_URL,
    VITE_SUPABASE_URL: v.SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY: v.SUPABASE_ANON_KEY,
  };

  try {
    const files = [writeEnvFile(BACKEND_DIR, backend), writeEnvFile(FRONTEND_DIR, frontend)];
    sendJson(res, 200, {
      ok: true,
      message: "Wrote backend/.env and frontend/.env",
      files: files.map((f) => path.relative(ROOT, f)),
    });
  } catch (err) {
    fail(res, 500, `Could not write .env files: ${err.message}`);
  }
}

// ---------- install (streamed over Server-Sent Events) ----------

const installState = { running: false };

/** Run a command, streaming each output line to `log`. Resolves true on exit code 0. */
function runStreamed(cmd, args, cwd, log, { shell = false } = {}) {
  return new Promise((resolve) => {
    log(`$ ${[cmd, ...args].join(" ")}`);
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        shell,
        env: { ...process.env, PYTHONUNBUFFERED: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
      });
    } catch (err) {
      log(`Failed to start ${cmd}: ${err.message}`, "stderr");
      return resolve(false);
    }
    const pipe = (stream, name) => {
      let buf = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        buf += chunk;
        const lines = buf.split(/\r\n|\n|\r/);
        buf = lines.pop();
        for (const line of lines) if (line.trim()) log(line, name);
      });
      stream.on("end", () => buf.trim() && log(buf, name));
    };
    pipe(child.stdout, "stdout");
    pipe(child.stderr, "stderr");
    let settled = false;
    child.on("error", (err) => {
      log(`Failed to start ${cmd}: ${err.message}`, "stderr");
      if (!settled) (settled = true), resolve(false);
    });
    child.on("close", (code) => {
      if (code !== 0) log(`Exited with code ${code}`, "stderr");
      if (!settled) (settled = true), resolve(code === 0);
    });
  });
}

/** Quiet helper for probing commands (e.g. which python exists). */
function capture(cmd, args) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(cmd, args, { timeout: 15000 });
    } catch {
      return resolve({ ok: false, out: "" });
    }
    child.stdout.on("data", (c) => (out += c));
    child.on("error", () => resolve({ ok: false, out }));
    child.on("close", (code) => resolve({ ok: code === 0, out: out.trim() }));
  });
}

async function findPython(log) {
  const candidates = IS_WIN
    ? [["py", ["-3"]], ["python", []], ["python3", []]]
    : [["python3", []], ["python", []]];
  const tooOld = [];
  for (const [cmd, pre] of candidates) {
    const r = await capture(cmd, [...pre, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"]);
    if (!r.ok || !/^\d+\.\d+$/.test(r.out)) continue;
    const [maj, min] = r.out.split(".").map(Number);
    if (maj === 3 && min >= 10) {
      log(`Using ${[cmd, ...pre].join(" ")} (Python ${r.out})`);
      return { cmd, pre };
    }
    tooOld.push(`${cmd} is Python ${r.out}`);
  }
  log(
    tooOld.length
      ? `Python 3.10+ is required, but found only: ${tooOld.join(", ")}. Install a newer Python from https://www.python.org/downloads/`
      : "Could not find Python. Install Python 3.10+ from https://www.python.org/downloads/ (on Windows, tick 'Add python.exe to PATH'), then retry.",
    "stderr",
  );
  return null;
}

async function installFrontend(log) {
  // Windows needs a shell to run npm.cmd; the command is fixed (no user input), so this is safe.
  return runStreamed("npm", ["install", "--no-fund", "--no-audit"], FRONTEND_DIR, log, { shell: IS_WIN });
}

async function installBackend(log) {
  if (fs.existsSync(VENV_PYTHON)) {
    log("Virtual env backend/venv already exists, reusing it.");
  } else {
    const py = await findPython(log);
    if (!py) return false;
    const ok = await runStreamed(py.cmd, [...py.pre, "-m", "venv", "venv"], BACKEND_DIR, log);
    if (!ok) {
      if (!IS_WIN) log("On Debian/Ubuntu you may need: sudo apt install python3-venv", "stderr");
      return false;
    }
  }
  return runStreamed(
    VENV_PYTHON,
    ["-m", "pip", "install", "--progress-bar", "off", "-r", "requirements.txt"],
    BACKEND_DIR,
    log,
  );
}

async function handleInstall(req, res) {
  if (installState.running) return fail(res, 409, "An install is already running.");
  if (!fs.existsSync(path.join(BACKEND_DIR, ".env")) || !fs.existsSync(path.join(FRONTEND_DIR, ".env"))) {
    return fail(res, 400, "Generate the .env files first.");
  }

  installState.running = true;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  // The installs keep going even if the tab closes; writes just become no-ops.
  const send = (event, data) => {
    if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const logger = (step) => (line, stream = "stdout") => send("log", { step, line, stream });

  const runStep = async (step, fn) => {
    send("step", { step, status: "running" });
    let ok = false;
    try {
      ok = await fn(logger(step));
    } catch (err) {
      logger(step)(`Unexpected error: ${err.message}`, "stderr");
    }
    send("step", { step, status: ok ? "success" : "error" });
    return ok;
  };

  try {
    // Run both in parallel; each log line is tagged with its step.
    const [fe, be] = await Promise.all([runStep("frontend", installFrontend), runStep("backend", installBackend)]);
    send("done", { ok: fe && be, frontend: fe, backend: be });
  } finally {
    installState.running = false;
    res.end();
  }
}

// ---------- connection tests ----------

async function handleTestAnthropic(res, body) {
  const apiKey = str(body.apiKey);
  if (!apiKey) return fail(res, 400, "Enter an API key first.");

  // Raw HTTP instead of the Anthropic SDK so this server needs no npm install to run.
  let r;
  try {
    r = await fetchJson(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 1024,
          output_config: { effort: "low" },
          messages: [{ role: "user", content: "Say hello in exactly 5 words." }],
        }),
      },
      60000,
    );
  } catch (err) {
    return fail(res, 502, networkError(err, "api.anthropic.com"));
  }

  const { res: upstream, body: data } = r;
  if (!upstream.ok) {
    const detail = data?.error?.message || `HTTP ${upstream.status}`;
    const hints = {
      401: "Anthropic rejected this key. Copy it again from console.anthropic.com → API Keys (it starts with sk-ant-).",
      403: `This key isn't allowed to use ${ANTHROPIC_MODEL}.`,
      404: `Model ${ANTHROPIC_MODEL} isn't available to this key.`,
      429: "Rate limited. Wait a few seconds and try again.",
    };
    const error = /credit balance/i.test(detail)
      ? "The key is valid, but the account has no credits. Add credits at console.anthropic.com → Billing."
      : hints[upstream.status] || detail;
    return fail(res, 502, error, { detail });
  }
  if (data.stop_reason === "refusal") return fail(res, 502, "The key works, but the model declined this prompt.");

  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  sendJson(res, 200, { ok: true, message: `Key works. Claude says: "${text}"`, model: data.model });
}

async function handleTestSupabase(res, body) {
  const url = normalizeSupabaseUrl(body.url);
  const anonKey = str(body.anonKey);
  const serviceRoleKey = str(body.serviceRoleKey);
  if (!url || !anonKey) return fail(res, 400, "Enter the Project URL and anon key first.");

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return fail(res, 400, "The Project URL isn't a valid URL. It looks like https://abcdefgh.supabase.co");
  }
  if (!/^https?:$/.test(parsed.protocol)) return fail(res, 400, "The Project URL must start with https://");

  // Catch the dangerous mix-up: the anon key ends up in the browser bundle.
  if (jwtRole(anonKey) === "service_role" || anonKey.startsWith("sb_secret_")) {
    return fail(res, 400, "The anon key field contains the service_role/secret key. Swap them: that key must never reach the frontend.");
  }
  if (serviceRoleKey && serviceRoleKey === anonKey) {
    return fail(res, 400, "The anon key and service role key are the same. Copy the service_role (secret) key into its own field.");
  }

  // 1. Project reachable + anon key accepted (auth settings endpoint is readable with the anon key).
  let settings;
  try {
    settings = await fetchJson(`${url}/auth/v1/settings`, { headers: supabaseHeaders(anonKey) });
  } catch (err) {
    return fail(res, 502, networkError(err, url));
  }
  if (settings.res.status === 401 || settings.res.status === 403) {
    return fail(res, 502, "The project was reached, but it rejected the anon key. Recopy it from Project Settings → API Keys.");
  }
  if (!settings.res.ok) {
    return fail(res, 502, `Supabase answered HTTP ${settings.res.status}. Double-check the Project URL (Project Settings → Data API / API).`);
  }

  const warnings = [];
  if (settings.body?.external && settings.body.external.google !== true) {
    warnings.push(
      "Google sign-in is not enabled in this Supabase project yet: Authentication → Sign In / Providers → Google → enable it and paste the same Client ID you enter in step 3.",
    );
  }

  // 2. Service role key (optional here, required for .env): only that key can list users.
  let serviceMsg = "";
  if (serviceRoleKey) {
    try {
      const admin = await fetchJson(`${url}/auth/v1/admin/users?page=1&per_page=1`, {
        headers: supabaseHeaders(serviceRoleKey),
      });
      if (!admin.res.ok) {
        return fail(res, 502, "The anon key works, but the service role key was rejected. Make sure you copied the service_role / secret key.");
      }
      serviceMsg = " Service role key works too.";
    } catch (err) {
      return fail(res, 502, networkError(err, url));
    }
  } else {
    warnings.push("No service role key entered yet. You'll need it before generating the .env files.");
  }

  sendJson(res, 200, { ok: true, message: `Connected to ${parsed.host}. Anon key accepted.${serviceMsg}`, warnings });
}

async function handleTestGoogle(res, body) {
  const clientId = str(body.clientId);
  const clientSecret = str(body.clientSecret);
  const redirectUri = str(body.redirectUri) || DEFAULTS.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret) return fail(res, 400, "Enter the Client ID and Client Secret first.");

  const warnings = [];
  if (!/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    return fail(
      res,
      400,
      "That doesn't look like a Google OAuth Client ID. It should look like 1234567890-abc123.apps.googleusercontent.com. Make sure you copied the Client ID, not the project ID or the secret.",
    );
  }
  if (clientSecret.endsWith(".apps.googleusercontent.com")) {
    return fail(res, 400, "The Client Secret field contains a Client ID. The secret usually starts with GOCSPX-.");
  }
  if (!clientSecret.startsWith("GOCSPX-")) {
    warnings.push("The Client Secret usually starts with GOCSPX-. Double-check that you copied the secret.");
  }
  if (redirectUri !== DEFAULTS.GOOGLE_REDIRECT_URI) {
    warnings.push(`The redirect URI differs from the backend default (${DEFAULTS.GOOGLE_REDIRECT_URI}).`);
  }

  // Ask Google's token endpoint with a dummy code. A known client gives "invalid_grant" (bad code);
  // an unknown client or a wrong secret gives "invalid_client". No user data is involved.
  let r;
  try {
    r = await fetchJson("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: "setup-wizard-credential-check",
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
  } catch (err) {
    return fail(res, 502, networkError(err, "oauth2.googleapis.com"));
  }

  const code = r.body?.error;
  if (code === "invalid_client") {
    const desc = r.body?.error_description || "";
    return fail(
      res,
      502,
      /not found/i.test(desc)
        ? "Google doesn't know this Client ID. Recopy it from Google Cloud Console → APIs & Services → Credentials."
        : "Google recognises the Client ID but rejected the secret. Recopy the Client Secret (or create a new one on the same OAuth client).",
      { detail: desc },
    );
  }
  if (code === "redirect_uri_mismatch") {
    return fail(
      res,
      502,
      `Redirect URI mismatch: ${redirectUri} is not registered on this OAuth client. In Google Cloud Console → Credentials → your OAuth client → Authorized redirect URIs, add exactly ${redirectUri} (http, localhost, port 5000, no trailing slash) and save.`,
    );
  }
  if (code !== "invalid_grant") {
    return fail(res, 502, `Unexpected answer from Google: ${code || r.res.status} ${r.body?.error_description || ""}`.trim());
  }

  sendJson(res, 200, {
    ok: true,
    message:
      "Google accepted this Client ID + Secret. Google only checks the redirect URI during a real sign-in, so use the button below to confirm it.",
    warnings,
  });
}

// ---------- live redirect-URI check ----------
// Briefly listens on the redirect URI's port (5000) so a real Google sign-in can land on it.

const redirectCheck = { status: "idle", message: "", server: null, timer: null, state: null };

function stopRedirectListener() {
  clearTimeout(redirectCheck.timer);
  redirectCheck.server?.close();
  redirectCheck.server = null;
}

function callbackPage(ok, text) {
  const color = ok ? "#12b76a" : "#f04438";
  return `<!doctype html><meta charset="utf-8"><title>Setup check</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:520px"><div style="font-size:48px;color:${color}">${ok ? "✓" : "✗"}</div>
<p style="font-size:18px">${text}</p><p style="color:#667085">You can close this tab and go back to the setup wizard.</p></div>`;
}

async function handleStartRedirectCheck(res, body) {
  const clientId = str(body.clientId);
  if (!clientId) return fail(res, 400, "Enter the Client ID first.");
  const redirectUri = DEFAULTS.GOOGLE_REDIRECT_URI;
  const target = new URL(redirectUri);

  stopRedirectListener();
  const state = crypto.randomBytes(16).toString("hex");
  Object.assign(redirectCheck, { status: "pending", message: "Waiting for Google to redirect back…", state });

  const server = http.createServer((req, resp) => {
    const u = new URL(req.url, redirectUri);
    if (u.pathname !== target.pathname) {
      resp.writeHead(404).end();
      return;
    }
    const error = u.searchParams.get("error");
    let ok = false;
    if (error) {
      redirectCheck.status = "error";
      redirectCheck.message =
        error === "access_denied"
          ? "The redirect URI works, but sign-in was cancelled or blocked. If the app is in Testing mode, add your Google account under OAuth consent screen → Test users."
          : `The redirect URI works, but Google returned an error: ${error}`;
    } else if (u.searchParams.get("code") && u.searchParams.get("state") === redirectCheck.state) {
      ok = true;
      redirectCheck.status = "success";
      redirectCheck.message = `Redirect URI confirmed: Google sent you back to ${redirectUri}.`;
    } else {
      redirectCheck.status = "error";
      redirectCheck.message = "A request reached the callback, but without a valid code/state. Try the check again.";
    }
    resp.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    resp.end(callbackPage(ok, redirectCheck.message));
    setTimeout(stopRedirectListener, 500);
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(target.port) || 80, "127.0.0.1", resolve);
    });
  } catch (err) {
    redirectCheck.status = "idle";
    return fail(
      res,
      409,
      err.code === "EADDRINUSE"
        ? `Port ${target.port} is already in use (is the backend running?). Stop it and try again, or just test sign-in from the app.`
        : `Could not listen on port ${target.port}: ${err.message}`,
    );
  }
  redirectCheck.server = server;
  redirectCheck.timer = setTimeout(() => {
    if (redirectCheck.status === "pending") {
      redirectCheck.status = "expired";
      redirectCheck.message = "No redirect arrived within 5 minutes.";
    }
    stopRedirectListener();
  }, 5 * 60 * 1000);

  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email",
      state,
      prompt: "select_account",
    });
  sendJson(res, 200, { ok: true, authUrl });
}

// ---------- static files + routing ----------

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    return;
  }
  res.writeHead(200, {
    "content-type": `${MIME[path.extname(file)] || "application/octet-stream"}; charset=utf-8`,
    "cache-control": "no-store",
  });
  fs.createReadStream(file).pipe(res);
}

const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

const server = http.createServer(async (req, res) => {
  // This server can write files and run commands, so only accept requests from its own page:
  // the Host check blocks DNS-rebinding, the Origin check blocks other sites posting to localhost.
  if (!ALLOWED_HOSTS.has(req.headers.host || "")) return fail(res, 403, "Forbidden host");
  const origin = req.headers.origin;
  if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ""))) return fail(res, 403, "Forbidden origin");

  const route = `${req.method} ${new URL(req.url, "http://x").pathname}`;
  if (!route.startsWith("POST /api/") && !route.startsWith("GET ")) return fail(res, 405, "Method not allowed");

  if (req.method === "POST" && !(req.headers["content-type"] || "").startsWith("application/json")) {
    return fail(res, 415, "Content-Type must be application/json");
  }

  try {
    if (route === "GET /api/status") return sendJson(res, 200, getStatus());
    if (route === "GET /api/test-google-redirect") {
      return sendJson(res, 200, { ok: true, status: redirectCheck.status, message: redirectCheck.message });
    }
    if (route.startsWith("GET /api/")) return fail(res, 404, "Unknown route");
    if (req.method === "GET") return serveStatic(req, res);

    const body = await readJsonBody(req);
    switch (route) {
      case "POST /api/write-env":
        return handleWriteEnv(res, body);
      case "POST /api/install":
        return await handleInstall(req, res);
      case "POST /api/test-anthropic":
        return await handleTestAnthropic(res, body);
      case "POST /api/test-supabase":
        return await handleTestSupabase(res, body);
      case "POST /api/test-google-oauth":
        return await handleTestGoogle(res, body);
      case "POST /api/test-google-redirect":
        return await handleStartRedirectCheck(res, body);
      default:
        return fail(res, 404, "Unknown route");
    }
  } catch (err) {
    if (!res.headersSent) fail(res, 500, err.message);
    else res.end();
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Is the wizard already running? Otherwise run with SETUP_PORT=4001.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  Setup wizard running:  http://localhost:${PORT}\n`);
  console.log("  Open that URL in your browser and follow the steps. Press Ctrl+C here when you're done.\n");
});

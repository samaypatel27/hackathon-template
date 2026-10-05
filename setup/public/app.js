// Setup wizard UI. Plain JS (no build step) so it runs straight from a fresh clone.
// Everything typed lives in `state` (memory only) until "Generate .env files" is clicked.

const FIELDS = [
  "ANTHROPIC_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
];
const SECRET_FIELDS = new Set(["ANTHROPIC_API_KEY", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "GOOGLE_CLIENT_SECRET"]);
const LABELS = {
  ANTHROPIC_API_KEY: ["Anthropic API key", 1],
  SUPABASE_URL: ["Supabase Project URL", 2],
  SUPABASE_ANON_KEY: ["Supabase anon key", 2],
  SUPABASE_SERVICE_ROLE_KEY: ["Supabase service role key", 2],
  GOOGLE_CLIENT_ID: ["Google Client ID", 3],
  GOOGLE_CLIENT_SECRET: ["Google Client secret", 3],
};

// Which fields each test needs (the Test button stays disabled until they're filled).
const TEST_FIELDS = {
  anthropic: ["ANTHROPIC_API_KEY"],
  supabase: ["SUPABASE_URL", "SUPABASE_ANON_KEY"],
  google: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  redirect: ["GOOGLE_CLIENT_ID"],
};
const TEST_LABELS = { anthropic: "Test Key", supabase: "Test Connection", google: "Validate", redirect: "Test redirect URI" };

const state = {
  step: 1,
  values: Object.fromEntries(FIELDS.map((f) => [f, ""])),
  tests: Object.fromEntries(Object.keys(TEST_FIELDS).map((t) => [t, { status: "idle" }])),
  envWritten: false,
  envStale: false, // values edited after the .env files were written
  install: { running: false, frontend: "idle", backend: "idle", done: false },
  defaults: { GOOGLE_REDIRECT_URI: "http://localhost:5000/auth/callback" },
  platform: "linux",
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- API ----------

async function api(path, body) {
  try {
    const res = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  } catch {
    return { ok: false, error: "Can't reach the setup server. Is `node setup/server.js` still running?" };
  }
}

// ---------- rendering ----------

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function iconEl(status) {
  const map = { pass: ["pass", "✓"], success: ["pass", "✓"], fail: ["fail", "✗"], error: ["fail", "✗"], idle: ["idle", "•"] };
  if (status === "loading" || status === "running" || status === "pending") return el("span", { className: "spinner" });
  const [cls, ch] = map[status] || map.idle;
  return el("span", { className: `icon ${cls}`, textContent: ch });
}

function renderResult(container, result) {
  container.replaceChildren();
  if (!result || result.status === "idle") return;
  const box = el("div", { className: `result-box ${result.status}` });
  box.append(iconEl(result.status), el("div", { className: "result-text", textContent: result.message || "" }));
  container.append(box);
  for (const w of result.warnings || []) container.append(el("div", { className: "warning", textContent: `⚠ ${w}` }));
  if (result.hint) container.append(el("div", { className: "hint", textContent: result.hint }));
}

const filled = (fields) => fields.every((f) => state.values[f].trim() !== "");

function stepDone(n) {
  const t = state.tests;
  return {
    1: t.anthropic.status === "pass",
    2: t.supabase.status === "pass",
    3: t.google.status === "pass",
    4: state.envWritten && !state.envStale && state.install.done,
    5: state.envWritten && !state.envStale && state.install.done,
  }[n];
}

function renderSummary() {
  const table = $("#summary");
  table.replaceChildren(el("tr", {}, el("th", { textContent: "Setting" }), el("th", { textContent: "Value" }), el("th")));
  for (const f of FIELDS) {
    const v = state.values[f].trim();
    const shown = !v ? "(missing)" : SECRET_FIELDS.has(f) && v.length > 14 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v;
    const [label, step] = LABELS[f];
    const edit = el("a", { href: "#", textContent: "Edit" });
    edit.addEventListener("click", (e) => (e.preventDefault(), goto(step, f)));
    table.append(
      el("tr", { className: v ? "" : "missing" }, el("td", { textContent: label }), el("td", { textContent: shown }), el("td", {}, edit)),
    );
  }
  table.append(
    el("tr", {}, el("td", { textContent: "Redirect URI (auto)" }), el("td", { textContent: state.defaults.GOOGLE_REDIRECT_URI }), el("td")),
  );
}

function render() {
  for (const s of $$("section[data-step]")) s.hidden = Number(s.dataset.step) !== state.step;
  for (const b of $$("#stepper button")) {
    const n = Number(b.dataset.goto);
    b.classList.toggle("active", n === state.step);
    b.classList.toggle("done", !!stepDone(n));
    $(".dot", b).textContent = stepDone(n) ? "✓" : String(n);
  }

  for (const [name, fields] of Object.entries(TEST_FIELDS)) {
    const btn = $(`[data-test="${name}"]`);
    const loading = state.tests[name].status === "loading" || state.tests[name].status === "pending";
    btn.disabled = !filled(fields) || loading;
    btn.textContent = loading ? "Testing…" : TEST_LABELS[name];
    btn.title = filled(fields) ? "" : "Fill in the fields above first";
    renderResult($(`[data-result="${name}"]`), state.tests[name]);
  }

  renderSummary();
  const allFilled = filled(FIELDS);
  $("#write-env").disabled = !allFilled || state.install.running;
  $("#write-env").title = allFilled ? "" : "Some values are missing. Use the Edit links above.";

  const inst = state.install;
  $("#install").disabled = !state.envWritten || state.envStale || inst.running;
  $("#install").textContent = inst.running ? "Installing…" : inst.done ? "Reinstall dependencies" : "Install dependencies";
  for (const step of ["frontend", "backend"]) {
    const li = $(`[data-install="${step}"]`);
    li.firstElementChild.replaceWith(iconEl(inst[step]));
  }
  $("#finish").disabled = !(inst.done && state.envWritten && !state.envStale);
}

function goto(step, focusField) {
  state.step = step;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (focusField) $(`#${focusField}`)?.focus();
}

// ---------- tests ----------

const TEST_CALLS = {
  anthropic: () => api("/api/test-anthropic", { apiKey: state.values.ANTHROPIC_API_KEY }),
  supabase: () =>
    api("/api/test-supabase", {
      url: state.values.SUPABASE_URL,
      anonKey: state.values.SUPABASE_ANON_KEY,
      serviceRoleKey: state.values.SUPABASE_SERVICE_ROLE_KEY,
    }),
  google: () =>
    api("/api/test-google-oauth", {
      clientId: state.values.GOOGLE_CLIENT_ID,
      clientSecret: state.values.GOOGLE_CLIENT_SECRET,
      redirectUri: state.defaults.GOOGLE_REDIRECT_URI,
    }),
};

async function runTest(name) {
  if (name === "redirect") return runRedirectTest();
  state.tests[name] = { status: "loading" };
  render();
  const r = await TEST_CALLS[name]();
  state.tests[name] = r.ok
    ? { status: "pass", message: r.message, warnings: r.warnings }
    : { status: "fail", message: r.error, warnings: r.warnings };
  render();
}

let redirectPoll = null;

async function runRedirectTest() {
  // Open the tab synchronously (inside the click) so popup blockers allow it.
  const tab = window.open("about:blank", "_blank");
  state.tests.redirect = { status: "loading", message: "Starting…" };
  render();
  const r = await api("/api/test-google-redirect", { clientId: state.values.GOOGLE_CLIENT_ID });
  if (!r.ok) {
    tab?.close();
    state.tests.redirect = { status: "fail", message: r.error };
    return render();
  }
  if (tab) tab.location.href = r.authUrl;
  else window.open(r.authUrl, "_blank");

  state.tests.redirect = {
    status: "pending",
    message: "Finish signing in in the new tab…",
    hint:
      "If Google shows “Error 400: redirect_uri_mismatch”, the URI above isn't registered exactly. Paste it into Authorized redirect URIs, save, wait a minute, and retry. " +
      "If it says “Access blocked”, add your account under OAuth consent screen → Test users.",
  };
  render();

  clearInterval(redirectPoll);
  redirectPoll = setInterval(async () => {
    const s = await api("/api/test-google-redirect");
    if (!s.ok || s.status === "pending") return;
    clearInterval(redirectPoll);
    state.tests.redirect =
      s.status === "success" ? { status: "pass", message: s.message } : { status: "fail", message: s.message || "Check cancelled." };
    render();
  }, 1500);
}

// ---------- write env + install ----------

async function writeEnv() {
  const btn = $("#write-env");
  btn.disabled = true;
  btn.textContent = "Writing…";
  const r = await api("/api/write-env", Object.fromEntries(FIELDS.map((f) => [f, state.values[f]])));
  btn.textContent = "Generate .env files";
  if (r.ok) {
    state.envWritten = true;
    state.envStale = false;
    renderResult($("#write-result"), { status: "pass", message: `${r.message}: ${r.files.join(", ")}` });
  } else {
    renderResult($("#write-result"), { status: "fail", message: r.error });
  }
  render();
}

function appendLog(step, line, stream) {
  const log = $("#log");
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const row = el("span", { className: stream === "stderr" ? "err" : "" });
  row.textContent = `[${step}] ${line}\n`;
  log.append(row);
  while (log.childNodes.length > 4000) log.firstChild.remove();
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function handleEvent(event, data) {
  if (event === "log") return appendLog(data.step, data.line, data.stream);
  if (event === "step") state.install[data.step] = data.status;
  else if (event === "done") {
    state.install.done = data.ok;
    renderResult(
      $("#install-result"),
      data.ok
        ? { status: "pass", message: "Both installs finished." }
        : {
            status: "fail",
            message: `Install failed for: ${[!data.frontend && "frontend", !data.backend && "backend"].filter(Boolean).join(" and ")}. Scroll the log above for the first error, fix it, then click Install again.`,
          },
    );
  }
  render();
}

async function install() {
  const inst = state.install;
  Object.assign(inst, { running: true, done: false, frontend: "pending", backend: "pending" });
  $("#log").hidden = false;
  $("#log").replaceChildren();
  renderResult($("#install-result"), null);
  render();

  let gotDone = false;
  try {
    const res = await fetch("/api/install", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    // Parse the Server-Sent Events stream by hand (EventSource only supports GET).
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "message";
        let data = "";
        for (const line of raw.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (event === "done") gotDone = true;
        handleEvent(event, JSON.parse(data || "{}"));
      }
    }
    if (!gotDone) throw new Error("Lost the connection to the setup server mid-install.");
  } catch (err) {
    if (inst.frontend !== "success") inst.frontend = "error";
    if (inst.backend !== "success") inst.backend = "error";
    renderResult($("#install-result"), { status: "fail", message: err.message });
  } finally {
    inst.running = false;
    render();
  }
}

// ---------- wiring ----------

function onFieldChange(field) {
  for (const [name, fields] of Object.entries(TEST_FIELDS)) {
    if (fields.includes(field) || (name === "supabase" && field === "SUPABASE_SERVICE_ROLE_KEY")) {
      state.tests[name] = { status: "idle" };
    }
  }
  if (state.envWritten && !state.envStale) {
    state.envStale = true;
    renderResult($("#write-result"), {
      status: "fail",
      message: "You changed a value after writing the .env files. Click Generate again to save it.",
    });
  }
  render();
}

function selectOs(os) {
  for (const b of $$("#os-tabs button")) b.classList.toggle("active", b.dataset.os === os);
  for (const p of $$("[data-os-panel]")) p.hidden = p.dataset.osPanel !== os;
}

async function init() {
  for (const f of FIELDS) {
    $(`#${f}`).addEventListener("input", (e) => {
      state.values[f] = e.target.value;
      onFieldChange(f);
    });
  }
  for (const b of $$("[data-goto]")) b.addEventListener("click", () => goto(Number(b.dataset.goto)));
  for (const b of $$("[data-test]")) b.addEventListener("click", () => runTest(b.dataset.test));
  for (const b of $$("[data-toggle]")) {
    b.addEventListener("click", () => {
      const input = $(`#${b.dataset.toggle}`);
      input.type = input.type === "password" ? "text" : "password";
      b.textContent = input.type === "password" ? "Show" : "Hide";
    });
  }
  $("#copy-redirect").addEventListener("click", async () => {
    const input = $("#redirect-uri");
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand("copy");
    }
    $("#copy-redirect").textContent = "Copied!";
    setTimeout(() => ($("#copy-redirect").textContent = "Copy"), 1500);
  });
  $("#write-env").addEventListener("click", writeEnv);
  $("#install").addEventListener("click", install);
  $("#finish").addEventListener("click", () => goto(5));
  for (const b of $$("#os-tabs button")) b.addEventListener("click", () => selectOs(b.dataset.os));

  // Restore progress from disk so closing and reopening the wizard doesn't start from zero.
  const status = await api("/api/status");
  if (status.ok) {
    state.defaults = status.defaults;
    state.platform = status.platform;
    for (const [k, v] of Object.entries(status.values || {})) {
      state.values[k] = v;
      $(`#${k}`).value = v;
    }
    const s = status.steps;
    state.envWritten = s.envComplete;
    if (s.frontendDepsInstalled) state.install.frontend = "success";
    if (s.backendDepsInstalled) state.install.backend = "success";
    state.install.done = s.frontendDepsInstalled && s.backendDepsInstalled;

    const notes = [];
    if (s.envComplete) notes.push("✓ .env files already written (values loaded below)");
    else if (s.backendEnvExists || s.frontendEnvExists) notes.push("• .env files exist but are incomplete");
    if (s.frontendDepsInstalled) notes.push("✓ frontend dependencies installed");
    if (s.backendDepsInstalled) notes.push("✓ backend venv + dependencies installed");
    else if (s.venvExists) notes.push("• backend venv exists but packages are missing");
    if (status.installRunning) notes.push("• an install is still running from a previous tab; wait for it to finish before reinstalling");
    if (status.nodeTooOldForVite) notes.push(`⚠ Node ${status.nodeVersion} is older than Vite needs (20.19+ or 22.12+). Upgrade Node before running the frontend.`);
    if (notes.length) {
      $("#banner").hidden = false;
      $("#banner").replaceChildren(el("b", { textContent: "Found existing setup:" }), ...notes.map((n) => el("div", { textContent: n })));
    }
    if (state.envWritten) {
      renderResult($("#write-result"), { status: "pass", message: "backend/.env and frontend/.env already exist with all values." });
    }
    state.step = state.envWritten && state.install.done ? 5 : state.envWritten ? 4 : 1;
  } else {
    $("#banner").hidden = false;
    $("#banner").textContent = status.error;
  }

  $("#redirect-uri").value = state.defaults.GOOGLE_REDIRECT_URI;
  selectOs(state.platform === "win32" ? "win" : "unix");
  render();
}

init();

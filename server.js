/**
 * HANS MD — Deploy UI Server
 * Pure Node.js built-ins only. Zero npm dependencies.
 */
"use strict";

const http      = require("http");
const https     = require("https");
const fs        = require("fs");
const path      = require("path");
const crypto    = require("crypto");
const { spawn } = require("child_process");
const { URL }   = require("url");

// ── Config ─────────────────────────────────────────────────────────────────
const PORT        = 8080;
const HERE        = __dirname;
const BOTS_DIR    = path.join(HERE, "bots");
const STATE_FILE  = path.join(HERE, "state.json");
const HTML_FILE   = path.join(HERE, "index.html");
const GH_API      = "https://api.github.com/repos/HaroldMth/HANS___MD/releases/latest";
const GH_APPJSON  = "https://raw.githubusercontent.com/HaroldMth/HANS___MD/main/app.json";
const UA          = "hans-deploy/1.0";
const LOG_MAX     = 400;
const RAM_INTERVAL_MS = 8000;

fs.mkdirSync(BOTS_DIR, { recursive: true });

// ── Persistent registry ────────────────────────────────────────────────────
// slug → { sid, config, ramCap, deployedAt, version }
let registry = {};
try { registry = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}

function saveRegistry() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(registry, null, 2));
}

// ── In-memory runtime state ────────────────────────────────────────────────
// slug → { proc, logs[], clients Set, status, ramMB, ramTimer, pipeLock }
const runtime = {};

function getRuntime(slug) {
  if (!runtime[slug]) {
    runtime[slug] = {
      proc: null, logs: [], clients: new Set(),
      status: "stopped", ramMB: 0, ramTimer: null, pipeLock: false,
    };
  }
  return runtime[slug];
}

// ── Helpers ────────────────────────────────────────────────────────────────
function sidToSlug(sid) {
  return crypto.createHash("md5").update(sid).digest("hex").slice(0, 10);
}

function pushLog(slug, line) {
  const rt = getRuntime(slug);
  if (rt.logs.length >= LOG_MAX) rt.logs.shift();
  rt.logs.push(line);
  const payload = `data: ${JSON.stringify(line)}\n\n`;
  for (const c of rt.clients) c.write(payload);
}

function pushStatus(slug, status) {
  getRuntime(slug).status = status;
  const payload = `event: status\ndata: ${JSON.stringify(status)}\n\n`;
  for (const c of getRuntime(slug).clients) c.write(payload);
}

function pushRam(slug, mb) {
  getRuntime(slug).ramMB = mb;
  const payload = `event: ram\ndata: ${mb}\n\n`;
  for (const c of getRuntime(slug).clients) c.write(payload);
}

function writeEnvFile(botDir, vars) {
  const lines = Object.entries(vars)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`);
  fs.writeFileSync(path.join(botDir, ".env"), lines.join("\n") + "\n");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => { try { resolve(JSON.parse(buf)); } catch { resolve({}); } });
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

// ── Networking helpers ─────────────────────────────────────────────────────
function httpsGet(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const reqOpts = { headers: { "User-Agent": UA, ...opts.headers } };
    https.get(url, reqOpts, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return httpsGet(res.headers.location, opts).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data, res }));
    }).on("error", reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    function get(u) {
      const mod = u.startsWith("https") ? https : http;
      mod.get(u, { headers: { "User-Agent": UA } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) return get(res.headers.location);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on("finish", () => out.close(resolve));
        out.on("error", reject);
        res.on("error", reject);
      }).on("error", reject);
    }
    get(url);
  });
}

// ── Bot process management ─────────────────────────────────────────────────
function readProcRam(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const m = text.match(/VmRSS:\s+(\d+)/);
    return m ? Math.round(parseInt(m[1]) / 1024) : 0;
  } catch { return 0; }
}

function startRamMonitor(slug) {
  const rt = getRuntime(slug);
  if (rt.ramTimer) clearInterval(rt.ramTimer);
  rt.ramTimer = setInterval(() => {
    if (!rt.proc || rt.proc.exitCode !== null) {
      clearInterval(rt.ramTimer);
      rt.ramTimer = null;
      return;
    }
    const mb = readProcRam(rt.proc.pid);
    pushRam(slug, mb);
    const cap = (registry[slug] || {}).ramCap || 512;
    if (mb > cap) {
      pushLog(slug, `⚠️  RAM cap breached: ${mb}MB > ${cap}MB — stopping bot`);
      rt.proc.kill("SIGTERM");
    }
  }, RAM_INTERVAL_MS);
}

function spawnBot(slug) {
  const botDir = path.join(BOTS_DIR, slug);
  const rt = getRuntime(slug);

  rt.proc = spawn("node", ["index.js"], {
    cwd: botDir,
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  pushStatus(slug, "running");
  startRamMonitor(slug);

  rt.proc.stdout.on("data", (d) =>
    d.toString().split("\n").filter(Boolean).forEach((l) => {
      pushLog(slug, l);
      if (l.includes("HANS MD Connected") || l.includes("connected to WA")) {
        pushStatus(slug, "online");
      }
    })
  );
  rt.proc.stderr.on("data", (d) =>
    d.toString().split("\n").filter(Boolean).forEach((l) => pushLog(slug, `[ERR] ${l}`))
  );
  rt.proc.on("close", (code) => {
    pushLog(slug, `\n⛔ Process exited (code ${code})`);
    pushStatus(slug, "stopped");
    pushRam(slug, 0);
    rt.proc = null;
  });
}

function stopBot(slug) {
  const rt = getRuntime(slug);
  if (!rt.proc || rt.proc.exitCode !== null) return false;
  if (rt.ramTimer) { clearInterval(rt.ramTimer); rt.ramTimer = null; }
  rt.proc.kill("SIGTERM");
  setTimeout(() => { if (rt.proc) rt.proc.kill("SIGKILL"); }, 5000);
  return true;
}

// ── Deploy pipeline ────────────────────────────────────────────────────────
function runCmd(cmd, args, slug, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, env: { ...process.env, ...opts.env } });
    p.stdout.on("data", (d) =>
      d.toString().split("\n").filter(Boolean).forEach((l) => pushLog(slug, l))
    );
    p.stderr.on("data", (d) =>
      d.toString().split("\n").filter(Boolean).forEach((l) => pushLog(slug, `  ${l}`))
    );
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))
    );
    p.on("error", reject);
  });
}

async function runDeploy(slug, sid, config, ramCap) {
  const rt = getRuntime(slug);
  if (rt.pipeLock) { pushLog(slug, "⚠️  Deploy already in progress"); return; }
  rt.pipeLock = true;
  rt.logs = [];
  pushStatus(slug, "deploying");

  const tmpTar     = path.join("/tmp", `hans_${slug}.tar.gz`);
  const tmpExtract = path.join("/tmp", `hans_extract_${slug}`);
  const botDir     = path.join(BOTS_DIR, slug);

  try {
    // 1. Stop existing bot if running
    if (rt.proc && rt.proc.exitCode === null) {
      pushLog(slug, "🛑 Stopping existing bot instance...");
      stopBot(slug);
      await new Promise((r) => setTimeout(r, 2000));
    }

    // 2. Fetch latest release metadata
    pushLog(slug, "📡 Fetching latest release info from GitHub...");
    const { body } = await httpsGet(GH_API);
    const release = JSON.parse(body);
    const tarUrl = release.tarball_url;
    const tag = release.tag_name || "latest";
    pushLog(slug, `📦 Release: ${tag}`);

    // 3. Download Tarball
    pushLog(slug, "⬇️  Downloading release archive...");
    await downloadFile(tarUrl, tmpTar);
    const sizeMB = (fs.statSync(tmpTar).size / 1024 / 1024).toFixed(1);
    pushLog(slug, `✅ Downloaded ${sizeMB} MB`);

    // 4. Extract
    pushLog(slug, "📂 Extracting archive...");
    fs.rmSync(tmpExtract, { recursive: true, force: true });
    fs.mkdirSync(tmpExtract, { recursive: true });
    await runCmd("tar", ["-xzf", tmpTar, "-C", tmpExtract], slug);

    // GitHub release tarball contains one top-level folder
    const [innerDir] = fs.readdirSync(tmpExtract);
    const srcDir = path.join(tmpExtract, innerDir);
    fs.rmSync(botDir, { recursive: true, force: true });
    try {
      // Fast path: same filesystem
      fs.renameSync(srcDir, botDir);
    } catch (e) {
      if (e.code === "EXDEV") {
        // Cross-device (e.g. /tmp → /home): fall back to recursive copy
        fs.cpSync(srcDir, botDir, { recursive: true });
      } else throw e;
    }
    pushLog(slug, "✅ Extracted");

    // 5. Cleanup temp files
    try { fs.rmSync(tmpTar, { force: true }); } catch {}
    try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch {}

    // 6. Write .env
    writeEnvFile(botDir, { SESSION_ID: sid, ...config });
    pushLog(slug, "⚙️  Config written to .env");

    // 7. Verify git is accessible (needed for libsignal github dep)
    try {
      await runCmd("git", ["--version"], slug, {});
    } catch {
      pushLog(slug, "⚠️  git not found in PATH — git dependencies may fail");
    }

    // 8. Ensure pnpm is available
    let pnpmCmd = "pnpm";
    let pnpmArgs = [];

    pushLog(slug, "🔍 Checking for pnpm...");
    try {
      await runCmd("pnpm", ["--version"], slug, {});
    } catch {
      const localPnpm = path.join(HERE, "node_modules", "pnpm", "bin", "pnpm.cjs");
      if (!fs.existsSync(localPnpm)) {
        pushLog(slug, "📥 pnpm not found — installing locally (no root required)...");
        await runCmd("npm", ["install", "pnpm"], slug, { cwd: HERE });
        pushLog(slug, "✅ pnpm installed locally");
      }
      pnpmCmd = "node";
      pnpmArgs = [localPnpm];
    }

    // 9. Install dependencies via pnpm
    pushLog(slug, "📦 Installing dependencies via pnpm...");
    // Allow all build scripts (baileys, sharp, protobufjs need postinstall)
    fs.writeFileSync(path.join(botDir, ".npmrc"),
      "dangerouslyAllowAllBuilds=true\nignore-scripts=false\n");
    await runCmd(
      pnpmCmd, [...pnpmArgs, "install", "--prod", "--no-frozen-lockfile", "--dangerously-allow-all-builds", "--reporter=append-only"],
      slug, {
        cwd: botDir,
        env: {
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "echo",
          npm_config_git: "true",
        },
      }
    );
    pushLog(slug, "✅ Dependencies installed");

    // 8. Persist registry
    registry[slug] = { sid, config, ramCap, deployedAt: new Date().toISOString(), version: tag };
    saveRegistry();

    // 9. Start bot
    pushLog(slug, "\n🚀 Starting HANS MD...\n");
    spawnBot(slug);

  } catch (err) {
    pushLog(slug, `\n❌ Deploy failed: ${err.message}`);
    pushStatus(slug, "error");
    try { fs.rmSync(tmpTar, { force: true }); } catch {}
    try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch {}
  } finally {
    rt.pipeLock = false;
  }
}

// ── HTTP Router ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  const method = req.method;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (method === "OPTIONS") { res.writeHead(204); return res.end(); }

  // GET /
  if (method === "GET" && p === "/") {
    try {
      const html = fs.readFileSync(HTML_FILE);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch {
      res.writeHead(500); return res.end("index.html not found");
    }
  }

  // GET /config — app.json env vars from GitHub
  if (method === "GET" && p === "/config") {
    try {
      const { body } = await httpsGet(GH_APPJSON);
      const app = JSON.parse(body);
      return json(res, 200, { env: app.env || {} });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // GET /lookup?sid=...
  if (method === "GET" && p === "/lookup") {
    const sid = u.searchParams.get("sid") || "";
    if (!sid) return json(res, 400, { error: "sid required" });
    const slug = sidToSlug(sid);
    const reg = registry[slug];
    const rt = getRuntime(slug);
    return json(res, 200, {
      exists: !!reg,
      slug,
      status: rt.status,
      ramMB: rt.ramMB,
      config: reg ? reg.config : {},
      ramCap: reg ? reg.ramCap : 512,
      version: reg ? reg.version : null,
      deployedAt: reg ? reg.deployedAt : null,
    });
  }

  // GET /bots — list all
  if (method === "GET" && p === "/bots") {
    const list = Object.entries(registry).map(([slug, r]) => ({
      slug,
      sid: r.sid ? r.sid.slice(0, 20) + "..." : "?",
      status: getRuntime(slug).status,
      ramMB: getRuntime(slug).ramMB,
      ramCap: r.ramCap,
      deployedAt: r.deployedAt,
      version: r.version,
    }));
    return json(res, 200, list);
  }

  // /bot/:slug/* routes
  const botMatch = p.match(/^\/bot\/([a-f0-9]+)(\/.*)?$/);
  if (botMatch) {
    const slug = botMatch[1];
    const sub  = botMatch[2] || "/";

    // GET /bot/:slug/status
    if (method === "GET" && sub === "/status") {
      const rt = getRuntime(slug);
      const reg = registry[slug] || {};
      return json(res, 200, {
        status: rt.status, ramMB: rt.ramMB,
        ramCap: reg.ramCap || 512, config: reg.config || {},
        version: reg.version, deployedAt: reg.deployedAt,
      });
    }

    // GET /bot/:slug/logs — SSE
    if (method === "GET" && sub === "/logs") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const rt = getRuntime(slug);
      // replay buffer
      for (const line of rt.logs) res.write(`data: ${JSON.stringify(line)}\n\n`);
      // send current status + ram
      res.write(`event: status\ndata: ${JSON.stringify(rt.status)}\n\n`);
      res.write(`event: ram\ndata: ${rt.ramMB}\n\n`);
      rt.clients.add(res);
      req.on("close", () => rt.clients.delete(res));
      return;
    }

    // POST /bot/:slug/stop
    if (method === "POST" && sub === "/stop") {
      const stopped = stopBot(slug);
      return json(res, 200, { ok: stopped });
    }

    // POST /bot/:slug/restart
    if (method === "POST" && sub === "/restart") {
      stopBot(slug);
      await new Promise((r) => setTimeout(r, 2000));
      spawnBot(slug);
      return json(res, 200, { ok: true });
    }

    // POST /bot/:slug/settings — update config & restart
    if (method === "POST" && sub === "/settings") {
      const body = await readBody(req);
      const reg = registry[slug];
      if (!reg) return json(res, 404, { error: "Bot not found" });
      reg.config = { ...reg.config, ...body.config };
      if (body.ramCap) reg.ramCap = Number(body.ramCap);
      saveRegistry();
      const botDir = path.join(BOTS_DIR, slug);
      writeEnvFile(botDir, { SESSION_ID: reg.sid, ...reg.config });
      pushLog(slug, "⚙️  Settings updated — restarting...");
      stopBot(slug);
      await new Promise((r) => setTimeout(r, 2000));
      spawnBot(slug);
      return json(res, 200, { ok: true });
    }

    // POST /bot/:slug/redeploy — full pipeline again
    if (method === "POST" && sub === "/redeploy") {
      const reg = registry[slug];
      if (!reg) return json(res, 404, { error: "Bot not found" });
      json(res, 200, { ok: true });
      runDeploy(slug, reg.sid, reg.config, reg.ramCap);
      return;
    }
  }

  // POST /deploy — fresh deploy
  if (method === "POST" && p === "/deploy") {
    const body = await readBody(req);
    const { sid, config = {}, ramCap = 512 } = body;
    if (!sid) return json(res, 400, { error: "sid required" });
    const slug = sidToSlug(sid);
    json(res, 200, { ok: true, slug });
    runDeploy(slug, sid, config, Number(ramCap));
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () =>
  console.log(`\n🌐  HANS MD Deploy UI  →  http://localhost:${PORT}\n`)
);

process.on("SIGINT", () => {
  for (const slug of Object.keys(runtime)) stopBot(slug);
  server.close(() => process.exit(0));
});

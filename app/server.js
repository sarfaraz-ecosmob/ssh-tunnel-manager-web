'use strict';

const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { DatabaseSync } = require('node:sqlite');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

// Load project-root .env when present (host run). Real env vars take precedence.
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* no .env file */ }

const app = express();
const PORT = Number(process.env.APP_PORT || 9999);
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
// Default to the user's ~/.ssh so keys can be used without copying them.
const KEY_DIR = process.env.KEY_DIR || path.join(os.homedir(), '.ssh');
const KNOWN_HOSTS_FILE = process.env.KNOWN_HOSTS_FILE || path.join(KEY_DIR, 'known_hosts');
const SSH_BIN = process.env.SSH_BIN || 'ssh';
const DB_PATH = path.join(DATA_DIR, 'tunnels.sqlite');
const active = new Map();
const recentLogs = [];
const MAX_LOGS = 200;

if (ADMIN_PASSWORD.length < 16) {
  console.error('ADMIN_PASSWORD must be at least 16 characters.');
  process.exit(1);
}
if (SESSION_SECRET.length < 32) {
  console.error('SESSION_SECRET must be at least 32 characters.');
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS tunnels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ssh_host TEXT NOT NULL,
    ssh_port INTEGER NOT NULL,
    ssh_user TEXT NOT NULL,
    key_file TEXT NOT NULL DEFAULT '',
    auth_method TEXT NOT NULL DEFAULT 'key',
    ssh_password TEXT NOT NULL DEFAULT '',
    local_host TEXT NOT NULL,
    local_port INTEGER NOT NULL,
    remote_host TEXT NOT NULL,
    remote_port INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
`);
// Migrate databases created before SSH password authentication existed.
{
  const cols = db.prepare('PRAGMA table_info(tunnels)').all().map(c => c.name);
  if (!cols.includes('auth_method')) db.exec("ALTER TABLE tunnels ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'key'");
  if (!cols.includes('ssh_password')) db.exec("ALTER TABLE tunnels ADD COLUMN ssh_password TEXT NOT NULL DEFAULT ''");
}
// Saved SSH passwords now live in this file; keep it owner-only.
try { fs.chmodSync(DB_PATH, 0o600); } catch { /* best effort */ }
const listStmt = db.prepare('SELECT * FROM tunnels ORDER BY name COLLATE NOCASE');
const getStmt = db.prepare('SELECT * FROM tunnels WHERE id = ?');
const insertStmt = db.prepare(`INSERT INTO tunnels
  (id,name,ssh_host,ssh_port,ssh_user,key_file,auth_method,ssh_password,local_host,local_port,remote_host,remote_port,created_at)
  VALUES (@id,@name,@ssh_host,@ssh_port,@ssh_user,@key_file,@auth_method,@ssh_password,@local_host,@local_port,@remote_host,@remote_port,@created_at)`);
const updateStmt = db.prepare(`UPDATE tunnels SET name=@name,ssh_host=@ssh_host,ssh_port=@ssh_port,
  ssh_user=@ssh_user,key_file=@key_file,auth_method=@auth_method,ssh_password=@ssh_password,
  local_host=@local_host,local_port=@local_port,
  remote_host=@remote_host,remote_port=@remote_port WHERE id=@id`);

function log(message, level = 'info', tunnelId = null) {
  recentLogs.unshift({ time: new Date().toISOString(), level, tunnelId, message: String(message).slice(0, 500) });
  if (recentLogs.length > MAX_LOGS) recentLogs.length = MAX_LOGS;
}
function publicTunnel(row) {
  if (!row) return null;
  const { ssh_password, ...rest } = row; // never expose the saved SSH password
  return { ...rest, hasKey: Boolean(row.key_file), hasPassword: Boolean(row.ssh_password), status: active.has(row.id) ? active.get(row.id).status : 'stopped' };
}
function parseAllowlist(name) {
  return (process.env[name] || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}
function allowed(value, envName) {
  const list = parseAllowlist(envName);
  return list.length === 0 || list.includes(String(value).toLowerCase());
}
function isValidHost(host) {
  // MVP accepts DNS names and IPv4 literals; IPv6 literals are intentionally not supported yet.
  return typeof host === 'string' && host.length <= 253 &&
    /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/.test(host) &&
    !host.includes('..') && !host.startsWith('-');
}
function constantTimeStringEqual(a, b) {
  const digestA = crypto.createHash('sha256').update(String(a)).digest();
  const digestB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(digestA, digestB) && String(a).length === String(b).length;
}
function validPort(port) {
  return Number.isInteger(Number(port)) && Number(port) >= 1 && Number(port) <= 65535;
}
function validateTunnel(body, existingId = null) {
  const fields = ['name', 'ssh_host', 'ssh_user', 'remote_host'];
  for (const f of fields) {
    if (typeof body[f] !== 'string' || !body[f].trim() || body[f].length > 253) {
      throw new Error(`Invalid ${f}`);
    }
  }
  // Default to key auth so older API clients keep working unchanged.
  const auth_method = body.auth_method == null || body.auth_method === '' ? 'key' : body.auth_method;
  if (!['key', 'password'].includes(auth_method)) throw new Error('Authentication method must be "key" or "password"');
  if (body.name.trim().length > 80) throw new Error('Name must be 80 characters or fewer');
  if (!isValidHost(body.ssh_host.trim())) throw new Error('Invalid SSH host');
  if (!isValidHost(body.remote_host.trim())) throw new Error('Invalid remote target host');
  if (!/^[a-zA-Z0-9._-]+$/.test(body.ssh_user) || body.ssh_user.length > 64) throw new Error('Invalid SSH username');
  if (!validPort(body.ssh_port) || !validPort(body.local_port) || !validPort(body.remote_port)) throw new Error('Ports must be between 1 and 65535');
  if (!['127.0.0.1', 'localhost'].includes(body.local_host)) throw new Error('Local bind address must be 127.0.0.1 or localhost');
  if (!allowed(body.ssh_host.trim(), 'ALLOWED_SSH_HOSTS')) throw new Error('SSH host is not in ALLOWED_SSH_HOSTS');
  if (!allowed(body.remote_host.trim(), 'ALLOWED_REMOTE_TARGETS')) throw new Error('Remote target is not in ALLOWED_REMOTE_TARGETS');
  let ssh_password = '';
  if (auth_method === 'key') {
    if (typeof body.key_file !== 'string' || !body.key_file.trim() || body.key_file.length > 253) throw new Error('Invalid key_file');
    if (!/^[a-zA-Z0-9._-]+$/.test(body.key_file) || body.key_file.includes('..')) throw new Error('Key file must be a filename in the mounted key directory');
    const keyPath = path.join(KEY_DIR, body.key_file);
    if (!fs.existsSync(keyPath) || !fs.statSync(keyPath).isFile()) throw new Error(`SSH key file not found in ${KEY_DIR}`);
  } else {
    // Password auth: a blank password on edit keeps the previously saved one.
    const old = existingId ? getStmt.get(existingId) : null;
    ssh_password = (typeof body.ssh_password === 'string' && body.ssh_password) ? body.ssh_password : (old && old.ssh_password) || '';
    if (!ssh_password) throw new Error('SSH password is required for password authentication');
    if (ssh_password.length > 253 || /[\x00-\x1f\x7f]/.test(ssh_password)) throw new Error('SSH password must be 253 characters or fewer without control characters');
  }
  const duplicate = listStmt.all().find(t => t.id !== existingId && t.local_host === body.local_host && t.local_port === Number(body.local_port));
  if (duplicate) throw new Error(`Local port already configured by "${duplicate.name}"`);
  return {
    name: body.name.trim(), ssh_host: body.ssh_host.trim(), ssh_port: Number(body.ssh_port),
    ssh_user: body.ssh_user, key_file: auth_method === 'key' ? body.key_file : '',
    auth_method, ssh_password, local_host: body.local_host,
    local_port: Number(body.local_port), remote_host: body.remote_host.trim(),
    remote_port: Number(body.remote_port)
  };
}
function authRequired(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  return res.status(401).json({ error: 'Authentication required' });
}
function csrfRequired(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  const host = req.get('host');
  if (origin && host) {
    try {
      const parsed = new URL(origin);
      if (parsed.host !== host) return res.status(403).json({ error: 'Cross-origin request rejected' });
    } catch {
      return res.status(403).json({ error: 'Invalid origin' });
    }
  }
  if (!req.session || !req.session.csrf || req.get('x-csrf-token') !== req.session.csrf) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  next();
}
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: {
  directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
    imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"],
    baseUri: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'"]
  }
}}));
app.use(express.json({ limit: '16kb' }));
app.use(session({
  name: 'stm.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.SESSION_SECURE === 'true',
    maxAge: 8 * 60 * 60 * 1000
  }
}));
app.use('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.post('/api/login', (req, res, next) => {
  const { username, password } = req.body || {};
  const u = String(username || '');
  const p = String(password || '');
  const uMatch = constantTimeStringEqual(u, ADMIN_USERNAME);
  const pMatch = constantTimeStringEqual(p, ADMIN_PASSWORD);
  if (!uMatch || !pMatch) {
    log('Rejected login attempt', 'warn');
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  req.session.regenerate(err => {
    if (err) return next(err);
    req.session.authenticated = true;
    req.session.username = ADMIN_USERNAME;
    req.session.csrf = crypto.randomBytes(32).toString('hex');
    req.session.save(err2 => {
      if (err2) return next(err2);
      log('User signed in');
      res.json({ username: ADMIN_USERNAME, csrf: req.session.csrf });
    });
  });
});
app.post('/api/logout', authRequired, csrfRequired, (req, res, next) => {
  for (const [id] of active) stopTunnel(id);
  req.session.destroy(err => {
    if (err) return next(err);
    res.clearCookie('stm.sid', { httpOnly: true, sameSite: 'strict', secure: process.env.SESSION_SECURE === 'true' });
    res.json({ ok: true });
  });
});
app.get('/api/session', (req, res) => {
  res.json({ authenticated: Boolean(req.session && req.session.authenticated), username: req.session?.username || null, csrf: req.session?.csrf || null });
});
app.use('/api', authRequired, csrfRequired);

app.get('/api/tunnels', (_req, res) => res.json(listStmt.all().map(publicTunnel)));
app.post('/api/tunnels', (req, res) => {
  try {
    const data = validateTunnel(req.body);
    const row = { id: crypto.randomUUID(), ...data, created_at: new Date().toISOString() };
    insertStmt.run(row);
    log(`Created tunnel profile "${row.name}"`);
    res.status(201).json(publicTunnel(row));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/tunnels/:id', (req, res) => {
  try {
    const old = getStmt.get(req.params.id);
    if (!old) return res.status(404).json({ error: 'Tunnel not found' });
    if (active.has(old.id)) return res.status(409).json({ error: 'Stop the tunnel before editing it' });
    const data = validateTunnel(req.body, old.id);
    updateStmt.run({ id: old.id, ...data });
    log(`Updated tunnel profile "${data.name}"`);
    res.json(publicTunnel(getStmt.get(old.id)));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/tunnels/:id', (req, res) => {
  const row = getStmt.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Tunnel not found' });
  if (active.has(row.id)) return res.status(409).json({ error: 'Stop the tunnel before deleting it' });
  db.prepare('DELETE FROM tunnels WHERE id = ?').run(row.id);
  log(`Deleted tunnel profile "${row.name}"`);
  res.json({ ok: true });
});
app.post('/api/tunnels/:id/start', (req, res) => {
  try {
    const row = getStmt.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Tunnel not found' });
    if (active.has(row.id)) return res.status(409).json({ error: 'Tunnel is already running' });
    const usePassword = row.auth_method === 'password';
    const keyPath = usePassword ? null : path.join(KEY_DIR, row.key_file);
    if (!usePassword && !fs.existsSync(keyPath)) return res.status(400).json({ error: 'SSH key file is missing' });
    if (usePassword && !row.ssh_password) return res.status(400).json({ error: 'SSH password is missing for this tunnel; edit it and save a password' });
    const args = [
      '-N', '-T',
      ...(usePassword
        ? ['-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no', '-o', 'KbdInteractiveAuthentication=no', '-o', 'NumberOfPasswordPrompts=1']
        : ['-i', keyPath, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes']),
      '-p', String(row.ssh_port),
      '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${KNOWN_HOSTS_FILE}`,
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-L', `${row.local_host}:${row.local_port}:${row.remote_host}:${row.remote_port}`,
      `${row.ssh_user}@${row.ssh_host}`
    ];
    const spawnOpts = { shell: false, stdio: ['ignore', 'ignore', 'pipe'] };
    if (usePassword) {
      // OpenSSH cannot read a saved password directly, so it is handed over
      // through a private SSH_ASKPASS helper (password stays in the child's
      // environment, never on disk or on a command line).
      spawnOpts.env = {
        ...process.env,
        DISPLAY: process.env.DISPLAY || ':0', // needed for askpass without a tty (OpenSSH < 8.4)
        SSH_ASKPASS: ensureAskpass(),
        SSH_ASKPASS_REQUIRE: 'force', // used by OpenSSH >= 8.4; harmless otherwise
        STM_ASKPASS_PASSWORD: row.ssh_password
      };
    }
    const child = spawn(SSH_BIN, args, spawnOpts);
    const entry = { child, status: 'starting', startedAt: new Date().toISOString(), error: '' };
    active.set(row.id, entry);
    child.stderr.on('data', chunk => {
      const msg = chunk.toString().trim();
      if (msg) {
        entry.error = msg.slice(0, 300);
        log(`SSH: ${msg}`, 'info', row.id);
      }
    });
    child.on('error', err => {
      entry.status = 'error';
      entry.error = err.message;
      log(`Could not start SSH process: ${err.message}`, 'error', row.id);
      active.delete(row.id);
    });
    child.on('exit', (code, signal) => {
      const current = active.get(row.id);
      if (current && current.child === child) active.delete(row.id);
      if (code !== 0 && code !== null) log(`SSH process exited with code ${code}${signal ? ` (${signal})` : ''}`, 'error', row.id);
      else log(`Tunnel "${row.name}" stopped`);
    });
    // Promote status only after the local forwarding socket is accepting connections.
    const probeUntil = Date.now() + 10000;
    const probe = () => {
      const current = active.get(row.id);
      if (!current || current.child !== child || child.exitCode !== null) return;
      const socket = net.connect({ host: row.local_host, port: row.local_port });
      socket.setTimeout(300);
      socket.once('connect', () => {
        socket.destroy();
        if (active.get(row.id) === entry) entry.status = 'running';
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() < probeUntil && active.get(row.id) === entry) setTimeout(probe, 250).unref();
      });
      socket.once('timeout', () => {
        socket.destroy();
        if (Date.now() < probeUntil && active.get(row.id) === entry) setTimeout(probe, 250).unref();
      });
    };
    setTimeout(probe, 250).unref();
    log(`Starting tunnel "${row.name}"`);
    res.status(202).json({ ok: true, status: 'starting' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
function stopTunnel(id) {
  const entry = active.get(id);
  if (!entry) return false;
  entry.status = 'stopping';
  entry.child.kill('SIGTERM');
  setTimeout(() => {
    const still = active.get(id);
    if (still && still.child === entry.child) entry.child.kill('SIGKILL');
  }, 3000).unref();
  return true;
}
app.post('/api/tunnels/:id/stop', (req, res) => {
  const row = getStmt.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Tunnel not found' });
  if (!stopTunnel(row.id)) return res.status(409).json({ error: 'Tunnel is not running' });
  log(`Stopping tunnel "${row.name}"`);
  res.json({ ok: true });
});
app.get('/api/logs', (_req, res) => res.json(recentLogs));
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: '0' }));
app.get('*', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

let askpassPath = null;
function ensureAskpass() {
  if (!askpassPath) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-askpass-'));
    askpassPath = path.join(dir, 'askpass.sh');
    fs.writeFileSync(askpassPath, '#!/bin/sh\nprintf "%s\\n" "$STM_ASKPASS_PASSWORD"\n', { mode: 0o700 });
    fs.chmodSync(askpassPath, 0o700);
  }
  return askpassPath;
}
function cleanup() {
  for (const [, entry] of active) entry.child.kill('SIGTERM');
  if (askpassPath) { try { fs.rmSync(path.dirname(askpassPath), { recursive: true, force: true }); } catch { /* best effort */ } }
  db.close();
}
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT', () => { cleanup(); process.exit(0); });

app.listen(PORT, '0.0.0.0', () => console.log(`SSH Tunnel Manager listening on ${PORT}`));

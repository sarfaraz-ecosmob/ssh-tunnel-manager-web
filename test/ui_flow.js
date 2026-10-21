'use strict';
// End-to-end UI test: drives the real web UI in headless Chrome.
// Login -> add tunnel profile -> start -> verify from the host namespace
// (ss + curl through the forwarded port) -> stop -> verify port released.
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ART = path.join(__dirname, 'artifacts');

function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const env = readEnv(path.join(ROOT, '.env'));
const APP_PORT = env.APP_PORT || '9999';
const BASE = `http://127.0.0.1:${APP_PORT}`;
const LOCAL_PORT = 15432;
const TUNNEL = {
  name: 'E2E Local Forward',
  ssh_host: '127.0.0.1',
  ssh_port: '2022',
  ssh_user: 'tunneluser',
  key_file: 'id_ed25519_test',
  local_host: '127.0.0.1',
  local_port: String(LOCAL_PORT),
  remote_host: '127.0.0.1',
  remote_port: '8099',
};

const step = msg => console.log(`[ui] ${msg}`);
const fail = async (page, msg) => {
  try { await page.screenshot({ path: path.join(ART, '99-failure.png'), fullPage: true }); } catch {}
  try {
    const diag = await page.evaluate(() => ({
      loginError: (document.getElementById('loginError') || {}).textContent || '',
      loginHidden: document.getElementById('loginView').classList.contains('hidden'),
      appHidden: document.getElementById('appView').classList.contains('hidden'),
      totalCount: (document.getElementById('totalCount') || {}).textContent,
      emptyHidden: (document.getElementById('emptyState') || {}).className,
      listHtml: (document.getElementById('tunnelList') || {}).innerHTML?.slice(0, 300),
    }));
    console.log('[ui][diag]', JSON.stringify(diag));
  } catch {}
  throw new Error(msg);
};

function hostListening(port) {
  const out = execSync(`ss -ltn | grep -E ':${port}\\s' || true`).toString();
  return out.includes(`:${port}`);
}
function curlThrough(port) {
  return execSync(`curl -s --max-time 5 http://127.0.0.1:${port}/ || echo CURL_FAILED`).toString();
}

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  let puppeteer;
  try {
    puppeteer = require('puppeteer-core');
  } catch {
    puppeteer = require(process.env.PUPPETEER_CORE_PATH);
  }

  if (hostListening(LOCAL_PORT)) throw new Error(`local port ${LOCAL_PORT} already busy before test`);
  if (!fs.existsSync(path.join(ROOT, 'ssh-keys', `${TUNNEL.key_file}.pub`))) throw new Error('test ssh key missing');

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1400, 950'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 950 });
  page.on('pageerror', e => console.log('[ui][pageerror]', e.message));
  page.on('response', r => { if (r.url().includes('/api/')) console.log(`[net] ${r.status()} ${r.url()}`); });

  try {
    step(`open ${BASE}`);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#loginView:not(.hidden)');
    await page.screenshot({ path: path.join(ART, '01-login.png') });

    const setField = (sel, value) => page.$eval(sel, (el, v) => { el.value = v; }, value);

    step('reject a wrong password');
    await setField('#loginForm input[name="username"]', env.ADMIN_USERNAME || 'admin');
    await setField('#loginForm input[name="password"]', 'definitely-wrong-password');
    await page.click('#loginForm button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('loginError').textContent.trim().length > 0, { timeout: 8000 });

    step('sign in');
    await setField('#loginForm input[name="password"]', env.ADMIN_PASSWORD);
    await page.click('#loginForm button[type="submit"]');
    await page.waitForFunction(() => !document.getElementById('appView').classList.contains('hidden'), { timeout: 8000 });
    const shownUser = await page.$eval('#usernameLabel', el => el.textContent);
    if (shownUser !== (env.ADMIN_USERNAME || 'admin')) await fail(page, `unexpected username label: ${shownUser}`);
    await page.waitForFunction(() => document.getElementById('totalCount').textContent !== '0' || !document.getElementById('emptyState').classList.contains('hidden'), { timeout: 8000 });
    const beforeTotal = await page.$eval('#totalCount', el => Number(el.textContent));
    const beforeActive = await page.$eval('#activeCount', el => Number(el.textContent));

    step('create tunnel profile through the dialog');
    await page.click('#addBtn');
    await page.waitForSelector('#tunnelDialog[open]');
    for (const [key, value] of Object.entries(TUNNEL)) {
      await setField(`#tunnelForm [name="${key}"]`, value);
    }
    await page.click('#tunnelForm button[type="submit"]');
    try {
      await page.waitForFunction(() => !document.getElementById('tunnelDialog').open, { timeout: 8000 });
    } catch {
      const err = await page.$eval('#formError', el => el.textContent);
      await fail(page, `form rejected: ${err}`);
    }
    await page.waitForFunction(name => document.body.innerText.includes(name), { timeout: 8000 }, TUNNEL.name);
    await page.waitForFunction(n => {
      const card = Array.from(document.querySelectorAll('.tunnel-card')).find(c => c.innerText.includes(n));
      const b = card && card.querySelector('.badge');
      return b && b.textContent.trim() === 'stopped';
    }, { timeout: 8000 }, TUNNEL.name);
    const total = await page.$eval('#totalCount', el => Number(el.textContent));
    if (total !== beforeTotal + 1) await fail(page, `expected ${beforeTotal + 1} tunnels after create, stats show ${total}`);

    step('edit round-trip keeps the profile');
    await page.evaluate(n => {
      const card = Array.from(document.querySelectorAll('.tunnel-card')).find(c => c.innerText.includes(n));
      card.querySelector('button[data-action="edit"]').click();
    }, TUNNEL.name);
    await page.waitForSelector('#tunnelDialog[open]');
    const keyPrefill = await page.$eval('#tunnelForm [name="key_file"]', el => el.value);
    if (keyPrefill !== TUNNEL.key_file) await fail(page, `edit dialog key_file not prefilled: "${keyPrefill}"`);
    await page.click('#tunnelForm button[type="submit"]');
    try {
      await page.waitForFunction(() => !document.getElementById('tunnelDialog').open, { timeout: 8000 });
    } catch {
      const err = await page.$eval('#formError', el => el.textContent);
      await fail(page, `edit save rejected: ${err}`);
    }
    const totalAfterEdit = await page.$eval('#totalCount', el => Number(el.textContent));
    if (totalAfterEdit !== beforeTotal + 1) await fail(page, `edit changed tunnel count to ${totalAfterEdit}`);

    step('start the tunnel');
    await page.evaluate(n => {
      const card = Array.from(document.querySelectorAll('.tunnel-card')).find(c => c.innerText.includes(n));
      card.querySelector('button[data-action="start"]').click();
    }, TUNNEL.name);
    await page.waitForFunction(n => {
      const card = Array.from(document.querySelectorAll('.tunnel-card')).find(c => c.innerText.includes(n));
      const b = card && card.querySelector('.badge');
      return b && b.textContent.trim() === 'running';
    }, { timeout: 25000 }, TUNNEL.name);
    const active = await page.$eval('#activeCount', el => Number(el.textContent));
    if (active !== beforeActive + 1) await fail(page, `expected active=${beforeActive + 1}, got ${active}`);
    await page.screenshot({ path: path.join(ART, '02-running.png'), fullPage: true });

    step('verify local port from the host namespace (ss)');
    if (!hostListening(LOCAL_PORT)) await fail(page, `port ${LOCAL_PORT} not listening per host ss`);
    console.log(`[host] ss says port ${LOCAL_PORT} is LISTENING`);

    step('verify data end-to-end (curl through the forwarded port)');
    const viaCurl = curlThrough(LOCAL_PORT);
    if (!viaCurl.includes('E2E_TARGET_OK')) await fail(page, `unexpected tunnel response: ${viaCurl}`);
    console.log(`[host] curl via tunnel -> ${viaCurl.trim()}`);

    const res = await fetch(`http://127.0.0.1:${LOCAL_PORT}/`, { signal: AbortSignal.timeout(5000) });
    const body = await res.text();
    if (!body.includes('E2E_TARGET_OK')) await fail(page, `unexpected fetch response: ${body}`);
    console.log('[host] fetch via tunnel OK');

    step('stop the tunnel');
    await page.evaluate(n => {
      const card = Array.from(document.querySelectorAll('.tunnel-card')).find(c => c.innerText.includes(n));
      card.querySelector('button[data-action="stop"]').click();
    }, TUNNEL.name);
    await page.waitForFunction(n => {
      const card = Array.from(document.querySelectorAll('.tunnel-card')).find(c => c.innerText.includes(n));
      const b = card && card.querySelector('.badge');
      return b && b.textContent.trim() === 'stopped';
    }, { timeout: 20000 }, TUNNEL.name);
    await page.waitForFunction(n => Number(document.getElementById('activeCount').textContent) === n, { timeout: 8000 }, beforeActive);
    await page.screenshot({ path: path.join(ART, '03-stopped.png'), fullPage: true });

    if (hostListening(LOCAL_PORT)) await fail(page, `port ${LOCAL_PORT} still listening after stop`);
    console.log(`[host] port ${LOCAL_PORT} released after stop`);

    step('verify activity logs page');
    await page.click('[data-page="activity"]');
    await page.waitForFunction(() => {
      const el = document.getElementById('logList');
      return el && el.innerText.includes('Starting tunnel "E2E Local Forward"');
    }, { timeout: 10000 });
    await page.screenshot({ path: path.join(ART, '04-activity.png'), fullPage: true });

    console.log('UI_FLOW_OK');
  } catch (err) {
    try { await page.screenshot({ path: path.join(ART, '99-failure.png'), fullPage: true }); } catch {}
    try {
      const diag = await page.evaluate(() => ({
        loginError: (document.getElementById('loginError') || {}).textContent || '',
        formError: (document.getElementById('formError') || {}).textContent || '',
        loginHidden: document.getElementById('loginView').classList.contains('hidden'),
        appHidden: document.getElementById('appView').classList.contains('hidden'),
        totalCount: (document.getElementById('totalCount') || {}).textContent,
        emptyClass: (document.getElementById('emptyState') || {}).className,
        listHtml: ((document.getElementById('tunnelList') || {}).innerHTML || '').slice(0, 300),
        toast: (document.getElementById('toast') || {}).textContent || '',
      }));
      console.log('[ui][diag]', JSON.stringify(diag));
    } catch {}
    throw err;
  } finally {
    await browser.close();
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error('UI_FLOW_FAILED:', err.message);
  process.exit(1);
});

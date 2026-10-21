'use strict';
// End-to-end UI test for SSH password authentication:
// login -> create a password-auth tunnel through the dialog -> start it ->
// verify the forwarded port from the host namespace -> stop -> delete profile.
// Requires test/fake_sshd.py to be started with --password (see test/run.sh).
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
const APP_PORT = process.env.APP_PORT || env.APP_PORT || '9999';
const BASE = `http://127.0.0.1:${APP_PORT}`;
const LOCAL_PORT = 15442;
const SSH_PASSWORD = process.env.E2E_SSH_PASSWORD || 'e2e-password-secret';
const TUNNEL = {
  name: 'E2E Password Tunnel',
  ssh_host: '127.0.0.1',
  ssh_port: '2022',
  ssh_user: 'tunneluser',
  auth_method: 'password',
  ssh_password: SSH_PASSWORD,
  local_host: '127.0.0.1',
  local_port: String(LOCAL_PORT),
  remote_host: '127.0.0.1',
  remote_port: '8099',
};

const step = msg => console.log(`[pwd] ${msg}`);
const fail = async (page, msg) => {
  try { await page.screenshot({ path: path.join(ART, '99-pwd-failure.png'), fullPage: true }); } catch {}
  try {
    const diag = await page.evaluate(() => ({
      formError: (document.getElementById('formError') || {}).textContent || '',
      toast: (document.getElementById('toast') || {}).textContent || '',
      listHtml: ((document.getElementById('tunnelList') || {}).innerHTML || '').slice(0, 300),
    }));
    console.log('[pwd][diag]', JSON.stringify(diag));
  } catch {}
  throw new Error(msg);
};

function hostListening(port) {
  const out = execSync(`ss -ltn | grep -E ':${port}\\s' || true`).toString();
  return out.includes(`:${port}`);
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

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1400, 950'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 950 });
  page.on('pageerror', e => console.log('[pwd][pageerror]', e.message));
  page.on('response', r => { if (r.url().includes('/api/')) console.log(`[net] ${r.status()} ${r.url()}`); });

  try {
    step(`open ${BASE}`);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#loginView:not(.hidden)');
    const setField = (sel, value) => page.$eval(sel, (el, v) => { el.value = v; }, value);

    step('sign in');
    await setField('#loginForm input[name="username"]', env.ADMIN_USERNAME || 'admin');
    await setField('#loginForm input[name="password"]', env.ADMIN_PASSWORD);
    await page.click('#loginForm button[type="submit"]');
    await page.waitForFunction(() => !document.getElementById('appView').classList.contains('hidden'), { timeout: 8000 });

    step('remove leftovers from previous runs (if any)');
    const staleExists = await page.evaluate(n => Array.from(document.querySelectorAll('.tunnel-card')).some(c => c.innerText.includes(n)), TUNNEL.name);
    if (staleExists) {
      page.once('dialog', d => d.accept());
      await page.evaluate(n => {
        const card = Array.from(document.querySelectorAll('.tunnel-card')).find(c => c.innerText.includes(n));
        card.querySelector('button[data-action="delete"]').click();
      }, TUNNEL.name);
      await page.waitForFunction(n => !Array.from(document.querySelectorAll('.tunnel-card')).some(c => c.innerText.includes(n)), { timeout: 8000 }, TUNNEL.name);
    }

    step('create a password-auth tunnel through the dialog');
    await page.click('#addBtn');
    await page.waitForSelector('#tunnelDialog[open]');
    const keyVisible = await page.$eval('#keyFileField', el => !el.classList.contains('hidden'));
    const pwHidden = await page.$eval('#passwordField', el => el.classList.contains('hidden'));
    if (!keyVisible || !pwHidden) await fail(page, 'dialog should default to key auth with the key field visible');
    await setField('#tunnelForm [name="auth_method"]', 'password');
    await page.$eval('#tunnelForm [name="auth_method"]', el => el.dispatchEvent(new Event('change', { bubbles: true })));
    await page.waitForSelector('#passwordField:not(.hidden)', { timeout: 3000 });
    const keyFieldHidden = await page.$eval('#keyFileField', el => el.classList.contains('hidden'));
    if (!keyFieldHidden) await fail(page, 'key field should hide when password auth is selected');
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
    await page.waitForFunction(n => document.body.innerText.includes(n), { timeout: 8000 }, TUNNEL.name);
    await page.screenshot({ path: path.join(ART, '07-password-created.png'), fullPage: true });

    step('edit round-trip: saved password is not sent back to the browser');
    await page.evaluate(n => {
      const card = Array.from(document.querySelectorAll('.tunnel-card')).find(c => c.innerText.includes(n));
      card.querySelector('button[data-action="edit"]').click();
    }, TUNNEL.name);
    await page.waitForSelector('#tunnelDialog[open]');
    const state = await page.$eval('#tunnelForm', form => ({
      auth: form.elements.auth_method.value,
      pwValue: form.elements.ssh_password.value,
      pwPlaceholder: form.elements.ssh_password.placeholder,
      keyHidden: document.getElementById('keyFileField').classList.contains('hidden'),
    }));
    if (state.auth !== 'password' || state.pwValue !== '' || !state.keyHidden) await fail(page, `bad edit prefill: ${JSON.stringify(state)}`);
    if (!/keep saved password/i.test(state.pwPlaceholder)) await fail(page, `unexpected password placeholder: ${state.pwPlaceholder}`);
    await page.click('#tunnelForm button[type="submit"]');
    try {
      await page.waitForFunction(() => !document.getElementById('tunnelDialog').open, { timeout: 8000 });
    } catch {
      const err = await page.$eval('#formError', el => el.textContent);
      await fail(page, `blank-password edit rejected (should keep saved password): ${err}`);
    }

    step('verify the API never exposes the stored password');
    const exposed = await page.evaluate(async pw => {
      const res = await fetch('/api/tunnels', { credentials: 'same-origin' });
      const list = await res.json();
      return JSON.stringify(list).includes(pw);
    }, SSH_PASSWORD);
    if (exposed) await fail(page, 'saved SSH password leaked through GET /api/tunnels');

    step('start the password tunnel');
    await page.evaluate(n => {
      const card = Array.from(document.querySelectorAll('.tunnel-card')).find(c => c.innerText.includes(n));
      card.querySelector('button[data-action="start"]').click();
    }, TUNNEL.name);
    await page.waitForFunction(n => {
      const card = Array.from(document.querySelectorAll('.tunnel-card')).find(c => c.innerText.includes(n));
      const b = card && card.querySelector('.badge');
      return b && b.textContent.trim() === 'running';
    }, { timeout: 25000 }, TUNNEL.name);
    await page.screenshot({ path: path.join(ART, '08-password-running.png'), fullPage: true });

    step('verify data end-to-end through the forwarded port');
    if (!hostListening(LOCAL_PORT)) await fail(page, `port ${LOCAL_PORT} not listening per host ss`);
    const viaCurl = execSync(`curl -s --max-time 5 http://127.0.0.1:${LOCAL_PORT}/ || echo CURL_FAILED`).toString();
    if (!viaCurl.includes('E2E_TARGET_OK')) await fail(page, `unexpected tunnel response: ${viaCurl}`);
    console.log(`[host] curl via password tunnel -> ${viaCurl.trim()}`);

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
    if (hostListening(LOCAL_PORT)) await fail(page, `port ${LOCAL_PORT} still listening after stop`);
    console.log(`[host] port ${LOCAL_PORT} released after stop`);

    step('delete the password tunnel profile');
    page.once('dialog', d => d.accept());
    await page.evaluate(n => {
      const card = Array.from(document.querySelectorAll('.tunnel-card')).find(c => c.innerText.includes(n));
      card.querySelector('button[data-action="delete"]').click();
    }, TUNNEL.name);
    await page.waitForFunction(n => !Array.from(document.querySelectorAll('.tunnel-card')).some(c => c.innerText.includes(n)), { timeout: 8000 }, TUNNEL.name);
    await page.screenshot({ path: path.join(ART, '09-password-deleted.png'), fullPage: true });

    console.log('PASSWORD_FLOW_OK');
  } catch (err) {
    try { await page.screenshot({ path: path.join(ART, '99-pwd-failure.png'), fullPage: true }); } catch {}
    throw err;
  } finally {
    await browser.close();
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error('PASSWORD_FLOW_FAILED:', err.message);
  process.exit(1);
});

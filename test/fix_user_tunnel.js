'use strict';
// One-off: fix the user's saved "Aizan" tunnel to match their terminal command
//   ssh -L 6443:localhost:6443 root@10.200.10.194
// (their saved profile pointed SSH at 127.0.0.1 with user ecosmob, both wrong),
// then start it via the UI and verify the local port from the host namespace.
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ART = path.join(__dirname, 'artifacts');
const NAME = 'Aizan';
const LOCAL_PORT = 6443;
const FIXED = {
  ssh_host: '10.200.10.194',
  ssh_port: '22',
  ssh_user: 'root',
  key_file: 'id_rsa',
  local_host: '127.0.0.1',
  local_port: '6443',
  remote_host: 'localhost',
  remote_port: '6443',
};

function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const env = readEnv(path.join(ROOT, '.env'));
const BASE = `http://127.0.0.1:${env.APP_PORT || '9999'}`;
const step = m => console.log(`[fix] ${m}`);

async function main() {
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1400, 950'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 950 });
  page.on('response', r => { if (r.url().includes('/api/')) console.log(`[net] ${r.status()} ${r.url()}`); });

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#loginView:not(.hidden)');
    const setField = (sel, value) => page.$eval(sel, (el, v) => { el.value = v; }, value);

    step('sign in');
    await setField('#loginForm input[name="username"]', env.ADMIN_USERNAME || 'admin');
    await setField('#loginForm input[name="password"]', env.ADMIN_PASSWORD);
    await page.click('#loginForm button[type="submit"]');
    await page.waitForFunction(() => !document.getElementById('appView').classList.contains('hidden'), { timeout: 8000 });

    step('open the Aizan profile for editing');
    await page.waitForFunction(n => document.body.innerText.includes(n), { timeout: 8000 }, NAME);
    await page.evaluate(n => {
      const card = Array.from(document.querySelectorAll('.tunnel-card')).find(c => c.innerText.includes(n));
      card.querySelector('button[data-action="edit"]').click();
    }, NAME);
    await page.waitForSelector('#tunnelDialog[open]');

    step('correct fields to match: ssh -L 6443:localhost:6443 root@10.200.10.194');
    for (const [key, value] of Object.entries(FIXED)) {
      await setField(`#tunnelForm [name="${key}"]`, value);
    }
    await page.click('#tunnelForm button[type="submit"]');
    try {
      await page.waitForFunction(() => !document.getElementById('tunnelDialog').open, { timeout: 8000 });
    } catch {
      const err = await page.$eval('#formError', el => el.textContent);
      throw new Error(`edit save rejected: ${err}`);
    }
    await page.screenshot({ path: path.join(ART, '05-user-tunnel-edited.png'), fullPage: true });

    step('start the tunnel');
    await page.evaluate(n => {
      const card = Array.from(document.querySelectorAll('.tunnel-card')).find(c => c.innerText.includes(n));
      card.querySelector('button[data-action="start"]').click();
    }, NAME);
    await page.waitForFunction(n => {
      const card = Array.from(document.querySelectorAll('.tunnel-card')).find(c => c.innerText.includes(n));
      const b = card && card.querySelector('.badge');
      return b && b.textContent.trim() === 'running';
    }, { timeout: 30000 }, NAME);

    const ss = execSync(`ss -ltn | grep -E ':${LOCAL_PORT}\\s' || true`).toString().trim();
    if (!ss) throw new Error(`port ${LOCAL_PORT} not listening on host`);
    console.log(`[host] ss says port ${LOCAL_PORT} is LISTENING`);

    for (const probe of [
      `curl -sk --max-time 5 -o /dev/null -w '%{http_code}' https://127.0.0.1:${LOCAL_PORT}/version || true`,
      `curl -sk --max-time 5 -o /dev/null -w '%{http_code}' https://127.0.0.1:${LOCAL_PORT}/ || true`,
      `curl -s --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:${LOCAL_PORT}/ || true`,
    ]) {
      const out = execSync(probe).toString();
      console.log(`[host] probe -> HTTP ${out.trim()} (${probe.split(' ')[3] || ''})`);
    }

    await page.screenshot({ path: path.join(ART, '06-user-tunnel-running.png'), fullPage: true });
    console.log('USER_TUNNEL_OK (left running)');
  } catch (err) {
    try { await page.screenshot({ path: path.join(ART, '99-user-tunnel-failure.png'), fullPage: true }); } catch {}
    throw err;
  } finally {
    await browser.close();
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error('USER_TUNNEL_FAILED:', err.message);
  process.exit(1);
});

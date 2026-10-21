'use strict';
let csrf = null;
let tunnels = [];
const $ = id => document.getElementById(id);
const api = async (url, options = {}) => {
  const headers = { ...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.method && options.method !== 'GET' ? {'X-CSRF-Token':csrf || ''} : {}), ...(options.headers || {}) };
  const response = await fetch(url, { credentials:'same-origin', ...options, headers });
  let data = {};
  try { data = await response.json(); } catch {}
  if (response.status === 401 && url !== '/api/login') showLogin();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
};
function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  setTimeout(() => $('toast').classList.remove('show'), 3000);
}
function showLogin() {
  $('loginView').classList.remove('hidden');
  $('appView').classList.add('hidden');
}
function showApp(username) {
  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('usernameLabel').textContent = username || 'admin';
  loadTunnels();
}
async function bootstrap() {
  try {
    const s = await api('/api/session');
    csrf = s.csrf;
    if (s.authenticated) showApp(s.username); else showLogin();
  } catch { showLogin(); }
}
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault(); $('loginError').textContent = '';
  const formEl = e.currentTarget;
  const form = new FormData(formEl);
  try {
    const result = await api('/api/login', {method:'POST', body:JSON.stringify({username:form.get('username'),password:form.get('password')})});
    csrf = result.csrf;
    formEl.reset();
    showApp(result.username);
  } catch(err) { $('loginError').textContent = err.message; }
});
$('logoutBtn').addEventListener('click', async () => {
  try { await api('/api/logout', {method:'POST',body:'{}'}); csrf=null; showLogin(); }
  catch(e) { toast(e.message); }
});
document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => {
  const page = button.dataset.page;
  document.querySelectorAll('[data-page]').forEach(b => b.classList.toggle('selected', b === button));
  $('tunnelsPage').classList.toggle('hidden', page !== 'tunnels');
  $('activityPage').classList.toggle('hidden', page !== 'activity');
  $('pageTitle').textContent = page === 'tunnels' ? 'Tunnels' : 'Activity logs';
  if (page === 'activity') loadLogs();
}));
$('addBtn').addEventListener('click', () => openDialog());
$('emptyAddBtn').addEventListener('click', () => openDialog());
$('closeDialog').addEventListener('click', () => $('tunnelDialog').close());
$('cancelDialog').addEventListener('click', () => $('tunnelDialog').close());
$('searchInput').addEventListener('input', renderTunnels);
$('refreshLogsBtn').addEventListener('click', loadLogs);

function openDialog(tunnel = null) {
  const form = $('tunnelForm');
  form.reset();
  $('formError').textContent = '';
  $('dialogTitle').textContent = tunnel ? 'Edit tunnel' : 'Add tunnel';
  const values = tunnel || {ssh_port:22,local_host:'127.0.0.1'};
  for (const [key,value] of Object.entries(values)) {
    if (form.elements[key]) form.elements[key].value = value ?? '';
  }
  form.elements.id.value = tunnel?.id || '';
  form.elements.ssh_password.placeholder = tunnel && tunnel.hasPassword ? 'Leave blank to keep saved password' : 'Required';
  syncAuthFields(form);
  $('tunnelDialog').showModal();
}
function syncAuthFields(form) {
  const isPassword = form.elements.auth_method.value === 'password';
  $('keyFileField').classList.toggle('hidden', isPassword);
  $('passwordField').classList.toggle('hidden', !isPassword);
  $('keyHint').classList.toggle('hidden', isPassword);
  $('passwordHint').classList.toggle('hidden', !isPassword);
  // Disabled inputs are omitted from FormData, so only the chosen secret is sent.
  form.elements.key_file.disabled = isPassword;
  form.elements.ssh_password.disabled = !isPassword;
}
$('tunnelForm').addEventListener('change', e => {
  if (e.target.name === 'auth_method') syncAuthFields(e.target.form);
});
$('tunnelForm').addEventListener('submit', async e => {
  e.preventDefault(); $('formError').textContent = '';
  const form = e.currentTarget;
  const values = Object.fromEntries(new FormData(form).entries());
  const id = values.id; delete values.id;
  ['ssh_port','local_port','remote_port'].forEach(k => values[k] = Number(values[k]));
  try {
    await api(id ? `/api/tunnels/${encodeURIComponent(id)}` : '/api/tunnels', {
      method:id ? 'PUT' : 'POST', body:JSON.stringify(values)
    });
    $('tunnelDialog').close(); toast(id ? 'Tunnel updated' : 'Tunnel created'); await loadTunnels();
  } catch(err) { $('formError').textContent = err.message; }
});
async function loadTunnels() {
  try { tunnels = await api('/api/tunnels'); renderTunnels(); }
  catch(e) { toast(e.message); }
}
function renderTunnels() {
  const query = $('searchInput').value.toLowerCase().trim();
  const filtered = tunnels.filter(t => [t.name,t.ssh_host,t.remote_host].join(' ').toLowerCase().includes(query));
  $('totalCount').textContent = tunnels.length;
  $('activeCount').textContent = tunnels.filter(t => t.status === 'running' || t.status === 'starting').length;
  $('stoppedCount').textContent = tunnels.filter(t => t.status === 'stopped').length;
  $('emptyState').classList.toggle('hidden', tunnels.length > 0);
  $('tunnelList').innerHTML = filtered.map(t => {
    const running = t.status === 'running' || t.status === 'starting' || t.status === 'stopping';
    const status = running ? t.status : 'stopped';
    return `<article class="tunnel-card">
      <div class="tunnel-main"><div class="tunnel-icon">${escapeHtml(t.name.slice(0,2).toUpperCase())}</div>
        <div style="min-width:0"><div class="tunnel-title-row"><span class="tunnel-title">${escapeHtml(t.name)}</span><span class="badge ${status}">${escapeHtml(status)}</span></div>
        <div class="route"><b>${escapeHtml(t.local_host)}:${t.local_port}</b> <span>forwards to</span> <b>${escapeHtml(t.remote_host)}:${t.remote_port}</b></div>
        <div class="subroute">via ${escapeHtml(t.ssh_user)}@${escapeHtml(t.ssh_host)}:${t.ssh_port} &middot; ${t.auth_method === 'password' ? 'password auth' : 'key auth'}</div></div>
      </div>
      <div class="actions">
        ${running ? `<button class="secondary" data-action="stop" data-id="${t.id}">Stop</button>` : `<button class="primary" data-action="start" data-id="${t.id}">Start tunnel</button>`}
        <button class="icon-btn" data-action="edit" data-id="${t.id}">Edit</button>
        <button class="icon-btn" data-action="delete" data-id="${t.id}">Delete</button>
      </div></article>`;
  }).join('');
  if (!filtered.length && tunnels.length) $('tunnelList').innerHTML = '<div class="empty-logs">No tunnels match your search.</div>';
  $('tunnelList').querySelectorAll('button[data-action]').forEach(button => button.addEventListener('click', () => tunnelAction(button.dataset.action, button.dataset.id)));
}
async function tunnelAction(action,id) {
  const t = tunnels.find(x => x.id === id);
  if (!t) return;
  try {
    if (action === 'edit') { openDialog(t); return; }
    if (action === 'delete') {
      if (!confirm(`Delete tunnel "${t.name}"?`)) return;
      await api(`/api/tunnels/${id}`, {method:'DELETE'});
      toast('Tunnel deleted');
    } else {
      await api(`/api/tunnels/${id}/${action}`, {method:'POST',body:'{}'});
      toast(action === 'start' ? 'Tunnel start requested' : 'Tunnel stop requested');
    }
    await loadTunnels();
  } catch(e) { toast(e.message); }
}
async function loadLogs() {
  try {
    const logs = await api('/api/logs');
    $('logList').innerHTML = logs.length ? logs.map(l => `<div class="log-row"><span class="log-time">${escapeHtml(new Date(l.time).toLocaleString())}</span><span class="log-level ${escapeHtml(l.level)}">${escapeHtml(l.level)}</span><span class="log-message">${escapeHtml(l.message)}</span></div>`).join('') : '<div class="empty-logs">No activity recorded yet.</div>';
  } catch(e) { toast(e.message); }
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
setInterval(() => {
  if (!$('appView').classList.contains('hidden')) {
    loadTunnels();
    if (!$('activityPage').classList.contains('hidden')) loadLogs();
  }
}, 5000);
bootstrap();

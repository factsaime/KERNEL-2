const $ = (id) => document.getElementById(id);
const THEMES = {
  green: ['#24E56E', '#0A6B2C'], white: ['#E8E8E8', '#6B6B6B'], red: ['#FA3131', '#840A0A'],
  blue: ['#2B2BE8', '#0B0B7A'], purple: ['#8A1CD6', '#3F0A70'], yellow: ['#F2D90A', '#7A6A00'],
};
let me = null, peer = null, lastId = 0, registerMode = false, timers = [], tab = 'chats';

async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'kernel' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'error'), { status: r.status });
  return data;
}
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const av = (name, cls = '') => el('span', 'avatar ' + cls, name.slice(0, 2));
const fmt = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/* ---------- theme ---------- */
function applyTheme(name) {
  const [a, b] = THEMES[name] || THEMES.red;
  document.documentElement.style.setProperty('--a', a);
  document.documentElement.style.setProperty('--b', b);
  try { localStorage.setItem('kernel-theme', name); } catch {}
  document.querySelectorAll('.theme').forEach((t) => t.classList.toggle('sel', t.dataset.t === name));
}
Object.entries(THEMES).forEach(([name, [a, b]]) => {
  const t = el('button', 'theme', 'The ' + name);
  t.dataset.t = name; t.style.setProperty('--ta', a); t.style.setProperty('--tb', b);
  t.onclick = () => applyTheme(name);
  $('themes').append(t);
});
let saved = 'red'; try { saved = localStorage.getItem('kernel-theme') || 'red'; } catch {}
applyTheme(saved);

/* ---------- auth ---------- */
function showAuth() {
  timers.forEach(clearInterval); timers = []; me = peer = null;
  document.body.classList.remove('in-app');
  $('app').classList.add('hidden'); $('auth').classList.remove('hidden');
}
$('a-toggle').onclick = () => {
  registerMode = !registerMode;
  $('a-title').textContent = registerMode ? 'Registration' : 'Login';
  $('a-sub').textContent = registerMode ? 'or login' : 'or register';
  $('a-submit').textContent = registerMode ? 'Registration' : 'Login';
  $('a-toggle').textContent = registerMode ? 'or login' : 'or registration';
  $('a-pass').autocomplete = registerMode ? 'new-password' : 'current-password';
  $('a-err').textContent = '';
};
$('auth-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api(registerMode ? '/register' : '/login', 'POST', { username: $('a-user').value, password: $('a-pass').value });
    $('a-pass').value = ''; start();
  } catch (err) { $('a-err').textContent = err.message; }
};

/* ---------- shell / tabs ---------- */
async function start() {
  try { me = await api('/me'); } catch { return showAuth(); }
  $('auth').classList.add('hidden'); $('app').classList.remove('hidden');
  document.body.classList.add('in-app');
  setTab('chats', false);
  loadList();
  timers.push(setInterval(loadList, 4000), setInterval(poll, 1500));
}

function setTab(name, enterMain = true) {
  tab = name;
  document.querySelectorAll('nav .pill').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  ['chat', 'profile', 'settings'].forEach((v) => $(v).classList.toggle('hidden', v !== (name === 'chats' ? 'chat' : name)));
  if (name === 'profile') renderProfile();
  if (enterMain && name !== 'chats') $('app').classList.add('in-main');
  if (name === 'chats' && !peer) $('app').classList.remove('in-main');
}
document.querySelectorAll('nav .pill').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
document.querySelectorAll('.back').forEach((b) => (b.onclick = () => { $('app').classList.remove('in-main'); if (tab === 'chats') peer = null; loadList(); }));

/* ---------- chat list ---------- */
async function loadList() {
  const q = $('search').value.trim();
  try {
    const list = $('list'); const next = document.createDocumentFragment();
    const add = (u, last) => {
      const row = el('div', 'chat-row' + (peer && peer.id === u.id ? ' active' : ''));
      const t = el('div', 't'); t.append(el('b', null, u.username));
      if (last) t.append(el('span', null, (last.sender_id === me.id ? 'you: ' : '') + last.body));
      row.append(av(u.username), t);
      row.onclick = () => openChat(u);
      next.append(row);
    };
    if (q) {
      const users = await api('/users?q=' + encodeURIComponent(q));
      next.append(el('div', 'sect', 'USERS'));
      users.forEach((u) => add(u));
      if (!users.length) next.append(el('div', 'sect', 'nobody found'));
    } else {
      const chats = await api('/chats');
      if (!chats.length) next.append(el('div', 'sect', 'no chats yet — find a user'));
      chats.forEach((c) => add({ id: c.id, username: c.username }, c));
    }
    list.replaceChildren(next);
  } catch (err) { if (err.status === 401) showAuth(); }
}
$('search').oninput = loadList;

async function openChat(u) {
  peer = u; lastId = 0;
  setTab('chats', false);
  $('peer-name').textContent = u.username;
  $('peer-av').textContent = u.username.slice(0, 2);
  $('msgs').replaceChildren(); $('send').classList.remove('hidden');
  $('app').classList.add('in-main');
  $('search').value = '';
  await poll(); loadList(); $('text').focus();
}

async function poll() {
  if (!peer) return;
  const target = peer;
  try {
    const rows = await api(`/messages/${target.id}?after=${lastId}`);
    if (peer !== target || !rows.length) return;
    const box = $('msgs');
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60 || lastId === 0;
    rows.forEach((m) => {
      const d = el('div', 'm' + (m.sender_id === me.id ? ' me' : ''));
      d.append(el('span', null, m.body), el('time', null, fmt(m.created_at)));
      box.append(d); lastId = m.id;
    });
    if (stick) box.scrollTop = box.scrollHeight;
  } catch (err) { if (err.status === 401) showAuth(); }
}

$('send').onsubmit = async (e) => {
  e.preventDefault();
  const body = $('text').value.trim();
  if (!body || !peer) return;
  $('text').value = '';
  try { await api('/messages/' + peer.id, 'POST', { body }); await poll(); loadList(); }
  catch { $('text').value = body; }
};

/* ---------- profile ---------- */
function renderProfile(editing = false) {
  $('p-av').textContent = me.username.slice(0, 2);
  $('p-handle').textContent = '@' + me.username;
  const box = $('p-info'); box.replaceChildren();
  if (editing) {
    const f = el('div', 'edit');
    const about = el('input'); about.placeholder = 'about me'; about.value = me.about; about.maxLength = 200;
    const addr = el('input'); addr.placeholder = 'address'; addr.value = me.address; addr.maxLength = 100;
    const save = el('button', null, 'save');
    save.onclick = async () => {
      await api('/profile', 'POST', { about: about.value, address: addr.value });
      me = await api('/me'); renderProfile();
    };
    f.append(about, addr, save); box.append(f);
    return;
  }
  const num = '+888 ' + String(me.id).padStart(4, '0') + '-' + String(me.id * 7919 % 100).padStart(2, '0') + ' (anonymous number)';
  [['Number', num], ['About me', me.about || 'not specified'], ['Address', me.address || 'not specified'], ['ID', '#' + me.id]]
    .forEach(([k, v]) => box.append(el('div', null, `${k}: ${v}`)));
}
$('p-edit').onclick = () => renderProfile(true);
$('p-settings').onclick = () => setTab('settings');

/* ---------- settings ---------- */
const sMsg = (t) => { $('s-msg').textContent = t; };
document.querySelectorAll('.row-item').forEach((r) => (r.onclick = () => {
  const p = $('sp-' + r.dataset.open); const open = p.classList.contains('hidden');
  document.querySelectorAll('.sub-panel').forEach((x) => x.classList.add('hidden'));
  p.classList.toggle('hidden', !open); sMsg('');
}));
$('s-pass').onclick = async () => {
  try {
    await api('/settings/password', 'POST', { old: $('s-old').value, new: $('s-new').value });
    $('s-old').value = $('s-new').value = ''; sMsg('password changed');
  } catch (err) { sMsg(err.message); }
};
$('s-clear').onclick = async () => {
  if (!confirm('delete all your chats?')) return;
  await api('/settings/clear', 'POST', {});
  $('msgs').replaceChildren(); lastId = 0; loadList(); sMsg('history deleted');
};
$('s-logout').onclick = async () => { await api('/logout', 'POST', {}).catch(() => {}); showAuth(); };

start();

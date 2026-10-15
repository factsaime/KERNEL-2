const $ = (id) => document.getElementById(id);
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

/* ---------- theme (picker + builder live in themes-ui.js) ---------- */
function applyTheme(id) {
  if (window.kernelThemes && typeof window.kernelThemes.apply === 'function') {
    window.kernelThemes.apply(id);
  }
}

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
  if (window.kernelThemes && typeof window.kernelThemes.pull === 'function') {
    window.kernelThemes.pull().then(() => window.kernelThemes.render());
  }
  if (me.theme) applyTheme(me.theme);
  timers.push(setInterval(loadList, 4000), setInterval(poll, 1500));
}

// Replay the entry animation. Clearing the classes, forcing a reflow and
// re-adding is what makes the browser restart it rather than ignore an
// unchanged class list.
function animateView(el) {
  if (!el) return;
  el.classList.remove('anim-in', 'anim-out');
  void el.offsetWidth;
  el.classList.add('anim-in');
  el.addEventListener('animationend', (e) => {
    if (e.target === el) el.classList.remove('anim-in');
  }, { once: true });
}

// Switch views with a single animation. The outgoing view is stripped of its
// animation class at once, so exactly one animation ever runs per switch.
function swapView(from, to) {
  if (from && from !== to) from.classList.remove('anim-in', 'anim-out');
  animateView(to);
}

function setTab(name, enterMain = true) {
  const next = name === 'chats' ? 'chat' : name;
  const target = $(next);
  // Capture the view currently on screen before the swap hides it.
  const leaving = [...document.querySelectorAll('.view')].find((v) => v !== target && !v.classList.contains('hidden')) || null;

  tab = name;

  document.querySelectorAll('nav .pill').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  ['chat', 'profile', 'settings'].forEach((v) => $(v).classList.toggle('hidden', v !== next));

  if (name === 'profile') renderProfile();
  // Re-pull custom themes whenever settings is opened, so the grid reflects
  // the account instead of a stale first load.
  if (name === 'settings' && window.kernelThemes) {
    window.kernelThemes.pull().then(() => window.kernelThemes.render());
  }
  // Sidebar tabs (Profile/Settings) always open the main pane; the Chats tab
  // only does so once a conversation is actually selected.
  if (name === 'chats') {
    if (!peer) $('app').classList.remove('in-main');
  } else if (enterMain) {
    $('app').classList.add('in-main');
  }

  // One animation per switch: the outgoing view is cleared at once and the
  // incoming one fades in. Chaining an erase-out first made the motion read
  // as if it played twice.
  swapView(leaving, target);
}
document.querySelectorAll('nav .pill').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

// The back arrow leaves the main pane and returns to the chat list; it plays
// the same single transition as a tab switch.
document.querySelectorAll('.back').forEach((b) => (b.onclick = () => {
  const onScreen = [...document.querySelectorAll('.view')].find((v) => !v.classList.contains('hidden')) || null;
  $('app').classList.remove('in-main');
  if (tab === 'chats') peer = null;

  const target = tab === 'chats' ? $('chat') : $(tab === 'profile' ? 'profile' : 'settings');
  swapView(onScreen, target);
  loadList();
}));

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

// Accordion: exactly one section open at a time, and clicking an open
// section closes it. Rows are matched to their own panel only.
document.querySelectorAll('.row-item').forEach((r) => {
  r.onclick = () => {
    const panel = r.dataset.open ? $('sp-' + r.dataset.open) : null;
    if (!panel) return;
    const wasOpen = !panel.classList.contains('hidden');
    document.querySelectorAll('.sub-panel').forEach((x) => x.classList.add('hidden'));
    if (!wasOpen) panel.classList.remove('hidden');
    sMsg('');
  };
});
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

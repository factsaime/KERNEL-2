const $ = (id) => document.getElementById(id);
let me = null, peer = null, lastId = 0, registerMode = false, timers = [];

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
const fmt = (s) => { const d = new Date(s.replace(' ', 'T') + 'Z'); return d.toLocaleString([], { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }); };

/* ---------- auth ---------- */
function showAuth() {
  timers.forEach(clearInterval); timers = []; me = peer = null;
  $('app').classList.add('hidden'); $('auth').classList.remove('hidden');
}
$('a-toggle').onclick = () => {
  registerMode = !registerMode;
  $('a-submit').textContent = registerMode ? 'register' : 'enter';
  $('a-toggle').textContent = registerMode ? 'have account? login' : 'no account? register';
  $('a-err').textContent = '';
};
$('auth-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api(registerMode ? '/register' : '/login', 'POST', { username: $('a-user').value, password: $('a-pass').value });
    $('a-pass').value = ''; start();
  } catch (err) { $('a-err').textContent = err.message; }
};

/* ---------- app ---------- */
async function start() {
  try { me = await api('/me'); } catch { return showAuth(); }
  $('auth').classList.add('hidden'); $('app').classList.remove('hidden');
  $('me-name').textContent = '@' + me.username;
  $('s-name').textContent = '@' + me.username;
  loadList();
  timers.push(setInterval(loadList, 4000), setInterval(poll, 1500));
}

async function loadList() {
  const q = $('search').value.trim();
  try {
    const chats = await api('/chats');
    const list = $('list'); list.replaceChildren();
    const add = (u, last) => {
      const it = el('div', 'item' + (peer && peer.id === u.id ? ' active' : ''));
      it.append(el('b', null, u.username));
      if (last) it.append(el('div', 'last', (last.sender_id === me.id ? 'you: ' : '') + last.body));
      it.onclick = () => openChat(u);
      list.append(it);
    };
    if (q) {
      const users = await api('/users?q=' + encodeURIComponent(q));
      list.append(el('div', 'sect', 'USERS'));
      users.forEach((u) => add(u));
      if (!users.length) list.append(el('div', 'sect', 'nobody found'));
    } else {
      if (!chats.length) list.append(el('div', 'sect', 'no chats yet — search a user'));
      chats.forEach((c) => add({ id: c.id, username: c.username }, c));
    }
  } catch (err) { if (err.status === 401) showAuth(); }
}
$('search').oninput = loadList;

async function openChat(u) {
  peer = u; lastId = 0;
  $('peer-name').textContent = u.username;
  $('msgs').replaceChildren(); $('send').classList.remove('hidden');
  $('app').classList.add('in-chat');
  $('search').value = '';
  await poll(); loadList(); $('text').focus();
}
$('btn-back').onclick = () => { $('app').classList.remove('in-chat'); peer = null; loadList(); };

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
  catch (err) { $('text').value = body; }
};

/* ---------- settings ---------- */
const sMsg = (t) => { $('s-msg').textContent = t; };
$('btn-settings').onclick = () => { sMsg(''); $('modal').classList.remove('hidden'); };
$('s-close').onclick = () => $('modal').classList.add('hidden');
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
$('s-logout').onclick = async () => {
  await api('/logout', 'POST', {}).catch(() => {});
  $('modal').classList.add('hidden'); showAuth();
};

start();

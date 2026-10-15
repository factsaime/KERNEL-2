const $ = (id) => document.getElementById(id);
const KC = window.KernelCrypto;

let me = null, peer = null, lastId = 0, registerMode = false, timers = [], tab = 'chats';
let myPriv = null;                       // ECDH private key, only in memory
const convKeys = new Map();              // peerId -> AES-GCM conversation key
const rendered = new Map();              // messageId -> { el, reacts, mine }
const REACTIONS = ['👍', '❤️', '😂', '🔥', '😮', '😢', '🐱', '🐋'];

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

/* ---------- crypto plumbing ---------- */
const convSalt = (a, b) => [Math.min(a, b), Math.max(a, b)].join('-');

// One AES-GCM key per conversation, derived from ECDH + both user ids.
async function convKeyFor(peerId, peerPub) {
  if (convKeys.has(peerId)) return convKeys.get(peerId);
  if (!myPriv || !peerPub) return null;
  try {
    const key = await KC.conversationKey(myPriv, peerPub, convSalt(me.id, peerId));
    convKeys.set(peerId, key);
    return key;
  } catch { return null; }
}

// Wrap the private key under a key derived from the password, then register or
// upgrade the account. This is the only moment the password is in memory.
async function adoptIdentity(password, mode) {
  const salt = KC.randomSalt();
  const iterations = KC.ITERATIONS;
  const { authHash, kek } = await KC.fromPassword(password, salt, iterations);
  const id = await KC.newIdentity();
  const wrap = await KC.wrapPrivate(id.pair, kek);
  const payload = { authHash, salt, iterations, pubkey: id.pubkey, ...wrap };
  if (mode === 'register') await api('/register', 'POST', { username: $('a-user').value.trim(), ...payload });
  else await api('/crypto/setup', 'POST', payload);
  myPriv = id.pair.privateKey;
}

async function loginWith(username, password) {
  const params = await api('/auth/params?username=' + encodeURIComponent(username));

  if (params.scheme === 'derived') {
    const { authHash, kek } = await KC.fromPassword(password, params.salt, params.iterations);
    const res = await api('/login', 'POST', { username, authHash });
    const km = await api('/crypto/key');
    if (km.wrappedPriv) {
      try { myPriv = await KC.unwrapPrivate(km.wrappedPriv, km.wrapIv, kek); }
      catch { myPriv = null; }          // keys exist but this password cannot open them
    }
    if (res.needsCryptoUpgrade || !myPriv) {
      await api('/logout', 'POST', {}).catch(() => {});
      await api('/login', 'POST', { username, password }).catch(() => {});
      await adoptIdentity(password, 'setup');
    }
    return res;
  }

  // Legacy account: the password reaches the server one last time, then the
  // account is switched to the derived scheme.
  const res = await api('/login', 'POST', { username, password });
  if (res.needsCryptoUpgrade) await adoptIdentity(password, 'setup');
  return res;
}

/* ---------- auth ---------- */
function showAuth() {
  timers.forEach(clearInterval); timers = []; me = peer = null;
  myPriv = null; convKeys.clear(); rendered.clear();
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
  const user = $('a-user').value.trim(), pass = $('a-pass').value;
  if (!KC || !KC.available()) {
    $('a-err').textContent = 'шифрование недоступно: нужен HTTPS или localhost';
    return;
  }
  $('a-submit').disabled = true;
  try {
    if (registerMode) await adoptIdentity(pass, 'register');
    else await loginWith(user, pass);
    $('a-pass').value = ''; start();
  } catch (err) {
    $('a-err').textContent = err.message;
  } finally {
    $('a-submit').disabled = false;
  }
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
  const leaving = [...document.querySelectorAll('.view')].find((v) => v !== target && !v.classList.contains('hidden')) || null;

  tab = name;

  document.querySelectorAll('nav .pill').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  ['chat', 'profile', 'settings'].forEach((v) => $(v).classList.toggle('hidden', v !== next));

  if (name === 'profile') renderProfile();
  if (name === 'settings' && window.kernelThemes) {
    window.kernelThemes.pull().then(() => window.kernelThemes.render());
  }
  if (name === 'chats') {
    if (!peer) $('app').classList.remove('in-main');
  } else if (enterMain) {
    $('app').classList.add('in-main');
  }

  swapView(leaving, target);
}
document.querySelectorAll('nav .pill').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

document.querySelectorAll('.back').forEach((b) => (b.onclick = () => {
  const onScreen = [...document.querySelectorAll('.view')].find((v) => !v.classList.contains('hidden')) || null;
  $('app').classList.remove('in-main');
  if (tab === 'chats') peer = null;

  const target = tab === 'chats' ? $('chat') : $(tab === 'profile' ? 'profile' : 'settings');
  swapView(onScreen, target);
  loadList();
}));

/* ---------- chat list ---------- */
async function previewText(chat) {
  if (chat.legacy) return chat.body || '';
  const key = await convKeyFor(chat.id, chat.pubkey);
  if (!key) return '···';
  const text = await KC.decryptText(key, chat.body_ct, chat.body_iv);
  return text === null ? 'не удалось расшифровать' : text;
}

async function loadList() {
  const q = $('search').value.trim();
  try {
    const list = $('list'); const next = document.createDocumentFragment();
    const add = (u, last) => {
      const row = el('div', 'chat-row' + (peer && peer.id === u.id ? ' active' : ''));
      const t = el('div', 't'); t.append(el('b', null, u.username));
      const line = el('span', null, '');
      t.append(line);
      row.append(av(u.username), t);
      row.onclick = () => openChat(u);
      next.append(row);
      return { line, last };
    };
    const pending = [];
    if (q) {
      const users = await api('/users?q=' + encodeURIComponent(q));
      next.append(el('div', 'sect', 'USERS'));
      users.forEach((u) => pending.push(add(u)));
      if (!users.length) next.append(el('div', 'sect', 'nobody found'));
    } else {
      const chats = await api('/chats');
      if (!chats.length) next.append(el('div', 'sect', 'no chats yet — find a user'));
      chats.forEach((c) => pending.push(add({ id: c.id, username: c.username }, c)));
    }
    list.replaceChildren(next);

    // Previews are decrypted after the rows are on screen so scrolling stays smooth.
    await Promise.all(pending.map(async ({ line, last }) => {
      if (!last) return;
      const text = await previewText({ ...last, id: last.id });
      line.textContent = (last.sender_id === me.id ? 'you: ' : '') + text;
    }));
  } catch (err) { if (err.status === 401) showAuth(); }
}
$('search').oninput = loadList;

async function openChat(u) {
  peer = u; lastId = 0;
  rendered.clear();
  setTab('chats', false);
  $('peer-name').textContent = u.username;
  $('peer-av').textContent = u.username.slice(0, 2);
  $('msgs').replaceChildren(); $('send').classList.remove('hidden');
  $('app').classList.add('in-main');
  $('search').value = '';
  await poll(); loadList(); $('text').focus();
}

/* ---------- messages ---------- */
function messageEl(m, text) {
  const d = el('div', 'm' + (m.sender_id === me.id ? ' me' : ''));
  d.append(el('span', 'm-body', text));
  d.append(el('time', null, fmt(m.created_at)));
  const reacts = el('div', 'm-reacts');
  d.append(reacts);
  return { el: d, reacts };
}

async function poll() {
  if (!peer) return;
  const target = peer;
  try {
    const data = await api(`/messages/${target.id}?after=${lastId}`);
    const rows = data.messages || [];
    if (peer !== target) return;
    if (data.pubkey && !convKeys.has(target.id)) await convKeyFor(target.id, data.pubkey);
    if (!rows.length) return;

    const key = convKeys.get(target.id) || null;
    const box = $('msgs');
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60 || lastId === 0;
    const legacy = [];

    for (const m of rows) {
      let text;
      if (m.legacy) { text = m.body || ''; legacy.push(m); }
      else text = (await KC.decryptText(key, m.ct, m.iv)) ?? '⚠ не удалось расшифровать';
      const { el: node, reacts } = messageEl(m, text);
      box.append(node);
      rendered.set(m.id, { el: node, reacts });
      lastId = m.id;
    }
    if (stick) box.scrollTop = box.scrollHeight;

    const ids = rows.map((m) => m.id);
    refreshReactions(ids);
    if (legacy.length) reencryptLegacy(legacy, key);
  } catch (err) { if (err.status === 401) showAuth(); }
}

// Old rows were stored in the clear. Re-encrypt them in place the first time a
// participant opens the thread, so the database stops holding plaintext.
async function reencryptLegacy(rows, key) {
  if (!key) return;
  const items = [];
  for (const m of rows) {
    const env = await KC.encryptText(key, m.body || '');
    items.push({ id: m.id, ...env });
  }
  try { await api('/messages/reencrypt', 'POST', { items }); } catch {}
}

$('send').onsubmit = async (e) => {
  e.preventDefault();
  const body = $('text').value.trim();
  if (!body || !peer) return;
  const key = convKeys.get(peer.id);
  if (!key) { $('text').value = body; return; }
  $('text').value = '';
  try {
    const env = await KC.encryptText(key, body);
    await api('/messages/' + peer.id, 'POST', env);
    await poll(); loadList();
  } catch { $('text').value = body; }
};

/* ---------- reactions ---------- */
async function refreshReactions(ids) {
  if (!ids.length || !peer) return;
  let rows;
  try { rows = await api('/reactions?ids=' + ids.join(',')); } catch { return; }
  const key = convKeys.get(peer.id);
  if (!key) return;

  const byMessage = new Map();
  for (const r of rows) {
    const emoji = await KC.decryptText(key, r.emoji_ct, r.emoji_iv);
    if (emoji === null) continue;
    if (!byMessage.has(r.message_id)) byMessage.set(r.message_id, []);
    byMessage.get(r.message_id).push({ userId: r.user_id, emoji });
  }
  for (const [mid, list] of byMessage) renderReacts(mid, list);
  for (const mid of ids) if (!byMessage.has(mid)) renderReacts(mid, []);
}

function renderReacts(mid, list) {
  const entry = rendered.get(mid);
  if (!entry) return;
  const counts = new Map();
  for (const r of list) {
    const cur = counts.get(r.emoji) || { n: 0, mine: false };
    cur.n += 1;
    if (r.userId === me.id) cur.mine = true;
    counts.set(r.emoji, cur);
  }
  const bar = entry.reacts;
  bar.replaceChildren();
  for (const [emoji, { n, mine }] of counts) {
    const pill = el('button', 'react' + (mine ? ' mine' : ''), emoji + (n > 1 ? ' ' + n : ''));
    pill.type = 'button';
    pill.title = mine ? 'убрать' : 'поставить';
    pill.onclick = () => setReaction(mid, mine ? null : emoji);
    bar.append(pill);
  }
  const add = el('button', 'react-add', '＋');
  add.type = 'button';
  add.title = 'реакция';
  add.onclick = () => togglePicker(mid);
  bar.append(add);
}

function togglePicker(mid) {
  const entry = rendered.get(mid);
  if (!entry) return;
  const existing = entry.el.querySelector('.m-picker');
  if (existing) { existing.remove(); return; }
  document.querySelectorAll('.m-picker').forEach((p) => p.remove());
  const picker = el('div', 'm-picker');
  REACTIONS.forEach((emoji) => {
    const b = el('button', 'pick', emoji);
    b.type = 'button';
    b.onclick = () => setReaction(mid, emoji);
    picker.append(b);
  });
  entry.el.append(picker);
}

async function setReaction(mid, emoji) {
  if (!peer) return;
  const key = convKeys.get(peer.id);
  if (!key) return;
  try {
    if (emoji === null) await api(`/messages/${mid}/reaction`, 'POST', { remove: true });
    else {
      const env = await KC.encryptText(key, emoji);
      await api(`/messages/${mid}/reaction`, 'POST', { emoji_ct: env.ct, emoji_iv: env.iv });
    }
  } catch {}
  document.querySelectorAll('.m-picker').forEach((p) => p.remove());
  refreshReactions([...rendered.keys()]);
}

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
  const enc = me.hasKeys ? 'сквозное шифрование включено' : 'ключей нет';
  [['Number', num], ['About me', me.about || 'not specified'], ['Address', me.address || 'not specified'],
   ['ID', '#' + me.id], ['Encryption', enc]]
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
  const oldPw = $('s-old').value, newPw = $('s-new').value;
  try {
    if (me.auth_scheme === 'derived' && myPriv) {
      // The password wraps the private key, so it has to be re-wrapped here.
      const oldDerived = await KC.fromPassword(oldPw, me.salt, me.iterations);
      const salt = KC.randomSalt();
      const iterations = KC.ITERATIONS;
      const newDerived = await KC.fromPassword(newPw, salt, iterations);
      const km = await api('/crypto/key');
      const priv = await KC.unwrapPrivate(km.wrappedPriv, km.wrapIv, oldDerived.kek);
      const wrap = await KC.wrapPrivate({ privateKey: priv }, newDerived.kek);
      await api('/settings/password', 'POST', {
        oldAuthHash: oldDerived.authHash, newAuthHash: newDerived.authHash, salt, iterations, ...wrap,
      });
    } else {
      await api('/settings/password', 'POST', { old: oldPw, new: newPw });
    }
    $('s-old').value = $('s-new').value = '';
    me = await api('/me');
    sMsg('password changed');
  } catch (err) { sMsg(err.message); }
};

$('s-clear').onclick = async () => {
  if (!confirm('delete all your chats?')) return;
  await api('/settings/clear', 'POST', {});
  $('msgs').replaceChildren(); lastId = 0; rendered.clear(); loadList(); sMsg('history deleted');
};
$('s-logout').onclick = async () => { await api('/logout', 'POST', {}).catch(() => {}); showAuth(); };

if (!KC || !KC.available()) {
  $('a-err').textContent = 'шифрование недоступно: нужен HTTPS или localhost';
}

start();

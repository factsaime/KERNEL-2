/* Kernel — theme picker + custom gradient builder.
   Depends on: window.KERNEL_THEMES (static/themes.js) and the global `api` from app.js. */
(function () {
  const $id = (id) => document.getElementById(id);
  const LIB = window.KERNEL_THEMES || [];
  const MAX_MY = 60;
  const STORE = 'kernel-my-themes';

  const state = {
    type: 'linear',
    angle: 135,
    stops: [{ c: '#5b5bf5', p: 0 }, { c: '#a855f7', p: 50 }, { c: '#ec4899', p: 100 }],
    editing: null,
    filter: 'all',
  };

  let myThemes = [];
  let active = '';

  /* ---------- helpers ---------- */
  const esc = (s) => String(s).replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  const hexOk = (v) => /^#[0-9a-fA-F]{6}$/.test(v);

  function buildCSS() {
    const stops = state.stops
      .slice()
      .sort((a, b) => a.p - b.p)
      .map((s) => `${s.c} ${s.p}%`)
      .join(', ');
    if (state.type === 'radial') return `radial-gradient(circle at 50% 50%, ${stops})`;
    if (state.type === 'conic') return `conic-gradient(from ${state.angle}deg at 50% 50%, ${stops})`;
    return `linear-gradient(${state.angle}deg, ${stops})`;
  }

  const allThemes = () => [...LIB, ...myThemes];

  function findTheme(id) {
    return allThemes().find((t) => t.id === id) || null;
  }

  function toast(msg) {
    let box = document.getElementById('kernel-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'kernel-toast';
      box.setAttribute('role', 'status');
      box.setAttribute('aria-live', 'polite');
      document.body.appendChild(box);
    }
    box.textContent = msg;
    box.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => box.classList.remove('show'), 2600);
  }

  /* ---------- my themes: local cache + account sync ---------- */
  function loadLocal() {
    try {
      const raw = localStorage.getItem(STORE);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function saveLocal(arr) {
    try { localStorage.setItem(STORE, JSON.stringify(arr)); } catch {}
  }

  async function pullThemes() {
    myThemes = loadLocal();
    try {
      const remote = await api('/themes');
      if (Array.isArray(remote)) {
        myThemes = remote;
        saveLocal(remote);
      }
    } catch {}
  }

  async function pushThemes() {
    saveLocal(myThemes);
    try {
      await api('/themes', 'POST', { themes: myThemes });
      return true;
    } catch (err) {
      toast(err.message || 'could not save to account');
      return false;
    }
  }

  /* ---------- applying a theme ---------- */
  function applyTheme(id, persist = true) {
    const t = findTheme(id);
    if (!t) return;
    const root = document.documentElement.style;
    if (t.grad.indexOf('linear-gradient') === 0) {
      // Fast path: the app paints body with a two-stop gradient.
      const stops = t.stops.slice().sort((a, b) => a.p - b.p);
      root.setProperty('--a', stops[0][0]);
      root.setProperty('--b', stops[stops.length - 1][0]);
      root.setProperty('--bg', t.grad);
    } else {
      root.setProperty('--a', t.stops[0][0]);
      root.setProperty('--b', t.stops[t.stops.length - 1][0]);
      root.setProperty('--bg', t.grad);
    }
    root.setProperty('--bg-third', t.stops.length > 2 ? t.stops[1][0] : t.stops[0][0]);
    active = t.id;
    try { localStorage.setItem('kernel-theme', t.id); } catch {}
    markSelected();
  }

  function markSelected() {
    document.querySelectorAll('.theme').forEach((b) =>
      b.classList.toggle('sel', b.dataset.t === active));
    document.querySelectorAll('.theme-fam').forEach((b) =>
      b.classList.toggle('sel', b.dataset.f === state.filter));
  }

  /* ---------- render: family chips ---------- */
  function renderFams() {
    const box = $id('theme-fams');
    if (!box) return;
    const fams = ['all', ...[...new Set(LIB.map((t) => t.fam))], 'mine'];
    box.replaceChildren(...fams.map((f) => {
      const b = document.createElement('button');
      b.className = 'theme-fam' + (state.filter === f ? ' sel' : '');
      b.dataset.f = f;
      b.textContent = f === 'all' ? 'Все' : f === 'mine' ? 'Мои' : f;
      b.onclick = () => { state.filter = f; renderGrid(); markSelected(); };
      return b;
    }));
  }

  /* ---------- render: theme grid ---------- */
  function renderGrid() {
    const box = $id('themes');
    if (!box) return;
    const q = ($id('theme-search')?.value || '').trim().toLowerCase();

    let list = allThemes();
    if (state.filter === 'mine') list = myThemes;
    else if (state.filter !== 'all') list = list.filter((t) => t.fam === state.filter);
    if (q) {
      list = list.filter((t) =>
        t.name.toLowerCase().includes(q) ||
        t.fam.toLowerCase().includes(q) ||
        t.id.includes(q) ||
        t.stops.some(([c]) => c.includes(q)));
    }

    const mineIds = new Set(myThemes.map((t) => t.id));
    const frag = document.createDocumentFragment();

    list.forEach((t) => {
      const b = document.createElement('button');
      b.className = 'theme' + (t.id === active ? ' sel' : '');
      b.dataset.t = t.id;
      b.style.setProperty('--ta', t.stops[0][0]);
      b.style.setProperty('--tb', t.stops[t.stops.length - 1][0]);
      b.style.background = t.grad;
      b.append(document.createTextNode(t.name));
      b.onclick = () => applyTheme(t.id);

      if (mineIds.has(t.id)) {
        b.append(Object.assign(document.createElement('span'), {
          className: 'theme-tag', textContent: 'МОЯ',
        }));
        const del = document.createElement('span');
        del.className = 'theme-del';
        del.textContent = '✕';
        del.title = 'Удалить тему';
        del.onclick = (e) => {
          e.stopPropagation();
          if (!confirm('Удалить тему «' + t.name + '»?')) return;
          myThemes = myThemes.filter((x) => x.id !== t.id);
          pushThemes();
          if (active === t.id) applyTheme('red');
          renderGrid();
        };
        b.append(del);
      }
      frag.append(b);
    });

    if (!list.length) {
      const p = document.createElement('div');
      p.className = 'muted theme-none';
      p.textContent = q ? 'Ничего не найдено' : 'Здесь пока пусто';
      frag.append(p);
    }
    box.replaceChildren(frag);
  }

  /* ---------- builder panel ---------- */
  function openBuilder(theme) {
    const panel = $id('theme-builder');
    if (!panel) return;
    if (theme) {
      state.stops = theme.stops.map(([c, p]) => ({ c, p }));
      state.angle = theme.angle != null ? theme.angle : 135;
      state.type = theme.grad.startsWith('radial') ? 'radial'
        : theme.grad.startsWith('conic') ? 'conic' : 'linear';
      state.editing = theme.id;
      $id('tb-name').value = theme.name;
    } else {
      state.editing = null;
      $id('tb-name').value = '';
    }
    panel.classList.remove('hidden');
    renderBuilder();
  }

  function closeBuilder() {
    const panel = $id('theme-builder');
    if (panel) panel.classList.add('hidden');
  }

  function renderBuilder() {
    const css = buildCSS();
    $id('tb-preview').style.background = css;
    $id('tb-code').textContent = css;
    $id('tb-angle-val').textContent = state.angle + '°';
    $id('tb-angle').value = state.angle;
    $id('tb-angle-field').style.display = state.type === 'radial' ? 'none' : '';
    document.querySelectorAll('#tb-type button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.type === state.type)));

    $id('tb-stops').replaceChildren(...state.stops.map((s, i) => {
      const row = document.createElement('div');
      row.className = 'stop-row';

      const pick = document.createElement('label');
      pick.className = 'stop-pick';
      pick.style.setProperty('--c', s.c);
      const col = document.createElement('input');
      col.type = 'color';
      col.value = s.c;
      col.setAttribute('aria-label', 'Цвет ' + (i + 1));
      col.oninput = () => { state.stops[i].c = col.value; renderBuilder(); };
      pick.append(col);

      const hex = document.createElement('input');
      hex.className = 'stop-hex';
      hex.value = s.c.toUpperCase();
      hex.maxLength = 7;
      hex.spellcheck = false;
      hex.setAttribute('aria-label', 'HEX ' + (i + 1));
      hex.oninput = () => {
        if (hexOk(hex.value)) { state.stops[i].c = hex.value.toLowerCase(); renderBuilder(); }
      };

      const pos = document.createElement('input');
      pos.className = 'stop-pos';
      pos.type = 'number';
      pos.min = 0; pos.max = 100; pos.step = 1;
      pos.value = s.p;
      pos.setAttribute('aria-label', 'Позиция ' + (i + 1));
      pos.oninput = () => {
        const v = Math.max(0, Math.min(100, Number(pos.value) || 0));
        state.stops[i].p = v;
        $id('tb-preview').style.background = buildCSS();
        $id('tb-code').textContent = buildCSS();
      };

      const del = document.createElement('button');
      del.className = 'stop-del';
      del.textContent = '✕';
      del.disabled = state.stops.length <= 2;
      del.setAttribute('aria-label', 'Удалить стоп ' + (i + 1));
      del.onclick = () => {
        if (state.stops.length <= 2) return;
        state.stops.splice(i, 1);
        renderBuilder();
      };

      row.append(pick, hex, pos, del);
      return row;
    }));
  }

  function slug(name, taken) {
    // Cyrillic (and any non-Latin) names must still yield a stable, readable id.
    const translit = {
      а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
      и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
      с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
      ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
    };
    const latin = name
      .toLowerCase()
      .split('')
      .map((ch) => (translit[ch] !== undefined ? translit[ch] : ch))
      .join('')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    // Fall back to a short hash when nothing transliterable is left.
    let base = latin.slice(0, 30);
    if (!base) {
      let h = 0;
      for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
      base = 'theme-' + h.toString(36);
    }
    base = 'my-' + base;

    let id = base, n = 2;
    while (taken.has(id)) id = base + '-' + n++;
    return id;
  }

  async function saveTheme() {
    const name = ($id('tb-name').value || '').trim();
    if (!name) { toast('Введите название темы'); return; }
    if (name.length > 40) { toast('Название: максимум 40 символов'); return; }

    const taken = new Set(allThemes().filter((t) => t.id !== state.editing).map((t) => t.id));
    const id = state.editing || slug(name, taken);
    if (taken.has(id)) { toast('Такая тема уже есть'); return; }

    const theme = {
      id,
      name,
      fam: 'Моя',
      angle: state.angle,
      stops: state.stops.map((s) => [s.c.toLowerCase(), Math.round(s.p)]),
      grad: buildCSS(),
    };

    const idx = myThemes.findIndex((t) => t.id === id);
    if (idx >= 0) myThemes[idx] = theme;
    else {
      if (myThemes.length >= MAX_MY) { toast('Максимум ' + MAX_MY + ' своих тем'); return; }
      myThemes.unshift(theme);
    }

    if (await pushThemes()) toast('«' + name + '» сохранена в аккаунте');
    applyTheme(id);
    closeBuilder();
    // A new theme has family "Моя": if the active filter would hide it,
    // switch to "Мои" so the user sees what they just saved.
    if (state.filter !== 'all' && state.filter !== 'mine') {
      state.filter = 'mine';
      renderFams();
    }
    renderGrid();
  }

  /* ---------- wiring ---------- */
  function init() {
    if (!$id('themes')) return;

    $id('theme-search').oninput = renderGrid;
    $id('theme-new').onclick = () => openBuilder(null);
    $id('tb-close').onclick = closeBuilder;
    $id('tb-save').onclick = saveTheme;
    $id('tb-random').onclick = () => {
      const hue = () => Math.floor(Math.random() * 360);
      const hsl2hex = (h, s, l) => {
        s /= 100; l /= 100;
        const k = (n) => (n + h / 30) % 12;
        const a = s * Math.min(l, 1 - l);
        const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
        const to = (x) => Math.round(255 * x).toString(16).padStart(2, '0');
        return '#' + to(f(0)) + to(f(8)) + to(f(4));
      };
      state.stops = [0, 50, 100].map((p) => ({ c: hsl2hex(hue(), 60 + Math.random() * 35, 25 + p * 0.35), p }));
      state.angle = Math.floor(Math.random() * 360);
      renderBuilder();
    };
    $id('tb-angle').oninput = () => {
      state.angle = Number($id('tb-angle').value);
      renderBuilder();
    };
    document.querySelectorAll('#tb-type button').forEach((b) => {
      b.onclick = () => { state.type = b.dataset.type; renderBuilder(); };
    });
    $id('tb-add').onclick = () => {
      if (state.stops.length >= 6) { toast('Максимум 6 стопов'); return; }
      const last = state.stops[state.stops.length - 1];
      state.stops.push({ c: last.c, p: Math.min(100, last.p) });
      renderBuilder();
    };

    renderFams();
    renderGrid();
    applyTheme((() => {
      try { return localStorage.getItem('kernel-theme') || 'red'; } catch { return 'red'; }
    })(), false);
    pullThemes().then(renderGrid);

    // Expose for app.js after login.
    window.kernelThemes = { pull: pullThemes, render: renderGrid, apply: applyTheme };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

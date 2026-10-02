// Staff workspace: left drawer menu, favorites bar, and pages as tabs (each tab is its own window / iframe).
(function () {
  const data = JSON.parse(document.getElementById('shell-data').textContent);
  const $ = (id) => document.getElementById(id);
  const tabbar = $('tabbar'); const panes = $('panes'); const drawer = $('drawer'); const scrim = $('scrim');
  const KEY = `gb.tabs.${data.userId}`;
  const MAX = 12;
  const HOME = '/dashboard';
  let tabs = []; let active = null; let seq = 0;
  let favorites = data.favorites.slice();

  const clean = (t) => String(t || '').replace(/ · GlobalBridge Logistics$/, '') || 'Loading…';
  const norm = (u) => { const a = new URL(u, location.origin); return a.pathname + a.search; };
  const labelFor = (url) => (data.items.find((i) => norm(i.href) === norm(url)) || {}).label;

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ tabs: tabs.map(({ url, title }) => ({ url, title })), active: tabs.findIndex((t) => t.id === active) })); } catch (e) { /* private mode */ }
  }

  function renderTabs() {
    tabbar.innerHTML = '';
    for (const t of tabs) {
      const el = document.createElement('div');
      el.className = `tab${t.id === active ? ' on' : ''}${t.home ? ' home' : ''}`;
      el.setAttribute('role', 'tab');
      el.title = t.title;
      const name = document.createElement('span');
      name.textContent = t.home ? 'Main' : t.title;
      el.appendChild(name);
      if (t.home) {
        const r = document.createElement('button'); r.className = 'x'; r.textContent = '↻'; r.title = 'Reload';
        r.onclick = (e) => { e.stopPropagation(); reload(t); }; el.appendChild(r);
      } else {
        const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.title = 'Close';
        x.onclick = (e) => { e.stopPropagation(); close(t.id); }; el.appendChild(x);
      }
      el.onclick = () => activate(t.id);
      el.onauxclick = (e) => { if (e.button === 1 && !t.home) close(t.id); };
      el.ondblclick = () => reload(t);
      tabbar.appendChild(el);
    }
    save();
  }

  function reload(t) { try { t.frame.contentWindow.location.reload(); } catch (e) { t.frame.src = t.url; } }

  function create(url, title, { home = false, focus = true } = {}) {
    const t = { id: `t${++seq}`, url, title: title || labelFor(url) || 'Loading…', home };
    const f = document.createElement('iframe');
    f.className = 'pane'; f.src = url; f.title = t.title;
    f.addEventListener('load', () => {
      try {
        const w = f.contentWindow;
        if (w.location.pathname === '/login') { location.href = '/login'; return; }
        t.url = w.location.pathname + w.location.search + w.location.hash;
        t.title = clean(w.document.title);
        f.title = t.title;
        renderTabs();
      } catch (e) { /* cross-origin (PDF viewer etc.) */ }
    });
    t.frame = f;
    panes.appendChild(f);
    tabs.push(t);
    // Keep the workspace light: drop the oldest non-main tab beyond the limit.
    while (tabs.length > MAX) { const old = tabs.find((x) => !x.home && x.id !== t.id); if (!old) break; close(old.id, true); }
    if (focus) activate(t.id); else renderTabs();
    return t;
  }

  /** Open a page in a tab — or switch to it if it is already open. */
  function open(url, title) {
    const u = norm(url);
    const hash = new URL(url, location.origin).hash;
    const existing = tabs.find((t) => norm(t.url) === u || (u === HOME && t.home));
    if (existing) {
      activate(existing.id);
      if (hash) try { existing.frame.contentWindow.location.hash = hash; } catch (e) { /* ignore */ }
      return existing;
    }
    return create(url, title);
  }

  function activate(id) {
    active = id;
    for (const t of tabs) t.frame.classList.toggle('on', t.id === id);
    renderTabs();
    const t = tabs.find((x) => x.id === id);
    if (t) document.title = `${t.home ? 'Main' : t.title} · GB Logix`;
  }

  function close(id, silent) {
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0 || tabs[i].home) return;
    tabs[i].frame.remove();
    tabs.splice(i, 1);
    if (active === id && !silent) activate((tabs[i] || tabs[i - 1] || tabs[0]).id);
    else renderTabs();
  }

  // Pages inside tabs call this for detail links (shipment, invoice, party…), like OPUS opening B/L entry.
  window.gbOpenTab = (url, title) => open(url, title);

  // ---------- drawer ----------
  function setDrawer(on) {
    drawer.classList.toggle('open', on); scrim.hidden = !on;
    drawer.setAttribute('aria-hidden', String(!on)); $('burger').setAttribute('aria-expanded', String(on));
  }
  $('burger').onclick = () => setDrawer(!drawer.classList.contains('open'));
  scrim.onclick = () => setDrawer(false);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setDrawer(false); });
  drawer.querySelectorAll('[data-cat]').forEach((b) => {
    const show = () => {
      drawer.querySelectorAll('[data-cat]').forEach((x) => x.classList.toggle('on', x === b));
      drawer.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== b.dataset.cat; });
    };
    b.addEventListener('mouseenter', show); b.addEventListener('click', show);
  });
  // ---------- left rail ----------
  const rail = $('rail');
  if (rail) {
    let hideT;
    const close = () => rail.querySelectorAll('.rail-item.open').forEach((x) => x.classList.remove('open'));
    rail.querySelectorAll('.rail-item').forEach((it) => {
      it.addEventListener('mouseenter', () => { clearTimeout(hideT); close(); it.classList.add('open'); });
      it.addEventListener('mouseleave', () => { hideT = setTimeout(() => it.classList.remove('open'), 180); });
    });
    rail.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-open]');
      const btn = e.target.closest('.rail-btn');
      if (a) { e.preventDefault(); open(a.dataset.open, a.dataset.title); close(); return; }
      if (btn) { e.preventDefault(); const it = btn.parentElement; const was = it.classList.contains('open'); close(); if (!was) it.classList.add('open'); }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    document.addEventListener('click', (e) => { if (!rail.contains(e.target)) close(); });
  }
  drawer.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-open]');
    if (a) { e.preventDefault(); open(a.dataset.open, a.dataset.title); setDrawer(false); }
    const star = e.target.closest('[data-star]');
    if (star) toggleFavorite(star.dataset.star);
  });

  // ---------- favorites ----------
  function renderFavorites() {
    const bar = $('favbar'); bar.innerHTML = '';
    for (const id of favorites) {
      const it = data.items.find((i) => i.id === id); if (!it) continue;
      const a = document.createElement('a'); a.href = it.href; a.textContent = it.label;
      a.onclick = (e) => { e.preventDefault(); open(it.href, it.label); };
      bar.appendChild(a);
    }
    if (!favorites.length) { const s = document.createElement('span'); s.className = 'empty'; s.textContent = '☰ → ☆ to add favorites'; bar.appendChild(s); }
    drawer.querySelectorAll('[data-star]').forEach((b) => {
      const on = favorites.includes(b.dataset.star); b.textContent = on ? '★' : '☆'; b.classList.toggle('on', on);
    });
  }
  async function toggleFavorite(id) {
    favorites = favorites.includes(id) ? favorites.filter((x) => x !== id) : [...favorites, id];
    renderFavorites();
    try {
      await fetch('/me/favorites', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': data.csrf }, body: JSON.stringify({ ids: favorites }) });
    } catch (e) { /* offline — kept for this session */ }
  }

  // ---------- global search ----------
  const gs = $('gsearch'); const gr = $('gresults');
  let timer = null; let results = []; let sel = 0;
  const esc = (v) => String(v || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const draw = () => {
    if (!results.length) { gr.innerHTML = gs.value.trim().length >= 2 ? '<div class="gempty">No match</div>' : ''; gr.hidden = gs.value.trim().length < 2; return; }
    gr.innerHTML = results.map((r, i) => `<a href="${esc(r.href)}" class="${i === sel ? 'on' : ''}" data-i="${i}"><span class="gt">${esc(r.type)}</span><b>${esc(r.label)}</b><span class="gs">${esc(r.sub)}</span></a>`).join('');
    gr.hidden = false;
  };
  const go = (r) => { if (!r) return; open(r.href, r.label); gs.value = ''; results = []; draw(); gr.hidden = true; gs.blur(); };
  gs.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = gs.value.trim();
      if (q.length < 2) { results = []; draw(); return; }
      try { results = await (await fetch(`/search.json?q=${encodeURIComponent(q)}`)).json(); } catch (e) { results = []; }
      sel = 0; draw();
    }, 180);
  });
  gs.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(results.length - 1, sel + 1); draw(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    if (e.key === 'Enter') { go(results[sel]); e.preventDefault(); }
    if (e.key === 'Escape') { gs.value = ''; results = []; draw(); gr.hidden = true; gs.blur(); }
  });
  gr.addEventListener('mousedown', (e) => { const a = e.target.closest('a[data-i]'); if (a) { e.preventDefault(); go(results[Number(a.dataset.i)]); } });
  gs.addEventListener('blur', () => setTimeout(() => { gr.hidden = true; }, 150));
  const focusSearch = (e) => {
    const t = e.target; if (e.key !== '/' || /INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable) return;
    e.preventDefault(); gs.focus();
  };
  document.addEventListener('keydown', focusSearch);
  window.gbFocusSearch = () => gs.focus();

  // ---------- bell: my follow-ups ----------
  const bell = $('bell'); const bc = $('bellcount');
  bell.onclick = (e) => { e.preventDefault(); open('/followups', 'Follow-ups'); };
  async function refreshBell() {
    try {
      const c = await (await fetch('/followups/count.json')).json();
      const n = c.critical + c.high;
      bc.hidden = !n; bc.textContent = n > 99 ? '99+' : String(n);
      bc.className = c.critical ? 'crit' : '';
      bell.title = `My follow-ups: ${c.critical} critical, ${c.high} high, ${c.total} open`;
    } catch (e) { /* offline */ }
  }
  refreshBell(); setInterval(refreshBell, 120000);
  window.gbRefreshBell = refreshBell;

  // ---------- start ----------
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { saved = null; }
  create(HOME, 'Main', { home: true, focus: true });
  if (saved && Array.isArray(saved.tabs)) {
    saved.tabs.filter((t) => t.url && norm(t.url) !== HOME && t.url.startsWith('/') && !t.url.startsWith('/app')).slice(0, MAX - 1)
      .forEach((t) => create(t.url, t.title, { focus: false }));
    const want = tabs[saved.active]; if (want) activate(want.id);
  }
  if (data.open && norm(data.open) !== HOME) open(data.open); else if (data.open) activate(tabs[0].id);
  history.replaceState(null, '', '/app');
  renderFavorites();
})();

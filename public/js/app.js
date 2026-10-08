// Small progressive enhancements: add/remove rows in line tables, confirm buttons.
document.addEventListener('click', (e) => {
  const add = e.target.closest('[data-add-row]');
  if (add) {
    const table = document.querySelector(`table[data-lines="${add.dataset.addRow}"] tbody`);
    const row = table.rows[table.rows.length - 1].cloneNode(true);
    row.querySelectorAll('input').forEach((i) => { i.value = ''; });
    table.appendChild(row);
    row.querySelector('input').focus();
  }
  const rm = e.target.closest('[data-remove-row]');
  if (rm) {
    const tbody = rm.closest('tbody');
    const tr = rm.closest('tr');
    if (tbody.rows.length > 1) tr.remove();
    else tr.querySelectorAll('input').forEach((i) => { i.value = ''; });
  }
  const confirmEl = e.target.closest('[data-confirm]');
  if (confirmEl && !window.confirm(confirmEl.dataset.confirm)) e.preventDefault();
});

// KG ↔ LBS and CBM ↔ FT³: the imperial box is filled from the metric one; typing pounds / cubic feet fills KG / CBM.
const CONV = { lbs: 2.20462, 'ft³': 35.3147 };
const convPair = (el) => {
  const scope = el.closest('tr') || el.closest('fieldset') || el.form || document;
  if (el.dataset.conv) return scope.querySelector(`[name="${el.dataset.convOf}"]`);
  return scope.querySelector(`[data-conv-of="${el.name}"]`);
};
document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.name && !el.dataset.conv) return;
  const other = convPair(el);
  if (!other) return;
  const v = el.value.trim() === '' ? NaN : Number(el.value.replace(/,/g, ''));
  if (Number.isNaN(v)) { other.value = ''; return; }
  if (el.dataset.conv) other.value = Math.round((v / CONV[el.dataset.conv]) * (el.dataset.conv === 'lbs' ? 100 : 1000)) / (el.dataset.conv === 'lbs' ? 100 : 1000);
  else other.value = Math.round(v * CONV[other.dataset.conv] * 100) / 100;
});

// Quick accounting entry on the shipment page: pick the usual party for the chosen type.
document.querySelectorAll('[data-kind-select]').forEach((sel) => {
  const party = sel.form.querySelector('select[name="company_id"]');
  const apply = () => { const id = sel.dataset[sel.value.toLowerCase()]; if (id) party.value = id; };
  sel.addEventListener('change', apply);
  apply();
});

// Checkbox settlement: live total of the checked items.
document.querySelectorAll('form[data-settle]').forEach((form) => {
  const out = form.querySelector('[data-settle-total]');
  const calc = () => {
    let t = 0;
    form.querySelectorAll('input[name="invoice_ids"]:checked').forEach((cb) => {
      const amt = form.querySelector(`input[name="amt_${cb.value}"]`);
      t += Number(String(amt ? amt.value : cb.dataset.balance).replace(/,/g, '')) * Number(cb.dataset.sign || 1) || 0;
    });
    out.textContent = t.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  form.addEventListener('input', calc);
  form.addEventListener('change', calc);
  form.querySelectorAll('[data-check-all]').forEach((all) => all.addEventListener('change', () => {
    form.querySelectorAll(`input[name="invoice_ids"][data-group="${all.dataset.checkAll}"]`).forEach((cb) => { cb.checked = all.checked; });
    calc();
  }));
  calc();
});

// Inside the workspace, detail pages open in their own tab (like OPUS): shipment, invoice, party / agent statement.
if (document.documentElement.classList.contains('embedded') && window.top.gbOpenTab) {
  const DETAIL = /^\/(shipments\/(\d+|new)|masters\/(\d+|new)|invoices\/(\d+|new)|billing\/(parties|agents)\/\d+|billing\/profit|history)(?:[?#]|$)/;
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || a.target || a.hasAttribute('download') || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return;
    const here = location.pathname + location.search;
    const path = url.pathname + url.search;
    if (path === here) return; // in-page anchors
    // The Main tab stays the dashboard: whatever it links to opens in its own tab.
    let home = false;
    try { home = window.frameElement && window.frameElement.dataset.home === '1'; } catch (err) { home = false; }
    if (home && url.pathname !== '/dashboard' && !/\.xlsx|\.pdf|format=|\/logout/.test(path)) {
      e.preventDefault();
      window.top.gbOpenTab(path + url.hash, a.textContent.trim().replace(/\s+/g, ' ').slice(0, 40));
      return;
    }
    if (DETAIL.test(url.pathname + url.search) && !/\/preview|\.xlsx|format=/.test(path)) {
      e.preventDefault();
      window.top.gbOpenTab(path + url.hash, a.textContent.trim().slice(0, 40));
    }
  });
}

// Permissions matrix: header checkbox checks / unchecks the whole column.
document.querySelectorAll('input[data-col]').forEach((all) => {
  const boxes = () => [...document.querySelectorAll(`input[data-perm="${all.dataset.col}"]:not(:disabled)`)];
  all.checked = boxes().length > 0 && boxes().every((b) => b.checked);
  all.addEventListener('change', () => boxes().forEach((b) => { b.checked = all.checked; }));
});

// Vendor bill booking: live sum of lines vs the invoice total.
document.querySelectorAll('form[data-bill]').forEach((form) => {
  const sumEl = form.querySelector('[data-sum]'); const diffEl = form.querySelector('[data-diff]');
  let total = Number(form.querySelector('[data-total]').dataset.total);
  form.querySelector('[data-flip-sides]')?.addEventListener('click', () => {
    form.querySelectorAll('select[name="l_side"]').forEach((sel) => { sel.value = sel.value === 'CREDIT' ? 'DEBIT' : 'CREDIT'; });
    if (Number.isFinite(total)) total = -total;
    const tEl = form.querySelector('[data-total]');
    if (tEl.dataset.total !== '') tEl.textContent = total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    calc();
  });
  const calc = () => {
    let s = 0;
    form.querySelectorAll('tbody tr').forEach((tr) => {
      const g = (n) => Number(String(tr.querySelector(`[name="${n}"]`).value || '').replace(/,/g, ''));
      const a = tr.querySelector('[name="l_amount"]').value.trim() ? g('l_amount') : g('l_rate') * (g('l_qty') || 1);
      // Debit / credit note: credit lines count against the debit lines.
      const credit = form.classList.contains('is-note') && tr.querySelector('[name="l_side"]')?.value === 'CREDIT';
      if (Number.isFinite(a)) s += credit ? -a : a;
    });
    sumEl.textContent = s.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const dir = form.querySelector('[data-note-dir]');
    if (dir) dir.textContent = !s ? '' : s > 0 ? '→ agent owes us' : '→ we owe the agent';
    const diff = Number.isFinite(total) && form.querySelector('[data-total]').dataset.total !== '' ? Math.round((s - total) * 100) / 100 : 0;
    diffEl.textContent = diff ? `Difference ${diff > 0 ? '+' : ''}${diff.toFixed(2)}` : '';
  };
  form.addEventListener('input', calc); form.addEventListener('click', () => setTimeout(calc)); calc();
  const kind = form.querySelector('[data-doc-kind]');
  kind?.addEventListener('change', () => { form.classList.toggle('is-note', kind.value === 'DN'); calc(); });
  form.addEventListener('change', calc);
});

// Inside a workspace tab: "/" jumps to the global search; saving anything refreshes the bell.
if (document.documentElement.classList.contains('embedded')) {
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable) return;
    if (window.top.gbFocusSearch) { e.preventDefault(); window.top.gbFocusSearch(); }
  });
  if (window.top.gbRefreshBell) window.top.gbRefreshBell();
}

// Drag & drop upload: drop a PDF / image — or the whole Outlook email (.msg / .eml) — onto any upload form marked
// data-drop. data-autosubmit sends it right away; data-drop-page also catches drops and Ctrl+V paste anywhere on the page.
(() => {
  const zones = [...document.querySelectorAll('form[data-drop]')];
  if (!zones.length) return;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const put = (form, list) => {
    const input = form.querySelector('input[type=file]');
    if (!list || !list.length || !input) return;
    const dt = new DataTransfer();
    [...list].forEach((f) => dt.items.add(f));
    input.files = dt.files;
    const note = form.querySelector('[data-drop-files]');
    if (note) note.textContent = [...dt.files].map((f) => f.name).join(', ');
    if (form.dataset.autosubmit !== undefined) {
      form.classList.add('busy');
      if (note) note.textContent = `Reading ${dt.files.length} file(s)… ${note.textContent}`;
      form.submit();
    }
  };
  const pageZone = zones.find((f) => f.dataset.dropPage !== undefined);
  zones.forEach((form) => {
    const input = form.querySelector('input[type=file]');
    input?.addEventListener('change', () => {
      const note = form.querySelector('[data-drop-files]');
      if (note) note.textContent = [...input.files].map((f) => f.name).join(', ');
      if (form.dataset.autosubmit !== undefined && input.files.length) { form.classList.add('busy'); form.submit(); }
    });
    form.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); form.classList.add('over'); });
    form.addEventListener('dragleave', (e) => { if (!form.contains(e.relatedTarget)) form.classList.remove('over'); });
    form.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); form.classList.remove('over'); put(form, e.dataTransfer.files); });
  });
  // Never let a missed drop open the PDF in place of the page.
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (pageZone) { pageZone.classList.add('over'); e.dataTransfer.dropEffect = 'copy'; } else e.dataTransfer.dropEffect = 'none';
  });
  document.addEventListener('dragleave', (e) => { if (pageZone && !e.relatedTarget) pageZone.classList.remove('over'); });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (pageZone) { pageZone.classList.remove('over'); put(pageZone, e.dataTransfer.files); }
  });
  if (pageZone) {
    document.addEventListener('paste', (e) => {
      if (e.target.closest?.('input:not([type=file]), textarea')) return;
      const files = e.clipboardData?.files;
      if (files && files.length) { e.preventDefault(); put(pageZone, files); }
    });
  }
})();

// Mode "Other" (non-shipment invoices): only the file name, customer, PIC and notes apply.
document.querySelectorAll('select[name="mode"]').forEach((sel) => {
  const form = sel.form;
  const apply = () => {
    const misc = sel.value === 'OTHER';
    form.querySelectorAll('[data-ship-only]').forEach((el) => { el.hidden = misc; });
    form.querySelectorAll('[data-misc-only]').forEach((el) => { el.hidden = !misc; });
    form.querySelectorAll('[data-air-only]').forEach((el) => { el.hidden = misc || sel.value !== 'AIR'; });
    form.querySelectorAll('[data-ocean-only]').forEach((el) => { el.hidden = misc || sel.value === 'AIR'; });
    form.querySelectorAll('[data-fcl-only]').forEach((el) => { el.hidden = misc || sel.value !== 'FCL'; });
  };
  sel.addEventListener('change', apply);
});

// ---------- type-ahead: a list of suggestions under the box while typing (↑ ↓ Enter, or click) ----------
function gbSuggestBox(input, source, pick) {
  const list = document.createElement('div');
  list.className = 'sugg'; list.hidden = true; list.setAttribute('role', 'listbox');
  document.body.appendChild(list);
  let items = []; let at = -1; let timer = null; let seq = 0;
  const place = () => {
    const r = input.getBoundingClientRect();
    const up = r.bottom + Math.min(list.offsetHeight || 260, 300) > window.innerHeight && r.top > 260; // no room below: open upwards
    Object.assign(list.style, { left: `${r.left + window.scrollX}px`, minWidth: `${Math.max(r.width, 220)}px`,
      top: up ? 'auto' : `${r.bottom + window.scrollY + 2}px`, bottom: up ? `${document.documentElement.clientHeight - r.top - window.scrollY + 2}px` : 'auto' });
  };
  const hide = () => { list.hidden = true; at = -1; };
  const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const mark = (label, q) => {
    const i = q ? label.toLowerCase().indexOf(q.toLowerCase()) : -1;
    return i < 0 ? esc(label) : `${esc(label.slice(0, i))}<b>${esc(label.slice(i, i + q.length))}</b>${esc(label.slice(i + q.length))}`;
  };
  const draw = (q) => {
    if (!items.length) { hide(); return; }
    list.innerHTML = items.map((it, i) => `<div class="sugg-item${i === at ? ' on' : ''}" data-i="${i}" role="option"><span>${mark(it.label, q)}</span>${it.sub ? `<span class="sugg-sub">${esc(it.sub)}</span>` : ''}</div>`).join('');
    list.hidden = false; place();
  };
  const run = () => {
    const q = input.value.trim(); const my = ++seq;
    Promise.resolve(source(q)).then((res) => { if (my !== seq || document.activeElement !== input) return; items = res || []; at = -1; draw(q); }).catch(() => {});
  };
  input.setAttribute('autocomplete', 'off');
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 140); });
  input.addEventListener('focus', () => { if (input.dataset.suggestOnFocus !== undefined) run(); });
  input.addEventListener('click', () => { if (input.dataset.suggestOnFocus !== undefined && list.hidden) run(); });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { at = Math.min(items.length - 1, at + 1); draw(input.value.trim()); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { at = Math.max(0, at - 1); draw(input.value.trim()); e.preventDefault(); }
    else if (e.key === 'Enter' && (at >= 0 || items.length === 1)) { e.preventDefault(); pick(items[Math.max(at, 0)]); hide(); }
    else if (e.key === 'Escape' || e.key === 'Tab') hide();
  });
  list.addEventListener('mousedown', (e) => { const el = e.target.closest('[data-i]'); if (!el) return; e.preventDefault(); pick(items[Number(el.dataset.i)]); hide(); });
  input.addEventListener('blur', () => setTimeout(hide, 120));
  window.addEventListener('resize', () => { if (!list.hidden) place(); });
}

// Drop-downs with many choices (parties, users…): type a few letters, pick from the suggestions.
document.querySelectorAll('select[data-party-search], select:not([multiple])').forEach((sel) => {
  const opts = () => [...sel.querySelectorAll('option')].filter((o) => o.value && !o.disabled);
  if (sel.dataset.partySearch === undefined && (opts().length < 12 || sel.closest('table, .filters, .bulkbar, .tools-menu'))) return;
  if (sel.previousElementSibling?.classList.contains('party-search')) return;
  const box = document.createElement('input');
  box.type = 'search'; box.className = 'party-search';
  box.placeholder = sel.dataset.partySearch !== undefined ? 'Type to find a party…' : 'Type to search…';
  sel.parentNode.insertBefore(box, sel);
  gbSuggestBox(box, (q) => {
    if (!q) return [];
    const ql = q.toLowerCase();
    const hits = opts().map((o) => ({ o, t: o.textContent.trim(), g: o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : '' }))
      .filter((x) => x.t.toLowerCase().includes(ql));
    hits.sort((a, b) => Number(!a.t.toLowerCase().startsWith(ql)) - Number(!b.t.toLowerCase().startsWith(ql)));
    return hits.slice(0, 10).map((x) => ({ label: x.t, sub: x.g, value: x.o.value }));
  }, (it) => {
    sel.value = it.value; box.value = '';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sel.classList.add('just-picked'); setTimeout(() => sel.classList.remove('just-picked'), 900);
  });
});

// Text fields: values used on earlier files (port, vessel, carrier, commodity, address, charge names…).
(() => {
  const meta = document.querySelector('meta[name="gb-suggest"]');
  if (!meta) return;
  const fields = new Set(meta.content.split(','));
  const cache = new Map();
  const attach = (input) => {
    if (input.dataset.sugg || !fields.has(input.name) || !/^(text|search|)$/.test(input.type || '')) return;
    input.dataset.sugg = '1';
    const dl = input.getAttribute('list') && document.getElementById(input.getAttribute('list'));
    if (dl) input.removeAttribute('list'); // our list replaces the browser's (its values are merged in below)
    // A fixed list (charge items): the whole list opens on click, like a drop-down; typing filters by name or code.
    if (dl) input.dataset.suggestOnFocus = '';
    const fixed = dl ? [...dl.options].map((o) => ({ label: o.value, sub: o.label && o.label !== o.value ? o.label : '' })) : [];
    gbSuggestBox(input, async (q) => {
      const ql = q.toLowerCase();
      const local = fixed.filter((it) => !ql || it.label.toLowerCase().includes(ql) || it.sub.toLowerCase().includes(ql));
      if (q.length < 2) return dl ? local : [];
      const key = `${input.name}|${ql}`;
      if (!cache.has(key)) cache.set(key, fetch(`/suggest.json?f=${encodeURIComponent(input.name)}&q=${encodeURIComponent(q)}`).then((r) => r.json()).catch(() => []));
      const server = (await cache.get(key)).filter((v) => !fixed.some((it) => it.label === v)).map((v) => ({ label: v, sub: 'used before' }));
      return [...local, ...server].filter((it) => it.label !== q).slice(0, dl ? 30 : 8);
    }, (it) => { input.value = it.label; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
  };
  document.querySelectorAll('input[name]').forEach(attach);
  // Rows added later (+ Line, + Container): attach when first focused.
  document.addEventListener('focusin', (e) => { if (e.target.matches?.('input[name]')) attach(e.target); });
})();

// "＋ New … from documents": show the editable name / address only while that option is picked.
document.querySelectorAll('select[data-new-party]').forEach((sel) => {
  const box = sel.closest('.field').querySelector('[data-new-party-box]');
  if (!box) return;
  const apply = () => { box.hidden = sel.value !== 'new'; };
  sel.addEventListener('change', apply);
  apply();
});

// Parties: read a dropped B/L / invoice / email and fill the "Add party" form from the party picked.
document.querySelectorAll('[data-party-reader]').forEach((zone) => {
  const form = document.getElementById('party-form');
  const out = zone.querySelector('[data-party-results]');
  const input = zone.querySelector('input[type=file]');
  const ROLE = { letterhead: 'Issuer (letterhead)', shipper: 'Shipper', consignee: 'Consignee', notify: 'Notify party', bill_to: 'Bill to' };
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const set = (name, v) => { const el = form.querySelector(`[name="${name}"]`); if (el && v) el.value = v; };
  const read = async (files) => {
    if (!files.length) return;
    const fd = new FormData();
    [...files].forEach((f) => fd.append('files', f));
    out.innerHTML = '<p class="small muted">Reading…</p>';
    zone.classList.add('busy');
    try {
      const r = await fetch(`/companies/read?_csrf=${encodeURIComponent(zone.dataset.csrf)}`, { method: 'POST', body: fd }).then((x) => x.json());
      if (!r.parties.length) { out.innerHTML = '<p class="small muted">No company names found — type them in the form.</p>'; return; }
      out.innerHTML = r.parties.map((p, i) => `<div class="party-cand">
        <div><span class="badge">${ROLE[p.role] || p.role}</span> <b>${esc(p.name)}</b>${p.address ? `<br><span class="small muted">${esc(p.address).replace(/\n/g, ', ')}</span>` : ''}${p.email ? `<br><span class="small">${esc(p.email)}</span>` : ''}</div>
        ${p.match ? `<a class="btn secondary small" href="/companies/${p.match.id}">Already on Parties — edit</a>` : `<button type="button" class="btn small" data-i="${i}">Use →</button>`}</div>`).join('');
      out.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', () => {
        const p = r.parties[Number(b.dataset.i)];
        set('name', p.name); set('address', p.address); set('country', p.country); set('phone', p.phone); set('emails', p.email);
        if (p.email && ['customer', 'agent'].includes(p.suggest)) set('billing_emails', p.email);
        set('type', p.suggest);
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
        form.querySelector('[name="name"]').focus();
      }));
    } catch (e) { out.innerHTML = `<p class="small late">Could not read the document (${esc(e.message)})</p>`; } finally { zone.classList.remove('busy'); }
  };
  input.addEventListener('change', () => read(input.files));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('over'); });
  zone.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.remove('over'); read(e.dataTransfer.files); });
});

// P/L: show one final buyer's lines (Target / Nordstrom …) or all.
document.querySelectorAll('[data-buyer-filter]').forEach((bar) => {
  const table = bar.parentNode.querySelector('table[data-lines="item"]');
  bar.addEventListener('click', (e) => {
    const chip = e.target.closest('.buyer-chip');
    if (!chip) return;
    bar.querySelectorAll('.buyer-chip').forEach((c) => c.classList.toggle('on', c === chip));
    const only = chip.dataset.only;
    table.querySelectorAll('tbody tr').forEach((tr) => { tr.hidden = Boolean(only) && tr.dataset.buyerRow !== only; });
  });
});

// Bulk selection: "select all" box, live count, button enabled only with a selection.
document.querySelectorAll('form[data-bulk]').forEach((form) => {
  const items = () => [...form.querySelectorAll('[data-bulk-item]')];
  const btn = form.querySelector('[data-bulk-btn]');
  const count = form.querySelector('[data-bulk-count]');
  const all = form.querySelector('[data-bulk-all]');
  const sync = () => { const n = items().filter((c) => c.checked).length; if (count) count.textContent = n; if (btn) btn.disabled = !n; if (all) all.checked = n && n === items().length; };
  all?.addEventListener('change', () => { items().forEach((c) => { c.checked = all.checked; }); sync(); });
  form.addEventListener('change', (e) => { if (e.target === form || e.target.matches('[data-bulk-item]')) sync(); });
  sync();
});

// Documents on a file: change type in place; "Select duplicates" ticks the extra copies.
document.querySelectorAll('select[data-doc-type]').forEach((sel) => {
  sel.addEventListener('change', () => {
    const f = document.createElement('form');
    f.method = 'post'; f.action = `/documents/${sel.dataset.docType}/type`;
    const csrf = sel.form?.querySelector('input[name="_csrf"]')?.value;
    f.innerHTML = `<input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="doc_type" value="${sel.value}">`;
    document.body.appendChild(f); f.submit();
  });
});
document.querySelectorAll('[data-check-dups]').forEach((b) => b.addEventListener('click', () => {
  b.form.querySelectorAll('[data-dup]').forEach((c) => { c.checked = true; });
  b.form.dispatchEvent(new Event('change', { bubbles: true }));
}));

// Copy a reference number (file ref, invoice no.) with one click.
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  navigator.clipboard?.writeText(b.dataset.copy).then(() => { const t = b.textContent; b.textContent = '✔'; setTimeout(() => { b.textContent = t; }, 1200); }).catch(() => {});
});

// Duplicate vendor / agent invoice numbers: checked while typing (box under the field) and on save (pop-up with the
// booked one, "Open it", "Cancel" or "Book anyway" for a genuinely different bill).
document.querySelectorAll('input[data-dup-check]').forEach((inp) => {
  const form = inp.form;
  const box = document.createElement('div');
  box.className = 'dup-box';
  inp.insertAdjacentElement('afterend', box);
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = (v) => Math.abs(Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const row = (d) => `<b class="mono">${esc(d.number)}</b> · ${esc(d.party)} · USD ${money(d.total)} · ${esc(d.date || '')}${d.file_ref ? ` · file <span class="mono">${esc(d.file_ref)}</span>${d.file_name ? ` (${esc(d.file_name)})` : ''}` : ''}${d.status === 'PAID' ? ' · paid' : ''} <a href="/invoices/${d.id}">Open ↗</a>`;
  const total = () => {
    let t = 0; let any = false;
    form.querySelectorAll('input[name="l_amount"]').forEach((a) => {
      const v = Number(String(a.value || '').replace(/,/g, ''));
      if (!a.value || !Number.isFinite(v)) return;
      const credit = a.closest('tr')?.querySelector('[name="l_side"]')?.value === 'CREDIT';
      t += credit ? -v : v; any = true;
    });
    return any ? Math.round(t * 100) / 100 : '';
  };
  let last = { same: [], other: [], similar: [] };
  let timer = null;
  const isOurs = () => ['AR'].includes(form.querySelector('[name="kind"]')?.value); // our A/R numbers are automatic
  const check = async () => {
    if (isOurs()) { box.innerHTML = ''; last = { same: [], other: [], similar: [] }; return; }
    const number = inp.value.trim();
    const p = new URLSearchParams({ number, company_id: form.querySelector('[name="company_id"]')?.value || '', total: total(),
      date: form.querySelector('[name="invoice_date"]')?.value || '', exclude: inp.dataset.exclude || '' });
    if (!number && p.get('total') === '') { box.innerHTML = ''; last = { same: [], other: [], similar: [] }; return; }
    try { last = await fetch(`/invoices/duplicates.json?${p}`).then((r) => r.json()); } catch { return; }
    box.innerHTML = last.same.length ? `<div class="dup bad">⚠ Already booked from this party:<br>${last.same.map(row).join('<br>')}</div>`
      : last.similar.length ? `<div class="dup warn">Same amount already booked from this party — check it is not the same bill re-sent:<br>${last.similar.map(row).join('<br>')}</div>`
        : last.other.length ? `<div class="dup info">This number also exists for another party (${esc(last.other[0].party)}) — saved with the party name added.</div>` : '';
  };
  const soon = () => { clearTimeout(timer); timer = setTimeout(check, 350); };
  inp.addEventListener('input', soon);
  form.addEventListener('change', (e) => { if (e.target.matches('[name="company_id"], [name="invoice_date"], [name="l_amount"], [name="l_side"], [name="kind"]')) soon(); });
  if (inp.value.trim()) setTimeout(check, 300);
  form.addEventListener('submit', async (e) => {
    if (form.dataset.dupOk) return;
    e.preventDefault();
    const submitter = e.submitter;
    await check();
    if (!last.same.length) { form.dataset.dupOk = '1'; return submitter ? form.requestSubmit(submitter) : form.submit(); }
    const dlg = document.createElement('dialog');
    dlg.className = 'dup-dialog';
    dlg.innerHTML = `<h3>⚠ This invoice is already booked</h3>
      <p>${last.same.map(row).join('<br>')}</p>
      <p class="small muted">Booking it again would count the cost twice. If it really is a different bill with the same number, choose "Book anyway" — it is saved as <b class="mono">${esc(inp.value.trim())}-2</b>.</p>
      <div class="actions"><a class="btn secondary" href="/invoices/${last.same[0].id}">Open the booked one</a>
        <button type="button" class="btn secondary" data-x="cancel">Cancel</button>
        <button type="button" class="btn danger" data-x="anyway">Book anyway</button></div>`;
    document.body.appendChild(dlg);
    dlg.showModal();
    dlg.addEventListener('click', (ev) => {
      const x = ev.target.closest('[data-x]')?.dataset.x;
      if (ev.target.closest('a')) { dlg.close(); dlg.remove(); return; }
      if (!x) return;
      dlg.close(); dlg.remove();
      if (x === 'anyway') {
        const h = document.createElement('input'); h.type = 'hidden'; h.name = 'allow_duplicate'; h.value = '1'; form.appendChild(h);
        form.dataset.dupOk = '1';
        if (submitter) form.requestSubmit(submitter); else form.submit();
      }
    });
  });
});

// Shipper / Consignee / Notify: type a few letters → names from Parties and earlier files; picking one fills the
// address (and the Customer when the consignee is a customer). An address typed by hand is never overwritten silently.
document.querySelectorAll('input[data-party-lookup]').forEach((inp) => {
  const role = inp.dataset.partyLookup;
  const addr = document.getElementById(inp.dataset.address);
  const form = inp.form;
  const list = document.createElement('div');
  list.className = 'lookup-list';
  list.hidden = true;
  inp.parentNode.style.position = 'relative';
  inp.insertAdjacentElement('afterend', list);
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let rows = []; let active = -1; let timer = null; let autoFilled = addr ? addr.value : '';
  const TYPE = { customer: 'customer', importer: 'importer', shipper: 'shipper', agent: 'agent', broker: 'broker', trucker: 'trucker', vendor: 'vendor', delivery: 'warehouse' };
  const render = () => {
    list.innerHTML = rows.map((r, i) => `<div class="lookup-item ${i === active ? 'on' : ''}" data-i="${i}"><b>${esc(r.name)}</b>
      <span class="muted small">${r.source === 'party' ? `Parties · ${TYPE[r.type] || r.type}` : 'used before'}</span>
      ${r.address ? `<div class="small muted">${esc(r.address).replace(/\n/g, ', ')}</div>` : '<div class="small muted">no address on record</div>'}</div>`).join('');
    list.hidden = !rows.length;
  };
  const pick = (r) => {
    inp.value = r.name;
    if (addr && r.address) {
      if (!addr.value.trim() || addr.value === autoFilled) { addr.value = r.address; autoFilled = r.address; flash(addr); }
      else if (addr.value.trim() !== r.address.trim()) offer(r.address);
    }
    if (role === 'consignee' && r.company_id && ['customer', 'importer'].includes(r.type)) {
      const cust = form.querySelector('[name="customer_id"]');
      if (cust && !cust.value && [...cust.options].some((o) => o.value === String(r.company_id))) { cust.value = String(r.company_id); cust.dispatchEvent(new Event('change', { bubbles: true })); flash(cust); }
    }
    rows = []; render();
  };
  const flash = (el) => { el.classList.add('autofilled'); setTimeout(() => el.classList.remove('autofilled'), 1600); };
  const offer = (address) => {
    let hint = addr.parentNode.querySelector('.addr-offer');
    if (!hint) { hint = document.createElement('div'); hint.className = 'addr-offer small'; addr.insertAdjacentElement('afterend', hint); }
    hint.innerHTML = `Saved address differs — <a href="#">use it</a>: <span class="muted">${esc(address).replace(/\n/g, ', ')}</span>`;
    hint.querySelector('a').onclick = (e) => { e.preventDefault(); addr.value = address; autoFilled = address; hint.remove(); flash(addr); };
  };
  const search = async () => {
    const q = inp.value.trim();
    if (q.length < 2) { rows = []; return render(); }
    try { rows = await fetch(`/parties/lookup.json?role=${role}&q=${encodeURIComponent(q)}`).then((r) => r.json()); } catch { rows = []; }
    active = -1; render();
  };
  inp.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 200); });
  inp.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); active = (active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length; render(); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(rows[active]); }
    else if (e.key === 'Escape') { rows = []; render(); }
  });
  list.addEventListener('mousedown', (e) => { const it = e.target.closest('[data-i]'); if (it) { e.preventDefault(); pick(rows[Number(it.dataset.i)]); } });
  // Typed the whole name and left the field: fill an empty address from the exact match.
  inp.addEventListener('blur', async () => {
    setTimeout(() => { rows = []; render(); }, 150);
    if (!addr || addr.value.trim() || inp.value.trim().length < 3) return;
    const res = await fetch(`/parties/lookup.json?role=${role}&q=${encodeURIComponent(inp.value.trim())}`).then((r) => r.json()).catch(() => []);
    const norm = (v) => String(v).toUpperCase().replace(/[^A-Z0-9]+/g, '');
    const hit = res.find((r) => norm(r.name) === norm(inp.value)) || (res.length === 1 ? res[0] : null);
    if (hit && !addr.value.trim()) pick({ ...hit, name: inp.value.trim() });
  });
});

// Required fields for the chosen mode (OPUS dark-blue fields): bold label with ●, light-blue box; red edge while empty.
(() => {
  const cfg = document.getElementById('required-fields');
  if (!cfg) return;
  const REQ = JSON.parse(cfg.textContent);
  const form = cfg.closest('form');
  const mode = form?.querySelector('[name="mode"]');
  if (!form || !mode) return;
  const apply = () => {
    const keys = REQ[mode.value] || REQ.FCL || [];
    form.querySelectorAll('.field.req').forEach((f) => f.classList.remove('req', 'missing'));
    for (const k of keys) {
      const el = form.querySelector(`[name="${k}"]`);
      const field = el?.closest('.field');
      if (!field) continue;
      field.classList.add('req');
      field.classList.toggle('missing', !String(el.value || '').trim());
    }
  };
  mode.addEventListener('change', apply);
  form.addEventListener('input', (e) => { const f = e.target.closest('.field.req'); if (f) f.classList.toggle('missing', !String(e.target.value || '').trim()); });
  form.addEventListener('change', (e) => { const f = e.target.closest('.field.req'); if (f) f.classList.toggle('missing', !String(e.target.value || '').trim()); });
  apply();
})();

// Shipment form: as the B/L no., carrier, port, agent or customer is entered, fill the still-empty carrier /
// pick-up location / delivery fields from past files (the server decides; typed values are never overwritten).
(() => {
  const form = document.getElementById('f_delivery_address')?.form;
  if (!form || !form.querySelector('#f_mbl_no')) return;
  const val = (k) => form.querySelector(`[name="${k}"]`)?.value || '';
  const keys = ['mode', 'mbl_no', 'carrier', 'scac', 'pod', 'agent_id', 'customer_id', 'consignee_name',
    'cfs_location', 'firms_code', 'freight_location_tel', 'delivery_company_id', 'delivery_address', 'trucker_id', 'broker_id'];
  const group = { cfs_location: 'pickup', firms_code: 'pickup', freight_location_tel: 'pickup',
    delivery_company_id: 'delivery', delivery_address: 'delivery', trucker_id: 'delivery', broker_id: 'delivery', carrier: 'carrier', scac: 'carrier' };
  let timer;
  const run = async () => {
    const p = new URLSearchParams();
    for (const k of keys) p.set(k, val(k));
    p.set('ctn', val('ctn_no'));
    const id = /\/shipments\/(\d+)/.exec(location.pathname)?.[1];
    if (id) p.set('id', id);
    let r;
    try { r = await fetch(`/shipments/autofill.json?${p}`).then((x) => x.json()); } catch { return; }
    for (const [k, v] of Object.entries(r.fills || {})) {
      const el = form.querySelector(`[name="${k}"]`);
      if (!el || el.value) continue;
      if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === String(v))) continue;
      el.value = v;
      el.classList.add('autofilled');
      el.dispatchEvent(new Event('change', { bubbles: true }));
      const g = group[k];
      const lab = form.querySelector(`label[for="${el.id}"]`);
      const text = g === 'carrier' ? `↺ ${r.from.carrier || ''}` : `↺ from ${r.from[g] || ''}`;
      if (lab && !lab.querySelector('.autofill-src')) { const sp = document.createElement('span'); sp.className = 'autofill-src'; sp.textContent = text; sp.title = 'Filled from past files — change it if this one is different'; lab.append(sp); }
    }
  };
  const trigger = () => { clearTimeout(timer); timer = setTimeout(run, 350); };
  for (const k of ['mode', 'mbl_no', 'carrier', 'pod', 'agent_id', 'customer_id', 'consignee_name']) {
    const el = form.querySelector(`[name="${k}"]`);
    if (el) { el.addEventListener('change', trigger); if (el.tagName === 'INPUT') el.addEventListener('blur', trigger); }
  }
  form.querySelector('[name="ctn_no"]')?.addEventListener('change', trigger);
  form.addEventListener('input', (e) => e.target.classList?.remove('autofilled'));
  if (!/\/shipments\/\d+/.test(location.pathname)) trigger();
})();

// Party types: several roles may be ticked; the radio marks the main one (ticking it ticks the role, unticking the
// main role moves "main" to the next ticked role).
document.querySelectorAll('.type-picks').forEach((box) => {
  const sync = () => {
    const picks = [...box.querySelectorAll('.type-pick')];
    if (!picks.some((p) => p.querySelector('[type=checkbox]').checked)) picks[0].querySelector('[type=checkbox]').checked = true;
    const main = picks.find((p) => p.querySelector('[type=radio]').checked && p.querySelector('[type=checkbox]').checked)
      || picks.find((p) => p.querySelector('[type=checkbox]').checked);
    for (const p of picks) {
      const on = p.querySelector('[type=checkbox]').checked;
      p.classList.toggle('on', on);
      p.querySelector('[type=radio]').checked = p === main;
      p.querySelector('[type=radio]').hidden = !on;
    }
  };
  box.addEventListener('change', (e) => {
    if (e.target.type === 'radio') e.target.closest('.type-pick').querySelector('[type=checkbox]').checked = true;
    sync();
  });
  sync();
});

// Work lists: inline notes / labels / flags save as you type (no Save button).
document.querySelectorAll('[data-quick]').forEach((el) => {
  const table = el.closest('[data-csrf]');
  const save = async () => {
    const body = { [el.dataset.field]: el.type === 'checkbox' ? el.checked : el.value };
    el.classList.remove('saved', 'failed');
    try {
      const r = await fetch(el.dataset.quick, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': table?.dataset.csrf || '' }, body: JSON.stringify(body) });
      el.classList.add(r.ok ? 'saved' : 'failed');
    } catch { el.classList.add('failed'); }
    if (el.tagName === 'SELECT') el.className = el.className.replace(/lab-\w+/, `lab-${el.value || 'none'}`);
  };
  el.addEventListener('change', save);
  if (el.tagName === 'INPUT' && el.type !== 'checkbox') el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
});

// Column settings: tick which columns a list shows (kept per list in this browser).
document.querySelectorAll('[data-colcfg]').forEach((btn) => {
  const key = `cols:${btn.dataset.colcfg}`;
  const table = document.querySelector(`[data-cols="${btn.dataset.colcfg}"]`);
  if (!table) return;
  const heads = [...table.querySelectorAll('thead th')];
  let hidden = [];
  try { hidden = JSON.parse(localStorage.getItem(key) || '[]'); } catch { hidden = []; }
  const apply = () => heads.forEach((th, i) => {
    const off = hidden.includes(th.textContent.trim());
    table.querySelectorAll(`tr > :nth-child(${i + 1})`).forEach((cell) => { cell.style.display = off ? 'none' : ''; });
  });
  apply();
  const panel = document.createElement('div'); panel.className = 'colcfg'; panel.hidden = true;
  heads.forEach((th) => {
    const name = th.textContent.trim(); if (!name) return;
    const l = document.createElement('label'); l.className = 'check small';
    const c = document.createElement('input'); c.type = 'checkbox'; c.checked = !hidden.includes(name);
    c.onchange = () => { hidden = c.checked ? hidden.filter((h) => h !== name) : [...hidden, name]; try { localStorage.setItem(key, JSON.stringify(hidden)); } catch { /* private mode */ } apply(); };
    l.append(c, ` ${name}`); panel.append(l);
  });
  btn.after(panel);
  btn.addEventListener('click', () => { panel.hidden = !panel.hidden; });
});

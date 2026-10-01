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
  const DETAIL = /^\/(shipments\/(\d+|new)|invoices\/(\d+|new)|billing\/(parties|agents)\/\d+|billing\/profit|history)(?:[?#]|$)/;
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || a.target || a.hasAttribute('download') || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return;
    const here = location.pathname + location.search;
    const path = url.pathname + url.search;
    if (path === here) return; // in-page anchors
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
  const total = Number(form.querySelector('[data-total]').dataset.total);
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
  };
  sel.addEventListener('change', apply);
});

// Long party lists: a small search box above the drop-down filters it as you type (Enter / single match picks it).
document.querySelectorAll('select[data-party-search]').forEach((sel) => {
  const box = document.createElement('input');
  box.type = 'search'; box.placeholder = 'Type to find a party…'; box.className = 'party-search';
  sel.parentNode.insertBefore(box, sel);
  const opts = [...sel.querySelectorAll('option')].filter((o) => o.value);
  box.addEventListener('input', () => {
    const q = box.value.trim().toLowerCase();
    const hits = opts.filter((o) => { const on = !q || o.textContent.toLowerCase().includes(q); o.hidden = !on; return on; });
    sel.querySelectorAll('optgroup').forEach((g) => { g.hidden = ![...g.children].some((o) => !o.hidden); });
    if (q && hits.length === 1) { sel.value = hits[0].value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const first = opts.find((o) => !o.hidden);
    if (first) { sel.value = first.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  });
});

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

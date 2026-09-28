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
      if (Number.isFinite(a)) s += a;
    });
    sumEl.textContent = s.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const diff = Number.isFinite(total) && form.querySelector('[data-total]').dataset.total !== '' ? Math.round((s - total) * 100) / 100 : 0;
    diffEl.textContent = diff ? `Difference ${diff > 0 ? '+' : ''}${diff.toFixed(2)}` : '';
  };
  form.addEventListener('input', calc); form.addEventListener('click', () => setTimeout(calc)); calc();
});

// Inside a workspace tab: "/" jumps to the global search; saving anything refreshes the bell.
if (document.documentElement.classList.contains('embedded')) {
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable) return;
    if (window.top.gbFocusSearch) { e.preventDefault(); window.top.gbFocusSearch(); }
  });
  if (window.top.gbRefreshBell) window.top.gbRefreshBell();
}

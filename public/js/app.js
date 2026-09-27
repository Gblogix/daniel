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

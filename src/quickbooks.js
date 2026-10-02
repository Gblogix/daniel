/**
 * QuickBooks Online sync (one way: this system → QBO, so the books follow what operations already entered).
 *   A/R invoice                 → QBO Invoice   (customer)
 *   D/N to agent (due to us)    → QBO Invoice   (agent as customer)
 *   C/N (net due to the agent)  → QBO Bill      (agent as vendor)
 *   A/P vendor bill             → QBO Bill      (vendor)
 *   Payment received / paid     → QBO Payment / Bill Payment, linked to the synced invoices / bills
 *   Party                       → QBO Customer / Vendor (found by name, else created)
 * An edited document is updated in QBO; a voided one is voided (invoice) or deleted (bill).
 *
 * Intuit app keys: QBO_CLIENT_ID / QBO_CLIENT_SECRET (developer.intuit.com › your app › Keys), QBO_ENV=sandbox|production.
 * Tokens and the company (realm) id live in the database (settings), never in git.
 */
const crypto = require('node:crypto');
const config = require('./config');
const store = require('./db');

const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const SCOPE = 'com.intuit.quickbooks.accounting';
const MINOR = 75;

let fetchImpl = (...a) => fetch(...a);
function setFetch(f) { fetchImpl = f; }

const env = () => (process.env.QBO_ENV || 'production').toLowerCase() === 'sandbox' ? 'sandbox' : 'production';
const apiBase = () => (env() === 'sandbox' ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com');
const clientId = () => process.env.QBO_CLIENT_ID || '';
const clientSecret = () => process.env.QBO_CLIENT_SECRET || '';
const redirectUri = () => process.env.QBO_REDIRECT_URI || `${config.baseUrl}/billing/quickbooks/callback`;
const round = (v) => Math.round((Number(v) || 0) * 100) / 100;

function tokens(db = store.db) { try { return JSON.parse(db.setting('qbo_tokens') || 'null'); } catch { return null; } }
function saveTokens(t, db = store.db) { db.setSetting('qbo_tokens', t ? JSON.stringify(t) : ''); }
function opt(k, db = store.db) { return db.setting(`qbo_${k}`) || ''; }
function setOpt(k, v, db = store.db) { db.setSetting(`qbo_${k}`, v ?? ''); }

function configured() { return Boolean(clientId() && clientSecret()); }
function connected(db = store.db) { const t = tokens(db); return Boolean(t?.refresh_token && t?.realm_id); }

/** Step 1 of "Connect to QuickBooks": Intuit's consent page. */
function authorizeUrl(db = store.db) {
  const state = crypto.randomBytes(16).toString('hex');
  setOpt('oauth_state', state, db);
  const q = new URLSearchParams({ client_id: clientId(), response_type: 'code', scope: SCOPE, redirect_uri: redirectUri(), state });
  return `${AUTH_URL}?${q}`;
}

async function tokenCall(body) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64')}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`QuickBooks sign-in: ${data.error_description || data.error || res.status}`);
  return data;
}

const stamp = (data, realm) => ({
  realm_id: realm, access_token: data.access_token, refresh_token: data.refresh_token,
  access_expires: Date.now() + (Number(data.expires_in || 3600) - 120) * 1000,
  refresh_expires: Date.now() + Number(data.x_refresh_token_expires_in || 8640000) * 1000,
});

/** Step 2: Intuit sends the user back with ?code=&realmId=&state=. */
async function handleCallback({ code, realmId, state }, db = store.db) {
  if (!state || state !== opt('oauth_state', db)) throw new Error('QuickBooks sign-in expired — click Connect again');
  setOpt('oauth_state', '', db);
  const data = await tokenCall({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
  saveTokens(stamp(data, String(realmId)), db);
  await companyInfo(db).catch(() => null);
  return tokens(db);
}

/** Without a public HTTPS address: paste the Company ID and a refresh token from Intuit's OAuth 2.0 Playground. */
async function connectManual({ realmId, refreshToken }, db = store.db) {
  const realm = String(realmId || '').replace(/\D/g, '');
  if (!realm || !refreshToken) throw new Error('Company ID (realm) and refresh token are both needed');
  const data = await tokenCall({ grant_type: 'refresh_token', refresh_token: String(refreshToken).trim() });
  saveTokens(stamp(data, realm), db);
  await companyInfo(db);
  return tokens(db);
}

async function disconnect(db = store.db) {
  const t = tokens(db);
  if (t?.refresh_token && configured()) {
    await fetchImpl(REVOKE_URL, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64')}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: t.refresh_token }),
    }).catch(() => null);
  }
  saveTokens(null, db);
  setOpt('company_name', '', db);
}

async function accessToken(db = store.db) {
  const t = tokens(db);
  if (!t?.refresh_token) throw new Error('QuickBooks is not connected');
  if (t.access_token && Date.now() < t.access_expires) return t;
  // Refresh tokens rotate: always keep the newest one Intuit returns.
  const data = await tokenCall({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
  const next = stamp(data, t.realm_id);
  saveTokens(next, db);
  return next;
}

async function api(pathname, { method = 'GET', body, query, db = store.db } = {}) {
  const t = await accessToken(db);
  const q = new URLSearchParams({ minorversion: String(MINOR), ...(query || {}) });
  const res = await fetchImpl(`${apiBase()}/v3/company/${t.realm_id}${pathname}${pathname.includes('?') ? '&' : '?'}${q}`, {
    method,
    headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.Fault) {
    const e = (data.Fault?.Error || [])[0] || {};
    const err = new Error(`QuickBooks: ${e.Message || res.status}${e.Detail ? ` — ${e.Detail}` : ''}`);
    err.code = e.code;
    throw err;
  }
  return data;
}

const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
async function query(sql, db = store.db) {
  const data = await api('/query', { query: { query: sql }, db });
  return data.QueryResponse || {};
}

async function companyInfo(db = store.db) {
  const t = tokens(db);
  const data = await api(`/companyinfo/${t.realm_id}`, { db });
  const name = data.CompanyInfo?.CompanyName || '';
  setOpt('company_name', name, db);
  return { name, country: data.CompanyInfo?.Country || '' };
}

/** Choices for the mapping screen. */
async function lists(db = store.db) {
  const [items, accounts] = await Promise.all([
    query("select Id, Name, Type from Item where Type in ('Service', 'NonInventory') maxresults 500", db),
    query('select Id, Name, AccountType, AccountSubType from Account where Active = true maxresults 1000', db),
  ]);
  const acc = accounts.Account || [];
  return {
    items: (items.Item || []).map((i) => ({ id: i.Id, name: i.Name })),
    income: acc.filter((a) => ['Income', 'Other Income'].includes(a.AccountType)).map((a) => ({ id: a.Id, name: a.Name })),
    expense: acc.filter((a) => ['Cost of Goods Sold', 'Expense', 'Other Expense'].includes(a.AccountType)).map((a) => ({ id: a.Id, name: a.Name })),
    bank: acc.filter((a) => a.AccountType === 'Bank').map((a) => ({ id: a.Id, name: a.Name })),
    deposit: acc.filter((a) => a.AccountType === 'Bank' || a.AccountSubType === 'UndepositedFunds').map((a) => ({ id: a.Id, name: a.Name })),
  };
}

// ---------- parties ----------

const addr = (text) => {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 5);
  return lines.length ? Object.fromEntries(lines.map((l, i) => [`Line${i + 1}`, l.slice(0, 500)])) : undefined;
};
const firstEmail = (...v) => v.map((x) => String(x || '').split(/[,;\s]+/).find((e) => /@/.test(e))).find(Boolean);

/** QBO Customer / Vendor id for a party (stored on the party once found or created). */
async function partyRef(companyId, kind, db = store.db) {
  const col = kind === 'Vendor' ? 'qbo_vendor_id' : 'qbo_customer_id';
  const c = db.get('SELECT * FROM companies WHERE id = ?', companyId);
  if (!c) throw new Error('Document has no party');
  if (c[col]) return c[col];
  const name = String(c.name).trim().slice(0, 100);
  // Display names are unique across customers AND vendors in QBO: a party that is both gets "(Vendor)" on the vendor side.
  const names = kind === 'Vendor' ? [name, `${name.slice(0, 90)} (Vendor)`] : [name];
  for (const n of names) {
    const hit = (await query(`select Id, DisplayName from ${kind} where DisplayName = '${esc(n)}'`, db))[kind]?.[0];
    if (hit) { db.run(`UPDATE companies SET ${col} = ? WHERE id = ?`, hit.Id, c.id); return hit.Id; }
  }
  const body = {
    DisplayName: name, CompanyName: name,
    ...(firstEmail(c.billing_emails, c.emails) ? { PrimaryEmailAddr: { Address: firstEmail(c.billing_emails, c.emails) } } : {}),
    ...(c.phone ? { PrimaryPhone: { FreeFormNumber: String(c.phone).slice(0, 30) } } : {}),
    ...(addr(c.address) ? { [kind === 'Vendor' ? 'BillAddr' : 'BillAddr']: addr(c.address) } : {}),
  };
  let created;
  try {
    created = (await api(`/${kind.toLowerCase()}`, { method: 'POST', body, db }))[kind];
  } catch (e) {
    if (kind !== 'Vendor' || !/Duplicate|6240/i.test(`${e.message} ${e.code}`)) throw e;
    created = (await api('/vendor', { method: 'POST', body: { ...body, DisplayName: names[1] }, db })).Vendor;
  }
  db.run(`UPDATE companies SET ${col} = ? WHERE id = ?`, created.Id, c.id);
  return created.Id;
}

// ---------- documents ----------

/** What a document becomes in QBO. */
function targetOf(inv) {
  if (inv.kind === 'AR') return 'Invoice';
  if (inv.kind === 'AP') return 'Bill';
  if (inv.kind === 'DN') return Number(inv.total) < 0 ? 'Bill' : 'Invoice';
  return null;
}

/**
 * Lines with their QBO sign: invoice lines are what the party owes; bill lines what we owe. When a D/N mixes debit and
 * credit lines so some would go negative, it is posted as one net line naming every charge (QBO keeps the PDF detail).
 */
function linesOf(inv, target) {
  const signed = inv.lines.map((l) => {
    let amt = Number(l.amount) || 0;
    if (inv.kind === 'DN') amt = l.side === 'CREDIT' ? -amt : amt;
    if (target === 'Bill' && inv.kind === 'DN') amt = -amt;
    return { ...l, amt: round(amt) };
  }).filter((l) => l.amt !== 0);
  if (signed.every((l) => l.amt > 0)) return signed.map((l) => ({ desc: [l.description, l.bl_no].filter(Boolean).join(' · '), amt: l.amt, rate: l.rate, qty: l.qty }));
  const net = round(signed.reduce((a, l) => a + l.amt, 0));
  return [{ desc: `${inv.number} net: ${signed.map((l) => `${l.description} ${l.amt < 0 ? '-' : ''}${Math.abs(l.amt).toFixed(2)}`).join(', ')}`.slice(0, 4000), amt: net }];
}

function memoOf(inv) {
  return [inv.ref_no && `File ${inv.ref_no}`, inv.hbl_no && `HBL ${inv.hbl_no}`, inv.mbl_no && `MBL ${inv.mbl_no}`, inv.agent_ref && `Agent ref ${inv.agent_ref}`, inv.memo].filter(Boolean).join(' · ').slice(0, 4000);
}

async function ensureItem(db = store.db) {
  if (opt('item_id', db)) return opt('item_id', db);
  const name = 'Logistics Services';
  const hit = (await query(`select Id from Item where Name = '${esc(name)}'`, db)).Item?.[0];
  if (hit) { setOpt('item_id', hit.Id, db); return hit.Id; }
  const income = opt('income_account', db) || (await query("select Id from Account where AccountType = 'Income' maxresults 1", db)).Account?.[0]?.Id;
  if (!income) throw new Error('Pick an income account / item on the QuickBooks page first');
  const item = (await api('/item', { method: 'POST', body: { Name: name, Type: 'Service', IncomeAccountRef: { value: income } }, db })).Item;
  setOpt('item_id', item.Id, db);
  return item.Id;
}

async function expenseAccount(db = store.db) {
  if (opt('expense_account', db)) return opt('expense_account', db);
  const a = (await query("select Id from Account where AccountType = 'Cost of Goods Sold' maxresults 1", db)).Account?.[0]
    || (await query("select Id from Account where AccountType = 'Expense' maxresults 1", db)).Account?.[0];
  if (!a) throw new Error('Pick an expense account on the QuickBooks page first');
  setOpt('expense_account', a.Id, db);
  return a.Id;
}

async function payloadOf(inv, db = store.db) {
  const target = targetOf(inv);
  const lines = linesOf(inv, target);
  const doc = String(inv.number).slice(0, 21);
  if (target === 'Invoice') {
    const item = await ensureItem(db);
    return {
      target,
      body: {
        CustomerRef: { value: await partyRef(inv.company_id, 'Customer', db) }, DocNumber: doc, TxnDate: inv.invoice_date,
        ...(inv.due_date ? { DueDate: inv.due_date } : {}), PrivateNote: memoOf(inv),
        ...(inv.customer_ref ? { CustomerMemo: { value: `Your ref: ${inv.customer_ref}`.slice(0, 1000) } } : {}),
        Line: lines.map((l) => {
          const exact = l.rate != null && l.qty != null && round(l.rate * l.qty) === l.amt;
          return { DetailType: 'SalesItemLineDetail', Amount: l.amt, Description: l.desc.slice(0, 4000),
            SalesItemLineDetail: { ItemRef: { value: item }, ...(exact ? { Qty: l.qty, UnitPrice: l.rate } : {}) } };
        }),
      },
    };
  }
  const account = await expenseAccount(db);
  return {
    target,
    body: {
      VendorRef: { value: await partyRef(inv.company_id, 'Vendor', db) }, DocNumber: doc, TxnDate: inv.invoice_date,
      ...(inv.due_date ? { DueDate: inv.due_date } : {}), PrivateNote: memoOf(inv),
      Line: lines.map((l) => ({ DetailType: 'AccountBasedExpenseLineDetail', Amount: l.amt, Description: l.desc.slice(0, 4000),
        AccountBasedExpenseLineDetail: { AccountRef: { value: account } } })),
    },
  };
}

const hashOf = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex');

async function current(target, id, db) {
  return (await api(`/${target.toLowerCase()}/${id}`, { db }))[target];
}

/** Send one document; returns { action: created|updated|voided|deleted|unchanged|skipped, qbo_id }. */
async function pushInvoice(invoiceId, { db = store.db } = {}) {
  const A = require('./accounting');
  const inv = A.getInvoice(invoiceId, db);
  if (!inv) throw new Error('Invoice not found');
  const mark = (fields) => db.run(`UPDATE invoices SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(fields), inv.id);
  try {
    if (inv.status === 'VOID') {
      if (!inv.qbo_id) return { action: 'skipped' };
      const live = await current(inv.qbo_type, inv.qbo_id, db).catch(() => null);
      if (live) {
        if (inv.qbo_type === 'Invoice') await api('/invoice', { method: 'POST', query: { operation: 'void' }, body: { Id: live.Id, SyncToken: live.SyncToken }, db });
        else await api(`/${inv.qbo_type.toLowerCase()}`, { method: 'POST', query: { operation: 'delete' }, body: { Id: live.Id, SyncToken: live.SyncToken }, db });
      }
      mark({ qbo_id: null, qbo_hash: null, qbo_synced_at: new Date().toISOString(), qbo_error: null });
      return { action: inv.qbo_type === 'Invoice' ? 'voided' : 'deleted' };
    }
    if (inv.status === 'DRAFT' || !inv.lines.length || !Number(inv.total)) return { action: 'skipped' };
    const { target, body } = await payloadOf(inv, db);
    const hash = hashOf({ target, body });
    if (inv.qbo_id && inv.qbo_hash === hash) return { action: 'unchanged', qbo_id: inv.qbo_id };
    let saved;
    if (inv.qbo_id && inv.qbo_type === target) {
      const live = await current(target, inv.qbo_id, db);
      saved = (await api(`/${target.toLowerCase()}`, { method: 'POST', body: { ...body, Id: live.Id, SyncToken: live.SyncToken, sparse: false }, db }))[target];
    } else {
      if (inv.qbo_id && inv.qbo_type && inv.qbo_type !== target) {
        // D/N turned into a C/N (or back): remove the old QBO document first.
        const live = await current(inv.qbo_type, inv.qbo_id, db).catch(() => null);
        if (live) await api(`/${inv.qbo_type.toLowerCase()}`, { method: 'POST', query: { operation: inv.qbo_type === 'Invoice' ? 'void' : 'delete' }, body: { Id: live.Id, SyncToken: live.SyncToken }, db });
      }
      saved = (await api(`/${target.toLowerCase()}`, { method: 'POST', body, db }))[target];
    }
    const action = inv.qbo_id ? 'updated' : 'created';
    mark({ qbo_id: saved.Id, qbo_type: target, qbo_hash: hash, qbo_synced_at: new Date().toISOString(), qbo_error: null });
    return { action, qbo_id: saved.Id };
  } catch (e) {
    mark({ qbo_error: e.message.slice(0, 500) });
    throw e;
  }
}

/** Payments: only the part applied to documents already in QBO (the rest stays unapplied here). */
async function pushPayment(paymentId, { db = store.db } = {}) {
  const p = db.get('SELECT * FROM payments WHERE id = ?', paymentId);
  if (!p) throw new Error('Payment not found');
  if (p.qbo_id) return { action: 'unchanged', qbo_id: p.qbo_id };
  if (String(p.method || '').toUpperCase() === 'NETTING') return { action: 'skipped' };
  const allocs = db.all(`SELECT a.amount, i.qbo_id, i.qbo_type FROM payment_allocations a JOIN invoices i ON i.id = a.invoice_id
    WHERE a.payment_id = ? AND i.qbo_id IS NOT NULL AND i.status <> 'VOID'`, p.id);
  const want = p.direction === 'IN' ? 'Invoice' : 'Bill';
  const lines = allocs.filter((a) => a.qbo_type === want && Number(a.amount) > 0)
    .map((a) => ({ Amount: round(a.amount), LinkedTxn: [{ TxnId: a.qbo_id, TxnType: want }] }));
  if (!lines.length) return { action: 'skipped' };
  const total = round(lines.reduce((s, l) => s + l.Amount, 0));
  try {
    let saved;
    if (p.direction === 'IN') {
      const dep = opt('deposit_account', db);
      saved = (await api('/payment', { method: 'POST', db, body: {
        CustomerRef: { value: await partyRef(p.company_id, 'Customer', db) }, TotalAmt: total, TxnDate: p.paid_on,
        ...(p.reference ? { PaymentRefNum: String(p.reference).slice(0, 21) } : {}), PrivateNote: [p.method, p.memo].filter(Boolean).join(' · ').slice(0, 4000),
        ...(dep ? { DepositToAccountRef: { value: dep } } : {}), Line: lines,
      } })).Payment;
    } else {
      const bank = opt('bank_account', db);
      if (!bank) throw new Error('Pick the bank account bill payments come from (QuickBooks page)');
      saved = (await api('/billpayment', { method: 'POST', db, body: {
        VendorRef: { value: await partyRef(p.company_id, 'Vendor', db) }, PayType: 'Check', CheckPayment: { BankAccountRef: { value: bank } },
        TotalAmt: total, TxnDate: p.paid_on, ...(p.reference ? { DocNumber: String(p.reference).slice(0, 21) } : {}),
        PrivateNote: [p.method, p.memo].filter(Boolean).join(' · ').slice(0, 4000), Line: lines,
      } })).BillPayment;
    }
    db.run('UPDATE payments SET qbo_id = ?, qbo_synced_at = ?, qbo_error = NULL WHERE id = ?', saved.Id, new Date().toISOString(), p.id);
    return { action: 'created', qbo_id: saved.Id };
  } catch (e) {
    db.run('UPDATE payments SET qbo_error = ? WHERE id = ?', e.message.slice(0, 500), p.id);
    throw e;
  }
}

/** Documents waiting for QBO: new, edited since, or voided after being sent. */
function pending(db = store.db) {
  const reviewedOnly = opt('reviewed_only', db) !== '0';
  const docs = db.all(`SELECT i.id, i.kind, i.number, i.total, i.status, i.qbo_id, i.qbo_error, i.reviewed_at, c.name AS company_name
    FROM invoices i LEFT JOIN companies c ON c.id = i.company_id
    WHERE (i.status = 'VOID' AND i.qbo_id IS NOT NULL)
       OR (i.status NOT IN ('VOID', 'DRAFT') AND i.total <> 0 AND (i.kind = 'AP' OR ? = 0 OR i.reviewed_at IS NOT NULL))
    ORDER BY i.invoice_date, i.id`, reviewedOnly ? 1 : 0);
  return docs;
}

let running = null;
/** Sync everything that changed. Returns a summary for the screen. */
async function syncAll({ db = store.db } = {}) {
  if (running) return running;
  running = (async () => {
    const out = { created: 0, updated: 0, voided: 0, unchanged: 0, skipped: 0, payments: 0, errors: [] };
    if (!connected(db)) { out.errors.push('QuickBooks is not connected'); return out; }
    for (const d of pending(db)) {
      try {
        const r = await pushInvoice(d.id, { db });
        if (r.action === 'deleted') out.voided += 1; else out[r.action] = (out[r.action] || 0) + 1;
      } catch (e) { out.errors.push(`${d.number}: ${e.message}`); }
    }
    if (opt('payments', db) !== '0') {
      for (const p of db.all('SELECT id FROM payments WHERE qbo_id IS NULL ORDER BY paid_on, id')) {
        try { if ((await pushPayment(p.id, { db })).action === 'created') out.payments += 1; } catch (e) { out.errors.push(`Payment #${p.id}: ${e.message}`); }
      }
    }
    setOpt('last_sync', JSON.stringify({ at: new Date().toISOString(), ...out, errors: out.errors.slice(0, 30) }), db);
    return out;
  })();
  try { return await running; } finally { running = null; }
}

function lastSync(db = store.db) { try { return JSON.parse(opt('last_sync', db) || 'null'); } catch { return null; } }

let timer = null;
function start() {
  if (timer) return false;
  const minutes = Math.max(10, Number(process.env.QBO_MINUTES || 30));
  timer = setInterval(() => {
    if (opt('auto') === '1' && connected()) syncAll().catch((e) => console.error('QuickBooks sync:', e.message));
  }, minutes * 60000);
  timer.unref?.();
  return configured();
}

module.exports = {
  configured, connected, env, redirectUri, authorizeUrl, handleCallback, connectManual, disconnect, companyInfo, lists,
  pushInvoice, pushPayment, syncAll, pending, lastSync, opt, setOpt, targetOf, linesOf, partyRef, setFetch, start, tokens,
};

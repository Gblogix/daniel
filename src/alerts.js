/**
 * Daily LFD / pickup digest to the office mailbox (7:00 office time): every open shipment whose last free day
 * is within 3 days (or past), with holds and the next step still open — the races seen in the inbox.
 */
const config = require('./config');
const store = require('./db');
const S = require('./shipments');

function officeNow(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

function lfdDigest({ db = store.db, now = new Date() } = {}) {
  const rows = S.list({ role: 'staff' }, { active: true, db })
    .map((s) => ({ s, lfd: S.lfdInfo(s, now), next: S.checklist(s).find((x) => x.next) }))
    .filter((x) => x.lfd && x.lfd.days <= 3)
    .sort((a, b) => a.lfd.days - b.lfd.days);
  return rows;
}

async function sendDigest({ db = store.db, now = new Date(), force = false } = {}) {
  const { date } = officeNow(now);
  if (!force && db.setting('lfd_digest_date') === date) return null;
  const rows = lfdDigest({ db, now });
  db.setSetting('lfd_digest_date', date);
  if (!rows.length) return null;
  const td = 'style="padding:4px 8px;border-bottom:1px solid #eee;font-size:13px"';
  const html = `<div style="font:14px Arial,sans-serif"><p><b>${rows.length} shipment(s)</b> with LFD within 3 days — ${date}</p>
<table style="border-collapse:collapse"><tr><th ${td}>LFD</th><th ${td}>Ref</th><th ${td}>MBL / MAWB</th><th ${td}>Container / pcs</th><th ${td}>Pick-up at</th><th ${td}>Holds</th><th ${td}>Next step</th></tr>
${rows.map(({ s, lfd, next }) => `<tr><td ${td}><b style="color:${lfd.days <= 0 ? '#b91c1c' : '#92400e'}">${lfd.date} (${lfd.days < 0 ? `${-lfd.days}d over` : lfd.days === 0 ? 'TODAY' : `${lfd.days}d`})</b></td>
<td ${td}><a href="${config.baseUrl}/shipments/${s.id}">${s.ref_no}</a></td><td ${td}>${s.mbl_no || ''}</td>
<td ${td}>${s.containers.map((c) => c.container_no).join(', ') || `${s.packages || ''} ${s.package_unit || ''}`}</td>
<td ${td}>${s.cfs_location || ''}${s.firms_code ? ` (${s.firms_code})` : ''}</td><td ${td}>${s.holds || ''}</td><td ${td}><b>${next ? next.label : ''}</b></td></tr>`).join('')}
</table></div>`;
  return require('./notify').queueEmail({
    kind: 'LFD_DIGEST', to: [config.company.email], subject: `[LFD watch] ${rows.length} shipment(s) — ${date}`, html,
  }, { db });
}

// ---------- heads-up: each staff member's follow-ups, every morning ----------
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function digestHtml(user, items, date) {
  const F = require('./followups');
  const c = F.counts(items);
  const color = { critical: '#b91c1c', high: '#b45309', normal: '#475569' };
  const row = (i) => `<tr><td style="padding:5px 8px;border-bottom:1px solid #eee;color:${color[i.severity]};font-weight:700;white-space:nowrap">${i.severity === 'normal' ? '○' : '●'} ${esc(i.severity)}</td>
    <td style="padding:5px 8px;border-bottom:1px solid #eee"><b>${esc(i.title)}</b>${i.s ? ` · <a href="${config.baseUrl}/shipments/${i.s.id}">${esc(S.fileName(i.s))}</a>` : ''}<br><span style="color:#64748b;font-size:12px">${esc(i.detail)}</span></td>
    <td style="padding:5px 8px;border-bottom:1px solid #eee;white-space:nowrap;font-size:12px">due ${esc(i.due || '')}</td></tr>`;
  return `<div style="font:14px Arial,sans-serif"><p>Good morning ${esc(user.name)},</p>
    <p><b>${c.critical}</b> critical · <b>${c.high}</b> high · ${c.total} open follow-up(s) on your files — ${date}.</p>
    <table style="border-collapse:collapse;width:100%">${items.slice(0, 40).map(row).join('')}</table>
    ${items.length > 40 ? `<p>+ ${items.length - 40} more</p>` : ''}
    <p><a href="${config.baseUrl}/app?open=/followups">Open my follow-ups →</a></p></div>`;
}

/** 7am: one email per staff member with the follow-ups on their files (accounting items for accounting users). */
async function sendDailyDigests({ db = store.db, now = new Date(), force = false } = {}) {
  const F = require('./followups');
  const { date } = officeNow(now);
  let sent = 0;
  for (const user of db.all("SELECT * FROM users WHERE role IN ('admin', 'staff') AND active = 1 AND email LIKE '%@%'")) {
    const key = `digest_${user.id}_date`;
    if (!force && db.setting(key) === date) continue;
    db.setSetting(key, date);
    const items = F.forUser(user, { db, now, mine: true });
    if (!items.length) continue;
    const c = F.counts(items);
    await require('./notify').queueEmail({
      kind: 'DAILY_DIGEST', to: [user.email], subject: `[GB Logix] Today: ${c.critical} critical · ${c.high} high · ${c.total} follow-ups — ${date}`,
      html: digestHtml(user, items, date),
    }, { db });
    sent++;
  }
  return sent;
}

// ---------- customer convenience: scheduled shipment report ----------
function customerReportHtml(company, rows, date) {
  const td = 'style="padding:5px 8px;border-bottom:1px solid #eee;font-size:12.5px;vertical-align:top"';
  return `<div style="font:14px Arial,sans-serif"><p>Hello ${esc(company.name)},</p>
    <p>Here is the status of your shipments with GlobalBridge Logistics as of ${esc(date)}.</p>
    <table style="border-collapse:collapse;width:100%"><tr style="background:#f1f5f9"><th ${td}>Shipment</th><th ${td}>ETD</th><th ${td}>ETA</th><th ${td}>Where / next</th><th ${td}>Delivery</th></tr>
    ${rows.map((s) => `<tr><td ${td}><b>${esc(S.fileName(s))}</b><br><span style="color:#64748b">${esc([s.mbl_no, s.hbl_no].filter(Boolean).join(' / '))}</span></td>
      <td ${td}>${esc(s.atd || s.etd || '')}</td><td ${td}><b>${esc(s.ata || s.eta || '')}</b></td><td ${td}>${esc(S.customerStep(s).text)}</td>
      <td ${td}>${esc([s.delivery_date, s.delivery_time].filter(Boolean).join(' ') || 'TBA')}</td></tr>`).join('')}</table>
    <p><a href="${config.baseUrl}/track">Live tracking, documents and delivery requests →</a></p>
    <p style="color:#64748b;font-size:12px">You receive this ${esc(company.report_frequency)} report because it was set up for your account. Reply to change it.</p></div>`;
}

async function sendCustomerReports({ db = store.db, now = new Date(), force = false } = {}) {
  const { date } = officeNow(now);
  const monday = new Date(`${date}T12:00:00Z`).getUTCDay() === 1;
  let sent = 0;
  for (const c of db.all("SELECT * FROM companies WHERE report_frequency IN ('daily', 'weekly')")) {
    if (!force && (c.report_last === date || (c.report_frequency === 'weekly' && !monday))) continue;
    db.run('UPDATE companies SET report_last = ? WHERE id = ?', date, c.id);
    const weekAgo = new Date(Date.parse(`${date}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10);
    const rows = S.list({ role: 'customer', company_id: c.id }, { db }).filter((s) => s.status !== 'DELIVERED' || (s.delivery_date || '') >= weekAgo);
    const to = String(c.report_emails || c.emails || '').split(/[,;\s]+/).filter((e) => /.+@.+\..+/.test(e));
    if (!rows.length || !to.length) continue;
    await require('./notify').queueEmail({
      kind: 'CUSTOMER_REPORT', to, subject: `Shipment report — ${c.name} — ${date} (${rows.length})`, html: customerReportHtml(c, rows, date),
    }, { db });
    sent++;
  }
  return sent;
}

function start() {
  const tick = () => {
    if (officeNow().hour < 7) return;
    if (store.db.setting('lfd_alerts') === '1') sendDigest().catch((e) => console.error('LFD digest:', e.message));
    if (store.db.setting('daily_digest') === '1') sendDailyDigests().catch((e) => console.error('Daily digest:', e.message));
    if (store.db.setting('customer_reports') === '1') sendCustomerReports().catch((e) => console.error('Customer reports:', e.message));
  };
  tick();
  return setInterval(tick, 15 * 60000);
}

module.exports = { lfdDigest, sendDigest, sendDailyDigests, sendCustomerReports, start, officeNow };

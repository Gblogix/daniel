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

function start() {
  const tick = () => {
    if (store.db.setting('lfd_alerts') !== '1') return;
    if (officeNow().hour >= 7) sendDigest().catch((e) => console.error('LFD digest:', e.message));
  };
  tick();
  return setInterval(tick, 15 * 60000);
}

module.exports = { lfdDigest, sendDigest, start, officeNow };

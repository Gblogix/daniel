/**
 * One-time: the Microsoft 365 mailboxes the owner gave for staff whose sign-in email differs. A user is matched by
 * first name (or the start of their sign-in email); nothing is set when it is not exactly one person, or when the
 * person already has a send-from mailbox — Admin › Users shows and edits it either way.
 */
const store = require('./db');

const STAFF_MAILBOXES = [
  { mailbox: 'jamesp@gblogix.com', names: ['james'] },
  { mailbox: 'JayL@gblogix.com', names: ['jay'], also: /^jae\w*\s+l/i }, // Jay may be signed up under his Korean name (Jaeho Lee)
];

function assignMailboxes({ db = store.db, list = STAFF_MAILBOXES } = {}) {
  const staff = db.all("SELECT id, name, email, mail_from FROM users WHERE role IN ('admin', 'staff') AND active = 1");
  const out = [];
  for (const m of list) {
    const first = (u) => String(u.name || '').trim().split(/\s+/)[0].toLowerCase();
    const local = (u) => String(u.email || '').split('@')[0].toLowerCase();
    let hits = staff.filter((u) => String(u.email).toLowerCase() === m.mailbox.toLowerCase());
    if (hits.length) { out.push({ mailbox: m.mailbox, user: hits[0].name, how: 'already the sign-in email' }); continue; }
    hits = staff.filter((u) => m.names.includes(first(u)) || m.names.some((n) => local(u).startsWith(n)) || (m.also && m.also.test(u.name || '')));
    if (hits.length !== 1) { out.push({ mailbox: m.mailbox, user: null, how: hits.length ? `${hits.length} possible users — set it on Admin › Users` : 'no matching user — set it on Admin › Users' }); continue; }
    const u = hits[0];
    if (u.mail_from) { out.push({ mailbox: m.mailbox, user: u.name, how: `kept ${u.mail_from}` }); continue; }
    db.run('UPDATE users SET mail_from = ? WHERE id = ?', m.mailbox, u.id);
    out.push({ mailbox: m.mailbox, user: u.name, how: 'set' });
  }
  return out;
}

module.exports = { assignMailboxes, STAFF_MAILBOXES };

/**
 * Debit / credit notes with overseas agents (NSC, Zhejiang …) — ours (printed by OPUS / this system) or theirs.
 * Read: note no., date, lines, debit / credit totals, file references, and turn every line into a side of the
 * agent account as we keep it: DEBIT = the agent owes us, CREDIT = we owe the agent.
 *   our D/N  : its DEBIT(+) lines → DEBIT, its CREDIT(-) lines (profit share …) → CREDIT
 *   their D/N: they charge us → CREDIT (and their credit lines → DEBIT)
 *   a C/N    : the whole note is a credit from its issuer
 * The text of a PDF keeps no column positions, so which amounts sat under CREDIT is worked out from the
 * "TOTAL <debit> <credit>" line (the subset of lines adding up to the credit total, credit-like wording first).
 */
const { chargeLines, labelled, labelDate, NUMBER_OK, references, matchVendor } = require('./vendorInvoice');

const CREDIT_WORDS = /PROFIT\s*SHARE|P\/S\b|REBATE|REFUND|CREDIT|DISCOUNT|COMMISSION|RETURN|DEDUCT|LESS\b/i;
const norm = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const round = (v) => Math.round(v * 100) / 100;
const money = (s) => Number(String(s).replace(/[^\d.]/g, ''));

function isNote(text) {
  const head = String(text || '').split(/\r?\n/).slice(0, 15).join(' ').toUpperCase();
  return /DEBIT\s*NOTE|CREDIT\s*NOTE|DEBIT\s*\/\s*CREDIT\s*NOTE|\bD\s*\/\s*N\s*(NO|#)|\bC\s*\/\s*N\s*(NO|#)|\bD\/C\s*NO/.test(head);
}

/** Indexes of the lines that make up `target` (credit-looking lines tried first); null when no exact subset. */
function creditSubset(lines, target) {
  const idx = lines.map((l, i) => i).sort((a, b) => Number(CREDIT_WORDS.test(lines[b].description)) - Number(CREDIT_WORDS.test(lines[a].description)));
  if (idx.length > 18) return null;
  let best = null;
  const walk = (k, sum, pick) => {
    if (best) return;
    if (Math.abs(sum - target) < 0.005) { best = [...pick]; return; }
    if (k >= idx.length || sum > target + 0.005) return;
    pick.push(idx[k]); walk(k + 1, sum + lines[idx[k]].amount, pick); pick.pop();
    walk(k + 1, sum, pick);
  };
  walk(0, 0, []);
  return best;
}

/**
 * Cross-check the lines with the printed balance: "BALANCE DUE TO <party> USD x" (direction given), or a plain
 * "Balance Amount USD x" (owed to the issuer).
 */
function balanceCheck(out, T, own, issuer) {
  const net = out.total;
  const dueTo = /BALANCE\s+DUE\s+TO\s+([A-Z][A-Z .,&()-]{2,60}?)\s+(?:USD\s*)?([\d,]+\.\d{2})/i.exec(T);
  const plain = !dueTo && /BALANCE\s*(?:AMOUNT)?\s*[:.]?\s*(?:USD\s*)?([\d,]+\.\d{2})/i.exec(T);
  let printed = null; let who = '';
  if (dueTo) { const toUs = own && norm(dueTo[1]).includes(own.split(' ')[0]); printed = money(dueTo[2]) * (toUs ? 1 : -1); who = dueTo[1].trim(); }
  else if (plain) { printed = money(plain[1]) * (issuer === 'us' ? 1 : -1) * (out.kind === 'CN' ? -1 : 1); who = issuer === 'us' ? 'us' : 'the agent'; }
  if (printed != null && Math.abs(Math.abs(printed) - Math.abs(net)) > 0.01) out.warnings.push(`Lines give a balance of ${Math.abs(net).toFixed(2)} but the note says ${Math.abs(printed).toFixed(2)} (to ${who}) — check the lines`);
}

function parseNote(text, { companies = [], ownName = 'GLOBALBRIDGE' } = {}) {
  const T = String(text || '');
  const U = T.toUpperCase();
  const lines = T.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  const head = lines.slice(0, 6).join(' ');
  const own = norm(ownName);
  // Issuer = the letterhead: the first lines before any "TO: / ATTN / MESSRS / AGENT :" block.
  // Stops at the title or the first "Label : value" line (the letterhead is often a logo image with no text at all).
  const letter = [];
  for (const l of lines.slice(0, 4)) {
    if (/^\s*(TO|ATTN|MESSRS|BILL\s*TO|AGENT|CUSTOMER|PARTNER)\b/i.test(l) || /^\s*(DEBIT|CREDIT)\s*NOTE\b|^\s*D\s*\/\s*[CN]\b|^\s*INVOICE\b/i.test(l) || /^\s*[A-Za-z][A-Za-z.\/ ]{1,24}\s*:/.test(l)) break;
    letter.push(l);
  }
  const ownWord = own.split(' ')[0];
  const has = (s) => Boolean(own) && norm(s).includes(ownWord);
  // Addressed to us ("Partner : GlobalBridge", "TO: GLOBALBRIDGE") or paid to someone else → the agent issued it.
  const toUs = lines.some((l) => /^\s*(TO|ATTN|MESSRS|PARTNER|BILL\s*TO|CUSTOMER|AGENT)\b[^:]*[:.]?/i.test(l) && has(l.replace(/^\s*(TO|ATTN|MESSRS|PARTNER|BILL\s*TO|CUSTOMER|AGENT)\b/i, '')));
  const benef = /BENEFICIARY(?:'S)?\s*(?:NAME)?\s*[:.]?\s*([^\n]+)/i.exec(T);
  const paidToUs = benef ? has(benef[1]) : null;
  const issuer = paidToUs === false || (toUs && !has(letter.join(' '))) ? 'them'
    : has(letter.join(' ')) || paidToUs === true ? 'us' : 'them';
  const kind = /CREDIT\s*NOTE/i.test(head) && !/DEBIT/i.test(head) ? 'CN' : 'DN';
  const out = { kind, issuer, warnings: [] };
  out.number = labelled(lines, /D\s*\/\s*C\s*(?:NOTE\s*)?NO\.?|D\s*\/\s*N\s*NO\.?|C\s*\/\s*N\s*NO\.?|(?:DEBIT|CREDIT)\s*NOTE\s*(?:NO\.?|#)|NOTE\s*NO\.?|INVOICE\s*NO\.?|REF(?:ERENCE)?\s*NO\.?/i, NUMBER_OK);
  out.date = labelDate(lines, /INV(?:OICE)?\.?\s*DATE|D\s*\/\s*C\s*DATE|(?:DEBIT|CREDIT)\s*NOTE\s*DATE|ISSUE\s*DATE|INVOICE\s*DATE|\bDATE\b/i);
  const agentRef = /AGENT\s*(?:FILING|REF(?:ERENCE)?)\s*NO\.?\s*[:.]?\s*([A-Z0-9-]{6,})/i.exec(T)
    || /HOUSE\s*(?:B\/L\s*)?NO\.?\s*[:.]?\s*(NSC[A-Z0-9]{6,})/i.exec(T) || /\b(NSC[A-Z]{2,5}\d{6,9})\b/.exec(U);
  out.agent_ref = agentRef ? agentRef[1] : null;
  out.refs = references(T);
  // Party: the agent named on it (never ourselves).
  // Party: the letterhead company ("NATIONAL SHIPPING. CO.,LTD" = "NATIONAL SHIPPING CO., LTD (국민해운)"), else an agent
  // named in the text, else the e-mail domain printed on it; never ourselves, never the shipper / consignee.
  const P = require('./party');
  const others = companies.filter((c) => norm(c.name) !== own);
  const top = letter.map((l) => P.norm(l)).filter((l) => l.length >= 4);
  const byLetter = others.find((c) => top.includes(P.norm(c.name)) || (c.short_name && top.includes(P.norm(c.short_name))));
  const byDomain = others.find((c) => String(`${c.emails || ''},${c.billing_emails || ''}`).toLowerCase().split(/[,;\s]+/)
    .some((e) => e.includes('@') && !/example$/.test(e) && new RegExp(`@${e.split('@')[1].replace(/\./g, '\\.')}\\b`, 'i').test(T)));
  out.party = (byLetter && { id: byLetter.id, name: byLetter.name })
    || matchVendor(T, others.filter((c) => require('../partyTypes').has(c, 'agent')), ownName)
    || (byDomain && { id: byDomain.id, name: byDomain.name })
    || (issuer === 'us' ? matchVendor(T, others, ownName) : null);

  // Debit / Credit printed per line ("… USD 8,600.00  8,600.00  0.00"): read both columns directly.
  const hdr = lines.findIndex((l) => /DESCRIPTION/i.test(l) && /DEBIT[^A-Z]*\s+CREDIT[^A-Z]*\s*$/i.test(l));
  if (hdr >= 0) {
    const AMT = /^\(?-?[\d,]*\d\.\d{2}\)?$/;
    const two = [];
    for (const l of lines.slice(hdr + 1)) {
      const flat = l.replace(/\s+/g, '').toUpperCase();
      if (/^(TOTAL|BALANCE|GRANDTOTAL|SUBTOTAL)/.test(flat)) break;
      const cells = l.trim().split(/\s{2,}/);
      if (cells.length < 3 || !AMT.test(cells[cells.length - 1]) || !AMT.test(cells[cells.length - 2])) continue;
      const debit = money(cells[cells.length - 2]); const credit = money(cells[cells.length - 1]);
      let k = 0;
      const bl = /^[A-Z]{4}[A-Z0-9]{6,}$/.test(cells[0]) && /\d{4}/.test(cells[0]) ? cells[k++] : null;
      const desc = cells[k];
      if (!desc || !/[A-Za-z]{2}/.test(desc)) continue;
      const rest = cells.slice(k + 1, -2);
      const rate = rest.length && AMT.test(rest[rest.length - 1]) ? money(rest[rest.length - 1]) : null;
      const qty = rest.find((c) => /^\d+(\.\d+)?$/.test(c));
      two.push({ description: desc.toUpperCase(), bl_no: bl, qty: qty != null ? Number(qty) : null, rate, amount: round(debit || credit), issuerCredit: !debit && credit > 0 });
    }
    if (two.length) {
      out.lines = two.map((l) => ({ description: l.description, bl_no: l.bl_no, qty: l.qty, rate: l.rate, amount: l.amount,
        side: (issuer === 'us') !== (kind === 'CN' || l.issuerCredit) ? 'DEBIT' : 'CREDIT' }));
      out.total = round(out.lines.reduce((a, l) => a + (l.side === 'DEBIT' ? l.amount : -l.amount), 0));
      balanceCheck(out, T, own, issuer);
      if (!out.number) out.warnings.push('Note number not found');
      if (!out.party) out.warnings.push('Agent not recognised — pick it from the list');
      return out;
    }
  }

  // Lines: "M KMHB2409001 TRUCKING CHARGE 650.00 C 650.00" → description + B/L, amount = last figure.
  const raw = chargeLines(lines.map((l) => l.replace(/\s+[PC]\s+(?=[\d,]+\.\d{2}\s*$)/, '  ')));
  const items = raw.map((l) => {
    let d = l.description.replace(/^[MH]\s+/, '');
    const bl = /^([A-Z]{4}[A-Z0-9]{6,})\s+/.exec(d);
    if (bl && /\d{4}/.test(bl[1])) d = d.slice(bl[0].length);
    return { description: d.replace(/\s+\d[\d,.]*$/, '').trim(), bl_no: bl ? bl[1] : null, amount: Math.abs(l.amount), negative: l.amount < 0 };
  }).filter((l) => l.description && !/^(TOTAL|GRAND|BALANCE)/.test(l.description));

  // Which lines are credits (from the issuer's side): negative figures, else the subset matching the credit total.
  const tot = /(?:^|\n)\s*TOTAL\s+(?:USD\s*)?([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s*(?:\n|$)/i.exec(T);
  let creditIdx = new Set(items.map((l, i) => (l.negative ? i : -1)).filter((i) => i >= 0));
  if (!creditIdx.size && tot) {
    const sub = creditSubset(items, money(tot[2]));
    if (sub) creditIdx = new Set(sub);
    else out.warnings.push('Could not tell which lines are credits — check the Debit / Credit column of each line');
  } else if (!creditIdx.size && kind === 'DN') {
    items.forEach((l, i) => { if (CREDIT_WORDS.test(l.description)) creditIdx.add(i); });
  }
  const issuerCredit = (i) => (kind === 'CN' ? true : creditIdx.has(i));
  // Our books: issuer = us → issuer's debit is the agent's debt (DEBIT); issuer = agent → flipped.
  out.lines = items.map((l, i) => ({ description: l.description, bl_no: l.bl_no, amount: round(l.amount),
    side: (issuer === 'us') !== issuerCredit(i) ? 'DEBIT' : 'CREDIT' }));
  const net = round(out.lines.reduce((a, l) => a + (l.side === 'DEBIT' ? l.amount : -l.amount), 0));
  out.total = net;
  balanceCheck(out, T, own, issuer);
  if (!out.number) out.warnings.push('Note number not found');
  if (!out.party) out.warnings.push('Agent not recognised — pick it from the list');
  if (!out.lines.length) out.warnings.push('No lines read — enter them from the note');
  return out;
}

module.exports = { isNote, parseNote, creditSubset };

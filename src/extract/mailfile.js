/**
 * Emails dragged in from Outlook arrive as a .msg file (Outlook desktop) or .eml (web / other clients).
 * expandMailFiles() replaces each of them with its attachments, so "drag the whole email onto the page" works the same
 * as dragging the PDF itself. Inline pictures (signature logos) are skipped.
 */
const path = require('node:path');

const MIME = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel', '.csv': 'text/csv', '.txt': 'text/plain' };
const isMail = (name) => /\.(msg|eml)$/i.test(name || '');
const extOf = (name) => path.extname(name || '').toLowerCase();

function fromMsg(buffer) {
  const MsgReader = require('@kenjiuno/msgreader').default;
  const r = new MsgReader(buffer);
  const info = r.getFileData();
  if (info.error) throw new Error(info.error);
  return {
    subject: info.subject || '',
    from: info.senderSmtpAddress || info.senderEmail || '',
    attachments: (info.attachments || []).filter((a) => !a.innerMsgContent).map((a) => {
      const f = r.getAttachment(a);
      return { filename: f.fileName || a.fileName || 'attachment', content: Buffer.from(f.content), inline: Boolean(a.pidContentId && /^image\//.test(a.attachMimeTag || '')), cid: a.pidContentId };
    }),
  };
}

async function fromEml(buffer) {
  const { simpleParser } = require('mailparser');
  const m = await simpleParser(buffer);
  return {
    subject: m.subject || '',
    from: m.from?.value?.[0]?.address || '',
    attachments: (m.attachments || []).map((a) => ({ filename: a.filename || 'attachment', content: a.content, inline: a.contentDisposition === 'inline' && /^image\//.test(a.contentType || ''), cid: a.cid })),
  };
}

/** @returns {Promise<{ files: {buffer, filename, mime, mail?}[], mails: {subject, from, count}[] }>} */
async function expandMailFiles(files, { accept = null } = {}) {
  const out = [];
  const mails = [];
  for (const f of files) {
    if (!isMail(f.filename)) { out.push(f); continue; }
    let mail;
    try { mail = /\.msg$/i.test(f.filename) ? fromMsg(f.buffer) : await fromEml(f.buffer); } catch (e) {
      mails.push({ subject: f.filename, error: 'could not open this email file' });
      continue;
    }
    let count = 0;
    for (const a of mail.attachments) {
      const ext = extOf(a.filename);
      if (a.inline || (/^image\//.test(MIME[ext] || '') && a.content.length < 15 * 1024)) continue; // logos / signatures
      if (accept && !accept.includes(ext)) continue;
      out.push({ buffer: a.content, filename: a.filename, mime: MIME[ext] || 'application/octet-stream', mail: { subject: mail.subject, from: mail.from } });
      count++;
    }
    mails.push({ subject: mail.subject, from: mail.from, count });
  }
  return { files: out, mails };
}

module.exports = { expandMailFiles, isMail };

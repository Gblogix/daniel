const path = require('node:path');

const root = path.resolve(__dirname, '..');

const cfg = module.exports = {
  root,
  port: Number(process.env.PORT || 3000),
  baseUrl: (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  dbPath: process.env.DB_PATH || path.join(root, 'data', 'gblogix.db'),
  uploadDir: process.env.UPLOAD_DIR || path.join(root, 'uploads'),
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-change-me',
  company: {
    name: 'GlobalBridge Logistics',
    short: 'GB Logix',
    address: process.env.COMPANY_ADDRESS || '',
    phone: process.env.COMPANY_PHONE || '',
    email: process.env.COMPANY_EMAIL || 'info@gblogix.com',
  },
  // Email: when SMTP_HOST is unset, messages are stored in the outbox only ("logged").
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'GlobalBridge Logistics <info@gblogix.com>',
  },
  // Microsoft 365 / Outlook (Graph API). When set, notices are sent from this mailbox instead of SMTP.
  graph: {
    tenantId: process.env.MS_TENANT_ID || '',
    clientId: process.env.MS_CLIENT_ID || '',
    clientSecret: process.env.MS_CLIENT_SECRET || '',
    mailbox: process.env.MS_MAILBOX || process.env.COMPANY_EMAIL || 'info@gblogix.com',
    // Optional: pull agent emails with PDF attachments from this folder into Document intake.
    intake: process.env.MS_MAIL_INTAKE === 'on',
    intakeFolder: process.env.MS_INTAKE_FOLDER || 'inbox',
    intakeMinutes: Number(process.env.MS_INTAKE_MINUTES || 10),
  },
  // Optional AI document extraction. Without a key, rule-based extraction is used.
  ai: {
    enabled: Boolean(process.env.ANTHROPIC_API_KEY) && process.env.AI_EXTRACTION !== 'off',
    model: process.env.AI_MODEL || 'claude-opus-5',
  },
};

cfg.graph.enabled = Boolean(cfg.graph.tenantId && cfg.graph.clientId && cfg.graph.clientSecret);
cfg.mailTransport = cfg.graph.enabled ? 'outlook' : cfg.smtp.host ? 'smtp' : 'log';

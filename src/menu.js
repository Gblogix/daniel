/**
 * Staff menu (OPUS style): categories in the left drawer, each with columns of pages. Every page opens as a tab.
 * `id` is what a user's favorites store; `acct` = accounting users only, `admin` = admins only.
 */
const auth = require('./auth');

const MENU = [
  { key: 'main', label: 'Main', icon: '🏠', cols: [
    { head: 'Main', items: [{ id: 'dashboard', label: 'Dashboard', href: '/dashboard' }] },
  ] },
  { key: 'shipments', label: 'Shipments', icon: '🚢', cols: [
    { head: 'Files', items: [
      { id: 'ship-list', label: 'Shipment list (open)', href: '/shipments' },
      { id: 'ship-new', label: 'New shipment', href: '/shipments/new' },
      { id: 'ship-active', label: 'Active — before delivery', href: '/shipments?stage=active' },
      { id: 'ship-delivered', label: 'Delivered — billing open', href: '/shipments?stage=delivered' },
      { id: 'history', label: 'Shipment history (closed)', href: '/history' },
    ] },
    { head: 'Tracking', items: [
      { id: 'track', label: 'Tracking board', href: '/track' },
      { id: 'track-delivered', label: 'Delivered cards', href: '/track?filter=delivered' },
      { id: 'lfd', label: 'Arrivals / LFD watch', href: '/dashboard#lfd' },
    ] },
  ] },
  { key: 'documents', label: 'Documents', icon: '📄', cols: [
    { head: 'Intake', items: [
      { id: 'intake', label: 'Document intake (review)', href: '/intakes' },
      { id: 'upload', label: 'Upload documents', href: '/portal' },
    ] },
    { head: 'Email', items: [{ id: 'outbox', label: 'Outbox / sent notices', href: '/outbox' }] },
  ] },
  { key: 'accounting', label: 'Accounting', icon: '🧮', acct: true, cols: [
    { head: 'Operation', items: [
      { id: 'ar-entry', label: 'A/R invoice entry', href: '/invoices/new?kind=AR' },
      { id: 'ap-entry', label: 'A/P vendor bill entry', href: '/invoices/new?kind=AP' },
      { id: 'dn-entry', label: 'Debit / credit note (agent)', href: '/invoices/new?kind=DN' },
    ] },
    { head: 'Banking', items: [
      { id: 'billing', label: 'Billing overview', href: '/billing' },
      { id: 'settle', label: 'Check & settle (vendors)', href: '/billing#payables' },
      { id: 'payment', label: 'Record payment', href: '/billing#pay' },
      { id: 'soa', label: 'Agent statement (SOA)', href: '/billing#agents' },
    ] },
    { head: 'Report', items: [
      { id: 'aging', label: 'AR aging', href: '/billing#aging' },
      { id: 'pl', label: 'P&L by file', href: '/billing/profit' },
      { id: 'not-invoiced', label: 'Delivered — not invoiced', href: '/shipments?stage=delivered&bill=not_invoiced' },
      { id: 'not-paid', label: 'Invoiced — not paid', href: '/shipments?stage=delivered&bill=unpaid' },
    ] },
  ] },
  { key: 'master', label: 'Master Code', icon: '🗂', cols: [
    { head: 'Parties', items: [{ id: 'parties', label: 'Parties (customers, agents, vendors)', href: '/companies' }] },
  ] },
  { key: 'admin', label: 'Administration', icon: '⚙', admin: true, cols: [
    { head: 'Administration', items: [
      { id: 'users', label: 'Users & access', href: '/admin/users' },
      { id: 'settings', label: 'Automation / Smartsheet / tracking', href: '/admin/settings' },
      { id: 'company', label: 'Company profile & numbering', href: '/admin/company' },
    ] },
  ] },
];

const DEFAULT_FAVORITES = ['dashboard', 'ship-list', 'track', 'intake', 'ar-entry', 'settle'];

function menuFor(user) {
  const acct = auth.canAccounting(user);
  return MENU.filter((m) => (!m.acct || acct) && (!m.admin || user.role === 'admin'));
}

function items(user) {
  return menuFor(user).flatMap((m) => m.cols.flatMap((c) => c.items));
}

/** The user's favorites (ids), limited to pages they may open. */
function favoritesFor(user) {
  let ids = null;
  try { ids = JSON.parse(user.favorites || 'null'); } catch { ids = null; }
  if (!Array.isArray(ids)) ids = DEFAULT_FAVORITES;
  const allowed = new Set(items(user).map((i) => i.id));
  return ids.filter((id) => allowed.has(id));
}

module.exports = { MENU, DEFAULT_FAVORITES, menuFor, items, favoritesFor };

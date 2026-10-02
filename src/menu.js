/**
 * Staff menu (OPUS style): categories in the left drawer, each with columns of pages. Every page opens as a tab.
 * `id` is what a user's favorites store; `acct` = accounting users only, `admin` = admins only.
 */
const auth = require('./auth');

const MENU = [
  { key: 'main', label: 'Main', icon: '🏠', cols: [
    { head: 'Main', items: [{ id: 'dashboard', label: 'Dashboard', href: '/dashboard' }, { id: 'followups', label: 'Follow-ups (my to-do)', href: '/followups' }] },
  ] },
  { key: 'shipments', label: 'Shipments', icon: '🚢', cols: [
    { head: 'Files', items: [
      { id: 'ship-list', label: 'Shipment list (open)', href: '/shipments' },
      { id: 'ship-mine', label: 'My files', href: '/shipments?mine=1' },
      { id: 'masters', label: 'Master B/L list (MB/L · MAWB)', href: '/masters' },
      { id: 'master-new', label: 'New ocean master (MB/L)', href: '/masters/new', perm: 'shipments_edit' },
      { id: 'master-new-air', label: 'New air master (MAWB)', href: '/masters/new?mode=AIR', perm: 'shipments_edit' },
      { id: 'ship-new', label: 'New house / shipment', href: '/shipments/new', perm: 'shipments_edit' },
      { id: 'misc-new', label: 'New other file (non-shipment invoices)', href: '/shipments/new?mode=OTHER', perm: 'shipments_edit' },
      { id: 'misc-list', label: 'Other files (non-shipment)', href: '/shipments?mode=OTHER' },
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
      { id: 'intake', label: 'Document hub (review uploads)', href: '/intakes' },
      { id: 'upload', label: 'Upload documents', href: '/portal' },
    ] },
    { head: 'Email', items: [{ id: 'outbox', label: 'Outbox / sent notices', href: '/outbox' }] },
  ] },
  { key: 'accounting', label: 'Accounting', icon: '🧮', perm: 'accounting', cols: [
    { head: 'Operation', items: [
      { id: 'vendor-bills', label: 'Vendor invoices & agent D/N · C/N — upload & book', href: '/vendor-bills' },
      { id: 'ar-entry', label: 'A/R invoice entry', href: '/invoices/new?kind=AR' },
      { id: 'ap-entry', label: 'A/P vendor bill entry', href: '/invoices/new?kind=AP' },
      { id: 'dn-entry', label: 'Debit / credit note (agent)', href: '/invoices/new?kind=DN' },
    ] },
    { head: 'Banking', items: [
      { id: 'billing', label: 'Billing overview', href: '/billing' },
      { id: 'settle', label: 'Check & settle (vendors)', href: '/billing#payables' },
      { id: 'payment', label: 'Record payment', href: '/billing#pay' },
      { id: 'soa', label: 'Agent statement (SOA)', href: '/billing#agents' },
      { id: 'qbo', label: 'QuickBooks Online — connect & sync', href: '/billing/quickbooks' },
    ] },
    { head: 'Report', items: [
      { id: 'aging', label: 'Aging report (A/R · A/P · D/N · C/N)', href: '/billing/aging' },
      { id: 'soa-party', label: 'Statement of account (any party)', href: '/billing/aging?side=all' },
      { id: 'pl', label: 'P&L by file', href: '/billing/profit' },
      { id: 'not-invoiced', label: 'Delivered — not invoiced', href: '/shipments?stage=delivered&bill=not_invoiced' },
      { id: 'not-paid', label: 'Invoiced — not paid', href: '/shipments?stage=delivered&bill=unpaid' },
      { id: 'no-cost', label: 'Delivered — no cost booked', href: '/shipments?stage=delivered&bill=no_cost' },
    ] },
  ] },
  { key: 'master', label: 'Master Code', icon: '🗂', cols: [
    { head: 'Parties', items: [{ id: 'parties', label: 'Parties (customers, agents, vendors)', href: '/companies' }] },
  ] },
  { key: 'admin', label: 'Administration', icon: '⚙', cols: [
    { head: 'Users', items: [
      { id: 'permissions', label: 'Permissions (check / uncheck)', href: '/admin/permissions', perm: 'users' },
      { id: 'users', label: 'Users — invite, password', href: '/admin/users', perm: 'users' },
    ] },
    { head: 'Settings', items: [
      { id: 'settings', label: 'Automation / Smartsheet / tracking', href: '/admin/settings', perm: 'settings' },
      { id: 'company', label: 'Company profile & numbering', href: '/admin/company', perm: 'settings' },
    ] },
  ] },
];

// Left icon rail (GoFreight / OPUS style): one icon per line of work; hover shows its pages.
const RAIL = [
  { key: 'home', label: 'Dashboard', icon: 'home', href: '/dashboard' },
  { key: 'todo', label: 'Follow-ups (my to-do)', icon: 'flag', href: '/followups' },
  { key: 'ocean', label: 'Ocean Import', icon: 'ship', groups: [
    { head: 'New', items: [
      { label: 'New house — FCL', href: '/shipments/new?mode=FCL', perm: 'shipments_edit' },
      { label: 'New house — LCL', href: '/shipments/new?mode=LCL', perm: 'shipments_edit' },
      { label: 'New ocean master (MB/L)', href: '/masters/new', perm: 'shipments_edit' },
      { label: 'Upload B/L / pre-alert', href: '/portal' },
    ] },
    { head: 'Lists', items: [
      { label: 'My shipments', href: '/shipments?mode=OCEAN&mine=1' },
      { label: 'Master B/L list', href: '/masters?mode=OCEAN' },
      { label: 'House B/L list', href: '/shipments?mode=OCEAN' },
      { label: 'Tracking board', href: '/track' },
      { label: 'Arrivals / LFD watch', href: '/dashboard#lfd' },
    ] },
  ] },
  { key: 'air', label: 'Air Import', icon: 'plane', groups: [
    { head: 'New', items: [
      { label: 'New house — HAWB', href: '/shipments/new?mode=AIR', perm: 'shipments_edit' },
      { label: 'New air master (MAWB)', href: '/masters/new?mode=AIR', perm: 'shipments_edit' },
      { label: 'Upload AWB / pre-alert', href: '/portal' },
    ] },
    { head: 'Lists', items: [
      { label: 'My shipments', href: '/shipments?mode=AIR&mine=1' },
      { label: 'MAWB list', href: '/masters?mode=AIR' },
      { label: 'HAWB list', href: '/shipments?mode=AIR' },
    ] },
  ] },
  { key: 'truck', label: 'Truck', icon: 'truck', groups: [
    { head: 'Truck', items: [
      { label: 'New truck file', href: '/shipments/new?mode=TRUCK', perm: 'shipments_edit' },
      { label: 'Truck files', href: '/shipments?mode=TRUCK' },
    ] },
  ] },
  { key: 'misc', label: 'Other files', icon: 'folder', groups: [
    { head: 'Other (non-shipment)', items: [
      { label: 'New other file', href: '/shipments/new?mode=OTHER', perm: 'shipments_edit' },
      { label: 'Other files', href: '/shipments?mode=OTHER' },
    ] },
  ] },
  { key: 'docs', label: 'Documents', icon: 'doc', groups: [
    { head: 'Documents', items: [
      { label: 'Document hub (review uploads)', href: '/intakes' },
      { label: 'Upload documents', href: '/portal' },
      { label: 'Outbox / sent emails', href: '/outbox' },
      { label: 'Shipment history (closed)', href: '/history' },
    ] },
  ] },
  { key: 'acct', label: 'Accounting', icon: 'calc', perm: 'accounting', fromMenu: 'accounting' },
  { key: 'reports', label: 'Reports', icon: 'chart', perm: 'accounting', groups: [
    { head: 'Management', admin: true, items: [
      { label: 'Business dashboard', href: '/dashboard#management' },
      { label: 'Lost customers', href: '/insights/lost' },
      { label: 'Negative profit files', href: '/insights/negative' },
    ] },
    { head: 'Accounting', items: [
      { label: 'P&L by file', href: '/billing/profit' },
      { label: 'Aging report', href: '/billing/aging' },
      { label: 'Statement of account', href: '/billing/aging?side=all' },
    ] },
  ] },
  { key: 'parties', label: 'Parties', icon: 'users', href: '/companies' },
  { key: 'admin', label: 'Administration', icon: 'gear', fromMenu: 'admin' },
];

/** The rail this user may see (empty groups / sections dropped). */
function railFor(user) {
  const ok = (x) => !x.perm || auth.can(user, x.perm);
  const menu = menuFor(user);
  return RAIL.filter(ok).map((r) => {
    if (r.fromMenu) {
      const m = menu.find((x) => x.key === r.fromMenu);
      return m ? { ...r, groups: m.cols.map((c) => ({ head: c.head, items: c.items })) } : null;
    }
    if (!r.groups) return r;
    const groups = r.groups.filter((g) => !g.admin || user.role === 'admin').map((g) => ({ ...g, items: g.items.filter(ok) })).filter((g) => g.items.length);
    return groups.length ? { ...r, groups } : null;
  }).filter(Boolean);
}

const DEFAULT_FAVORITES = ['dashboard', 'followups', 'ship-list', 'track', 'intake', 'vendor-bills', 'ar-entry', 'settle'];

/** The menu this user may see: categories and pages filtered by their permissions; empty columns / categories dropped. */
function menuFor(user) {
  const ok = (x) => !x.perm || auth.can(user, x.perm);
  return MENU.filter(ok)
    .map((m) => ({ ...m, cols: m.cols.map((c) => ({ ...c, items: c.items.filter(ok) })).filter((c) => c.items.length) }))
    .filter((m) => m.cols.length);
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

module.exports = { MENU, RAIL, DEFAULT_FAVORITES, menuFor, railFor, items, favoritesFor };

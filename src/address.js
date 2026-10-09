/**
 * Tidy a postal address: lists merged from several columns / documents repeat the street, the city, the company
 * name and the state ("1525 W COMMONWEALTH AVE, SOLVENZA TRADE INC / 1525 W COMMONWEALTH AVE / FULLERTON, CA 92833
 * UNITED STATES, FULLERTON, CA, CALIFORNIA, 92833"). Keeps the first mention of everything, in order.
 */
const STATES = { ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY' };
const COUNTRIES = /^(UNITED STATES( OF AMERICA)?|USA|U\.?S\.?A\.?|US|KOREA|SOUTH KOREA|REPUBLIC OF KOREA|CHINA|P\.?R\.? ?CHINA|JAPAN|VIET ?NAM|TAIWAN|HONG KONG|THAILAND|INDIA|INDONESIA|MALAYSIA|PHILIPPINES|SINGAPORE|CANADA|MEXICO)$/i;

const words = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9가-힣]+/g, ' ').trim().split(/\s+/).filter(Boolean);
const key = (s) => words(s).join(' ');

function tidy(addr, name = '') {
  if (!addr) return addr;
  const nameKey = key(String(name).replace(/[,.]?\s*(INC|LLC|LTD|CO|CORP|CORPORATION|COMPANY)\.?$/i, ''));
  const seen = new Set();
  let country = false;
  const out = [];
  for (const line of String(addr).split(/\r?\n/)) {
    const kept = [];
    for (const raw of line.split(/,(?=\s)|,$/)) {
      const chunk = raw.trim();
      if (!chunk) continue;
      const k = key(chunk);
      if (!k) continue;
      // The company's own name inside its address.
      if (nameKey && (k === key(name) || k === nameKey || k.replace(/ (INC|LLC|LTD|CO|CORP)$/, '') === nameKey)) continue;
      // A second country (e.g. "UNITED STATES" appended to a Korean address) or the same one again.
      const bare = chunk.replace(/\.$/, '');
      if (COUNTRIES.test(bare) && country) continue;
      // Everything in it already said (repeated street / city / zip; "CALIFORNIA" after "CA").
      const ws = words(chunk).map((w) => STATES[w] || w);
      const full = STATES[k];
      if ((full && seen.has(full)) || ws.every((w) => seen.has(w))) continue;
      ws.forEach((w) => seen.add(w));
      if (COUNTRIES.test(bare) || /\b(KOREA|CHINA|UNITED STATES|U\.?S\.?A)\b/i.test(chunk)) country = true;
      kept.push(chunk);
    }
    if (kept.length) out.push(kept.join(', '));
  }
  return out.join('\n');
}

module.exports = { tidy };

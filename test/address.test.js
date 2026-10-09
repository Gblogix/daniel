// Address tidy (merged imports repeat street / city / name / state) and the A/N without prices (made-up data).
const test = require('node:test');
const assert = require('node:assert/strict');
const { tidy } = require('../src/address');

test('repeated street, city, zip, state name and the company name are dropped', () => {
  assert.equal(tidy('1525 W. SAMPLE AVE, SAMPLE TRADE INC\n1525 W. SAMPLE AVE\nFULLERTON, CA 92833 UNITED STATES, FULLERTON, CA, CALIFORNIA, 92833', 'SAMPLE TRADE INC'),
    '1525 W. SAMPLE AVE\nFULLERTON, CA 92833 UNITED STATES');
  assert.equal(tidy('3F, 12, SAMPLE-RO 79-GIL, GANGNAM-GU, SEOUL, REPUBLIC OF KOREA\nTEL: +82 70-0000-0000 ATT: KIM, SAMPLE INTERNATIONAL INC\n3F, 12, SAMPLE-RO 79-GIL, GANGNAM-GU, SEOUL, REPUBLIC OF KOREA\nUNITED STATES', 'SAMPLE INTERNATIONAL INC'),
    '3F, 12, SAMPLE-RO 79-GIL, GANGNAM-GU, SEOUL, REPUBLIC OF KOREA\nTEL: +82 70-0000-0000 ATT: KIM');
});

test('a normal address is left alone', () => {
  assert.equal(tidy('100 MAIN ST, SUITE 100\nLOS ANGELES, CA 90001', 'X'), '100 MAIN ST, SUITE 100\nLOS ANGELES, CA 90001');
  assert.equal(tidy('', 'X'), '');
});

test('A/N without prices: no charges, no amount due, no invoice no.', () => {
  const T = require('../src/docs/templates');
  const s = { mode: 'AIR', items: [], containers: [], hbl_no: 'H1', charges: [{ description: 'AIR FREIGHT', amount: 500 }] };
  const inv = { number: 'GBL-INV1', total: 500, paid_amount: 0, due_date: '2026-10-20', lines: [{ description: 'AIR FREIGHT', amount: 500 }] };
  const withP = T.arrivalNotice(s, { company: {}, invoice: inv });
  const without = T.arrivalNotice(s, { company: {}, invoice: inv, prices: false });
  assert.match(withP, /USD 500\.00/);
  assert.match(withP, /GBL-INV1/);
  assert.doesNotMatch(without, /500\.00/);
  assert.doesNotMatch(without, /GBL-INV1/);
});

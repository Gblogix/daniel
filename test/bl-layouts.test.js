// B/L layouts seen in real files (names / numbers made up): carrier waybill with label rows over value rows,
// NSC house B/L with printed-graphic labels (values only) + rider page, ISF sheet with numbered boxes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractRules } = require('../src/extract/rules');
const { mergeExtractions } = require('../src/extract/index');

const MBL = `Dear Customer, please note that any changes to payment terms or prepaid payer made after vessel departure and invoice issuance may incur a payer amendment fee.
NON-NEGOTIABLE WAYBILL  SCAC  MAEU
B/L No. 261234567
Shipper (As principal, where “care of”, “c/o”, or other variants used.)  Booking No.
NATIONAL SHIPPING CO LTD  261234567
11 DANGSANRO41-GIL
Consignee (Negotiable only if consigned "to order", "to order of" a named Person or "to order of bearer".
As principal, where “care of”, “c/o”, or other variants used.)
GLOBALBRIDGE LOGISTICS
1661 N.RAYMOND AVE., SUITE 140F, ANAHEIM, CA 92801  This contract is subject to the terms, conditions and exceptions
Notify Party (see clause 22)  the Carrier reasonable notice in writing.
GLOBALBRIDGE LOGISTICS  Delivery will be made to the Consignee or his authorised agent on production of reasonable proof of
Onward inland routing (Not part of Carriage as defined in clause 1. For account and risk of Merchant)
Vessel  Voyage No.  Place of Receipt. Applicable only when document used as Multimodal Waybill
MAERSK CAP SAMPLE  612E
Port of Loading  Port of Discharge  Place of Delivery. Applicable only when document used as Multimodal Transport B/L. (see clause 1)
Busan  Long Beach
Kind of Packages; Description of goods; Marks and Numbers; Container No./Seal No.  Weight  Measurement
10000.000 KGS  50.0000 CBM
2 containers said to contain 30 PACKAGES
FACIAL SERUM
B/L: 261234567  Page : 2
MNBU4117750 ML-KR1170001 40 REEF 9'6 12 PACKAGES 4000.000 KGS 20.0000 CBM
MNBU3596983 ML-KR1170002 40 REEF 9'6 18 PACKAGES 6000.000 KGS 30.0000 CBM
CY/CY`;

const HBL = `SAMPLE BEAUTY CO.,LTD
46F, 100 YEOUI-DAERO, YEONGDEUNGPO-GU,
SEOUL, REPUBLIC OF KOREA  NSCLGB26019999
BRIGHT TRADE INC
100 W MAIN AVE
FULLERTON, CA 92833
TEL) (213) 555-0101
E-MAIL : OPS@BRIGHTTRADE.EXAMPLE
SAME AS CONSIGNEE
BUSAN, KOREA
MAERSK CAP SAMPLE 612E  BUSAN, KOREA
LONG BEACH, U.S.A.  LONG BEACH, U.S.A.
40RHX2  30 PACKAGES  "SHIPPER'S LOAD & COUNT"  10,000.000KGS  50.000CBM
LADEN ON BOARD
SEP.28.2026
== ATTACHED RIDER ==
HOUSE B/L NO : NSCLGB26019999
MNBU3596983/KR1170002(40RH)/18(PACKAGES)  *INVOICE NO. : UB005
6,000.000KGS/30.000CBM
MNBU4117750/KR1170001(40RH)/12(PACKAGES)
4,000.000KGS/20.000CBM`;

const ISF = `2. Seller Name & Address
SAMPLE BEAUTY CO.,LTD
Container No. /  MNBU3596983 / KR1170002 (40RH)
Seal No.  MNBU4117750 / KR1170001 (40RH)
Carrier's SCAC CODE  MAEU
AMS House B/L Number  COUNTRY OF ORIGIN
REPUBLIC OF KOREA
3. Buyer Name & Address ( Importer of Record)  HTS CODE
(KSCT) LGB26019999A
BRIGHT TRADE INC
1525 W MAIN AVE  3304.99 , 3305.10
House B/L Number  Master B/L or Booking#
TEL) (213) 555-0101
E-MAIL : OPS@BRIGHTTRADE.EXAMPLE  NSCLGB26019999  MAEU261234567
VESSEL NAME / VOYAGE  ETD:  ETA:
MAERSK CAP SAMPLE / 612E  2026-09-28  2026-10-12`;

test('carrier waybill: values under label rows, SCAC prefix, per-container seal / size / figures', () => {
  const r = extractRules(MBL, { filename: 'MAEU261234567.pdf' });
  assert.equal(r.mbl_no, 'MAEU261234567');
  assert.equal(r.hbl_no, null);
  assert.deepEqual([r.vessel, r.voyage, r.pol, r.pod], ['MAERSK CAP SAMPLE', '612E', 'BUSAN', 'LONG BEACH']);
  assert.equal(r.place_of_delivery, null, 'empty box stays empty — no contract prose');
  assert.equal(r.shipper_name, 'NATIONAL SHIPPING CO LTD');
  assert.equal(r.service_term, 'CY/CY');
  assert.deepEqual(r.containers, [
    { container_no: 'MNBU4117750', seal_no: 'ML-KR1170001', size_type: '40RH', packages: 12, weight_kg: 4000, cbm: 20 },
    { container_no: 'MNBU3596983', seal_no: 'ML-KR1170002', size_type: '40RH', packages: 18, weight_kg: 6000, cbm: 30 },
  ]);
});

test('NSC house B/L without printed labels + rider; ISF numbered boxes; merged draft', () => {
  const h = extractRules(HBL, { filename: 'BL_NSCLGB26019999.pdf' });
  assert.deepEqual([h.hbl_no, h.shipper_name, h.consignee_name, h.notify_party], ['NSCLGB26019999', 'SAMPLE BEAUTY CO.,LTD', 'BRIGHT TRADE INC', 'SAME AS CONSIGNEE']);
  assert.deepEqual([h.vessel, h.voyage, h.pol, h.pod, h.place_of_delivery, h.etd], ['MAERSK CAP SAMPLE', '612E', 'BUSAN, KOREA', 'LONG BEACH, U.S.A', 'LONG BEACH, U.S.A', '2026-09-28']);
  assert.equal(h.consignee_address, '100 W MAIN AVE\nFULLERTON, CA 92833');
  assert.deepEqual(h.consignee_contact, { email: 'ops@brighttrade.example', phone: '(213) 555-0101' });
  assert.equal(h.containers.find((c) => c.container_no === 'MNBU3596983').weight_kg, 6000);

  const i = extractRules(ISF, { filename: 'ISF_NSCLGB26019999.pdf' });
  assert.deepEqual([i.hbl_no, i.mbl_no, i.scac, i.ams_bl_no], ['NSCLGB26019999', 'MAEU261234567', 'MAEU', 'KSCTLGB26019999A']);
  assert.deepEqual([i.vessel, i.voyage, i.etd, i.eta], ['MAERSK CAP SAMPLE', '612E', '2026-09-28', '2026-10-12']);
  assert.equal(i.consignee_name, 'BRIGHT TRADE INC');

  const m = { ...extractRules(MBL, { filename: 'MAEU261234567.pdf' }), doc_type: 'MBL' };
  const d = mergeExtractions([m, { ...h, doc_type: 'HBL' }, { ...i, doc_type: 'ISF' }]);
  assert.equal(d.consignee_name, 'BRIGHT TRADE INC', 'house consignee wins over the carrier B/L (us)');
  assert.equal(d.carrier, 'Maersk');
  assert.equal(d.eta, '2026-10-12');
  assert.equal(d.containers.length, 2);
});

test('heads-up when the B/L names an invoice with no C/I / P/L uploaded', () => {
  const h = { ...extractRules(HBL, { filename: 'BL.pdf' }), doc_type: 'HBL' };
  assert.deepEqual(h.invoice_refs, ['UB005']);
  const pl = { doc_type: 'PL', ci_invoice_no: 'EZVC_TGT_26-09', items: [{ description: 'x', invoice_no: 'EZVC_TGT_26-09' }], packages: 788, weight_kg: 3157.27, containers: [], warnings: [] };
  const pl2 = { ...pl, ci_invoice_no: 'BSBUS26091601', items: [{ description: 'y', invoice_no: 'BSBUS26091601' }], packages: 136, weight_kg: 697.8 };
  const d = mergeExtractions([h, pl, pl2]);
  assert.deepEqual(d.missing_invoices, ['UB005']);
  assert.equal(d.items.length, 2);
  assert.ok(d.warnings.some((w) => /UB005/.test(w)));
  assert.ok(!d.warnings.some((w) => /packages differs/.test(w)), 'a P/L total is not compared with the B/L total');
});

// IATA air waybill (labels are printed graphics, only values come out). Master and house share the header line.
const MAWB = `180 ICN 12345675  180-12345675
SAMPLE SHIPPING CO., LTD.  SKY SAMPLE AIR INC
11, SAMPLE-RO, SEOUL, REPUBLIC OF KOREA
TEL: 02-000-0000
GLOBAL BRIDGE LOGISTICS
1661 N.RAYMOND AVE., SUITE 140F, ANAHEIM,
CA 92801
"FREIGHT PREPAID"
SAMPLE HANDLING KOREA CO.,LTD  SAME AS CONSIGNEE
INCHEON AIRPORT, KOREA
LAX KE  KRW  N.V.D
LOS ANGELES,CA U.S.A.  KE017/01.OCT.2026  NIL
1  150.0 KQ  180.0  AS AGREED  CONSOLIDATION SHIPMENT AS
PER ATTACHED MANIFEST
SAMPLE HANDLING KOREA CO.,LTD
AGENT FOR THE CARRIER : SKY SAMPLE AIR INC
01.OCT.26 INCHEON, KOREA  ADMINISTRATOR`;

const HAWB = `180 ICN 12345675  NSCXA2600001
SAMPLE SHIPPING CO., LTD.
MAPLE COSMETICS INC.
1F, 1, SAMPLE-DAERO, SEOUL,  11, SAMPLE-RO, SEOUL
REPUBLIC OF KOREA (00000)  REPUBLIC OF KOREA
TEL: +82 70-0000-0000 ATT: KIM  TEL : 02-000-0000
E-MAIL: KIM@MAPLE.EXAMPLE
HARBOR TRADE INC
100 W SAMPLE AVE FULLERTON, CA 92833
TEL) (213) 555-0100
E-MAIL: BUYER@HARBOR.EXAMPLE
"FREIGHT COLLECT"
SAMPLE SHIPPING CO., LTD.  SAMPLE CREDIT, INC.
1 S SAMPLE ST, LOS ANGELES, CA
INCHEON AIRPORT, KOREA
LAX  KE  USD  C  C  N.V.D
LOS ANGELES,CA U.S.A.  KE017/01.OCT.2026  NIL
1  150.0 K Q  180.0  AS AGREED  LIP TINT
INVOICE NO.:
#MCUS26090001
SAMPLE SHIPPING CO., LTD.
AGENT FOR THE CARRIER : SKY SAMPLE AIR INC
01.OCT.26 INCHEON, KOREA  K.W HAN`;

test('air waybill: MAWB reads as master, HAWB as house under the same MAWB', () => {
  const m = extractRules(MAWB, { filename: 'MAWB_180-12345675.pdf' });
  assert.equal(m.doc_type, 'AWB');
  assert.equal(m.mbl_no, '180-12345675');
  assert.equal(m.doc_role, 'master');
  assert.ok(!m.hbl_no);
  assert.equal(m.flight_no, 'KE017');
  assert.equal(m.etd, '2026-10-01');
  assert.equal(m.weight_kg, 150);

  const h = extractRules(HAWB, { filename: 'HAWB_NSCXA2600001.pdf' });
  assert.equal(h.doc_role, 'house');
  assert.equal(h.mbl_no, '180-12345675');
  assert.equal(h.hbl_no, 'NSCXA2600001');
  assert.equal(h.shipper_name, 'MAPLE COSMETICS INC.');
  assert.equal(h.consignee_name, 'HARBOR TRADE INC');
  assert.equal(h.notify_party, 'SAMPLE CREDIT, INC.');
  assert.match(h.pol, /INCHEON/);
  assert.match(h.pod, /LOS ANGELES/);
  assert.equal(h.packages, 1);
  assert.equal(h.chargeable_weight, 180);

  const d = mergeExtractions([m, h]);
  assert.equal(d.mode, 'AIR');
  assert.equal(d.hbl_no, 'NSCXA2600001');
  assert.equal(d.shipper_name, 'MAPLE COSMETICS INC.');
  assert.equal(d.consignee_name, 'HARBOR TRADE INC');
});

test("IATA air waybill box titles (\"Shipper's Name and Address\") are not taken as the shipper / consignee", () => {
  const T = `NSCXA2699999
Shipper's Name and Address      Shipper's Account Number      Not Negotiable
SAMPLE ELECTRONICS CO., LTD                                    Air Waybill
123 TEST-RO, SEOUL, KOREA
Consignee's Name and Address    Consignee's Account Number
SAMPLE TRADE INC
100 SAMPLE AVE, LOS ANGELES, CA 90001
Issuing Carrier's Agent Name and City
SAMPLE AGENT CO., LTD`;
  const r = extractRules(T, 'awb.pdf');
  assert.equal(r.shipper_name, 'SAMPLE ELECTRONICS CO., LTD');
  assert.equal(r.consignee_name, 'SAMPLE TRADE INC');
});

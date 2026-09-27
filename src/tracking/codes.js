/** Carrier / airline identification from document numbers. */

// B/L prefix -> carrier SCAC (the prefix printed on the B/L is not always the SCAC, e.g. MSC = MEDU/MSCU).
const BL_PREFIX = {
  HDMU: 'HDMU', ONEY: 'ONEY', CMDU: 'CMDU', ANNU: 'CMDU', CHNL: 'CMDU', MAEU: 'MAEU', SEAU: 'MAEU', MEDU: 'MSCU', MSCU: 'MSCU',
  EGLV: 'EGLV', EISU: 'EGLV', COSU: 'COSU', CCMJ: 'COSU', OOLU: 'OOLU', YMLU: 'YMLU', YMJA: 'YMLU', ZIMU: 'ZIMU',
  HLCU: 'HLCU', WHLC: 'WHLC', SMLM: 'SMLM', KMTC: 'KMTU', KMTU: 'KMTU', SKLU: 'SKLU', SNKO: 'SNKO', PABV: 'PABV', MATS: 'MATS',
};
const CARRIERS = {
  HDMU: 'HMM', ONEY: 'ONE', CMDU: 'CMA CGM', MAEU: 'Maersk', MSCU: 'MSC', EGLV: 'Evergreen', COSU: 'COSCO', OOLU: 'OOCL',
  YMLU: 'Yang Ming', ZIMU: 'ZIM', HLCU: 'Hapag-Lloyd', WHLC: 'Wan Hai', SMLM: 'SM Line', KMTU: 'KMTC', SKLU: 'Sinokor',
  SNKO: 'Sinokor', PABV: 'PIL', MATS: 'Matson',
};

// IATA air waybill prefix -> airline (common on KR/CN -> US lanes).
const AIRLINES = {
  '180': 'Korean Air', '988': 'Asiana', '921': 'SF Airlines', '936': 'DHL Aviation', '112': 'China Cargo Airlines',
  '781': 'China Eastern', '784': 'China Southern', '999': 'Air China', '297': 'China Airlines', '695': 'EVA Air',
  '160': 'Cathay Pacific', '020': 'Lufthansa Cargo', '618': 'Singapore Airlines', '131': 'JAL', '205': 'ANA',
  '176': 'Emirates', '157': 'Qatar Airways', '172': 'Cargolux', '369': 'Atlas Air', '406': 'UPS', '023': 'FedEx',
  '016': 'United', '001': 'American', '006': 'Delta', '880': 'Hainan', '479': 'Shenzhen Airlines', '324': 'Shandong Airlines',
};

function scacFromBl(bl) {
  const p = String(bl || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  return BL_PREFIX[p] || null;
}

/** "921-63150570" / "92163150570" -> { prefix, serial, awb, airline } */
function parseAwb(no) {
  const d = String(no || '').replace(/\D/g, '');
  if (d.length !== 11) return null;
  return { prefix: d.slice(0, 3), serial: d.slice(3), awb: `${d.slice(0, 3)}-${d.slice(3)}`, airline: AIRLINES[d.slice(0, 3)] || null };
}

/** Container number carrier prefix -> SCAC (only for carrier-owned boxes; leasing boxes are ambiguous). */
const CONTAINER_OWNER = { HDMU: 'HDMU', ONEU: 'ONEY', CMAU: 'CMDU', MSKU: 'MAEU', MRKU: 'MAEU', MSCU: 'MSCU', MEDU: 'MSCU', EGHU: 'EGLV', EISU: 'EGLV', CSNU: 'COSU', CCLU: 'COSU', OOLU: 'OOLU', YMLU: 'YMLU', ZIMU: 'ZIMU', HLXU: 'HLCU', HLBU: 'HLCU', WHLU: 'WHLC' };

function detectScac(s) {
  return (s.scac && s.scac.length === 4 ? s.scac.toUpperCase() : null)
    || scacFromBl(s.mbl_no)
    || (s.containers || []).map((c) => CONTAINER_OWNER[String(c.container_no).slice(0, 4)]).find(Boolean)
    || null;
}

module.exports = { scacFromBl, parseAwb, detectScac, CARRIERS, AIRLINES };

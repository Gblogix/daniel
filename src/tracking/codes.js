/** Carrier / airline identification from document numbers. */

// B/L prefix -> carrier SCAC (the prefix printed on the B/L is not always the SCAC, e.g. MSC = MEDU/MSCU).
const BL_PREFIX = {
  HDMU: 'HDMU', ONEY: 'ONEY', CMDU: 'CMDU', ANNU: 'CMDU', CHNL: 'CMDU', MAEU: 'MAEU', SEAU: 'MAEU', MEDU: 'MSCU', MSCU: 'MSCU',
  EGLV: 'EGLV', EISU: 'EGLV', COSU: 'COSU', CCMJ: 'COSU', OOLU: 'OOLU', YMLU: 'YMLU', YMJA: 'YMLU', ZIMU: 'ZIMU',
  HLCU: 'HLCU', WHLC: 'WHLC', SMLM: 'SMLM', KMTC: 'KMTU', KMTU: 'KMTU', SKLU: 'SKLU', SNKO: 'SNKO', PABV: 'PABV', MATS: 'MATS',
  APLU: 'APLU', HASL: 'HASL', NSSL: 'NSSL',
};
const CARRIERS = {
  HDMU: 'HMM', ONEY: 'ONE', CMDU: 'CMA CGM', MAEU: 'Maersk', MSCU: 'MSC', EGLV: 'Evergreen', COSU: 'COSCO', OOLU: 'OOCL',
  YMLU: 'Yang Ming', ZIMU: 'ZIM', HLCU: 'Hapag-Lloyd', WHLC: 'Wan Hai', SMLM: 'SM Line', KMTU: 'KMTC', SKLU: 'Sinokor',
  SNKO: 'Sinokor', PABV: 'PIL', MATS: 'Matson', APLU: 'APL', HASL: 'Heung-A', NSSL: 'Namsung',
};

// IATA air waybill prefix -> airline (common on KR/CN -> US lanes).
const AIRLINES = {
  '350': 'Air Premia',
  '180': 'Korean Air', '988': 'Asiana', '921': 'SF Airlines', '936': 'DHL Aviation', '112': 'China Cargo Airlines',
  '781': 'China Eastern', '784': 'China Southern', '999': 'Air China', '297': 'China Airlines', '695': 'EVA Air',
  '160': 'Cathay Pacific', '020': 'Lufthansa Cargo', '618': 'Singapore Airlines', '131': 'JAL', '205': 'ANA',
  '176': 'Emirates', '157': 'Qatar Airways', '172': 'Cargolux', '369': 'Atlas Air', '406': 'UPS', '023': 'FedEx',
  '016': 'United', '001': 'American', '006': 'Delta', '074': 'KLM', '057': 'Air France', '125': 'British Airways',
  '235': 'Turkish Airlines', '217': 'Thai Airways', '738': 'Vietnam Airlines', '607': 'Etihad', '403': 'Polar Air Cargo', '880': 'Hainan', '479': 'Shenzhen Airlines', '324': 'Shandong Airlines',
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

/**
 * The carrier's own public tracking page for this B/L (one click when no tracking API is connected). Falls back to a
 * container search when the carrier has no deep link.
 */
function trackUrl(s) {
  const scac = detectScac(s);
  const bl = String(s.mbl_no || '').toUpperCase().replace(/\s+/g, '');
  const bare = scac && bl.startsWith(scac) ? bl.slice(scac.length) : bl;
  const ctn = (s.containers || [])[0]?.container_no || s.first_ctn || '';
  const e = encodeURIComponent;
  const pages = {
    MAEU: bare && `https://www.maersk.com/tracking/${e(bare)}`,
    MSCU: bl && `https://www.msc.com/en/track-a-shipment?agencyPath=msc&trackingNumber=${e(bare)}&trackingMode=0`,
    CMDU: bl && `https://www.cma-cgm.com/ebusiness/tracking/search?SearchBy=BL&Reference=${e(bl)}`,
    HLCU: bl && `https://www.hapag-lloyd.com/en/online-business/track/track-by-booking-solution.html?blno=${e(bare)}`,
    ONEY: bl && `https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking?trakNoParam=${e(bare)}&trakNoTpCdParam=B`,
  };
  if (s.mode === 'AIR') return null;
  const url = (scac && pages[scac]) || (ctn ? `https://www.searates.com/container/tracking/?number=${e(ctn)}` : null);
  return url ? { url, label: scac && pages[scac] ? `${CARRIERS[scac] || scac} tracking` : 'Container tracking (SeaRates)' } : null;
}

module.exports = { scacFromBl, parseAwb, detectScac, trackUrl, CARRIERS, AIRLINES };

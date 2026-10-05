// ==========================================
// TRADERNET ARMENIA (FREEDOM BROKER) RULES
// ==========================================
const TRADERNET_RULES = {
  broker: "Freedom Broker Armenia (Tradernet)",
  annualRate: 0.1500,                  // 15.00% annual margin interest
  dailyRate: 0.1500 / 365,             // 0.04109589% daily rate
  rolloverHour: 4,                     // 4:00 AM AMT (UTC+4) daily overnight cycle
  maintenanceMarginRatio: 0.10,        // Tradernet standard D_min discount = 10%
  stopOutRatio: 0.00,                  // Absolute liquidation at 0 equity
  commPerShare: 0.012,                 // $0.012 per share
  commVolumePct: 0.0012,               // 0.12% trade value
  minCommOrder: 1.20                   // $1.20 minimum per execution
};

const DAILY_RATE = TRADERNET_RULES.dailyRate;
const GIST_FILE_NAME = "margin_state.json";

function formatUSD(val) {
  const num = Number(val) || 0;
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function createBlankState() {
  return {
    activeView: "COMBINED",
    marginBalance: 0.00,
    realizedMarginCharged: 0.00,
    startDate: new Date().toISOString().split('T')[0],
    lastRolloverTimestamp: Date.now(),
    lastUpdated: Date.now(),
    cashCushion: {
      freeCash: 0.00,
      holdings: []
    },
    positions: {}
  };
}

let state = createBlankState();
let gistSyncTimeout = null;

// ==========================================
// GITHUB GIST ENCODING & REPLICATION ENGINE
// ==========================================
function encodePayload(obj) {
  const jsonStr = JSON.stringify(obj);
  return btoa(encodeURIComponent(jsonStr).replace(/%([0-9A-F]{2})/g, function(match, p1) {
    return String.fromCharCode('0x' + p1);
  }));
}

function decodePayload(str) {
  const jsonStr = decodeURIComponent(Array.prototype.map.call(atob(str), function(c) {
    return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
  }).join(''));
  return JSON.parse(jsonStr);
}

function extractCleanGistId(rawInput) {
  if (!rawInput) return "";
  let trimmed = rawInput.trim();
  const match = trimmed.match(/([a-f0-9]{20,32})/i);
  return match ? match[1] : trimmed.replace(/.*gist\.github\.com\/[^/]+\//i, '').replace(/[^a-zA-Z0-9_-]/g, '');
}

function setGistStatus(status, text) {
  const dot = document.getElementById('cloudStatusDot');
  const label = document.
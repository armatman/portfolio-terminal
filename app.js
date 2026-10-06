import { createBlankState, normalizePortfolioState, realizeClosedTrade, resolveTradeDateTimestamp } from './src/domain/portfolio.ts';

// ==========================================
// USER-CONFIGURABLE BROKER DEFAULT ASSUMPTIONS
// ==========================================
const DEFAULT_TRADERNET_RULES = {
  broker: "Freedom Broker Armenia (Tradernet)",
  annualRate: 0.1500,                  // Default: 15.00% annual margin interest
  dayCountBasis: 365,
  rolloverHour: 4,                     // Default: 4:00 AM in Asia/Yerevan
  rolloverMinute: 0,
  rolloverTimeZone: "Asia/Yerevan",
  maintenanceMarginRatio: 0.10,        // Default maintenance equity ratio
  stopOutRatio: 0.00,                  // Default stop-out equity ratio
  commPerShare: 0.012,                 // Default: $0.012 per share
  commVolumePct: 0.0012,               // Default: 0.12% trade value
  minCommOrder: 1.20                   // Default: $1.20 minimum per execution
};

const TRADERNET_RULES = { ...DEFAULT_TRADERNET_RULES };
const TRADERNET_RULES_STORAGE_KEY = 'tradernet_rules_v1';
const GIST_FILE_NAME = "margin_state.json";

function formatUSD(val) {
  const num = Number(val) || 0;
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

let state = createBlankState();
let gistSyncTimeout = null;
let quoteRefreshTimer = null;
let isRefreshingLivePrices = false;
let lastRenderedDeskView = null;
const livePriceRequests = new Map();

const QUOTE_REFRESH_INTERVAL_KEY = 'quote_refresh_interval_ms';
const DEFAULT_QUOTE_REFRESH_INTERVAL_MS = 60 * 1000;
const QUOTE_REFRESH_INTERVALS = new Set([0, 15 * 1000, 30 * 1000, 60 * 1000]);

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
  const label = document.getElementById('cloudStatusText');
  if (!dot || !label) return;

  label.innerText = `GIST: ${text.toUpperCase()}`;
  dot.className = "w-1.5 h-1.5 rounded-full";

  if (status === 'syncing') {
    dot.classList.add('bg-amber-400', 'animate-pulse');
  } else if (status === 'synced') {
    dot.classList.add('bg-emerald-400');
  } else if (status === 'error') {
    dot.classList.add('bg-rose-400');
  } else {
    dot.classList.add('bg-slate-500');
  }
}

async function pushStateToGist(forceImmediate = false) {
  const gistId = extractCleanGistId(localStorage.getItem('github_gist_id'));
  const token = (localStorage.getItem('github_pat_token') || '').trim();
  if (!gistId || !token) {
    const missing = [];
    if (!gistId) missing.push('GIST ID');
    if (!token) missing.push('TOKEN');
    setGistStatus('idle', `ADD ${missing.join(' + ')}`);
    return;
  }

  state.lastUpdated = Date.now();

  const doPush = async () => {
    setGistStatus('syncing', 'WRITING...');
    try {
      const encodedBase64 = encodePayload(state);
      const fileBody = JSON.stringify({
        updated: state.lastUpdated,
        payload: encodedBase64
      }, null, 2);

      const res = await fetch(`https://api.github.com/gists/${gistId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          files: {
            [GIST_FILE_NAME]: {
              content: fileBody
            }
          }
        })
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(`HTTP ${res.status}: ${errJson.message || 'Gist update rejected'}`);
      }

      setGistStatus('synced', 'UPDATED');
    } catch (err) {
      logTerminal(`[Gist Sync Error]: ${err.message}`);
      setGistStatus('error', 'FAIL');
    }
  };

  if (forceImmediate) {
    if (gistSyncTimeout) clearTimeout(gistSyncTimeout);
    await doPush();
  } else {
    if (gistSyncTimeout) clearTimeout(gistSyncTimeout);
    gistSyncTimeout = setTimeout(doPush, 600);
  }
}

async function pullStateFromGistOnLoad() {
  const gistId = extractCleanGistId(localStorage.getItem('github_gist_id'));
  const token = (localStorage.getItem('github_pat_token') || '').trim();
  if (!gistId) return false;

  setGistStatus('syncing', 'FETCHING...');
  try {
    const headers = { 'Accept': 'application/vnd.github+json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`https://api.github.com/gists/${gistId}`, { headers });
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(`HTTP ${res.status}: ${errJson.message || 'Fetch failed'}`);
    }

    const data = await res.json();
    const targetFile = data.files && (data.files[GIST_FILE_NAME] || Object.values(data.files)[0]);
    if (!targetFile || !targetFile.content) throw new Error("Gist contains no readable file.");

    let remoteState = null;
    let parsedEnvelope = null;
    try { parsedEnvelope = JSON.parse(targetFile.content); } catch (e) {}

    if (parsedEnvelope) {
      if (parsedEnvelope.payload && typeof parsedEnvelope.payload === 'string') {
        try {
          remoteState = decodePayload(parsedEnvelope.payload);
        } catch (decErr) {
          try { remoteState = JSON.parse(atob(parsedEnvelope.payload)); } catch (e2) {}
        }
      } else if (typeof parsedEnvelope === 'object') {
        remoteState = parsedEnvelope;
      }
    }

    if (remoteState && typeof remoteState === 'object') {
      state = normalizePortfolioState(remoteState);
      localStorage.setItem('margin_portfolio_state_dynamic_v2', JSON.stringify(state));

      setGistStatus('synced', 'ONLINE');
      logTerminal("[Gist]: Cloud data successfully loaded. Local storage rewritten with remote state.");
      return true;
    } else {
      throw new Error("Invalid remote payload structure");
    }
  } catch (e) {
    logTerminal(`[Gist Notice]: Could not pull remote Gist (${e.message}). Falling back to local cache.`);
    setGistStatus('error', 'OFFLINE');
  }
  return false;
}

async function pullCloudAndRewriteLocal() {
  logTerminal("[System]: Fetching cloud data from GitHub Gist...");
  const success = await pullStateFromGistOnLoad();
  if (success) {
    verifyTradernetRulesOnload();
    applyOvernightRollover();
    renderBoard();
    logTerminal("[System]: Local data rewritten with cloud state successfully.");
  } else {
    logTerminal("[Error]: Failed to pull cloud data. Check Gist ID / Token.");
  }
}

async function loadSavedState() {
  loadTradernetRules();
  const savedKey = localStorage.getItem('gemini_api_key');
  if (savedKey) document.getElementById('apiKeyInput').value = savedKey;

  const savedFinnhub = localStorage.getItem('finnhub_api_key');
  if (savedFinnhub) document.getElementById('finnhubKeyInput').value = savedFinnhub;

  const savedGistId = localStorage.getItem('github_gist_id');
  if (savedGistId) document.getElementById('gistIdInput').value = savedGistId;

  const savedToken = localStorage.getItem('github_pat_token');
  if (savedToken) document.getElementById('githubTokenInput').value = savedToken;

  const pulled = await pullStateFromGistOnLoad();
  if (!pulled) {
    const saved = localStorage.getItem('margin_portfolio_state_dynamic_v2');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object') {
          state = normalizePortfolioState(parsed);
        }
      } catch (error) {
        logTerminal(`[Local State Error]: Could not load saved portfolio (${error.message}). Starting with defaults.`);
      }
    }
  }

  verifyTradernetRulesOnload();
  applyOvernightRollover();
  renderBoard();
}

let headerCredentialsHidden = false;

function updateHeaderCredentialsVisibility() {
  const inputIds = ['apiKeyInput', 'finnhubKeyInput', 'gistIdInput', 'githubTokenInput'];
  const inputs = inputIds.map(id => document.getElementById(id));
  const allFieldsFilled = inputs.every(input => input.value.trim().length > 0);
  const fields = document.getElementById('headerCredentialsFields');
  const toggleButton = document.getElementById('toggleHeaderCredentialsButton');
  const saveButton = document.getElementById('saveApiKeysButton');

  if (!allFieldsFilled) headerCredentialsHidden = false;
  fields.classList.toggle('hidden', headerCredentialsHidden);
  toggleButton.classList.toggle('hidden', !allFieldsFilled);
  saveButton.classList.toggle('hidden', headerCredentialsHidden);
  toggleButton.textContent = headerCredentialsHidden ? 'Show keys' : 'Hide keys';
  toggleButton.title = headerCredentialsHidden ? 'Show credential inputs' : 'Hide credential inputs';
  toggleButton.setAttribute('aria-expanded', String(!headerCredentialsHidden));
  const actionButtons = toggleButton.parentElement;
  actionButtons.classList.toggle('ml-auto', !headerCredentialsHidden);
  actionButtons.classList.toggle('mx-auto', headerCredentialsHidden);
  localStorage.setItem('header_credentials_hidden', String(headerCredentialsHidden));
}

function toggleHeaderCredentialsVisibility() {
  headerCredentialsHidden = !headerCredentialsHidden;
  updateHeaderCredentialsVisibility();
}

function saveState() {
  state.lastUpdated = Date.now();
  localStorage.setItem('margin_portfolio_state_dynamic_v2', JSON.stringify(state));
  pushStateToGist(false);
}

function resetToBlankState() {
  if (confirm("Reset the entire terminal to a blank slate? This will clear all holdings, balances, and history locally and on GitHub Gist.")) {
    state = createBlankState();
    saveState();
    pushStateToGist(true);
    renderBoard();
    logTerminal("[System]: Portfolio reset to a clean blank slate.");
    showToast('Portfolio reset to a blank slate.', 'warning');
  }
}

async function saveApiKeys() {
  const gKey = document.getElementById('apiKeyInput').value.trim();
  localStorage.setItem('gemini_api_key', gKey);

  const fKey = document.getElementById('finnhubKeyInput').value.trim();
  localStorage.setItem('finnhub_api_key', fKey);

  const rawGist = document.getElementById('gistIdInput').value.trim();
  const cleanGistId = extractCleanGistId(rawGist);
  localStorage.setItem('github_gist_id', cleanGistId);

  const token = document.getElementById('githubTokenInput').value.trim();
  localStorage.setItem('github_pat_token', token);

  logTerminal("[System]: Credentials saved.");
  const syncConfigured = Boolean(cleanGistId && token);
  showToast(
    syncConfigured
      ? 'Credentials saved. Checking cloud state...'
      : 'Saved locally. A Gist ID and GitHub token are required to upload.',
    syncConfigured ? 'success' : 'warning'
  );
  if (cleanGistId) {
    await pullCloudAndRewriteLocal();
  }
}

function calcCommission(shares, totalVal) {
  if (shares <= 0) return 0;
  return Math.max(TRADERNET_RULES.minCommOrder, (TRADERNET_RULES.commPerShare * shares) + (TRADERNET_RULES.commVolumePct * totalVal));
}

function getDailyRate() {
  return TRADERNET_RULES.annualRate / TRADERNET_RULES.dayCountBasis;
}

function loadTradernetRules() {
  const stored = localStorage.getItem(TRADERNET_RULES_STORAGE_KEY);
  if (!stored) return;

  try {
    const savedRules = JSON.parse(stored);
    const candidates = {
      annualRate: Number(savedRules.annualRate),
      dayCountBasis: savedRules.dayCountBasis === undefined ? DEFAULT_TRADERNET_RULES.dayCountBasis : Number(savedRules.dayCountBasis),
      maintenanceMarginRatio: Number(savedRules.maintenanceMarginRatio),
      stopOutRatio: Number(savedRules.stopOutRatio),
      rolloverHour: Number(savedRules.rolloverHour),
      rolloverMinute: Number(savedRules.rolloverMinute),
      commPerShare: Number(savedRules.commPerShare),
      commVolumePct: Number(savedRules.commVolumePct),
      minCommOrder: Number(savedRules.minCommOrder)
    };
    const valid = Number.isFinite(candidates.annualRate) && candidates.annualRate >= 0 && candidates.annualRate <= 1 &&
      [360, 365].includes(candidates.dayCountBasis) &&
      Number.isFinite(candidates.maintenanceMarginRatio) && candidates.maintenanceMarginRatio >= 0 && candidates.maintenanceMarginRatio < 1 &&
      Number.isFinite(candidates.stopOutRatio) && candidates.stopOutRatio >= 0 && candidates.stopOutRatio <= candidates.maintenanceMarginRatio &&
      Number.isInteger(candidates.rolloverHour) && candidates.rolloverHour >= 0 && candidates.rolloverHour <= 23 &&
      Number.isInteger(candidates.rolloverMinute) && candidates.rolloverMinute >= 0 && candidates.rolloverMinute <= 59 &&
      Number.isFinite(candidates.commPerShare) && candidates.commPerShare >= 0 &&
      Number.isFinite(candidates.commVolumePct) && candidates.commVolumePct >= 0 && candidates.commVolumePct <= 1 &&
      Number.isFinite(candidates.minCommOrder) && candidates.minCommOrder >= 0;
    if (!valid) throw new Error('Saved broker assumptions are outside the supported range.');
    Object.assign(TRADERNET_RULES, candidates);
  } catch (error) {
    logTerminal(`[Settings Error]: Could not load saved broker assumptions (${error.message}). Using defaults.`);
  }
}

function setBrokerRuleInputs() {
  document.getElementById('annualMarginRateInput').value = (TRADERNET_RULES.annualRate * 100).toFixed(2);
  document.getElementById('interestDayCountInput').value = String(TRADERNET_RULES.dayCountBasis);
  document.getElementById('maintenanceMarginInput').value = (TRADERNET_RULES.maintenanceMarginRatio * 100).toFixed(2);
  document.getElementById('stopOutRatioInput').value = (TRADERNET_RULES.stopOutRatio * 100).toFixed(2);
  document.getElementById('rolloverTimeInput').value =
    `${String(TRADERNET_RULES.rolloverHour).padStart(2, '0')}:${String(TRADERNET_RULES.rolloverMinute).padStart(2, '0')}`;
  document.getElementById('commissionPerShareInput').value = TRADERNET_RULES.commPerShare;
  document.getElementById('commissionVolumeInput').value = (TRADERNET_RULES.commVolumePct * 100).toFixed(2);
  document.getElementById('minimumCommissionInput').value = TRADERNET_RULES.minCommOrder.toFixed(2);
  document.getElementById('stopOutRatioInput').setCustomValidity('');
}

function saveBrokerRuleInputs(event) {
  event.preventDefault();
  const form = event.currentTarget;
  document.getElementById('stopOutRatioInput').setCustomValidity('');
  if (!form.reportValidity()) return;

  const [rolloverHour, rolloverMinute] = document.getElementById('rolloverTimeInput').value.split(':').map(Number);
  const previousRollover = `${TRADERNET_RULES.rolloverHour}:${TRADERNET_RULES.rolloverMinute}`;
  const updatedRules = {
    ...TRADERNET_RULES,
    annualRate: Number(document.getElementById('annualMarginRateInput').value) / 100,
    dayCountBasis: Number(document.getElementById('interestDayCountInput').value),
    maintenanceMarginRatio: Number(document.getElementById('maintenanceMarginInput').value) / 100,
    stopOutRatio: Number(document.getElementById('stopOutRatioInput').value) / 100,
    rolloverHour,
    rolloverMinute,
    commPerShare: Number(document.getElementById('commissionPerShareInput').value),
    commVolumePct: Number(document.getElementById('commissionVolumeInput').value) / 100,
    minCommOrder: Number(document.getElementById('minimumCommissionInput').value)
  };
  if (updatedRules.stopOutRatio > updatedRules.maintenanceMarginRatio) {
    document.getElementById('stopOutRatioInput').setCustomValidity('Stop-out equity must not exceed maintenance equity.');
    document.getElementById('stopOutRatioInput').reportValidity();
    return;
  }
  document.getElementById('stopOutRatioInput').setCustomValidity('');
  Object.assign(TRADERNET_RULES, updatedRules);
  localStorage.setItem(TRADERNET_RULES_STORAGE_KEY, JSON.stringify(updatedRules));
  const nextRollover = `${TRADERNET_RULES.rolloverHour}:${TRADERNET_RULES.rolloverMinute}`;
  if (previousRollover !== nextRollover) {
    state.lastRolloverTimestamp = getLatestRolloverTimestamp();
    saveState();
  }
  verifyTradernetRulesOnload();
  renderBoard();
  showToast('Broker assumptions saved in this browser.', 'success');
}

function resetBrokerRules() {
  const previousRollover = `${TRADERNET_RULES.rolloverHour}:${TRADERNET_RULES.rolloverMinute}`;
  Object.assign(TRADERNET_RULES, DEFAULT_TRADERNET_RULES);
  localStorage.removeItem(TRADERNET_RULES_STORAGE_KEY);
  setBrokerRuleInputs();
  if (previousRollover !== `${TRADERNET_RULES.rolloverHour}:${TRADERNET_RULES.rolloverMinute}`) {
    state.lastRolloverTimestamp = getLatestRolloverTimestamp();
    saveState();
  }
  verifyTradernetRulesOnload();
  renderBoard();
  showToast('Broker assumptions restored to defaults.', 'info');
}

function getQuoteSymbolMapping(ticker) {
  const symbol = ticker.trim().toUpperCase();
  return state.quoteSymbols?.[symbol] || {};
}

function setQuoteSymbolMapping(ticker, mapping) {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) throw new Error('A portfolio ticker is required.');
  if (!state.quoteSymbols || typeof state.quoteSymbols !== 'object') state.quoteSymbols = {};
  const normalizedMapping = {
    finnhub: (mapping.finnhub || '').trim(),
    stooq: (mapping.stooq || '').trim()
  };
  if (!normalizedMapping.finnhub && !normalizedMapping.stooq) {
    delete state.quoteSymbols[symbol];
  } else {
    state.quoteSymbols[symbol] = normalizedMapping;
  }
  const trackedItems = [
    state.positions[symbol],
    state.cashCushion?.holdings?.find(holding => holding.ticker === symbol)
  ].filter(Boolean);
  trackedItems.forEach(item => {
    item.quoteSource = 'Symbol mapping changed; refresh quote';
    delete item.quoteUpdatedAt;
  });
  saveState();
  return normalizedMapping;
}

function populateQuoteSymbolMapping(ticker) {
  const symbol = ticker.trim().toUpperCase();
  const mapping = getQuoteSymbolMapping(symbol);
  document.getElementById('finnhubSymbolInput').value = mapping.finnhub || '';
  document.getElementById('stooqSymbolInput').value = mapping.stooq || '';
  document.getElementById('quoteMappingStatus').textContent = symbol
    ? `Mapping for ${symbol}. Blank provider symbol uses its default US ticker format.`
    : 'Blank provider symbol uses its default US ticker format.';
}

function saveQuoteSymbolMapping(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;

  const ticker = document.getElementById('quoteMappingTickerInput').value.trim().toUpperCase();
  if (!ticker) return;

  const mapping = setQuoteSymbolMapping(ticker, {
    finnhub: document.getElementById('finnhubSymbolInput').value.trim(),
    stooq: document.getElementById('stooqSymbolInput').value.trim()
  });
  document.getElementById('quoteMappingStatus').textContent =
    mapping.finnhub || mapping.stooq
      ? `Saved ${ticker}: Finnhub ${mapping.finnhub || '(default)'}, Stooq ${mapping.stooq || '(default)'}. Refresh quotes to apply.`
      : `${ticker} uses default provider symbols. Refresh quotes to apply.`;
  showToast(`Quote symbols updated for ${ticker}.`, 'success');
}

function verifyTradernetRulesOnload() {
  const ratePct = (TRADERNET_RULES.annualRate * 100).toFixed(2);
  const dailyPct = (getDailyRate() * 100).toFixed(4);
  const maintenancePct = (TRADERNET_RULES.maintenanceMarginRatio * 100).toFixed(2);
  const rolloverTime = `${String(TRADERNET_RULES.rolloverHour).padStart(2, '0')}:${String(TRADERNET_RULES.rolloverMinute).padStart(2, '0')}`;
  document.getElementById('rulesSummary').innerText = 
    `Broker model: ${ratePct}% p.a. (${dailyPct}%/d, /${TRADERNET_RULES.dayCountBasis}) | ${rolloverTime} Armenia time compounding | Maintenance equity ${maintenancePct}%`;
  updateRiskAssumptionTitles();
}

function updateRiskAssumptionTitles() {
  document.getElementById('boardStopOutRow').title =
    `Estimate assumes the configured ${(TRADERNET_RULES.stopOutRatio * 100).toFixed(2)}% stop-out equity threshold and that the full allocated cushion qualifies as collateral. Actual broker requirements may differ.`;
  document.getElementById('boardMarginRisk').parentElement.title =
    `Estimated from portfolio equity and configured thresholds: ${(TRADERNET_RULES.maintenanceMarginRatio * 100).toFixed(2)}% maintenance equity and ${(TRADERNET_RULES.stopOutRatio * 100).toFixed(2)}% stop-out equity. Not a live broker risk indicator.`;
}

function getZonedDateParts(date, timeZone = TRADERNET_RULES.rolloverTimeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

function zonedLocalTimeToTimestamp(year, month, day, hour, minute, timeZone = TRADERNET_RULES.rolloverTimeZone) {
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute);
  let timestamp = targetUtc;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = getZonedDateParts(new Date(timestamp), timeZone);
    const representedUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const adjustment = targetUtc - representedUtc;
    if (adjustment === 0) return timestamp;
    timestamp += adjustment;
  }
  return timestamp;
}

function shiftCalendarDate(year, month, day, offset) {
  const shifted = new Date(Date.UTC(year, month - 1, day + offset));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function getRolloverTimestampForLocalDate(year, month, day) {
  return zonedLocalTimeToTimestamp(
    year, month, day, TRADERNET_RULES.rolloverHour, TRADERNET_RULES.rolloverMinute
  );
}

function getLatestRolloverTimestamp(now = new Date()) {
  const local = getZonedDateParts(now);
  let rollover = getRolloverTimestampForLocalDate(local.year, local.month, local.day);
  if (rollover > now.getTime()) {
    const previousDate = shiftCalendarDate(local.year, local.month, local.day, -1);
    rollover = getRolloverTimestampForLocalDate(previousDate.year, previousDate.month, previousDate.day);
  }
  return rollover;
}

function applyOvernightRollover() {
  const now = new Date();
  if (!Number.isFinite(Number(state.lastRolloverTimestamp)) || Number(state.lastRolloverTimestamp) <= 0) {
    state.lastRolloverTimestamp = getLatestRolloverTimestamp(now);
    saveState();
    return;
  }

  let elapsedCycles = 0;
  const lastRolloverTimestamp = Number(state.lastRolloverTimestamp);
  const last = getZonedDateParts(new Date(lastRolloverTimestamp));
  let rolloverDate = { year: last.year, month: last.month, day: last.day };
  let cursor = getRolloverTimestampForLocalDate(rolloverDate.year, rolloverDate.month, rolloverDate.day);
  if (cursor <= lastRolloverTimestamp) {
    rolloverDate = shiftCalendarDate(rolloverDate.year, rolloverDate.month, rolloverDate.day, 1);
    cursor = getRolloverTimestampForLocalDate(rolloverDate.year, rolloverDate.month, rolloverDate.day);
  }
  while (cursor <= now.getTime()) {
    elapsedCycles++;
    rolloverDate = shiftCalendarDate(rolloverDate.year, rolloverDate.month, rolloverDate.day, 1);
    cursor = getRolloverTimestampForLocalDate(rolloverDate.year, rolloverDate.month, rolloverDate.day);
  }

  if (elapsedCycles > 0 && Math.abs(state.marginBalance) > 0) {
    const currentDebt = Math.abs(state.marginBalance);
    const compoundedDebt = currentDebt * Math.pow(1 + getDailyRate(), elapsedCycles);
    const interestAccrued = compoundedDebt - currentDebt;

    state.marginBalance = -compoundedDebt;

    const tickers = Object.keys(state.positions);
    const totalInvested = getTotalPortfolioInvested();
    if (tickers.length > 0 && totalInvested > 0) {
      tickers.forEach(ticker => {
        const position = state.positions[ticker];
        const invested = (position.tranches || []).reduce((sum, tranche) => sum + (tranche.qty * tranche.price), 0);
        position.marginCharged = (position.marginCharged || 0) + (interestAccrued * invested / totalInvested);
      });
    } else {
      state.realizedMarginCharged = (state.realizedMarginCharged || 0) + interestAccrued;
    }

    state.lastRolloverTimestamp = now.getTime();
    saveState();
    logTerminal(`[Broker ${String(TRADERNET_RULES.rolloverHour).padStart(2, '0')}:${String(TRADERNET_RULES.rolloverMinute).padStart(2, '0')} Armenia rollover]: Processed ${elapsedCycles} cycle(s). Accrued interest: +$${formatUSD(interestAccrued)}. Margin Debt: -$${formatUSD(compoundedDebt)}.`);
  } else if (elapsedCycles > 0) {
    state.lastRolloverTimestamp = now.getTime();
    saveState();
  }
}

function setActiveView(view) {
  state.activeView = view;
  renderBoard();
}

function renderConsoleQuickActions() {
  const container = document.getElementById('consoleQuickActions');
  container.innerHTML = '';

  const pos = state.positions[state.activeView];
  const label = document.createElement('span');
  label.className = 'text-[10px] font-bold uppercase tracking-wider text-slate-500';

  if (!pos) {
    label.textContent = 'Quick actions';
    const hint = document.createElement('span');
    hint.className = 'text-[10px] text-slate-500';
    hint.textContent = 'Select a margin ticker to use stock shortcuts.';
    container.append(label, hint);
    return;
  }

  label.className = 'text-[10px] font-bold uppercase tracking-wider text-slate-500';
  label.textContent = `${pos.ticker} · ${formatUSD(pos.shares)} shares`;
  container.appendChild(label);

  const currentPrice = Number(pos.currentPrice) > 0 ? Number(pos.currentPrice) : null;
  const priceText = currentPrice ? formatUSD(currentPrice) : '[price]';
  const actions = [
    { text: 'Quote', command: `quote ${pos.ticker}`, color: 'text-amber-300 border-amber-900/70 hover:bg-amber-950/50' },
    { text: 'Buy…', command: `bought [shares] ${pos.ticker} for ${priceText}`, color: 'text-emerald-300 border-emerald-900/70 hover:bg-emerald-950/50' },
    { text: 'Sell part…', command: `sold [shares] ${pos.ticker} for ${priceText}`, color: 'text-rose-300 border-rose-900/70 hover:bg-rose-950/50' },
    { text: 'Sell all…', command: `sold all ${pos.ticker} for ${priceText}`, color: 'text-rose-300 border-rose-900/70 hover:bg-rose-950/50' },
    { text: 'Set target…', command: `set ${pos.ticker} PT to [price]`, color: 'text-cyan-300 border-cyan-900/70 hover:bg-cyan-950/50' }
  ];

  actions.forEach(action => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `rounded border bg-slate-900 px-2.5 py-1 text-[10px] font-bold transition ${action.color}`;
    button.textContent = action.text;
    button.addEventListener('click', () => {
      const input = document.getElementById('cmdInput');
      input.value = action.command;
      input.focus();
      if (action.command.includes('[')) {
        const selectionStart = action.command.indexOf('[');
        const selectionEnd = action.command.indexOf(']', selectionStart) + 1;
        input.setSelectionRange(selectionStart, selectionEnd);
      } else {
        input.setSelectionRange(input.value.length, input.value.length);
      }
    });
    container.appendChild(button);
  });
}

function getTotalPortfolioInvested() {
  return Object.values(state.positions).reduce((acc, pos) => {
    return acc + (pos.tranches || []).reduce((sum, tr) => sum + (tr.qty * tr.price), 0);
  }, 0);
}

function getCashCushionTotal() {
  if (!state.cashCushion) return 0;
  const cashVal = Number(state.cashCushion.freeCash) || 0;
  const stocksVal = (state.cashCushion.holdings || []).reduce((sum, h) => sum + (h.shares * h.price), 0);
  return cashVal + stocksVal;
}

function updateCombinedBreakeven() {
  const beEl = document.getElementById('daysToBreakeven');
  if (!beEl) return;

  const tickers = Object.keys(state.positions);
  const totalDebt = Math.abs(state.marginBalance);

  let totalGrossTarget = 0;
  let totalInvested = 0;
  let totalComms = 0;
  let totalMarginCharged = state.realizedMarginCharged || 0;

  tickers.forEach(t => {
    const pos = state.positions[t];
    if (pos && pos.shares > 0) {
      const cost = (pos.tranches || []).reduce((sum, tr) => sum + (tr.qty * tr.price), 0);
      totalInvested += cost;
      const valSell = pos.shares * pos.pt;
      const commSell = calcCommission(pos.shares, valSell);
      totalGrossTarget += (valSell - cost);
      totalComms += (pos.commBuy || 0) + commSell;
      totalMarginCharged += (pos.marginCharged || 0.00);
    }
  });

  const netTargetProfit = totalGrossTarget - totalComms - totalMarginCharged;

  if (tickers.length === 0 || totalInvested === 0) {
    beEl.innerText = "Combined Breakeven: No active trades";
    return;
  }

  if (totalDebt <= 0) {
    beEl.innerText = "Combined Breakeven: No margin debt";
    return;
  }

  if (netTargetProfit <= 0) {
    beEl.innerText = "Combined Breakeven: 0 days (Net Target ≤ $0)";
    return;
  }

  if (getDailyRate() === 0) {
    beEl.innerText = "Combined Breakeven: 0 days (no ongoing margin interest)";
    return;
  }

  const t_be = Math.log(1 + (netTargetProfit / totalDebt)) / Math.log(1 + getDailyRate());
  const beDays = Math.ceil(t_be);

  const beDate = new Date();
  beDate.setDate(beDate.getDate() + beDays);
  const beDateStr = beDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  beEl.innerText = `Combined Breakeven: ${beDays} days (${beDateStr})`;
}

function renderBoard() {
  const tickers = Object.keys(state.positions);
  const tabsContainer = document.getElementById('tickerTabs');
  tabsContainer.innerHTML = '';

  const isCushionActive = state.activeView === "CASH_CUSHION";
  const isClosedHistoryActive = state.activeView === "CLOSED_HISTORY";
  updateEmptyStateVisibility(tickers.length === 0 && !isCushionActive && !isClosedHistoryActive);

  if (tickers.length === 0) {
    if (!isCushionActive && !isClosedHistoryActive) state.activeView = "COMBINED";
    const emptyLabel = document.createElement('span');
    emptyLabel.className = "text-xs font-bold text-slate-500 uppercase tracking-wider";
    emptyLabel.innerText = "NO ACTIVE TRADES";
    tabsContainer.appendChild(emptyLabel);
  } else if (tickers.length === 1) {
    if (!isCushionActive && !isClosedHistoryActive) state.activeView = tickers[0];
    const btn = document.createElement('button');
    btn.className = `px-3 py-1 rounded text-xs font-bold transition ${state.activeView === tickers[0] ? 'bg-emerald-600 text-black' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`;
    btn.innerText = `MARGIN: ${tickers[0]}`;
    btn.onclick = () => setActiveView(tickers[0]);
    tabsContainer.appendChild(btn);
  } else {
    if (!isCushionActive && !isClosedHistoryActive && state.activeView !== "COMBINED" && !state.positions[state.activeView]) {
      state.activeView = "COMBINED";
    }

    const combinedBtn = document.createElement('button');
    combinedBtn.className = `px-3 py-1 rounded text-xs font-bold transition ${state.activeView === "COMBINED" ? 'bg-emerald-600 text-black' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`;
    combinedBtn.innerText = "COMBINED PORTFOLIO";
    combinedBtn.onclick = () => setActiveView("COMBINED");
    tabsContainer.appendChild(combinedBtn);

    tickers.forEach(t => {
      const btn = document.createElement('button');
      btn.className = `px-3 py-1 rounded text-xs font-bold transition ${state.activeView === t ? 'bg-emerald-600 text-black' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`;
      btn.innerText = t;
      btn.onclick = () => setActiveView(t);
      tabsContainer.appendChild(btn);
    });
  }

  const cushionTotal = getCashCushionTotal();
  const cushionBtn = document.createElement('button');
  cushionBtn.className = `px-3 py-1 rounded text-xs font-bold transition flex items-center gap-1.5 ${isCushionActive ? 'bg-cyan-500 text-black' : 'bg-slate-900 border border-cyan-800/60 text-cyan-400 hover:bg-slate-800'}`;
  cushionBtn.innerHTML = `<span>🛡️ BALANCE</span> <span class="text-[10px] px-1.5 py-0.2 rounded ${isCushionActive ? 'bg-cyan-800 text-white' : 'bg-cyan-950 text-cyan-300 font-mono'}">+$${cushionTotal.toLocaleString('en-US', {maximumFractionDigits:0})}</span>`;
  cushionBtn.onclick = () => setActiveView("CASH_CUSHION");
  tabsContainer.appendChild(cushionBtn);

  const closedHistoryBtn = document.createElement('button');
  closedHistoryBtn.className = `px-3 py-1 rounded text-xs font-bold transition ${isClosedHistoryActive ? 'bg-purple-500 text-black' : 'bg-slate-900 border border-purple-800/60 text-purple-300 hover:bg-slate-800'}`;
  closedHistoryBtn.innerText = `CLOSED HISTORY (${state.closedTrades.length})`;
  closedHistoryBtn.onclick = () => setActiveView("CLOSED_HISTORY");
  tabsContainer.appendChild(closedHistoryBtn);
  document.getElementById('closedTradesCount').textContent =
    `${state.closedTrades.length} realized exit${state.closedTrades.length === 1 ? '' : 's'}`;

  const mainDesk = document.getElementById('mainDeskContainer');
  const cushionDesk = document.getElementById('cashCushionContainer');
  const closedHistoryDesk = document.getElementById('closedHistoryContainer');
  let activeDesk;
  let activeDeskView;

  if (isCushionActive) {
    mainDesk.classList.add('hidden');
    cushionDesk.classList.remove('hidden');
    closedHistoryDesk.classList.add('hidden');
    renderCashCushionPanel();
    activeDesk = cushionDesk;
    activeDeskView = 'CASH_CUSHION';
  } else if (isClosedHistoryActive) {
    mainDesk.classList.add('hidden');
    cushionDesk.classList.add('hidden');
    closedHistoryDesk.classList.remove('hidden');
    renderClosedHistoryPanel();
    activeDesk = closedHistoryDesk;
    activeDeskView = 'CLOSED_HISTORY';
  } else {
    mainDesk.classList.remove('hidden');
    cushionDesk.classList.add('hidden');
    closedHistoryDesk.classList.add('hidden');

    if (state.activeView === "COMBINED" && tickers.length !== 1) {
      renderCombinedView(tickers);
    } else if (tickers.length > 0) {
      renderSingleAssetView(state.positions[state.activeView] || state.positions[tickers[0]]);
    } else {
      renderCombinedView([]);
    }
    activeDesk = mainDesk;
    activeDeskView = state.activeView;
  }

  renderConsoleQuickActions();

  if (activeDeskView !== lastRenderedDeskView) {
    playEntryAnimation(activeDesk, 'ui-view-enter');
    lastRenderedDeskView = activeDeskView;
  }

  updateCombinedBreakeven();
}

function playEntryAnimation(element, animationClass) {
  element.classList.remove(animationClass);
  void element.offsetWidth;
  element.classList.add(animationClass);
  element.addEventListener('animationend', () => element.classList.remove(animationClass), { once: true });
}

function renderCashCushionPanel() {
  if (!state.cashCushion) state.cashCushion = { freeCash: 0.00, holdings: [] };
  const freeCash = Number(state.cashCushion.freeCash) || 0;
  const marginDebt = Math.abs(Number(state.marginBalance) || 0);
  const signedBalance = freeCash + (Number(state.marginBalance) || 0);
  document.getElementById('freeCashInput').value = signedBalance.toFixed(2);
  const debtMeta = document.getElementById('cashBalanceDebtMeta');
  if (debtMeta) {
    debtMeta.textContent = `Balance: $${formatUSD(freeCash)} | Debt: -$${formatUSD(marginDebt)}`;
  }

  const tableBody = document.getElementById('cashStocksTableBody');
  const tableFooter = document.getElementById('cashStocksTableFooter');
  tableBody.innerHTML = '';

  let stocksTotal = 0;
  const holdings = state.cashCushion.holdings || [];

  holdings.forEach(h => {
    stocksTotal += (Number(h.shares) || 0) * (Number(h.price) || 0);
  });

  holdings.forEach((h, idx) => {
    const shares = Number(h.shares) || 0;
    const price = Number(h.price) || 0;
    const val = shares * price;
    const allocation = stocksTotal > 0 ? (val / stocksTotal) * 100 : 0;
    const quoteMeta = formatQuoteMetadata(h);

    const tr = document.createElement('tr');
    tr.className = "hover:bg-slate-900/40";
    const addCell = (content, className) => {
      const cell = document.createElement('td');
      cell.className = className;
      cell.textContent = content;
      tr.appendChild(cell);
      return cell;
    };
    addCell(h.ticker, 'py-2 px-3 text-cyan-300 font-bold');
    addCell(shares.toLocaleString('en-US', { maximumFractionDigits: 3 }), 'py-2 px-3 text-right text-slate-200 tabular-nums');
    const priceCell = document.createElement('td');
    priceCell.className = 'py-2 px-3 text-right text-emerald-400 font-semibold tabular-nums';
    const priceLabel = document.createElement('span');
    priceLabel.textContent = `$${formatUSD(price)}`;
    const quoteLabel = document.createElement('span');
    quoteLabel.className = 'mt-0.5 block text-[9px] font-normal text-slate-500';
    quoteLabel.textContent = quoteMeta;
    priceCell.append(priceLabel, quoteLabel);
    tr.appendChild(priceCell);
    addCell(`$${formatUSD(val)}`, 'py-2 px-3 text-right text-white font-semibold');
    addCell(`${allocation.toFixed(1)}%`, 'py-2 px-3 text-right text-slate-300 tabular-nums');
    const actionsCell = addCell('', 'py-2 px-3 text-center space-x-2');
    const refreshButton = document.createElement('button');
    refreshButton.className = 'text-cyan-400 hover:text-cyan-300 text-xs font-bold';
    refreshButton.title = 'Refresh Live Price';
    refreshButton.setAttribute('aria-label', `Refresh ${h.ticker} quote`);
    refreshButton.textContent = '↻';
    refreshButton.addEventListener('click', () => fetchLivePrice(h.ticker));
    const removeButton = document.createElement('button');
    removeButton.className = 'text-rose-400 hover:text-rose-300 text-xs font-bold';
    removeButton.textContent = 'Remove';
    removeButton.addEventListener('click', () => removeCashStock(idx));
    actionsCell.append(refreshButton, removeButton);
    tableBody.appendChild(tr);
  });

  if ((state.cashCushion.holdings || []).length === 0) {
    tableBody.innerHTML = `<tr><td colspan="6" class="py-3 text-center text-slate-500 italic">No cash stocks entered. Add unleveraged stocks below (price auto-fetches).</td></tr>`;
  }
  tableFooter.innerHTML = holdings.length > 0
    ? `<tr>
        <td class="py-2 px-3 text-slate-300 font-bold" colspan="3">${holdings.length} holding${holdings.length === 1 ? '' : 's'}</td>
        <td class="py-2 px-3 text-right text-white font-bold">$${formatUSD(stocksTotal)}</td>
        <td class="py-2 px-3 text-right text-slate-300 font-bold">${stocksTotal > 0 ? '100.0%' : '—'}</td>
        <td></td>
      </tr>`
    : '';
  document.getElementById('cashHoldingsSummary').textContent =
    `${holdings.length} holding${holdings.length === 1 ? '' : 's'} · $${formatUSD(stocksTotal)} market value`;

  const totalCushion = freeCash + stocksTotal;
  document.getElementById('cushionTotalValue').innerText = `$${formatUSD(totalCushion)}`;
}

function renderClosedHistoryPanel() {
  const tableBody = document.getElementById('closedTradesTableBody');
  tableBody.innerHTML = '';

  const trades = [...state.closedTrades].sort((a, b) => Number(b.date) - Number(a.date));
  trades.forEach(trade => {
    const row = document.createElement('tr');
    row.className = 'border-b border-slate-800/60 text-slate-300';

    const dateValue = Number(trade.date);
    const closedDate = new Date(Number.isFinite(dateValue) ? dateValue : Date.parse(trade.date));
    const dateText = Number.isNaN(closedDate.getTime())
      ? 'Unknown'
      : closedDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const netProfit = Number(trade.netProfit) || 0;
    const netCell = document.createElement('td');
    netCell.className = `py-2 px-3 text-right font-bold ${netProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`;
    netCell.textContent = `${netProfit >= 0 ? '+' : '-'}$${formatUSD(Math.abs(netProfit))}`;

    [
      { value: trade.ticker || '—', className: 'py-2 px-3 font-bold text-white' },
      { value: dateText, className: 'py-2 px-3 whitespace-nowrap' },
      { value: `${formatUSD(trade.shares)} shares`, className: 'py-2 px-3 text-right whitespace-nowrap' },
      { value: `${Math.max(0, Number(trade.holdingDays) || 0)} days`, className: 'py-2 px-3 text-right whitespace-nowrap' },
      { value: `$${formatUSD(trade.feesAndCommissions)}`, className: 'py-2 px-3 text-right whitespace-nowrap' }
    ].forEach(cell => {
      const element = document.createElement('td');
      element.className = cell.className;
      element.textContent = cell.value;
      row.appendChild(element);
    });
    row.appendChild(netCell);
    tableBody.appendChild(row);
  });

  document.getElementById('closedTradesEmptyState').classList.toggle('hidden', trades.length > 0);
}

function formatQuoteMetadata(holding) {
  if (!holding.quoteUpdatedAt) return holding.quoteSource || 'Not fetched';

  const updatedAt = Number(holding.quoteUpdatedAt);
  if (!Number.isFinite(updatedAt)) return holding.quoteSource || 'Not fetched';
  const time = new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const refreshInterval = Number(localStorage.getItem(QUOTE_REFRESH_INTERVAL_KEY)) || DEFAULT_QUOTE_REFRESH_INTERVAL_MS;
  const isStale = Date.now() - updatedAt > Math.max(5 * 60 * 1000, refreshInterval * 2);
  return `${isStale ? 'Stale · ' : ''}${holding.quoteSource || 'Quote'} · ${time}`;
}

function recordTrackedPrice(ticker, price, sourceName, updatedAt = null) {
  const symbol = ticker.toUpperCase();
  let matched = false;
  const updateQuoteMetadata = holding => {
    holding.quoteSource = sourceName;
    if (updatedAt === null) delete holding.quoteUpdatedAt;
    else holding.quoteUpdatedAt = updatedAt;
  };

  if (state.positions[symbol]) {
    state.positions[symbol].currentPrice = price;
    updateQuoteMetadata(state.positions[symbol]);
    matched = true;
  }
  const cashHolding = state.cashCushion?.holdings?.find(holding => holding.ticker === symbol);
  if (cashHolding) {
    cashHolding.price = price;
    updateQuoteMetadata(cashHolding);
    matched = true;
  }
  return matched;
}

function addCashHolding(ticker, shares, givenPrice = 0) {
  const symbol = ticker.trim().toUpperCase();
  const quantity = Number(shares);
  const manualPrice = Number(givenPrice);
  if (!symbol || !Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('Ticker and a positive share quantity are required.');
  }

  if (!state.cashCushion) state.cashCushion = { freeCash: 0, holdings: [] };
  if (!Array.isArray(state.cashCushion.holdings)) state.cashCushion.holdings = [];
  const existing = state.cashCushion.holdings.find(holding => holding.ticker === symbol);
  const currentPrice = Number.isFinite(manualPrice) && manualPrice > 0
    ? manualPrice
    : (Number(existing?.price) || 0);

  if (existing) {
    existing.shares = (Number(existing.shares) || 0) + quantity;
  } else {
    state.cashCushion.holdings.push({ ticker: symbol, shares: quantity, price: currentPrice });
  }
  if (Number.isFinite(manualPrice) && manualPrice > 0) {
    recordTrackedPrice(symbol, manualPrice, 'Manual');
  }
  return { ticker: symbol, shares: quantity, price: currentPrice };
}

function removeCashHolding(ticker) {
  const holdings = state.cashCushion?.holdings;
  if (!Array.isArray(holdings)) return null;
  const symbol = ticker.trim().toUpperCase();
  const index = holdings.findIndex(holding => holding.ticker === symbol);
  return index < 0 ? null : holdings.splice(index, 1)[0];
}

function setCurrentBalance(value) {
  const signedBalance = Number.isFinite(Number(value)) ? Number(value) : 0;
  state.cashCushion.freeCash = Math.max(0, signedBalance);
  state.marginBalance = Math.min(0, signedBalance);
  return {
    balance: Math.max(0, signedBalance),
    debt: Math.max(0, -signedBalance)
  };
}

function saveCurrentBalanceFromInput() {
  const input = document.getElementById('freeCashInput');
  if (!input.reportValidity()) return;

  const inputValue = input.valueAsNumber;
  const { balance, debt } = setCurrentBalance(inputValue);
  saveState();
  renderBoard();
  logTerminal(`[Balance]: Current balance/debt updated. Balance: $${formatUSD(balance)} | Margin debt: -$${formatUSD(debt)}.`);
  showToast(`Balance $${formatUSD(balance)} | Debt -$${formatUSD(debt)}`, 'success');
}

async function addCashStockFromUI() {
  const tickerInput = document.getElementById('newCashTicker');
  const sharesInput = document.getElementById('newCashShares');
  const priceInput = document.getElementById('newCashPrice');

  const ticker = tickerInput.value.trim().toUpperCase();
  const shares = sharesInput.valueAsNumber;
  const manualPrice = priceInput.value === '' ? NaN : priceInput.valueAsNumber;

  if (!tickerInput.reportValidity() || !sharesInput.reportValidity() ||
      (priceInput.value !== '' && !priceInput.reportValidity())) return;

  if (!ticker) {
    logTerminal(`[Error]: Please enter valid ticker symbol and share count.`);
    tickerInput.focus();
    return;
  }

  addCashHolding(ticker, shares, manualPrice);

  tickerInput.value = '';
  sharesInput.value = '';
  priceInput.value = '';

  saveState();
  renderBoard();
  logTerminal(`[Balance]: Added ${shares} ${ticker}. Fetching live online quote...`);
  showToast(`${shares} ${ticker} added to balance holdings.`, 'success');
  await fetchLivePrice(ticker);
}

function removeCashStock(index) {
  const holding = state.cashCushion?.holdings?.[index];
  if (!holding) return;
  const removed = removeCashHolding(holding.ticker);
  saveState();
  renderBoard();
  logTerminal(`[Cash Cushion]: Removed ${removed.ticker} from cash holdings.`);
  showToast(`${removed.ticker} removed from cash holdings.`, 'info');
}

function renderCombinedView(tickers) {
  let totalInvested = 0;
  let totalMarketValue = 0;
  let totalCommBuy = 0;
  let totalCommSell = 0;
  let totalGrossTarget = 0;
  let totalMarginCharged = state.realizedMarginCharged || 0;

  tickers.forEach(t => {
    const pos = state.positions[t];
    const cost = (pos.tranches || []).reduce((sum, tr) => sum + (tr.qty * tr.price), 0);
    totalInvested += cost;
    totalMarketValue += pos.shares * pos.currentPrice;
    totalCommBuy += pos.commBuy;
    const valSell = pos.shares * pos.pt;
    totalCommSell += calcCommission(pos.shares, valSell);
    totalGrossTarget += (valSell - cost);
    totalMarginCharged += (pos.marginCharged || 0.00);
  });

  const totalComms = totalCommBuy + totalCommSell;
  const net0 = totalGrossTarget - totalComms - totalMarginCharged;
  const netPct = totalInvested > 0 ? (net0 / totalInvested) * 100 : 0;
  const totalUnrealized = totalMarketValue - totalInvested;
  const unrealizedPct = totalInvested > 0 ? (totalUnrealized / totalInvested) * 100 : 0;

  const totalDebt = Math.abs(state.marginBalance);
  const dailyAccrual = totalDebt * getDailyRate();

  document.getElementById('boardTitle').innerText = tickers.length > 0
    ? `COMBINED PORTFOLIO (${tickers.length} Positions | ${netPct >= 0 ? '+' : ''}${netPct.toFixed(2)}% Net Combined Target)`
    : `NO ACTIVE MARGIN POSITIONS`;

  document.getElementById('boardTranches').innerText = tickers.length > 0
    ? tickers.map(t => `${t}: ${state.positions[t].shares}sh @ PT $${formatUSD(state.positions[t].pt)}`).join(' | ')
    : "None";

  document.getElementById('boardInvested').innerText = `$${formatUSD(totalInvested)} | Across ${tickers.length} Assets`;
  
  const unSign = totalUnrealized >= 0 ? '+' : '';
  document.getElementById('boardPrice').innerHTML = `$${formatUSD(totalMarketValue)} – <span class="${totalUnrealized >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${unSign}$${formatUSD(totalUnrealized)} (${unSign}${unrealizedPct.toFixed(2)}%)</span>`;
  
  document.getElementById('boardMargin').innerText = `-$${formatUSD(totalDebt)} ($${formatUSD(dailyAccrual)}/day @ ${(getDailyRate()*100).toFixed(4)}%)`;
  document.getElementById('boardComms').innerText = `$${formatUSD(totalComms)} ($${formatUSD(totalCommBuy)} buy / $${formatUSD(totalCommSell)} sell)`;
  document.getElementById('boardMarginCharged').innerText = `$${formatUSD(totalMarginCharged)}`;

  const cushionTotal = getCashCushionTotal();
  document.getElementById('boardCushionLabel').innerText = 'Cash / Collateral Cushion:';
  document.getElementById('boardCushionMetric').innerText = `+$${formatUSD(cushionTotal)}`;
  const quotes = tickers.map(ticker => state.positions[ticker]).filter(position => position.quoteUpdatedAt);
  const latestQuote = quotes.sort((a, b) => b.quoteUpdatedAt - a.quoteUpdatedAt)[0];
  document.getElementById('boardQuoteMeta').innerText = latestQuote
    ? `Latest portfolio quote · ${formatQuoteMetadata(latestQuote)}`
    : 'No live quotes fetched for margin positions';

  const totalAccountEquity = (totalMarketValue + cushionTotal) - totalDebt;
  const totalAccountAssets = totalMarketValue + cushionTotal;
  const equityPct = totalAccountAssets > 0 ? (totalAccountEquity / totalAccountAssets) * 100 : 0;
  document.getElementById('boardEquity').innerText = `$${formatUSD(totalAccountEquity)} (${equityPct.toFixed(2)}%)`;

  renderMarginRisk(totalDebt, totalMarketValue, cushionTotal);

  renderProjectionTable(totalGrossTarget, totalComms, totalDebt, totalMarginCharged, state.startDate);
}

function renderSingleAssetView(pos) {
  if (!pos) return;
  const totalInvested = (pos.tranches || []).reduce((sum, t) => sum + (t.qty * t.price), 0);
  const avgPrice = pos.shares > 0 ? totalInvested / pos.shares : 0;
  const valSell = pos.shares * pos.pt;
  const commSell = calcCommission(pos.shares, valSell);
  const totalComms = pos.commBuy + commSell;
  const gross = valSell - totalInvested;

  const portfolioInvested = getTotalPortfolioInvested();
  const weight = portfolioInvested > 0 ? (totalInvested / portfolioInvested) : 1;
  
  const totalAccountDebt = Math.abs(state.marginBalance);
  const allocatedDebt = totalAccountDebt * weight;
  const totalCushion = getCashCushionTotal();
  const allocatedCushion = totalCushion * weight;
  const allocatedDailyAccrual = allocatedDebt * getDailyRate();
  const posMarginCharged = pos.marginCharged || 0.00;

  const net0 = gross - totalComms - posMarginCharged;
  const netPct = totalInvested > 0 ? (net0 / totalInvested) * 100 : 0;

  const currentMktVal = pos.shares * pos.currentPrice;
  const unrealized = currentMktVal - totalInvested;
  const unrealizedPct = avgPrice > 0 ? ((pos.currentPrice - avgPrice) / avgPrice) * 100 : 0;

  document.getElementById('boardTitle').innerText = `${pos.ticker} (${pos.shares} Shares @ $${formatUSD(pos.pt)} PT | ${netPct >= 0 ? '+' : ''}${netPct.toFixed(2)}% Net Target)`;
  document.getElementById('boardTranches').innerText = (pos.tranches && pos.tranches.length > 0) 
    ? pos.tranches.map(t => `${t.qty} @ $${formatUSD(t.price)} (${t.date || 'New'})`).join(' + ')
    : "None";
  document.getElementById('boardInvested').innerText = `$${formatUSD(totalInvested)} | $${formatUSD(avgPrice)}`;
  
  const unSign = unrealized >= 0 ? '+' : '';
  document.getElementById('boardPrice').innerHTML = `$${formatUSD(pos.currentPrice)} | $${formatUSD(currentMktVal)} – <span class="${unrealized >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${unSign}$${formatUSD(unrealized)} (${unSign}${unrealizedPct.toFixed(2)}%)</span>`;
  
  const isFullDebt = Math.abs(allocatedDebt - totalAccountDebt) < 0.01;
  document.getElementById('boardMargin').innerText = isFullDebt
    ? `-$${formatUSD(allocatedDebt)} ($${formatUSD(allocatedDailyAccrual)}/day)`
    : `-$${formatUSD(allocatedDebt)} ($${formatUSD(allocatedDailyAccrual)}/day) [${((allocatedDebt / (totalAccountDebt || 1)) * 100).toFixed(0)}% of -$${formatUSD(totalAccountDebt)} Total]`;

  document.getElementById('boardComms').innerText = `$${formatUSD(totalComms)} ($${formatUSD(pos.commBuy)} buy / $${formatUSD(commSell)} sell)`;
  document.getElementById('boardMarginCharged').innerText = `$${formatUSD(posMarginCharged)} (Position To Date)`;

  document.getElementById('boardCushionLabel').innerText = 'Allocated Cash / Collateral:';
  document.getElementById('boardCushionMetric').innerText = `+$${formatUSD(allocatedCushion)}`;
  document.getElementById('boardQuoteMeta').innerText = formatQuoteMetadata(pos);

  const positionAssets = currentMktVal + allocatedCushion;
  const positionEquity = positionAssets - allocatedDebt;
  const equityPct = positionAssets > 0 ? (positionEquity / positionAssets) * 100 : 0;
  document.getElementById('boardEquity').innerText = `$${formatUSD(positionEquity)} (${equityPct.toFixed(2)}%)`;

  renderMarginRisk(allocatedDebt, currentMktVal, allocatedCushion);

  renderProjectionTable(gross, totalComms, allocatedDebt, posMarginCharged, pos.startDate || state.startDate);
}

function renderMarginRisk(debt, positionValue, collateral) {
  const marginCallRow = document.getElementById('boardMarginCallRow');
  const stopOutRow = document.getElementById('boardStopOutRow');
  const riskSummary = document.getElementById('boardMarginRisk');

  if (debt <= 0) {
    riskSummary.innerText = 'No margin debt';
    riskSummary.className = 'text-emerald-400 font-bold font-mono';
    marginCallRow.classList.add('hidden');
    stopOutRow.classList.add('hidden');
    return;
  }

  const assets = positionValue + collateral;
  const equity = assets - debt;
  const equityRatio = assets > 0 ? (equity / assets) * 100 : -Infinity;
  const maintenanceRatio = TRADERNET_RULES.maintenanceMarginRatio * 100;
  const stopOutRatio = TRADERNET_RULES.stopOutRatio * 100;
  let riskLevel;
  let riskClass;

  if (equityRatio <= stopOutRatio) {
    riskLevel = 'Stop-out level';
    riskClass = 'text-rose-400';
  } else if (equityRatio <= maintenanceRatio) {
    riskLevel = 'Margin-call level';
    riskClass = 'text-rose-400';
  } else if (equityRatio <= maintenanceRatio + 5) {
    riskLevel = 'Elevated';
    riskClass = 'text-amber-400';
  } else {
    riskLevel = 'Healthy';
    riskClass = 'text-emerald-400';
  }
  riskSummary.innerText = `${riskLevel} · ${Number.isFinite(equityRatio) ? `${equityRatio.toFixed(1)}% equity` : 'negative equity'} (${maintenanceRatio.toFixed(1)}% maintenance)`;
  riskSummary.className = `${riskClass} font-bold font-mono`;

  const marginCallAssetsRequired = debt / (1 - TRADERNET_RULES.maintenanceMarginRatio);
  const stopOutAssetsRequired = debt / (1 - TRADERNET_RULES.stopOutRatio);
  marginCallRow.classList.toggle('hidden', collateral >= marginCallAssetsRequired);
  stopOutRow.classList.toggle('hidden', collateral >= stopOutAssetsRequired);
  const marginCallValue = Math.max(0, marginCallAssetsRequired - collateral);
  const stopOutValue = Math.max(0, stopOutAssetsRequired - collateral);

  if (marginCallValue > 0) document.getElementById('boardMarginCall').innerText = formatRiskTrigger(marginCallValue, positionValue);
  if (collateral < stopOutAssetsRequired) document.getElementById('boardStopOut').innerText = formatRiskTrigger(stopOutValue, positionValue);
}

function formatRiskTrigger(triggerValue, currentValue) {
  if (currentValue <= 0) return `Position value $${formatUSD(triggerValue)}`;

  const bufferPct = ((currentValue - triggerValue) / currentValue) * 100;
  if (bufferPct < 0) {
    return `Position value $${formatUSD(triggerValue)} (already ${Math.abs(bufferPct).toFixed(1)}% below trigger)`;
  }
  return `Position value $${formatUSD(triggerValue)} (${bufferPct.toFixed(1)}% buffer)`;
}

function renderProjectionTable(gross, totalComms, debtToUse, marginChargedToUse, baseDateStr) {
  const tableBody = document.getElementById('projectionTableBody');
  tableBody.innerHTML = '';
  
  if (debtToUse > 0 || gross > 0) {
    const dayOffsets = [0, 7, 14, 21, 28, 35];
    const base = baseDateStr ? new Date(baseDateStr + "T12:00:00") : new Date();

    dayOffsets.forEach(days => {
      const d = new Date(base);
      d.setDate(d.getDate() + days);
      
      const dateFormatted = `${d.toLocaleDateString('en-US', { month: 'short' })} ${d.getDate()}`;
      const label = days === 0 ? `${dateFormatted} (Today)` : `${dateFormatted} (+${days}d)`;

      const b_t = debtToUse * Math.pow(1 + getDailyRate(), days);
      const additionalAccrual = b_t - debtToUse;
      const m_d = marginChargedToUse + additionalAccrual;
      const fee_c = totalComms + m_d;
      const net_p = gross - fee_c;
      const dr = b_t * getDailyRate();

      const tr = document.createElement('tr');
      tr.className = days === 0 ? "bg-slate-900/80 font-bold" : "hover:bg-slate-900/40";
      const netClass = net_p >= 0 ? "text-emerald-400" : "text-rose-400";
      const netSign = net_p >= 0 ? "+" : "";

      tr.innerHTML = `
        <td class="py-2 px-3 text-slate-300 font-semibold">${label}</td>
        <td class="py-2 px-3 text-right ${netClass} font-semibold">${netSign}$${formatUSD(net_p)}</td>
        <td class="py-2 px-3 text-right text-slate-200">$${formatUSD(fee_c)}</td>
        <td class="py-2 px-3 text-right text-slate-400">$${formatUSD(m_d)} ($${formatUSD(dr)})</td>
        <td class="py-2 px-3 text-right text-rose-400">-$${formatUSD(b_t)}</td>
      `;
      tableBody.appendChild(tr);
    });
  } else {
    tableBody.innerHTML = `<tr><td colspan="5" class="py-4 text-center text-slate-500 italic">No active position to project.</td></tr>`;
  }
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  const palette = {
    success: 'border-emerald-500/60 bg-emerald-950/80 text-emerald-200',
    error: 'border-rose-500/60 bg-rose-950/80 text-rose-200',
    warning: 'border-amber-500/60 bg-amber-950/80 text-amber-200',
    info: 'border-sky-500/60 bg-sky-950/80 text-sky-200'
  };

  toast.className = `border rounded-lg px-3 py-2 text-xs font-semibold shadow-lg backdrop-blur-sm ${palette[type] || palette.info}`;
  toast.classList.add('ui-toast-enter');
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-1');
    setTimeout(() => toast.remove(), 220);
  }, 2600);
}

function updateEmptyStateVisibility(isEmpty) {
  const panel = document.getElementById('emptyStatePanel');
  if (!panel) return;
  panel.classList.toggle('hidden', !isEmpty);
}

function logTerminal(content, isUser = false, isHtml = false) {
  const log = document.getElementById('terminalLog');
  if (!log) {
    console.log(content);
    return;
  }
  const div = document.createElement('div');
  if (isUser) {
    div.className = "text-cyan-400 font-semibold";
    div.innerText = "> " + content;
  } else if (isHtml) {
    div.innerHTML = content;
  } else {
    div.className = "text-slate-300";
    div.innerText = content;
  }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

async function requestLivePrice(symbol) {
  const existingRequest = livePriceRequests.get(symbol);
  if (existingRequest) return existingRequest;

  const request = fetchLivePriceFromProviders(symbol).then(result => ({
    ...result,
    matched: result.price !== null
      ? recordTrackedPrice(symbol, result.price, result.sourceName, result.updatedAt)
      : false
  }));
  livePriceRequests.set(symbol, request);
  try {
    return await request;
  } finally {
    if (livePriceRequests.get(symbol) === request) livePriceRequests.delete(symbol);
  }
}

async function fetchLivePriceFromProviders(symbol) {
  symbol = symbol.toUpperCase();
  let price = null;
  let sourceName = "";
  const providerErrors = [];
  const configuredSymbols = state.quoteSymbols?.[symbol] || {};
  const finnhubSymbol = configuredSymbols.finnhub || symbol;
  const stooqSymbol = configuredSymbols.stooq || `${symbol.toLowerCase()}.us`;

  const finnhubKey = localStorage.getItem('finnhub_api_key');

  if (finnhubKey) {
    try {
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(finnhubSymbol)}&token=${encodeURIComponent(finnhubKey)}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.c && Number(data.c) > 0) {
          price = Number(data.c);
          sourceName = `Finnhub Live · ${finnhubSymbol}`;
        } else {
          providerErrors.push("Finnhub returned no valid quote");
        }
      } else {
        providerErrors.push(`Finnhub returned HTTP ${res.status}`);
      }
    } catch (error) {
      providerErrors.push(`Finnhub: ${error.message}`);
    }
  }

  if (!price) {
    try {
      const stooqUrl = `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSymbol.toLowerCase())}&f=sd2t2ohlcv&h&e=csv`;
      const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(stooqUrl)}`;
      
      const res = await fetch(proxyUrl);
      if (res.ok) {
        const json = await res.json();
        if (json && json.contents) {
          const lines = json.contents.trim().split('\n');
          if (lines.length >= 2) {
            const cols = lines[1].split(',');
            const val = parseFloat(cols[6]);
            if (!isNaN(val) && val > 0) {
              price = val;
              sourceName = `Stooq Feed · ${stooqSymbol}`;
            } else {
              providerErrors.push("Stooq returned no valid quote");
            }
          } else {
            providerErrors.push("Stooq returned an empty quote");
          }
        } else {
          providerErrors.push("Stooq proxy returned no quote data");
        }
      } else {
        providerErrors.push(`Stooq proxy returned HTTP ${res.status}`);
      }
    } catch (error) {
      providerErrors.push(`Stooq: ${error.message}`);
    }
  }

  const updatedAt = price ? Date.now() : null;

  return {
    price,
    sourceName,
    updatedAt,
    error: price ? null : (providerErrors.length ? providerErrors.join("; ") : "No quote provider is configured")
  };
}

async function fetchLivePrice(ticker, silent = false) {
  const symbol = ticker.toUpperCase();
  const result = await requestLivePrice(symbol);

  if (result.price !== null) {
    saveState();
    renderBoard();
    if (!silent) {
      logTerminal(`[${result.sourceName}]: ${symbol} updated to $${formatUSD(result.price)}${result.matched ? '' : ' (quote only)'}.`);
    }
    return result.price;
  }

  const tracked = state.positions[symbol]?.currentPrice || (state.cashCushion?.holdings?.find(h => h.ticker === symbol)?.price) || 0;
  if (!silent) {
    logTerminal(`[Market Data Error]: Could not fetch ${symbol}. ${result.error}. Retained tracked price: $${formatUSD(tracked)}. Set manually via: price ${symbol} <number>.`);
  }
  return null;
}

async function refreshAllLivePrices() {
  if (isRefreshingLivePrices) return;

  const marginSymbols = Object.keys(state.positions);
  const cashSymbols = (state.cashCushion?.holdings || []).map(h => h.ticker);
  const allSymbols = Array.from(new Set([...marginSymbols, ...cashSymbols]));

  if (allSymbols.length === 0) return;

  isRefreshingLivePrices = true;
  try {
    logTerminal(`[System]: Polling live quotes for ${allSymbols.join(', ')}...`);
    const failedQuotes = [];
    for (const sym of allSymbols) {
      const result = await requestLivePrice(sym);
      if (result.price === null) failedQuotes.push(`${sym} (${result.error})`);
    }
    if (failedQuotes.length < allSymbols.length) saveState();
    renderBoard();
    if (failedQuotes.length === 0) {
      logTerminal(`[System]: Live market quotes refreshed for all ${allSymbols.length} assets.`);
    } else {
      const successfulCount = allSymbols.length - failedQuotes.length;
      logTerminal(`[Market Data Error]: Quotes refreshed for ${successfulCount}/${allSymbols.length} assets. Failed: ${failedQuotes.join(', ')}.`);
    }
  } finally {
    isRefreshingLivePrices = false;
  }
}

function setQuoteRefreshInterval(interval) {
  const intervalMs = Number(interval);
  if (!QUOTE_REFRESH_INTERVALS.has(intervalMs)) {
    throw new Error(`Unsupported quote refresh interval: ${interval}`);
  }

  if (quoteRefreshTimer !== null) clearInterval(quoteRefreshTimer);
  quoteRefreshTimer = null;
  localStorage.setItem(QUOTE_REFRESH_INTERVAL_KEY, String(intervalMs));

  if (intervalMs > 0) {
    quoteRefreshTimer = setInterval(() => {
      if (!document.hidden) document.getElementById('refreshQuotesButton').click();
    }, intervalMs);
  }
}

function exportBackupJSON() {
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state, null, 2));
  const downloadAnchor = document.createElement('a');
  const filename = `margin_portfolio_backup_${new Date().toISOString().split('T')[0]}.json`;
  downloadAnchor.setAttribute("href", dataStr);
  downloadAnchor.setAttribute("download", filename);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
  logTerminal(`[Backup]: Exported state to ${filename}.`);
}

async function importBackupJSON(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const importedState = JSON.parse(e.target.result);
      if (importedState && typeof importedState === 'object') {
        state = normalizePortfolioState(importedState);
        
        localStorage.setItem('margin_portfolio_state_dynamic_v2', JSON.stringify(state));
        await pushStateToGist(true);
        renderBoard();
        logTerminal(`[Backup Import]: Successfully imported ${file.name}. GitHub Gist overwritten.`);
      } else {
        throw new Error("Invalid structure");
      }
    } catch (err) {
      logTerminal(`[Backup Error]: Could not parse backup file (${err.message}).`);
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

function runLadderSimulation(data) {
  const ticker = data.ticker || (state.activeView !== "COMBINED" && state.activeView !== "CASH_CUSHION" && state.activeView !== "CLOSED_HISTORY" ? state.activeView : Object.keys(state.positions)[0]);
  const pos = state.positions[ticker];
  if (!pos || pos.shares <= 0) {
    logTerminal(`[Ladder Error]: No active position found for ${ticker}.`);
    return;
  }

  const totalInvested = (pos.tranches || []).reduce((sum, t) => sum + (t.qty * t.price), 0);
  const portfolioInvested = getTotalPortfolioInvested();
  const weight = portfolioInvested > 0 ? (totalInvested / portfolioInvested) : 1;
  
  let runningDebt = Math.abs(state.marginBalance) * weight;
  let totalAccruedMargin = pos.marginCharged || 0.00;
  let totalComms = pos.commBuy;
  let totalGrossProceeds = 0;
  let currentDay = 0;

  const stepsRender = [];

  data.steps.forEach((step, idx) => {
    const stepDays = Math.max(0, step.days - currentDay);
    if (stepDays > 0 && runningDebt > 0) {
      const compounded = runningDebt * Math.pow(1 + getDailyRate(), stepDays);
      totalAccruedMargin += (compounded - runningDebt);
      runningDebt = compounded;
    }
    currentDay = step.days;

    const proceeds = step.shares * step.price;
    totalGrossProceeds += proceeds;
    const commSell = calcCommission(step.shares, proceeds);
    totalComms += commSell;

    const netCashCredited = proceeds - commSell;
    runningDebt = Math.max(0, runningDebt - netCashCredited);

    stepsRender.push(`
      <div class="border-l-2 border-cyan-500/50 pl-2 space-y-0.5">
        <div class="text-slate-200 font-semibold">Stage ${idx + 1} (${step.label || '+' + step.days + 'd'}): Sell ${step.shares} @ $${formatUSD(step.price)}</div>
        <div class="text-slate-400">Proceeds: $${formatUSD(proceeds)} | Comm: $${formatUSD(commSell)} | Remaining Debt: <span class="text-rose-400 font-mono">-$${formatUSD(runningDebt)}</span></div>
      </div>
    `);
  });

  const grossPnl = totalGrossProceeds - totalInvested;
  const netPnl = grossPnl - totalComms - totalAccruedMargin;
  const netPct = totalInvested > 0 ? (netPnl / totalInvested) * 100 : 0;
  const netColor = netPnl >= 0 ? "text-emerald-400" : "text-rose-400";
  const netSign = netPnl >= 0 ? "+" : "";

  const html = `
    <div class="border border-purple-800/80 bg-purple-950/20 p-3 rounded my-2 text-xs space-y-2">
      <div class="font-bold text-purple-300 border-b border-purple-800/60 pb-1 flex justify-between items-center">
        <span>[LADDERED SCALE-OUT SIMULATION]: ${ticker}</span>
        <span class="${netColor} font-black text-sm">${netSign}$${formatUSD(netPnl)} (${netSign}${netPct.toFixed(2)}% Net)</span>
      </div>
      <div class="space-y-1.5 py-1">
        ${stepsRender.join('')}
      </div>
      <div class="border-t border-purple-800/60 pt-1.5 grid grid-cols-2 gap-2 text-slate-300">
        <div><span class="text-slate-500">Gross Proceeds:</span> $${formatUSD(totalGrossProceeds)} (Gross: ${grossPnl >= 0 ? '+' : ''}$${formatUSD(grossPnl)})</div>
        <div><span class="text-slate-500">Total Comms:</span> $${formatUSD(totalComms)}</div>
        <div><span class="text-slate-500">Accrued Margin Drag:</span> <span class="text-rose-400">$${formatUSD(totalAccruedMargin)}</span></div>
        <div><span class="text-slate-500">Debt Reduction Benefit:</span> <span class="text-emerald-400 font-semibold">Reduced Bleed Applied</span></div>
      </div>
    </div>
  `;
  logTerminal(html, false, true);
}

function runComparison(data) {
  const ticker = data.ticker || (state.activeView !== "COMBINED" && state.activeView !== "CASH_CUSHION" && state.activeView !== "CLOSED_HISTORY" ? state.activeView : Object.keys(state.positions)[0]);
  const pos = state.positions[ticker];
  if (!pos || pos.shares <= 0) {
    logTerminal(`[Comparison Error]: No active position found for ${ticker}.`);
    return;
  }

  const totalInvested = (pos.tranches || []).reduce((sum, t) => sum + (t.qty * t.price), 0);
  const portfolioInvested = getTotalPortfolioInvested();
  const weight = portfolioInvested > 0 ? (totalInvested / portfolioInvested) : 1;
  const debtToUse = Math.abs(state.marginBalance) * weight;
  const marginChargedToUse = pos.marginCharged || 0.00;

  const computed = data.scenarios.map(s => {
    const grossProceeds = pos.shares * s.price;
    const grossPnl = grossProceeds - totalInvested;
    const commSell = calcCommission(pos.shares, grossProceeds);
    const totalComms = pos.commBuy + commSell;
    
    const b_t = debtToUse * Math.pow(1 + getDailyRate(), s.days);
    const additionalMargin = b_t - debtToUse;
    const totalMargin = marginChargedToUse + additionalMargin;

    const netPnl = grossPnl - totalComms - totalMargin;
    const netPct = (netPnl / totalInvested) * 100;
    const resultingBalance = state.marginBalance + (grossProceeds - commSell);

    return {
      ...s,
      grossProceeds,
      grossPnl,
      commSell,
      totalComms,
      totalMargin,
      additionalMargin,
      netPnl,
      netPct,
      resultingBalance
    };
  });

  const sA = computed[0];
  const sB = computed[1];
  const diffNet = sB.netPnl - sA.netPnl;
  const diffMargin = sB.totalMargin - sA.totalMargin;

  const diffColor = diffNet >= 0 ? "text-emerald-400 font-black" : "text-rose-400 font-black";
  const diffSign = diffNet >= 0 ? "+" : "";

  const html = `
    <div class="border border-cyan-800 bg-cyan-950/20 p-3 rounded my-2 text-xs space-y-3">
      <div class="font-bold text-cyan-300 border-b border-cyan-800/60 pb-1 flex justify-between items-center">
        <span>[COMPARISON]: ${pos.shares} ${ticker} — ${sA.label} VS ${sB.label}</span>
        <span class="${diffColor}">Diff: ${diffSign}$${formatUSD(diffNet)} Net</span>
      </div>

      <div class="grid grid-cols-2 gap-4">
        <div class="bg-slate-900/60 p-2.5 rounded border border-slate-800 space-y-1">
          <div class="font-bold text-slate-200 border-b border-slate-800 pb-1 flex justify-between">
            <span>${sA.label}</span>
            <span class="${sA.netPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${sA.netPnl >= 0 ? '+' : ''}$${formatUSD(sA.netPnl)} (${sA.netPct.toFixed(2)}%)</span>
          </div>
          <div><span class="text-slate-500">Gross Proceeds:</span> $${formatUSD(sA.grossProceeds)}</div>
          <div><span class="text-slate-500">Commissions:</span> $${formatUSD(sA.totalComms)}</div>
          <div><span class="text-slate-500">Margin Accrued:</span> $${formatUSD(sA.totalMargin)}</div>
          <div><span class="text-slate-500">Resulting Balance:</span> <span class="${sA.resultingBalance >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${sA.resultingBalance >= 0 ? '+' : '-'}$${formatUSD(Math.abs(sA.resultingBalance))}</span></div>
        </div>

        <div class="bg-slate-900/60 p-2.5 rounded border border-slate-800 space-y-1">
          <div class="font-bold text-slate-200 border-b border-slate-800 pb-1 flex justify-between">
            <span>${sB.label}</span>
            <span class="${sB.netPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${sB.netPnl >= 0 ? '+' : ''}$${formatUSD(sB.netPnl)} (${sB.netPct.toFixed(2)}%)</span>
          </div>
          <div><span class="text-slate-500">Gross Proceeds:</span> $${formatUSD(sB.grossProceeds)}</div>
          <div><span class="text-slate-500">Commissions:</span> $${formatUSD(sB.totalComms)}</div>
          <div><span class="text-slate-500">Margin Accrued:</span> $${formatUSD(sB.totalMargin)} (+${formatUSD(sB.additionalMargin)})</div>
          <div><span class="text-slate-500">Resulting Balance:</span> <span class="${sB.resultingBalance >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${sB.resultingBalance >= 0 ? '+' : '-'}$${formatUSD(Math.abs(sB.resultingBalance))}</span></div>
        </div>
      </div>

      <div class="text-[11px] text-slate-400 border-t border-slate-800 pt-1.5 flex justify-between">
        <span>Tradernet margin penalty for waiting: <strong class="text-rose-400">+$${formatUSD(diffMargin)}</strong></span>
        <span>Net advantage: <strong class="${diffColor}">${diffSign}$${formatUSD(diffNet)}</strong></span>
      </div>
    </div>
  `;

  logTerminal(html, false, true);
}

function runSimulation(simPrice, daysOffset, label, tickerTarget) {
  const ticker = tickerTarget || (state.activeView !== "COMBINED" && state.activeView !== "CASH_CUSHION" && state.activeView !== "CLOSED_HISTORY" ? state.activeView : Object.keys(state.positions)[0]);
  const pos = state.positions[ticker];
  if (!pos || pos.shares <= 0) {
    logTerminal(`[Simulation Error]: No active position open for ${ticker}.`);
    return;
  }

  const totalInvested = (pos.tranches || []).reduce((sum, t) => sum + (t.qty * t.price), 0);
  const grossProceeds = pos.shares * simPrice;
  const grossPnl = grossProceeds - totalInvested;
  const commSell = calcCommission(pos.shares, grossProceeds);
  const totalComms = pos.commBuy + commSell;

  const portfolioInvested = getTotalPortfolioInvested();
  const weight = portfolioInvested > 0 ? (totalInvested / portfolioInvested) : 1;
  const debtToUse = Math.abs(state.marginBalance) * weight;

  const b_t = debtToUse * Math.pow(1 + getDailyRate(), daysOffset);
  const additionalMargin = b_t - debtToUse;
  const totalMarginAtDate = (pos.marginCharged || 0.00) + additionalMargin;

  const netPnl = grossPnl - totalComms - totalMarginAtDate;
  const netPct = totalInvested > 0 ? (netPnl / totalInvested) * 100 : 0;
  const resultingBalance = (state.marginBalance + (grossProceeds - commSell));

  const netColor = netPnl >= 0 ? "text-emerald-400" : "text-rose-400";
  const netSign = netPnl >= 0 ? "+" : "";
  const balColor = resultingBalance >= 0 ? "text-emerald-400" : "text-rose-400";
  const balSign = resultingBalance >= 0 ? "+" : "-";

  const html = `
    <div class="border border-cyan-800/80 bg-cyan-950/20 p-3 rounded my-2 text-xs space-y-1">
      <div class="font-bold text-cyan-300 flex justify-between border-b border-cyan-800/50 pb-1">
        <span>[SIMULATION]: Sell ${pos.shares} ${ticker} @ $${formatUSD(simPrice)} (${label})</span>
        <span class="${netColor} font-black">${netSign}$${formatUSD(netPnl)} (${netSign}${netPct.toFixed(2)}%)</span>
      </div>
      <div class="grid grid-cols-2 gap-2 text-slate-300 pt-1">
        <div><span class="text-slate-500">Gross Proceeds:</span> $${formatUSD(grossProceeds)} (Gross: ${grossPnl >= 0 ? '+' : ''}$${formatUSD(grossPnl)})</div>
        <div><span class="text-slate-500">Commissions:</span> $${formatUSD(totalComms)} ($${formatUSD(pos.commBuy)} buy / $${formatUSD(commSell)} sell)</div>
        <div><span class="text-slate-500">Margin Accrued:</span> $${formatUSD(totalMarginAtDate)} (+$${formatUSD(additionalMargin)} over ${daysOffset}d)</div>
        <div><span class="text-slate-500">Resulting Balance:</span> <span class="${balColor} font-semibold">${balSign}$${formatUSD(Math.abs(resultingBalance))}</span></div>
      </div>
    </div>
  `;
  logTerminal(html, false, true);
}

// ==========================================
// PORTFOLIO ACTIONS (CASH-FIRST ORDER FLOW)
// ==========================================
async function applyPortfolioActions(action) {
  const todayDateStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

  if (action.action === "buy") {
    const ticker = action.ticker.toUpperCase();
    const shares = Number(action.shares);
    const price = Number(action.price);
    const tradeCost = shares * price;
    const buyComm = calcCommission(shares, tradeCost);
    const totalOutlay = tradeCost + buyComm;

    if (!state.positions[ticker]) {
      state.positions[ticker] = {
        ticker: ticker,
        shares: 0,
        tranches: [],
        currentPrice: price,
        quoteSource: 'Trade input',
        pt: action.pt ? Number(action.pt) : Number((price * 1.05).toFixed(2)),
        commBuy: 0,
        marginCharged: 0.00,
        startDate: new Date().toISOString().split('T')[0]
      };
    }

    const pos = state.positions[ticker];
    pos.shares += shares;
    pos.tranches.push({
      qty: shares,
      price: price,
      date: action.date || todayDateStr,
      acquiredAt: resolveTradeDateTimestamp(action.date),
      buyCommission: buyComm
    });
    pos.commBuy += buyComm;
    pos.currentPrice = price;
    pos.quoteSource = 'Trade input';
    delete pos.quoteUpdatedAt;
    if (action.pt) pos.pt = Number(action.pt);

    // 1. Consume Free Cash first
    const currentFreeCash = Number(state.cashCushion?.freeCash) || 0;
    const cashUsed = Math.min(currentFreeCash, totalOutlay);
    const debtAdded = totalOutlay - cashUsed;

    if (cashUsed > 0) {
      state.cashCushion.freeCash = currentFreeCash - cashUsed;
    }

    // 2. Only the remaining unpaid portion increases margin debt
    state.marginBalance = state.marginBalance - debtAdded;
    state.activeView = ticker;

    saveState();
    logTerminal(`[Executed Buy]: Added ${shares} ${ticker} @ $${formatUSD(price)}. Outlay: $${formatUSD(totalOutlay)} (Comm: $${formatUSD(buyComm)}). Funded: $${formatUSD(cashUsed)} cash | +$${formatUSD(debtAdded)} margin debt. Free Cash remaining: $${formatUSD(state.cashCushion.freeCash)}. Total Margin Debt: -$${formatUSD(Math.abs(state.marginBalance))}.`);
    showToast(`${shares} ${ticker} bought at $${formatUSD(price)}.`, 'success');
  } 
  else if (action.action === "sell") {
    const ticker = action.ticker.toUpperCase();
    let pos = state.positions[ticker];
    let isCashHolding = false;
    let cashHoldingIdx = -1;

    // Check if closing a cash-held stock instead of a margin position
    if (!pos && state.cashCushion && state.cashCushion.holdings) {
      cashHoldingIdx = state.cashCushion.holdings.findIndex(h => h.ticker === ticker);
      if (cashHoldingIdx !== -1) {
        isCashHolding = true;
        pos = state.cashCushion.holdings[cashHoldingIdx];
      }
    }

    if (!pos) {
      logTerminal(`[Error]: Position ${ticker} not found to close.`);
      return;
    }

    const availableShares = Number(pos.shares);
    if (!Number.isFinite(availableShares) || availableShares <= 0) {
      logTerminal(`[Error]: Position ${ticker} has no valid shares to sell.`);
      return;
    }

    const hasRequestedShares = action.shares !== null && action.shares !== undefined;
    const requestedShares = hasRequestedShares ? Number(action.shares) : availableShares;
    if (!Number.isFinite(requestedShares) || requestedShares <= 0) {
      logTerminal(`[Sell Error]: Enter a positive share quantity, or omit the quantity to sell all ${ticker} shares.`);
      showToast('Sell quantity must be greater than zero.', 'error');
      return;
    }
    const sharesToSell = Math.min(availableShares, requestedShares);

    const sellPrice = Number(action.price);
    if (!Number.isFinite(sellPrice) || sellPrice <= 0) {
      logTerminal(`[Sell Error]: Enter a valid sale price greater than zero for ${ticker}.`);
      showToast('Sale price must be greater than zero.', 'error');
      return;
    }
    const grossProceeds = sharesToSell * sellPrice;
    const sellComm = calcCommission(sharesToSell, grossProceeds);
    const netCashCredited = grossProceeds - sellComm;

    // 1. Pay down existing margin debt first
    const currentDebt = Math.abs(state.marginBalance);
    let debtRepaid = 0;
    let cashSurplus = 0;

    if (currentDebt > 0) {
      debtRepaid = Math.min(currentDebt, netCashCredited);
      state.marginBalance = currentDebt > debtRepaid ? -(currentDebt - debtRepaid) : 0;
      cashSurplus = netCashCredited - debtRepaid;
    } else {
      cashSurplus = netCashCredited;
    }

    // 2. Overflow proceeds automatically replenish Free Uninvested Cash
    if (cashSurplus > 0) {
      if (!state.cashCushion) state.cashCushion = { freeCash: 0.00, holdings: [] };
      state.cashCushion.freeCash = (Number(state.cashCushion.freeCash) || 0) + cashSurplus;
    }

    const resultMessage = `${sharesToSell} ${ticker} sold at $${formatUSD(sellPrice)}.`;

    if (isCashHolding) {
      if (sharesToSell >= pos.shares) {
        state.cashCushion.holdings.splice(cashHoldingIdx, 1);
        logTerminal(`[Cash Holding Closed]: Sold ${sharesToSell} ${ticker} @ $${formatUSD(sellPrice)}. Net credited: +$${formatUSD(netCashCredited)} (Debt paid: $${formatUSD(debtRepaid)}, Free Cash added: $${formatUSD(cashSurplus)}).`);
      } else {
        pos.shares -= sharesToSell;
        logTerminal(`[Cash Holding Partial Sell]: Sold ${sharesToSell} ${ticker} @ $${formatUSD(sellPrice)}. Remaining: ${pos.shares} shares.`);
      }
    } else {
      const realizedTrade = realizeClosedTrade(pos, ticker, sharesToSell, sellPrice, sellComm, Date.now());
      state.positions[ticker] = realizedTrade.position;
      if (realizedTrade.trade) state.closedTrades.push(realizedTrade.trade);
      state.realizedMarginCharged = (state.realizedMarginCharged || 0) + realizedTrade.marginFee;

      if (realizedTrade.position.shares <= 1e-8) {
        delete state.positions[ticker];
        state.activeView = "COMBINED";
        logTerminal(`[Position Closed]: Sold ${sharesToSell} ${ticker} @ $${formatUSD(sellPrice)}. Net credited: +$${formatUSD(netCashCredited)} (Debt paid: $${formatUSD(debtRepaid)}, Free Cash added: $${formatUSD(cashSurplus)}). Remaining Debt: -$${formatUSD(Math.abs(state.marginBalance))}. Free Cash: $${formatUSD(state.cashCushion.freeCash)}.`);
      } else {
        logTerminal(`[Partial Sell]: Sold ${sharesToSell} ${ticker} @ $${formatUSD(sellPrice)}. Net credited: +$${formatUSD(netCashCredited)} (Debt paid: $${formatUSD(debtRepaid)}, Free Cash added: $${formatUSD(cashSurplus)}). Remaining: ${realizedTrade.position.shares} shares.`);
      }
    }

    saveState();
    showToast(resultMessage, 'success');
  }
  else if (action.action === "set_pt") {
    const ticker = (action.ticker ? action.ticker.toUpperCase() : null) || (state.activeView !== "COMBINED" && state.activeView !== "CASH_CUSHION" && state.activeView !== "CLOSED_HISTORY" ? state.activeView : Object.keys(state.positions)[0]);
    if (state.positions[ticker] && Number(action.pt) > 0) {
      state.positions[ticker].pt = Number(action.pt);
      saveState();
      logTerminal(`[Target Updated]: ${ticker} PT updated to $${formatUSD(action.pt)}.`);
    }
  }
  else if (action.action === "set_price") {
    const ticker = (action.ticker ? action.ticker.toUpperCase() : null) || (state.activeView !== "COMBINED" && state.activeView !== "CASH_CUSHION" && state.activeView !== "CLOSED_HISTORY" ? state.activeView : Object.keys(state.positions)[0]);
    const newP = Number(action.price);
    
    if (!newP || isNaN(newP) || newP <= 0) {
      logTerminal(`[Price Unchanged]: No valid price amount supplied. Enter: price ${ticker} <number>.`);
      return;
    }

    const updated = recordTrackedPrice(ticker, newP, 'Manual');
    if (updated) {
      saveState();
      logTerminal(`[Price Updated]: ${ticker} market price set to $${formatUSD(newP)}.`);
    }
  }
  else if (action.action === "set_balance") {
    state.marginBalance = -Math.abs(Number(action.balance));
    saveState();
    logTerminal(`[Margin Synced]: Total margin balance explicitly set to -$${formatUSD(Math.abs(state.marginBalance))}.`);
  }
  else if (action.action === "set_free_cash") {
    const { balance, debt } = setCurrentBalance(action.amount);
    saveState();
    logTerminal(`[Balance]: Current balance/debt updated. Balance: $${formatUSD(balance)} | Margin debt: -$${formatUSD(debt)}.`);
  }
  else if (action.action === "add_cash_stock") {
    const ticker = action.ticker.toUpperCase();
    const shares = Number(action.shares);
    const givenPrice = Number(action.price) || 0;

    addCashHolding(ticker, shares, givenPrice);
    saveState();
    logTerminal(`[Balance]: Added ${shares} ${ticker} to balance holdings. Syncing online quote...`);
    renderBoard();
    await fetchLivePrice(ticker);
    return;
  }
  else if (action.action === "remove_cash_stock") {
    const ticker = action.ticker.toUpperCase();
    const removed = removeCashHolding(ticker);
    if (removed) {
      saveState();
      logTerminal(`[Balance]: Removed ${removed.ticker} from balance holdings.`);
    }
  }

  renderBoard();
}

async function executeCommand() {
  const input = document.getElementById('cmdInput');
  const text = input.value.trim();
  if (!text) return;
  
  logTerminal(text, true);
  input.value = '';

  if (/^(?:pull|sync cloud|cloud pull|pull cloud|load cloud)$/i.test(text)) {
    await pullCloudAndRewriteLocal();
    return;
  }

  const quoteSymbolCommand = text.match(/^quote\s+symbol(?:\s+(.*))?$/i);
  if (quoteSymbolCommand) {
    const [tickerInput, ...assignments] = (quoteSymbolCommand[1] || '').trim().split(/\s+/);
    if (!tickerInput || !/^[A-Za-z0-9._:-]+$/.test(tickerInput) || assignments.length === 0) {
      logTerminal('[Command Error]: Use quote symbol TICKER finnhub=SYMBOL stooq=SYMBOL (use default to clear a provider mapping).');
      return;
    }
    const mapping = { ...getQuoteSymbolMapping(tickerInput) };
    for (const assignment of assignments) {
      const match = assignment.match(/^(finnhub|stooq)=(.+)$/i);
      if (!match) {
        logTerminal('[Command Error]: Use quote symbol TICKER finnhub=SYMBOL stooq=SYMBOL (use default to clear a provider mapping).');
        return;
      }
      mapping[match[1].toLowerCase()] = match[2].toLowerCase() === 'default' ? '' : match[2];
    }
    const ticker = tickerInput.toUpperCase();
    const updatedMapping = setQuoteSymbolMapping(ticker, mapping);
    logTerminal(`[Quote Mapping]: ${ticker} — Finnhub: ${updatedMapping.finnhub || 'default'} | Stooq: ${updatedMapping.stooq || 'default'}. Refresh ${ticker} or click Quotes to apply.`);
    return;
  }

  const quoteMatch = text.match(/^(?:quote|price of|fetch price|get price)\s+([A-Za-z]+)$/i);
  if (quoteMatch) {
    fetchLivePrice(quoteMatch[1].toUpperCase());
    return;
  }

  const apiKey = localStorage.getItem('gemini_api_key');
  if (!apiKey) {
    logTerminal("[Error]: Missing API Key. Enter your Google AI Studio key above.");
    showToast('Missing Gemini API key.', 'error');
    return;
  }

  document.getElementById('aiStatus').innerText = "CONNECTING...";
  document.getElementById('aiStatus').className = "text-amber-400 text-[10px]";

  const activeTickers = Object.keys(state.positions);
  const dynamicTodayStr = new Date().toISOString().split('T')[0];

  const prompt = `
Analyze this trading input: "${text}".
Active margin positions: ${JSON.stringify(activeTickers)}.
Currently viewed asset: "${state.activeView}".
Today's reference date: ${dynamicTodayStr}.

Classify intent into ONE JSON structure (NO markdown backticks, raw JSON only):

1. ADD CASH / UNLEVERAGED STOCK (e.g. "add cash stock 50 AAPL", "add cash stock 50 AAPL at 230", "bought 10 VOO for cash", "cash stock 20 NVDA"):
{
  "intent": "action",
  "action": "add_cash_stock",
  "ticker": "<ticker symbol>",
  "shares": <number>,
  "price": <number or null if not stated>
}

2. REMOVE CASH STOCK (e.g. "remove cash stock AAPL", "delete cash holding VOO"):
{
  "intent": "action",
  "action": "remove_cash_stock",
  "ticker": "<ticker symbol>"
}

3. SET CURRENT BALANCE OR MARGIN DEBT (positive for balance, negative for debt; e.g. "balance 5000", "balance -5000"):
{
  "intent": "action",
  "action": "set_free_cash",
  "amount": <number>
}

4. LADDERED SCALE-OUT (e.g. "sell 15 JBL for 305 today and 18 for 315 in 7 days"):
{
  "intent": "ladder",
  "ticker": "<ticker symbol, default to activeView>",
  "steps": [
    { "shares": <number>, "price": <number>, "days": <integer days from today>, "label": "<short label>" }
  ]
}

5. SIDE-BY-SIDE EXIT COMPARISON (e.g. "sell today for 300 vs sell 10 days later for 310"):
{
  "intent": "comparison",
  "ticker": "<ticker symbol or null>",
  "scenarios": [
    { "label": "<e.g. Today @ $300>", "price": <number>, "days": <integer days from today> },
    { "label": "<e.g. 10d Later @ $310>", "price": <number>, "days": <integer days from today> }
  ]
}

6. SINGLE WHAT-IF SIMULATION (e.g. "in case of selling for 300 today"):
{
  "intent": "simulation",
  "ticker": "<ticker symbol or null>",
  "simPrice": <number>,
  "daysOffset": <integer days from today>,
  "label": "<short label>"
}

7. LIVE QUOTE INQUIRY (e.g. "what's the current JBL price?", "quote AAPL"):
{
  "intent": "fetch_quote",
  "ticker": "<ticker symbol, default to activeView>"
}

8. BUYING SHARES:
{
  "intent": "action",
  "action": "buy",
  "ticker": "<ticker symbol>",
  "shares": <number>,
  "price": <number>,
  "pt": <number or null>,
  "date": "<e.g. 05 Oct or null>"
}

9. SELLING / CLOSING SHARES:
{
  "intent": "action",
  "action": "sell",
  "ticker": "<ticker symbol>",
  "shares": <number or null if selling all>,
  "price": <number>
}

10. SETTING TARGET (PT or SL):
{
  "intent": "action",
  "action": "set_pt",
  "ticker": "<ticker symbol or null>",
  "pt": <number>
}

11. SETTING MARKET PRICE:
{
  "intent": "action",
  "action": "set_price",
  "ticker": "<ticker symbol or null>",
  "price": <number>
}

12. SYNCING MARGIN BALANCE:
{
  "intent": "action",
  "action": "set_balance",
  "balance": <number>
}

13. GENERAL CHAT / Q&A:
{
  "intent": "chat",
  "response": "<concise explanation>"
}
`;

  try {
    let activeModels = [];
    try {
      const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      const listData = await listRes.json();
      if (listData.models) {
        activeModels = listData.models
          .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent"))
          .map(m => m.name.replace(/^models\//, ''));
      }
    } catch (listErr) {}

    activeModels.sort((a, b) => (b.includes("flash") ? 1 : 0) - (a.includes("flash") ? 1 : 0));
    if (activeModels.length === 0) {
      activeModels = ["gemini-1.5-flash", "gemini-2.0-flash", "gemini-1.5-pro"];
    }

    document.getElementById('aiStatus').innerText = "PARSING...";
    let lastError = null;
    let success = false;

    for (const model of activeModels) {
      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { 
              temperature: 0.0,
              responseMimeType: "application/json"
            }
          })
        });

        const data = await response.json();
        if (data.error) {
          if (data.error.code === 503 || data.error.code === 404 || data.error.code === 400) {
            lastError = new Error(`${data.error.message} (${model})`);
            continue;
          }
          throw new Error(`${data.error.message} (Code ${data.error.code})`);
        }

        if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
          throw new Error("No candidate returned by Gemini API.");
        }

        const rawText = data.candidates[0].content.parts[0].text.trim();
        const parsed = JSON.parse(rawText);

        if (parsed.intent === "ladder") {
          runLadderSimulation(parsed);
          logTerminal(`[Ladder Exit Evaluated via ${model}]`);
        } else if (parsed.intent === "comparison") {
          runComparison(parsed);
          logTerminal(`[Comparison Evaluated via ${model}]`);
        } else if (parsed.intent === "simulation") {
          runSimulation(parsed.simPrice, parsed.daysOffset || 0, parsed.label || "Sim Target", parsed.ticker);
          logTerminal(`[Simulation Evaluated via ${model}]`);
        } else if (parsed.intent === "fetch_quote") {
          const tickerToFetch = (parsed.ticker && parsed.ticker !== "null") ? parsed.ticker.toUpperCase() : (state.activeView !== "COMBINED" && state.activeView !== "CASH_CUSHION" && state.activeView !== "CLOSED_HISTORY" ? state.activeView : Object.keys(state.positions)[0]);
          if (tickerToFetch) fetchLivePrice(tickerToFetch);
          else logTerminal("[Notice]: No active ticker specified to fetch quote for.");
        } else if (parsed.intent === "action") {
          await applyPortfolioActions(parsed);
        } else if (parsed.intent === "chat") {
          logTerminal(`[AI Advisor]: ${parsed.response}`);
        }

        document.getElementById('aiStatus').innerText = "READY";
        document.getElementById('aiStatus').className = "text-slate-500 text-[10px]";
        success = true;
        break;
      } catch (err) {
        lastError = err;
      }
    }

    if (!success) {
      logTerminal(`[Error]: ${lastError ? lastError.message : 'All model endpoints busy. Retry in 15s.'}`);
      document.getElementById('aiStatus').innerText = "ERROR";
      document.getElementById('aiStatus').className = "text-rose-400 text-[10px]";
    }
  } catch (err) {
    logTerminal(`[Error]: ${err.message}`);
    document.getElementById('aiStatus').innerText = "ERROR";
    document.getElementById('aiStatus').className = "text-rose-400 text-[10px]";
  }
}

window.onload = async () => {
  await loadSavedState();
  headerCredentialsHidden = localStorage.getItem('header_credentials_hidden') === 'true';
  ['apiKeyInput', 'finnhubKeyInput', 'gistIdInput', 'githubTokenInput'].forEach(id => {
    document.getElementById(id).addEventListener('input', updateHeaderCredentialsVisibility);
  });
  const quoteRefreshInterval = document.getElementById('quoteRefreshInterval');
  const savedQuoteRefreshInterval = localStorage.getItem(QUOTE_REFRESH_INTERVAL_KEY);
  const parsedQuoteRefreshInterval = savedQuoteRefreshInterval === null ? NaN : Number(savedQuoteRefreshInterval);
  const initialQuoteRefreshInterval = QUOTE_REFRESH_INTERVALS.has(parsedQuoteRefreshInterval)
    ? parsedQuoteRefreshInterval
    : DEFAULT_QUOTE_REFRESH_INTERVAL_MS;
  quoteRefreshInterval.value = String(initialQuoteRefreshInterval);
  quoteRefreshInterval.addEventListener('change', () => setQuoteRefreshInterval(quoteRefreshInterval.value));
  setQuoteRefreshInterval(initialQuoteRefreshInterval);
  setBrokerRuleInputs();
  document.getElementById('brokerRulesForm').addEventListener('submit', saveBrokerRuleInputs);
  document.getElementById('resetBrokerRulesButton').addEventListener('click', resetBrokerRules);
  document.getElementById('quoteSymbolForm').addEventListener('submit', saveQuoteSymbolMapping);
  document.getElementById('quoteMappingTickerInput').addEventListener('change', event => {
    populateQuoteSymbolMapping(event.target.value);
  });
  updateHeaderCredentialsVisibility();
  await refreshAllLivePrices();
};

Object.assign(window, {
  addCashStockFromUI,
  executeCommand,
  exportBackupJSON,
  importBackupJSON,
  pullCloudAndRewriteLocal,
  refreshAllLivePrices,
  resetToBlankState,
  saveApiKeys,
  saveCurrentBalanceFromInput,
  toggleHeaderCredentialsVisibility
});

import { createBlankState, normalizePortfolioBackup, normalizePortfolioState, realizeClosedTrade, resolveSaleQuantity, resolveTradeDateTimestamp } from './src/domain/portfolio.ts';
import { getUsEquityProjectionDates } from './src/domain/tradingCalendar.ts';
import { generateIntentText, GeminiApiError, listGeminiModels, shouldTryAnotherGeminiModel } from './src/features/ai/geminiClient.ts';
import { parseAiIntent } from './src/features/ai/intent.ts';
import { buildIntentPrompt } from './src/features/ai/prompt.ts';
import { parseFinnhubQuoteDetails } from './src/features/quotes/finnhubQuote.ts';
import { fetchFinnhubInsight } from './src/features/quotes/finnhubInsights.ts';
import {
  fetchAlphaVantageAnalysts,
  fetchAlphaVantageEarnings,
  fetchAlphaVantageNews,
  fetchAlphaVantageOverview,
  fetchAlphaVantageQuote
} from './src/features/quotes/alphaVantageAnalysts.ts';
import { fetchTwelveDataQuote } from './src/features/quotes/twelveData.ts';
import {
  decryptProviderKeys,
  encryptProviderKeys
} from './src/features/credentials/encryptedProviderKeys.ts';
import {
  fetchRapidApiYahooAnalystTarget,
  fetchRapidApiYahooQuote
} from './src/features/quotes/rapidApiYahoo.ts';
import {
  classifyActualVsEstimate,
  classifyRecommendationCounts,
  classifySentimentScore,
  calculateTargetUpsidePercent,
  sentimentLabel,
  summarizeDailyQuote,
  summarizeGrowth
} from './src/features/quotes/sentiment.ts';

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
const GIST_CREDENTIALS_FILE_NAME = "provider_keys.enc.json";

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
let marketInsightsOpen = false;
let activeInsightSection = 'news';
let loadedInsightTicker = '';
let insightRequestId = 0;
let insightTicker = '';
const boardAnalystSnapshots = new Map();
const boardAnalystErrors = new Map();
const boardAnalystRequests = new Map();
const BOARD_ANALYST_CACHE_TTL_MS = 5 * 60 * 1000;
const BOARD_ANALYST_RETRY_MS = 60 * 1000;
const FINNHUB_ANALYST_RESTRICTED_PREFIX = 'finnhub_analyst_target_restricted:';
const QUOTE_PROVIDER_TIMEOUT_MS = 15 * 1000;

const QUOTE_REFRESH_INTERVAL_KEY = 'quote_refresh_interval_ms';
const DEFAULT_QUOTE_REFRESH_INTERVAL_MS = 60 * 1000;
const QUOTE_REFRESH_INTERVALS = new Set([0, 15 * 1000, 30 * 1000, 60 * 1000]);


// ==========================================
// HANDLE YAHOO API DATA
// ==========================================
const YAHOO_PROXY_URL = 'https://trading-proxy.armenavetisyan-sa.workers.dev';

async function fetchYahooStockData(ticker) {
  if (!ticker) return null;
  const cleanTicker = ticker.trim().toUpperCase();

  try {
    const res = await fetch(`${YAHOO_PROXY_URL}?symbol=${encodeURIComponent(cleanTicker)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    return data;
  } catch (err) {
    console.warn(`[Yahoo Data Error for ${cleanTicker}]:`, err.message);
    return null;
  }
}

// ==========================================
// GITHUB GIST ENCODING & REPLICATION ENGINE
// ==========================================
function encodePayload(obj) {
  const jsonStr = JSON.stringify(obj);
  return btoa(encodeURIComponent(jsonStr).replace(/%([0-9A-F]{2})/g, function (match, p1) {
    return String.fromCharCode('0x' + p1);
  }));
}

function decodePayload(str) {
  const jsonStr = decodeURIComponent(Array.prototype.map.call(atob(str), function (c) {
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

function getProviderKeysFromStorage() {
  return {
    finnhub: localStorage.getItem('finnhub_api_key') || '',
    alphaVantage: localStorage.getItem('alpha_vantage_api_key') || '',
    twelveData: localStorage.getItem('twelve_data_api_key') || '',
    rapidApiYahoo: localStorage.getItem('rapidapi_yahoo_key') || ''
  };
}

function applyProviderKeys(keys) {
  const storageKeys = {
    finnhub: 'finnhub_api_key',
    alphaVantage: 'alpha_vantage_api_key',
    twelveData: 'twelve_data_api_key',
    rapidApiYahoo: 'rapidapi_yahoo_key'
  };
  const inputIds = {
    finnhub: 'finnhubKeyInput',
    alphaVantage: 'alphaVantageKeyInput',
    twelveData: 'twelveDataKeyInput',
    rapidApiYahoo: 'rapidApiKeyInput'
  };
  Object.entries(storageKeys).forEach(([keyName, storageKey]) => {
    const value = keys[keyName] || '';
    if (value) localStorage.setItem(storageKey, value);
    else localStorage.removeItem(storageKey);
    const input = document.getElementById(inputIds[keyName]);
    if (input) input.value = value;
  });
}

async function saveProviderKeysToGist(keys, geminiKey) {
  const gistId = extractCleanGistId(localStorage.getItem('github_gist_id'));
  const token = (localStorage.getItem('github_pat_token') || '').trim();
  if (!gistId || !token) return false;
  if (!geminiKey.trim()) {
    throw new Error('Enter the Gemini key to encrypt provider keys for Gist storage.');
  }
  const envelope = await encryptProviderKeys(keys, geminiKey);
  const response = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      files: {
        [GIST_CREDENTIALS_FILE_NAME]: {
          content: JSON.stringify(envelope, null, 2)
        }
      }
    })
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`Could not save encrypted provider keys to Gist (HTTP ${response.status}: ${error.message || 'Gist update rejected'}).`);
  }
  return true;
}

async function restoreProviderKeysFromGistFile(file) {
  if (!file?.content) return;
  let envelope;
  try {
    envelope = JSON.parse(file.content);
  } catch {
    throw new Error('Encrypted provider-keys file is not valid JSON.');
  }

  let geminiKey = sessionStorage.getItem('gemini_api_key') ||
    localStorage.getItem('gemini_gist_unlock_key') ||
    '';
  if (!geminiKey) {
    geminiKey = window.prompt('Encrypted provider keys were found in this Gist. Enter the Gemini API key to unlock them:')?.trim() || '';
    if (!geminiKey) {
      logTerminal('[Gist Keys]: Restore skipped because the Gemini unlock key was not provided.');
      return;
    }
  }

  try {
    const keys = await decryptProviderKeys(envelope, geminiKey);
    sessionStorage.setItem('gemini_api_key', geminiKey);
    localStorage.setItem('gemini_gist_unlock_key', geminiKey);
    const geminiInput = document.getElementById('apiKeyInput');
    if (geminiInput) geminiInput.value = geminiKey;
    applyProviderKeys(keys);
    logTerminal('[Gist Keys]: Encrypted provider keys unlocked and saved in this browser.');
  } catch (error) {
    logTerminal(`[Gist Keys Error]: ${error instanceof Error ? error.message : String(error)}`);
    showToast('Could not unlock provider keys. Check the Gemini key.', 'error');
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
    const files = data.files || {};
    const targetFile = files[GIST_FILE_NAME] ||
      Object.entries(files).find(([name]) => name !== GIST_CREDENTIALS_FILE_NAME)?.[1];
    if (!targetFile || !targetFile.content) throw new Error("Gist contains no readable file.");
    if (files[GIST_CREDENTIALS_FILE_NAME]) {
      await restoreProviderKeysFromGistFile(files[GIST_CREDENTIALS_FILE_NAME]);
    }

    let remoteState = null;
    let parsedEnvelope = null;
    try { parsedEnvelope = JSON.parse(targetFile.content); } catch (e) { }

    if (parsedEnvelope) {
      if (parsedEnvelope.payload && typeof parsedEnvelope.payload === 'string') {
        try {
          remoteState = decodePayload(parsedEnvelope.payload);
        } catch (decErr) {
          try { remoteState = JSON.parse(atob(parsedEnvelope.payload)); } catch (e2) { }
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
  localStorage.removeItem('gemini_api_key');
  const savedGeminiKey = sessionStorage.getItem('gemini_api_key');
  if (savedGeminiKey) document.getElementById('apiKeyInput').value = savedGeminiKey;

  const savedFinnhub = localStorage.getItem('finnhub_api_key');
  if (savedFinnhub) document.getElementById('finnhubKeyInput').value = savedFinnhub;

  const savedAlphaVantage = localStorage.getItem('alpha_vantage_api_key');
  if (savedAlphaVantage) document.getElementById('alphaVantageKeyInput').value = savedAlphaVantage;

  const savedTwelveData = localStorage.getItem('twelve_data_api_key');
  if (savedTwelveData) document.getElementById('twelveDataKeyInput').value = savedTwelveData;

  const savedRapidApi = localStorage.getItem('rapidapi_yahoo_key');
  if (savedRapidApi) document.getElementById('rapidApiKeyInput').value = savedRapidApi;

  localStorage.removeItem('fmp_api_key');

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

function areHeaderCredentialsConfigured() {
  return ['apiKeyInput', 'finnhubKeyInput', 'gistIdInput', 'githubTokenInput']
    .every(id => document.getElementById(id).value.trim().length > 0);
}

function updateHeaderCredentialsVisibility() {
  const allFieldsFilled = areHeaderCredentialsConfigured();
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
  const geminiKey = document.getElementById('apiKeyInput').value.trim();
  if (geminiKey) sessionStorage.setItem('gemini_api_key', geminiKey);
  else sessionStorage.removeItem('gemini_api_key');
  localStorage.removeItem('gemini_api_key');

  const fKey = document.getElementById('finnhubKeyInput').value.trim();
  localStorage.setItem('finnhub_api_key', fKey);
  for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
    const key = sessionStorage.key(index);
    if (key?.startsWith(FINNHUB_ANALYST_RESTRICTED_PREFIX)) sessionStorage.removeItem(key);
  }

  const alphaVantageKey = document.getElementById('alphaVantageKeyInput').value.trim();
  if (alphaVantageKey) localStorage.setItem('alpha_vantage_api_key', alphaVantageKey);
  else localStorage.removeItem('alpha_vantage_api_key');
  const twelveDataKey = document.getElementById('twelveDataKeyInput').value.trim();
  if (twelveDataKey) localStorage.setItem('twelve_data_api_key', twelveDataKey);
  else localStorage.removeItem('twelve_data_api_key');
  const rapidApiKey = document.getElementById('rapidApiKeyInput').value.trim();
  if (rapidApiKey) localStorage.setItem('rapidapi_yahoo_key', rapidApiKey);
  else localStorage.removeItem('rapidapi_yahoo_key');
  renderBoardAnalystConsensus(getMarketInsightsTicker(), true);

  const rawGist = document.getElementById('gistIdInput').value.trim();
  const cleanGistId = extractCleanGistId(rawGist);
  localStorage.setItem('github_gist_id', cleanGistId);

  const token = document.getElementById('githubTokenInput').value.trim();
  localStorage.setItem('github_pat_token', token);

  let encryptedKeysSynced = false;
  if (cleanGistId && token) {
    try {
      encryptedKeysSynced = await saveProviderKeysToGist(getProviderKeysFromStorage(), geminiKey);
      if (encryptedKeysSynced) logTerminal('[Gist Keys]: Provider keys encrypted and saved to the Gist.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logTerminal(`[Gist Keys Error]: ${message}`);
      showToast(`Provider keys saved locally, but cloud encryption failed: ${message}`, 'error');
    }
  }

  logTerminal("[System]: Credentials saved.");
  const syncConfigured = Boolean(cleanGistId && token);
  const toastMessage = syncConfigured
    ? encryptedKeysSynced
      ? 'Credentials saved securely. Checking cloud state...'
      : 'Credentials saved locally. Add a Gemini key to encrypt provider keys in the Gist.'
    : 'Provider keys saved in this browser. Gist sync is not configured.';
  showToast(toastMessage, syncConfigured && encryptedKeysSynced ? 'success' : 'warning');
  if (cleanGistId) {
    await pullCloudAndRewriteLocal();
  }
  if (marketInsightsOpen) await loadMarketInsight(activeInsightSection, true);
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
    delete item.quoteDetails;
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
  const ticker = pos?.ticker || '[TICKER]';
  const currentPrice = pos && Number(pos.currentPrice) > 0 ? Number(pos.currentPrice) : null;
  const priceText = currentPrice === null ? '[current price]' : formatUSD(currentPrice);
  const comparisonPrice = currentPrice === null ? null : Number((currentPrice * 1.02).toFixed(2));
  const comparisonPriceText = comparisonPrice === null ? '[price]' : formatUSD(comparisonPrice);
  const commandInput = document.getElementById('cmdInput');
  commandInput.placeholder = `e.g. sell today for ${priceText} vs sell 14 days later for ${comparisonPriceText}`;
  document.getElementById('hintBuyShares').textContent = `bought [shares] ${ticker} for ${priceText}, pt [target]`;
  document.getElementById('hintCashHolding').textContent =
    `add cash stock [shares] ${ticker} or remove cash stock ${ticker}`;
  document.getElementById('hintLadderExit').textContent =
    `sell [shares] ${ticker} for ${priceText} today and [shares] for [price] in 7 days`;
  document.getElementById('hintExitComparison').textContent =
    `sell today for ${priceText} vs sell 14 days later for ${comparisonPriceText}`;
  document.getElementById('hintLiveQuote').textContent =
    `quote ${ticker} or what's the current ${ticker} price?`;
  document.getElementById('hintClosePosition').textContent =
    `sold all ${ticker} for ${priceText}`;

  const label = document.createElement('span');
  label.className = 'text-[10px] font-bold uppercase tracking-wider text-slate-500';

  if (!pos) {
    label.textContent = 'Quick actions';
    const hint = document.createElement('span');
    hint.className = 'text-[10px] text-slate-500';
    hint.textContent = 'Examples use [TICKER]; select a margin holding to use its tracked price.';
    container.append(label, hint);
    return;
  }

  label.className = 'text-[10px] font-bold uppercase tracking-wider text-slate-500';
  label.textContent = `${pos.ticker} · ${formatUSD(pos.shares)} shares`;
  container.appendChild(label);

  const actions = [
    { text: 'Quote', command: `quote ${pos.ticker}`, color: 'text-amber-300 border-amber-900/70 hover:bg-amber-950/50' },
    { text: 'Buy…', command: `bought [shares] ${pos.ticker} for ${priceText}`, color: 'text-emerald-300 border-emerald-900/70 hover:bg-emerald-950/50' },
    { text: 'Sell part…', command: `sold [shares] ${pos.ticker} for ${priceText}`, color: 'text-rose-300 border-rose-900/70 hover:bg-rose-950/50' },
    { text: 'Sell all…', command: `sold all ${pos.ticker} for ${priceText}`, color: 'text-rose-300 border-rose-900/70 hover:bg-rose-950/50' },
    {
      text: 'Compare exits…',
      command: `sell today for ${priceText} vs sell 14 days later for ${comparisonPriceText}`,
      selectText: comparisonPriceText,
      color: 'text-cyan-300 border-cyan-900/70 hover:bg-cyan-950/50'
    },
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
      if (action.selectText) {
        const selectionStart = action.command.lastIndexOf(action.selectText);
        input.setSelectionRange(selectionStart, selectionStart + action.selectText.length);
      } else if (action.command.includes('[')) {
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

function createStockPageLink(ticker, provider) {
  const link = document.createElement('a');
  const symbol = encodeURIComponent(ticker);
  link.href = provider === 'Finviz'
    ? `https://finviz.com/stock?t=${symbol}`
    : `https://stocktwits.com/symbol/${symbol}`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.className = 'px-2 py-1 rounded text-[10px] font-bold text-cyan-300 border border-cyan-900/70 hover:bg-slate-800';
  link.textContent = provider;
  link.title = `Open ${ticker} on ${provider} in a new tab`;
  link.setAttribute('aria-label', `Open ${ticker} on ${provider} in a new tab`);
  return link;
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
  cushionBtn.innerHTML = `<span>🛡️ BALANCE</span> <span class="text-[10px] px-1.5 py-0.2 rounded ${isCushionActive ? 'bg-cyan-800 text-white' : 'bg-cyan-950 text-cyan-300 font-mono'}">+$${cushionTotal.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>`;
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

  const activeTicker = state.positions[state.activeView] ? state.activeView : '';
  const stockPageLinks = document.getElementById('boardExternalLinks');
  stockPageLinks.replaceChildren();
  if (activeTicker) {
    stockPageLinks.append(
      createStockPageLink(activeTicker, 'Finviz'),
      createStockPageLink(activeTicker, 'Stocktwits')
    );
  }

  renderConsoleQuickActions();

  if (activeDeskView !== lastRenderedDeskView) {
    playEntryAnimation(activeDesk, 'ui-view-enter');
    lastRenderedDeskView = activeDeskView;
  }

  updateCombinedBreakeven();
  syncMarketInsightsPanel();
}

function getMarketInsightsTicker() {
  const currentView = state.activeView;
  if (currentView && currentView !== 'COMBINED' && currentView !== 'CASH_CUSHION') {
    return currentView;
  }
  const tickers = Object.keys(state.positions || {});
  return tickers.length === 1 ? tickers[0] : '';
}

function syncMarketInsightsPanel() {
  const ticker = getMarketInsightsTicker();
  const toggle = document.getElementById('marketInsightsToggle');
  const panel = document.getElementById('marketInsightsPanel');
  if (!toggle || !panel) return;

  toggle.classList.toggle('hidden', !ticker);
  panel.classList.toggle('hidden', !marketInsightsOpen || !ticker);
  toggle.setAttribute('aria-expanded', String(marketInsightsOpen && Boolean(ticker)));
  toggle.textContent = marketInsightsOpen ? 'HIDE INSIGHTS' : 'MARKET INSIGHTS';

  if (!ticker) {
    marketInsightsOpen = false;
    loadedInsightTicker = '';
    return;
  }

  const tickerBadge = document.getElementById('marketInsightsTicker');
  if (tickerBadge) tickerBadge.textContent = `· ${ticker}`;

  if (marketInsightsOpen && loadedInsightTicker !== ticker) {
    loadedInsightTicker = ticker;
    loadMarketInsight(activeInsightSection);
  }
}

async function renderYahooInsights(ticker) {
  const container = document.getElementById('marketInsightsBody') || document.getElementById('marketInsightsPanel');
  if (!container) return;

  container.innerHTML = '<div class="py-3 text-center text-xs text-slate-500 font-mono animate-pulse">Loading market insights...</div>';

  try {
    const res = await fetch(`${YAHOO_PROXY_URL}?symbol=${encodeURIComponent(ticker)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const val = data.valuation || {};
    const cal = data.calendar || {};
    const t = data.analystTargets || {};
    const p = data.price || {};

    container.innerHTML = `
      <div class="p-3 bg-slate-950/60 rounded border border-slate-800 space-y-3 font-mono text-xs">
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div class="bg-slate-900/70 p-2 rounded border border-slate-800/80">
            <span class="text-[10px] text-slate-500 uppercase block">Trailing P/E</span>
            <span class="text-white font-bold">${val.peTrailing ? Number(val.peTrailing).toFixed(2) : '—'}</span>
          </div>
          <div class="bg-slate-900/70 p-2 rounded border border-slate-800/80">
            <span class="text-[10px] text-slate-500 uppercase block">Forward P/E</span>
            <span class="text-white font-bold">${val.peForward ? Number(val.peForward).toFixed(2) : '—'}</span>
          </div>
          <div class="bg-slate-900/70 p-2 rounded border border-slate-800/80">
            <span class="text-[10px] text-slate-500 uppercase block">PEG Ratio</span>
            <span class="text-white font-bold">${val.pegRatio ?? '—'}</span>
          </div>
          <div class="bg-slate-900/70 p-2 rounded border border-slate-800/80">
            <span class="text-[10px] text-slate-500 uppercase block">Short % Float</span>
            <span class="text-amber-400 font-bold">${val.shortPercentOfFloat ?? '—'}</span>
          </div>
        </div>

        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1 border-t border-slate-800/60 text-[11px]">
          <div><span class="text-slate-500">Mean Target:</span> <span class="text-emerald-400 font-bold">$${t.mean ? t.mean.toFixed(2) : '—'}</span></div>
          <div><span class="text-slate-500">Consensus:</span> <span class="text-cyan-300 font-bold uppercase">${t.consensusRecommendation || '—'}</span> (${t.numberOfAnalysts || 0} analysts)</div>
          <div><span class="text-slate-500">Next Earnings:</span> <span class="text-purple-300 font-bold">${cal.earningsDate || 'TBD'}</span></div>
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="py-2 text-rose-400 text-xs">Failed to load insights: ${err.message}</div>`;
  }
}

function toggleMarketInsights() {
  const ticker = getMarketInsightsTicker();
  if (!ticker) return;
  const tickerWasLoaded = loadedInsightTicker === ticker;
  marketInsightsOpen = !marketInsightsOpen;
  syncMarketInsightsPanel();
  if (marketInsightsOpen && tickerWasLoaded) loadMarketInsight(activeInsightSection);
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
    const price = Number(h.currentPrice) || 0;
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
    const tickerCell = addCell('', 'py-2 px-3 text-cyan-300 font-bold');
    tickerCell.append(
      createInsightElement('span', '', h.ticker),
      document.createTextNode(' '),
      sentimentBadge(
        Number.isFinite(h.quoteDetails?.change)
          ? h.quoteDetails.change > 0 ? 'bullish' : h.quoteDetails.change < 0 ? 'bearish' : 'neutral'
          : 'unknown',
        Number.isFinite(h.quoteDetails?.change) && `${h.quoteDetails.changePercent.toFixed(2)}%`
      )
    );
    addCell(shares.toLocaleString('en-US', { maximumFractionDigits: 3 }), 'py-2 px-3 text-right text-slate-200 tabular-nums');
    const priceCell = document.createElement('td');
    priceCell.className = 'py-2 px-3 text-right text-emerald-400 font-semibold tabular-nums';
    const priceLabel = document.createElement('span');
    priceLabel.textContent = `$${formatUSD(price)}`;
    const quoteLabel = document.createElement('span');
    quoteLabel.className = 'mt-0.5 block text-[9px] font-normal text-slate-500';
    quoteLabel.textContent = quoteMeta;
    priceCell.append(priceLabel);
    const dailyQuoteLabel = createDailyQuoteLabel(h.quoteDetails);
    if (dailyQuoteLabel) priceCell.append(dailyQuoteLabel);
    priceCell.append(quoteLabel);
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

  const trades = state.closedTrades
    .map((trade, index) => ({ trade, index }))
    .sort((a, b) => Number(b.trade.date) - Number(a.trade.date));
  trades.forEach(({ trade, index }) => {
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
    const actionsCell = document.createElement('td');
    actionsCell.className = 'py-2 px-3 text-right';
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'rounded border border-slate-700 px-2 py-1 text-[10px] font-semibold text-slate-400 hover:border-rose-800 hover:text-rose-300';
    deleteButton.textContent = 'Delete';
    deleteButton.setAttribute('aria-label', `Delete ${trade.ticker || 'unknown'} closed trade from history`);
    deleteButton.addEventListener('click', () => deleteClosedTrade(index));
    actionsCell.appendChild(deleteButton);
    row.appendChild(actionsCell);
    tableBody.appendChild(row);
  });

  document.getElementById('closedTradesEmptyState').classList.toggle('hidden', trades.length > 0);
}

function deleteClosedTrade(index) {
  const trade = state.closedTrades[index];
  if (!trade) return;
  if (!confirm(`Delete the ${trade.ticker || 'unknown'} closed trade from history? This cannot be undone.`)) return;

  state.closedTrades.splice(index, 1);
  saveState();
  renderBoard();
  logTerminal(`[History]: Removed the ${trade.ticker || 'unknown'} closed trade from history.`);
  showToast('Closed trade removed from history.', 'info');
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

function createDailyQuoteLabel(details) {
  if (!details || typeof details !== 'object') return null;
  const hasChange = Number.isFinite(details.change) && Number.isFinite(details.changePercent);
  const hasRange = Number.isFinite(details.high) && Number.isFinite(details.low);
  if (!hasChange && !hasRange) return null;

  const label = document.createElement('span');
  label.className = 'mt-0.5 block text-[9px] font-normal tabular-nums';
  const parts = [];
  if (hasChange) {
    const sign = details.change >= 0 ? '+' : '−';
    parts.push(`${sign}$${formatUSD(Math.abs(details.change))} (${sign}${Math.abs(details.changePercent).toFixed(2)}%)`);
    label.classList.add('text-slate-400');
  } else {
    label.classList.add('text-slate-400');
  }
  if (hasRange) parts.push(`H $${formatUSD(details.high)} / L $${formatUSD(details.low)}`);
  label.textContent = `Day: ${parts.join(' · ')}`;
  return label;
}

function createInsightElement(tagName, className = '', text = '') {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function sentimentBadge(direction, label = sentimentLabel(direction)) {
  const styles = {
    bullish: 'border-emerald-800 bg-emerald-950/50 text-emerald-300',
    bearish: 'border-rose-800 bg-rose-950/50 text-rose-300',
    neutral: 'border-slate-700 bg-slate-900 text-slate-300',
    unknown: 'border-slate-800 bg-slate-950 text-slate-500'
  };
  const badge = createInsightElement(
    'span',
    `inline-flex items-center rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${styles[direction]}`,
    label
  );
  badge.dataset.sentiment = direction;
  badge.title = direction === 'unknown'
    ? 'The selected data source did not provide a sentiment signal.'
    : 'A directional marker based only on the provider values shown in this section.';
  return badge;
}

function getAnalystTargetPrice(result) {
  const targets = result?.targets && typeof result.targets === 'object' ? result.targets : {};
  const values = [result?.targetPrice, targets.targetMean, targets.targetMedian];
  return values.find(value => typeof value === 'number' && Number.isFinite(value) && value > 0);
}

async function fetchBoardAnalystTarget(ticker) {
  const finnhubKey = localStorage.getItem('finnhub_api_key') || '';
  const alphaVantageKey = localStorage.getItem('alpha_vantage_api_key') || '';
  const rapidApiKey = localStorage.getItem('rapidapi_yahoo_key') || '';
  const failures = [];
  const restrictionKey = `${FINNHUB_ANALYST_RESTRICTED_PREFIX}${ticker}`;
  const finnhubRestricted = sessionStorage.getItem(restrictionKey) === 'true';

  if (!ticker) return null;
  const cleanTicker = ticker.trim().toUpperCase();

  try {
    const res = await fetch(`${YAHOO_PROXY_URL}?symbol=${encodeURIComponent(cleanTicker)}`);
    if (res.ok) {
      const data = await res.json();
      const t = data.analystTargets;
      const targetPrice = t?.median || t?.mean || t?.high;

      // If Yahoo returns a valid target, return immediately. Finnhub gets ignored.
      if (typeof targetPrice === "number" && Number.isFinite(targetPrice) && targetPrice > 0) {
        return {
          targetPrice: targetPrice,
          provider: "Yahoo",
          source: "Yahoo",
          targetMean: t.mean,
          targetHigh: t.high,
          targetLow: t.low,
          numberOfAnalysts: t.numberOfAnalysts || 0,
          consensus: t.consensusRecommendation || null,
          valuation: data.valuation,
          calendar: data.calendar,
          profile: data.profile
        };
      }
    }
  } catch (err) {
    console.warn(`[Yahoo Worker Error for ${cleanTicker}]:`, err.message);
  }

  if (finnhubKey && !finnhubRestricted) {
    try {
      const result = await fetchFinnhubInsight(finnhubKey, 'stock/price-target', { symbol: ticker });
      const targetPrice = getAnalystTargetPrice({ targets: result });
      if (targetPrice) return { targetPrice, source: 'Finnhub' };
      failures.push('Finnhub returned no consensus price target.');
    } catch (error) {
      if (error?.status === 403) {
        sessionStorage.setItem(restrictionKey, 'true');
        failures.push('Finnhub analyst price targets are restricted for this symbol or plan (HTTP 403).');
      } else {
        failures.push(`Finnhub: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else if (finnhubKey && finnhubRestricted) {
    failures.push('Finnhub analyst price targets were previously restricted for this symbol in this session.');
  }

  if (alphaVantageKey) {
    try {
      const result = await fetchAlphaVantageAnalysts(alphaVantageKey, ticker);
      if (result.targetPrice) return { targetPrice: result.targetPrice, source: 'Alpha Vantage' };
      failures.push('Alpha Vantage returned no consensus price target.');
    } catch (error) {
      failures.push(`Alpha Vantage: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (rapidApiKey) {
    try {
      return await fetchRapidApiYahooAnalystTarget(rapidApiKey, ticker);
    } catch (error) {
      failures.push(`Yahoo Finance via RapidAPI: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length === 0) {
    throw new Error('Add a Finnhub, Alpha Vantage, or RapidAPI key to load analyst consensus.');
  }
  throw new Error(failures.join(' '));
}

function renderBoardAnalystConsensus(ticker, force = false) {
  const container = document.getElementById('boardAnalystConsensus');
  if (!container) return;
  const hideConsensus = () => {
    container.textContent = '';
    container.removeAttribute('title');
    container.className = 'hidden';
  };
  if (!ticker || !state.positions[ticker]) {
    hideConsensus();
    return;
  }

  const finnhubKey = localStorage.getItem('finnhub_api_key') || '';
  const alphaVantageKey = localStorage.getItem('alpha_vantage_api_key') || '';
  const rapidApiKey = localStorage.getItem('rapidapi_yahoo_key') || '';
  const credentials = `${finnhubKey}|${alphaVantageKey}|${rapidApiKey}`;
  const now = Date.now();
  const snapshot = boardAnalystSnapshots.get(ticker);
  const error = boardAnalystErrors.get(ticker);
  const currentPrice = Number(state.positions[ticker].currentPrice);

  if (!finnhubKey && !alphaVantageKey && !rapidApiKey) {
    hideConsensus();
    return;
  }

  if (!force && snapshot?.credentials === credentials && now - snapshot.fetchedAt < BOARD_ANALYST_CACHE_TTL_MS) {
    const upside = calculateTargetUpsidePercent(snapshot.targetPrice, currentPrice);
    if (upside !== undefined) {
      const color = upside > 0
        ? 'border-emerald-800 bg-emerald-950/40 text-emerald-300'
        : upside < 0
          ? 'border-rose-800 bg-rose-950/40 text-rose-300'
          : 'border-slate-700 bg-slate-900 text-slate-300';
      const isRapidApiAverage = snapshot.basis?.startsWith('average of ') ?? false;
      const shortSource = isRapidApiAverage ? 'Yahoo avg' : snapshot.source;
      const reportCount = isRapidApiAverage ? ` · ${snapshot.basis.match(/\d+/)?.[0]} reports` : '';
      container.textContent = `${shortSource} · $${formatUSD(snapshot.targetPrice)}${reportCount} · ${upside >= 0 ? '+' : ''}${upside.toFixed(2)}%`;
      container.title = `Target from ${snapshot.source}${snapshot.basis ? ` (${snapshot.basis} from the past year)` : ''}: $${formatUSD(snapshot.targetPrice)} versus current price $${formatUSD(currentPrice)}.`;
      container.className = `rounded border px-2.5 py-1 text-[10px] font-semibold ${color}`;
    } else {
      container.textContent = `${snapshot.source} price target · $${formatUSD(snapshot.targetPrice)}${snapshot.basis ? ` · ${snapshot.basis}` : ''} · current price unavailable`;
      container.title = `Price target from ${snapshot.source}${snapshot.basis ? ` (${snapshot.basis})` : ''}.`;
      container.className = 'rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-[10px] font-semibold text-slate-300';
    }
    return;
  }

  if (!force && error?.credentials === credentials && now - error.failedAt < BOARD_ANALYST_RETRY_MS) {
    container.textContent = `Analyst target unavailable · ${error.summary}`;
    container.title = error.message;
    container.className = 'rounded border border-amber-800 bg-amber-950/30 px-2.5 py-1 text-[10px] font-semibold text-amber-300';
    return;
  }

  const existingRequest = boardAnalystRequests.get(ticker);
  if (existingRequest?.credentials === credentials) {
    container.textContent = 'Checking analyst target providers…';
    container.removeAttribute('title');
    container.className = 'rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-[10px] font-semibold text-slate-400';
    return;
  }

  container.textContent = 'Checking analyst target providers…';
  container.removeAttribute('title');
  container.className = 'rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-[10px] font-semibold text-slate-400';
  const request = { credentials };
  boardAnalystRequests.set(ticker, request);
  fetchBoardAnalystTarget(ticker).then(result => {
    if (localStorage.getItem('finnhub_api_key') !== finnhubKey ||
      localStorage.getItem('alpha_vantage_api_key') !== alphaVantageKey ||
      localStorage.getItem('rapidapi_yahoo_key') !== rapidApiKey) return;
    boardAnalystSnapshots.set(ticker, { ...result, credentials, fetchedAt: Date.now() });
    boardAnalystErrors.delete(ticker);
  }).catch(requestError => {
    if (localStorage.getItem('finnhub_api_key') !== finnhubKey ||
      localStorage.getItem('alpha_vantage_api_key') !== alphaVantageKey ||
      localStorage.getItem('rapidapi_yahoo_key') !== rapidApiKey) return;
    const message = requestError instanceof Error ? requestError.message : String(requestError);
    const summaryParts = [];
    if (message.includes('Finnhub analyst price targets are restricted')) {
      summaryParts.push('Finnhub plan restricted');
    }
    if (/25 requests per day|rate limit|frequency exceeded/i.test(message)) {
      summaryParts.push('Alpha Vantage limit reached');
    } else if (alphaVantageKey && message.includes('Alpha Vantage')) {
      summaryParts.push('Alpha Vantage returned no target');
    } else if (!alphaVantageKey) {
      summaryParts.push('add Alpha Vantage key for fallback');
    }
    if (message.includes('no analyst price target')) {
      summaryParts.push('RapidAPI returned no analyst target');
    } else if (message.includes('RapidAPI')) {
      summaryParts.push('RapidAPI Yahoo Finance unavailable');
    }
    const summary = summaryParts.join(' · ') || 'provider access or data unavailable';
    boardAnalystErrors.set(ticker, { credentials, failedAt: Date.now(), message, summary });
  }).finally(() => {
    if (boardAnalystRequests.get(ticker) === request) boardAnalystRequests.delete(ticker);
    if (getMarketInsightsTicker() === ticker) renderBoardAnalystConsensus(ticker);
  });
}

function renderInsightNotice(message, isError = false) {
  const content = document.getElementById('marketInsightsContent');
  const notice = createInsightElement(
    'p',
    isError ? 'text-amber-200' : 'text-slate-400',
    message
  );
  if (!isError) {
    content.replaceChildren(notice);
    return;
  }
  const retry = createInsightElement('button', 'mt-3 rounded border border-amber-800/70 bg-amber-950/30 px-2.5 py-1.5 text-[10px] font-bold text-amber-200 transition hover:bg-amber-900/50', 'Try again');
  retry.type = 'button';
  retry.addEventListener('click', refreshMarketInsight);
  const errorPanel = createInsightElement('div', 'rounded-md border border-amber-900/50 bg-amber-950/10 p-3');
  errorPanel.append(notice, retry);
  content.replaceChildren(errorPanel);
}

function setMarketInsightsStatus(text, tone = 'idle') {
  const status = document.getElementById('marketInsightsStatus');
  const tones = {
    idle: 'border-slate-700 bg-slate-900 text-slate-400',
    loading: 'border-cyan-800 bg-cyan-950/50 text-cyan-200',
    success: 'border-emerald-800 bg-emerald-950/40 text-emerald-300',
    warning: 'border-amber-800 bg-amber-950/40 text-amber-200',
    error: 'border-rose-800 bg-rose-950/40 text-rose-300'
  };
  status.className = `rounded-full border px-2 py-0.5 text-[9px] font-semibold ${tones[tone] || tones.idle}`;
  status.textContent = text;
}

function formatInsightDate(value, options = { day: 'numeric', month: 'short', year: 'numeric' }) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleDateString(undefined, options);
}

function isFiniteQuoteValue(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function renderMarketInsightNews(data) {
  const content = document.getElementById('marketInsightsContent');
  const articles = Array.isArray(data?.articles) ? data.articles
    : Array.isArray(data) ? data : [];
  const validArticles = articles
    .filter(article => article && typeof article === 'object' && typeof article.headline === 'string' && typeof article.url === 'string').slice(0, 8);
  if (validArticles.length === 0) {
    renderInsightNotice('No recent company news was returned for this symbol.');
    return;
  }

  const list = createInsightElement('div', 'divide-y divide-slate-800/80');
  if (data?.source) list.appendChild(createInsightElement('p', 'pb-2 text-[10px] text-cyan-300', `Source · ${data.source}`));
  const scoredArticles = validArticles.filter(article => Number.isFinite(article.sentimentScore));
  if (scoredArticles.length > 0) {
    const averageScore = scoredArticles.reduce((sum, article) => sum + article.sentimentScore, 0) / scoredArticles.length;
    const direction = classifySentimentScore(averageScore);
    const summary = createInsightElement('div', 'mb-2 flex flex-wrap items-center gap-2');
    summary.append(
      createInsightElement('span', 'text-[10px] text-slate-400', `News sentiment · ${scoredArticles.length} scored stories`),
      sentimentBadge(direction, `${sentimentLabel(direction)} · ${averageScore.toFixed(2)}`)
    );
    list.prepend(summary);
  }
  validArticles.forEach(article => {
    const item = createInsightElement('article', 'py-3 first:pt-0 last:pb-0');
    const meta = createInsightElement('div', 'mb-1 flex flex-wrap gap-x-2 text-[10px] text-slate-500');
    meta.append(
      createInsightElement('span', '', article.source || 'News'),
      createInsightElement('span', '', Number(article.datetime) > 0 ? formatInsightDate(Number(article.datetime) * 1000) : 'Date unavailable')
    );
    if (typeof article.sentimentLabel === 'string') {
      const normalized = article.sentimentLabel.toLowerCase();
      const direction = normalized.includes('bullish')
        ? 'bullish'
        : normalized.includes('bearish')
          ? 'bearish'
          : normalized.includes('neutral')
            ? 'neutral'
            : 'unknown';
      meta.appendChild(sentimentBadge(direction, article.sentimentLabel));
    }
    const link = createInsightElement('a', 'font-semibold text-slate-100 hover:text-cyan-300');
    link.textContent = article.headline;
    try {
      const url = new URL(article.url);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
    } catch {
      link.removeAttribute('href');
    }
    item.append(meta, link);
    if (typeof article.summary === 'string' && article.summary.trim()) {
      item.append(createInsightElement('p', 'mt-1 line-clamp-3 text-[11px] leading-relaxed text-slate-400', article.summary));
    }
    list.appendChild(item);
  });
  content.replaceChildren(list);
}

function appendInsightMetric(container, label, value) {
  const card = createInsightElement('div', 'rounded border border-slate-800 bg-slate-900/60 p-2.5');
  card.append(
    createInsightElement('div', 'text-[9px] uppercase tracking-wider text-slate-500', label),
    createInsightElement('div', 'mt-1 font-mono text-sm font-semibold text-slate-100', value)
  );
  container.appendChild(card);
}

function renderMarketInsightFundamentals(result) {
  const content = document.getElementById('marketInsightsContent');
  const overview = result?.overview && typeof result.overview === 'object' ? result.overview : null;
  const profile = overview
    ? {
      name: overview.Name,
      finnhubIndustry: overview.Industry || overview.Sector,
      exchange: overview.Exchange,
      country: overview.Country,
      weburl: overview.OfficialSite,
      marketCapitalization: Number(overview.MarketCapitalization) / 1_000_000
    }
    : result?.profile && typeof result.profile === 'object' ? result.profile : {};
  const metric = result?.metric && typeof result.metric === 'object' ? result.metric : {};
  const metrics = overview
    ? {
      marketCapitalization: profile.marketCapitalization,
      peBasicExclExtraTTM: Number(overview.PERatio),
      epsBasicExclExtraItemsTTM: Number(overview.EPS),
      '52WeekHigh': Number(overview['52WeekHigh']),
      '52WeekLow': Number(overview['52WeekLow']),
      dividendYieldIndicatedAnnual: Number(overview.DividendYield) * 100
    }
    : metric.metric && typeof metric.metric === 'object' ? metric.metric : {};
  const hasProfile = typeof profile.name === 'string' && profile.name.trim();
  const hasMetrics = Object.keys(metrics).length > 0;
  if (!hasProfile && !hasMetrics) {
    renderInsightNotice('No company profile or fundamental metrics were returned.');
    return;
  }

  const root = createInsightElement('div', 'space-y-3');
  if (result?.source) root.appendChild(createInsightElement('p', 'text-[10px] text-cyan-300', `Source · ${result.source}`));
  if (hasProfile) {
    const profileRow = createInsightElement('div', 'flex flex-wrap items-start justify-between gap-2 border-b border-slate-800 pb-3');
    const company = createInsightElement('div');
    company.append(
      createInsightElement('h3', 'font-bold text-white', profile.name),
      createInsightElement('p', 'mt-1 text-[10px] text-slate-400', [profile.finnhubIndustry, profile.exchange, profile.country].filter(value => typeof value === 'string' && value).join(' · ') || 'Company profile')
    );
    profileRow.appendChild(company);
    if (typeof profile.weburl === 'string') {
      try {
        const url = new URL(profile.weburl);
        if (url.protocol === 'https:' || url.protocol === 'http:') {
          const website = createInsightElement('a', 'text-[10px] text-cyan-300 hover:text-cyan-200', 'Company website');
          website.href = url.href;
          website.target = '_blank';
          website.rel = 'noopener noreferrer';
          profileRow.appendChild(website);
        }
      } catch {
        // Ignore malformed optional profile URLs.
      }
    }
    root.appendChild(profileRow);
  }

  const formatMetricValue = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const definitions = [
    ['Market cap', 'marketCapitalization', value => `$${formatUSD(value)}M`],
    ['P/E · TTM', 'peBasicExclExtraTTM', value => value.toFixed(2)],
    ['EPS · TTM', 'epsBasicExclExtraItemsTTM', value => `$${formatUSD(value)}`],
    ['52-week high', '52WeekHigh', value => `$${formatUSD(value)}`],
    ['52-week low', '52WeekLow', value => `$${formatUSD(value)}`],
    ['Dividend yield', 'dividendYieldIndicatedAnnual', value => `${value.toFixed(2)}%`]
  ];
  const grid = createInsightElement('div', 'grid grid-cols-2 gap-2 sm:grid-cols-3');
  let count = 0;
  definitions.forEach(([label, key, formatter]) => {
    let value = formatMetricValue(metrics[key]);
    if (value === null && key === 'marketCapitalization') value = formatMetricValue(profile.marketCapitalization);
    if (value === null) return;
    appendInsightMetric(grid, label, formatter(value));
    count += 1;
  });
  if (count > 0) root.appendChild(grid);
  const growthValues = overview
    ? [Number(overview.QuarterlyRevenueGrowthYOY), Number(overview.QuarterlyEarningsGrowthYOY)]
    : [Number(metrics.revenueGrowthTTMYoy), Number(metrics.epsGrowthTTMYoy)]
      .filter(Number.isFinite)
      .map(value => value / 100);
  if (growthValues.some(Number.isFinite)) {
    const growthSentiment = summarizeGrowth(growthValues);
    root.appendChild(createInsightElement(
      'p',
      'flex flex-wrap items-center gap-2 text-[10px] text-slate-400',
      ''
    ));
    const growthSummary = root.lastElementChild;
    growthSummary.append(
      createInsightElement('span', '', 'Reported YoY revenue / earnings growth'),
      sentimentBadge(growthSentiment, `${sentimentLabel(growthSentiment)} growth`)
    );
  }
  const currentPrice = Number(state.positions[insightTicker]?.currentPrice);
  const high52Week = Number(metrics['52WeekHigh']);
  const low52Week = Number(metrics['52WeekLow']);
  if (Number.isFinite(currentPrice) && high52Week > low52Week) {
    const rangePosition = (currentPrice - low52Week) / (high52Week - low52Week);
    const rangeRow = createInsightElement('p', 'flex flex-wrap items-center gap-2 text-[10px] text-slate-400');
    rangeRow.append(
      createInsightElement('span', '', `52-week range position · ${Math.max(0, Math.min(100, rangePosition * 100)).toFixed(0)}%`),
      sentimentBadge(rangePosition > 0.6 ? 'bullish' : rangePosition < 0.4 ? 'bearish' : 'neutral', 'Price position')
    );
    root.appendChild(rangeRow);
  }
  content.replaceChildren(root);
}

function renderMarketInsightEarnings(data) {
  const content = document.getElementById('marketInsightsContent');
  const isHistorical = data?.source === 'Alpha Vantage';
  const events = Array.isArray(data?.earningsCalendar) ? data.earningsCalendar
    : isHistorical && Array.isArray(data?.quarterlyEarnings)
      ? data.quarterlyEarnings.map(event => ({
        date: event.fiscalDateEnding,
        hour: 'reported',
        epsEstimate: Number(event.estimatedEPS),
        epsActual: Number(event.reportedEPS),
        surprisePercentage: Number(event.surprisePercentage)
      }))
      : [];
  const sorted = events
    .filter(event => event && typeof event === 'object' && typeof event.date === 'string')
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 10);
  if (sorted.length === 0) {
    renderInsightNotice('No earnings events were returned for the selected date range.');
    return;
  }
  const list = createInsightElement('div', 'divide-y divide-slate-800/80');
  const upcoming = sorted.filter(event => !isFiniteQuoteValue(event.epsActual) || !isFiniteQuoteValue(event.epsEstimate)).length;
  if (upcoming > 0) {
    list.appendChild(createInsightElement(
      'p',
      'pb-2 text-[10px] text-slate-500',
      `${upcoming} event${upcoming === 1 ? '' : 's'} do not have an actual-vs-estimate sentiment signal yet.`
    ));
  }
  const scoredEvents = sorted.filter(event => isFiniteQuoteValue(event.epsActual) && isFiniteQuoteValue(event.epsEstimate));
  if (scoredEvents.length > 0) {
    const beats = scoredEvents.filter(event => event.epsActual > event.epsEstimate).length;
    const misses = scoredEvents.filter(event => event.epsActual < event.epsEstimate).length;
    const direction = beats > misses ? 'bullish' : misses > beats ? 'bearish' : 'neutral';
    const snapshot = createInsightElement('div', 'flex flex-wrap items-center gap-2 pb-2');
    snapshot.append(
      createInsightElement('span', 'text-[10px] text-slate-400', `EPS snapshot · ${beats} beat${beats === 1 ? '' : 's'} / ${misses} miss${misses === 1 ? '' : 'es'}`),
      sentimentBadge(direction, `${sentimentLabel(direction)} earnings`)
    );
    list.appendChild(snapshot);
  }
  list.appendChild(createInsightElement(
    'p',
    'pb-2 text-[10px] text-cyan-300',
    isHistorical ? 'Source · Alpha Vantage · reported quarterly history (not a forward calendar)' : 'Upcoming and recent earnings calendar'
  ));
  sorted.forEach(event => {
    const row = createInsightElement('div', 'grid grid-cols-2 gap-2 py-2 first:pt-0');
    const dateLabel = createInsightElement('div', 'font-semibold text-slate-100', formatInsightDate(event.date));
    const timing = event.hour === 'bmo' ? 'Before market' : event.hour === 'amc' ? 'After market' : event.hour === 'reported' ? 'Reported' : event.hour || 'Time unavailable';
    const details = createInsightElement('div', 'text-right text-[10px] text-slate-400', `${event.symbol || insightTicker} · ${timing}`);
    row.append(dateLabel, details);
    const values = [];
    if (isFiniteQuoteValue(event.epsEstimate)) values.push(`EPS est. ${Number(event.epsEstimate).toFixed(2)}`);
    if (isFiniteQuoteValue(event.epsActual)) values.push(`actual ${Number(event.epsActual).toFixed(2)}`);
    if (Number.isFinite(event.surprisePercentage)) values.push(`surprise ${Number(event.surprisePercentage).toFixed(2)}%`);
    if (values.length > 0) row.appendChild(createInsightElement('div', 'col-span-2 text-[10px] text-slate-500', values.join(' · ')));
    const earningsDirection = isFiniteQuoteValue(event.epsActual) && isFiniteQuoteValue(event.epsEstimate)
      ? classifyActualVsEstimate(event.epsActual, event.epsEstimate)
      : 'unknown';
    if (earningsDirection !== 'unknown') {
      row.appendChild(sentimentBadge(earningsDirection, event.epsActual > event.epsEstimate ? 'EPS beat' : event.epsActual < event.epsEstimate ? 'EPS miss' : 'In line'));
    }
    list.appendChild(row);
  });
  content.replaceChildren(list);
}

function renderMarketInsightAnalysts(result) {
  const content = document.getElementById('marketInsightsContent');
  const recommendations = Array.isArray(result?.recommendations) ? result.recommendations : [];
  const latest = recommendations
    .filter(item => item && typeof item === 'object' && typeof item.period === 'string')
    .sort((a, b) => b.period.localeCompare(a.period))[0];
  const alphaRatings = result?.ratingCounts && typeof result.ratingCounts === 'object'
    ? result.ratingCounts
    : null;
  const ratingData = latest || alphaRatings;
  const targets = result?.targets && typeof result.targets === 'object' ? result.targets : {};
  const targetPrice = isFiniteQuoteValue(result?.targetPrice) ? result.targetPrice : null;
  const hasTargets = targetPrice !== null || ['targetHigh', 'targetMean', 'targetMedian', 'targetLow']
    .some(key => isFiniteQuoteValue(targets[key]));
  if (!ratingData && !hasTargets) {
    renderInsightNotice('No analyst recommendations or price targets were returned.');
    return;
  }

  const root = createInsightElement('div', 'space-y-3');
  if (typeof result?.source === 'string') root.appendChild(createInsightElement('p', 'text-[10px] text-cyan-300', `Source · ${result.source}`));
  if (ratingData) {
    const period = latest?.period;
    const direction = classifyRecommendationCounts(ratingData);
    const heading = createInsightElement('div', 'flex flex-wrap items-center gap-2');
    heading.append(
      createInsightElement('p', 'text-[10px] text-slate-500', `Recommendation counts${period ? ` · ${formatInsightDate(period)}` : ''}`),
      sentimentBadge(direction, `Consensus · ${sentimentLabel(direction)}`)
    );
    root.appendChild(heading);
    const grid = createInsightElement('div', 'grid grid-cols-2 gap-2 sm:grid-cols-5');
    [
      ['Strong buy', ratingData.strongBuy],
      ['Buy', ratingData.buy],
      ['Hold', ratingData.hold],
      ['Sell', ratingData.sell],
      ['Strong sell', ratingData.strongSell]
    ].forEach(([label, value]) => {
      if (isFiniteQuoteValue(value)) appendInsightMetric(grid, label, String(value));
    });
    root.appendChild(grid);
  }
  if (hasTargets) {
    root.appendChild(createInsightElement('p', 'pt-1 text-[10px] text-slate-500', `Analyst price target${targets.lastUpdated ? ` · Updated ${formatInsightDate(targets.lastUpdated)}` : ''}`));
    const grid = createInsightElement('div', `grid grid-cols-2 gap-2 ${targetPrice !== null ? 'sm:grid-cols-1' : 'sm:grid-cols-4'}`);
    if (targetPrice !== null) appendInsightMetric(grid, result?.basis ? 'Average analyst target' : 'Consensus target', `$${formatUSD(targetPrice)}`);
    else {
      [
        ['Low', 'targetLow'],
        ['Median', 'targetMedian'],
        ['Mean', 'targetMean'],
        ['High', 'targetHigh']
      ].forEach(([label, key]) => {
        if (isFiniteQuoteValue(targets[key])) appendInsightMetric(grid, label, `$${formatUSD(targets[key])}`);
      });
    }
    root.appendChild(grid);
    const referencePrice = Number(state.positions[insightTicker]?.currentPrice);
    if (targetPrice !== null && referencePrice > 0) {
      const upside = ((targetPrice - referencePrice) / referencePrice) * 100;
      const direction = upside > 1 ? 'bullish' : upside < -1 ? 'bearish' : 'neutral';
      const targetSummary = createInsightElement('p', 'flex flex-wrap items-center gap-2 text-[10px] text-slate-400');
      targetSummary.append(
        createInsightElement('span', '', `${result?.basis ? 'Average target' : 'Consensus target'} vs tracked price · ${upside >= 0 ? '+' : ''}${upside.toFixed(2)}%`),
        sentimentBadge(direction, `Target ${sentimentLabel(direction)}`)
      );
      root.appendChild(targetSummary);
    }
  }
  content.replaceChildren(root);
}

function renderMarketInsightAccessError(section, error, ticker) {
  const content = document.getElementById('marketInsightsContent');
  const root = createInsightElement('div', 'space-y-2');
  root.appendChild(createInsightElement(
    'p',
    'font-semibold text-amber-300',
    error instanceof Error ? error.message : String(error)
  ));
  if (error?.status === 403 && section === 'analysts') {
    const trackedTarget = state.positions[ticker]?.pt;
    root.appendChild(createInsightElement(
      'p',
      'text-slate-400',
      Number.isFinite(trackedTarget)
        ? `Analyst consensus is not available from this Finnhub plan. Your tracked target is $${formatUSD(trackedTarget)}; this is your portfolio target, not an analyst estimate.`
        : 'Analyst recommendations and price targets are restricted for this Finnhub key. They are not included in your own portfolio target.'
    ));
  } else {
    root.appendChild(createInsightElement(
      'p',
      'text-slate-500',
      'Endpoint access varies by Finnhub plan and exchange. Check your account entitlements or try again after updating your key.'
    ));
  }
  const retry = createInsightElement('button', 'mt-1 rounded border border-rose-800/70 bg-rose-950/30 px-2.5 py-1.5 text-[10px] font-bold text-rose-200 transition hover:bg-rose-900/50', 'Retry this section');
  retry.type = 'button';
  retry.addEventListener('click', refreshMarketInsight);
  root.appendChild(retry);
  content.replaceChildren(root);
}

function hasMarketInsightData(section, result) {
  if (section === 'news') {
    const articles = Array.isArray(result) ? result : result?.articles;
    return Array.isArray(articles) && articles.length > 0;
  }
  if (section === 'fundamentals') {
    return Boolean(result?.overview?.Name || result?.profile?.name ||
      Object.keys(result?.metric?.metric || {}).length > 0);
  }
  if (section === 'earnings') {
    return Boolean(result?.earningsCalendar?.length || result?.quarterlyEarnings?.length);
  }
  return Boolean(
    result?.targetPrice ||
    result?.targets?.targetHigh ||
    result?.targets?.targetMean ||
    result?.targets?.targetMedian ||
    result?.targets?.targetLow ||
    result?.recommendations?.length ||
    result?.ratingCounts
  );
}

function hasAnalystPriceTarget(result) {
  return Boolean(
    result?.targetPrice ||
    result?.targets?.targetMean ||
    result?.targets?.targetMedian ||
    result?.targets?.targetHigh ||
    result?.targets?.targetLow
  );
}

async function addRapidApiAnalystTarget(result, ticker, apiKey) {
  if (!apiKey || hasAnalystPriceTarget(result)) return result;
  const target = await fetchRapidApiYahooAnalystTarget(apiKey, ticker);
  return {
    ...result,
    ...target,
    source: result?.source ? `${result.source} + ${target.source}` : target.source
  };
}

async function fetchAlphaVantageInsight(section, apiKey, ticker, force) {
  if (section === 'news') {
    const articles = await fetchAlphaVantageNews(apiKey, ticker, { force });
    return { source: 'Alpha Vantage', articles };
  }
  if (section === 'fundamentals') {
    const overview = await fetchAlphaVantageOverview(apiKey, ticker, { force });
    return { source: 'Alpha Vantage', overview };
  }
  if (section === 'earnings') {
    return {
      source: 'Alpha Vantage',
      ...(await fetchAlphaVantageEarnings(apiKey, ticker, { force }))
    };
  }
  return fetchAlphaVantageAnalysts(apiKey, ticker, { force });
}

async function loadMarketInsight(section, force = false) {
  const ticker = getMarketInsightsTicker();
  const content = document.getElementById('marketInsightsContent');
  const tickerBadge = document.getElementById('marketInsightsTicker');

  if (!content) return;

  if (!ticker) {
    content.innerHTML = '<div class="py-4 text-center text-xs text-slate-500">Select a margin position to load its market insights.</div>';
    return;
  }

  // 1. Update active tab states visually
  insightTicker = ticker;
  activeInsightSection = section;
  if (tickerBadge) tickerBadge.textContent = `· ${ticker}`;

  document.querySelectorAll('[data-insight]').forEach(button => {
    const selected = button.dataset.insight === section;
    button.className = `insight-tab whitespace-nowrap rounded px-3 py-1.5 text-[10px] font-bold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400 ${selected ? 'bg-cyan-400 text-slate-950 shadow-sm shadow-cyan-950' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'}`;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });

  content.innerHTML = '<div class="py-4 text-center text-xs text-slate-500 font-mono animate-pulse">Loading live data...</div>';

  try {
    // --- TAB 1: NEWS (Finnhub) ---
    if (section === 'news') {
      const finnhubKey = localStorage.getItem('finnhub_api_key');
      if (!finnhubKey) throw new Error("Finnhub API key required for news.");

      const toDate = new Date().toISOString().split('T')[0];
      const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const res = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${fromDate}&to=${toDate}&token=${finnhubKey}`);
      if (!res.ok) throw new Error("Finnhub news request failed.");
      const news = await res.json();

      if (!news || news.length === 0) {
        content.innerHTML = '<div class="py-3 text-slate-500 text-xs">No recent news found.</div>';
        return;
      }

      content.innerHTML = '<div class="space-y-2 mt-2">' + news.slice(0, 5).map(n => `
        <a href="${n.url}" target="_blank" class="block bg-slate-900/60 p-2.5 rounded border border-slate-800 hover:border-cyan-800 transition">
          <div class="text-[10px] text-cyan-400 mb-1">${new Date(n.datetime * 1000).toLocaleDateString()} · ${n.source}</div>
          <div class="text-slate-200 text-xs font-semibold leading-snug">${n.headline}</div>
        </a>
      `).join('') + '</div>';
      return;
    }

    // --- TABS 2, 3, 4: YAHOO PROXY WORKER ---
    const res = await fetch(`${YAHOO_PROXY_URL}?symbol=${encodeURIComponent(ticker)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (section === 'fundamentals') {
      const val = data.valuation || {};
      const fh = data.financialHealth || {};

      content.innerHTML = `
        <div class="p-3 bg-slate-950/60 rounded border border-slate-800 space-y-3 font-mono text-xs mt-2">
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div class="bg-slate-900/70 p-2 rounded border border-slate-800/80">
              <span class="text-[10px] text-slate-500 uppercase block">Trailing P/E</span>
              <span class="text-white font-bold">${val.peTrailing ? Number(val.peTrailing).toFixed(2) : '—'}</span>
            </div>
            <div class="bg-slate-900/70 p-2 rounded border border-slate-800/80">
              <span class="text-[10px] text-slate-500 uppercase block">Forward P/E</span>
              <span class="text-white font-bold">${val.peForward ? Number(val.peForward).toFixed(2) : '—'}</span>
            </div>
            <div class="bg-slate-900/70 p-2 rounded border border-slate-800/80">
              <span class="text-[10px] text-slate-500 uppercase block">PEG Ratio</span>
              <span class="text-white font-bold">${val.pegRatio ?? '—'}</span>
            </div>
            <div class="bg-slate-900/70 p-2 rounded border border-slate-800/80">
              <span class="text-[10px] text-slate-500 uppercase block">Short % Float</span>
              <span class="text-amber-400 font-bold">${val.shortPercentOfFloat ?? '—'}</span>
            </div>
            <div class="bg-slate-900/70 p-2 rounded border border-slate-800/80">
              <span class="text-[10px] text-slate-500 uppercase block">Profit Margin</span>
              <span class="text-white font-bold">${fh.profitMargin ?? '—'}</span>
            </div>
            <div class="bg-slate-900/70 p-2 rounded border border-slate-800/80">
              <span class="text-[10px] text-slate-500 uppercase block">ROE</span>
              <span class="text-white font-bold">${fh.returnOnEquity ?? '—'}</span>
            </div>
            <div class="bg-slate-900/70 p-2 rounded border border-slate-800/80">
              <span class="text-[10px] text-slate-500 uppercase block">Price to Book</span>
              <span class="text-white font-bold">${val.priceToBook ?? '—'}</span>
            </div>
            <div class="bg-slate-900/70 p-2 rounded border border-slate-800/80">
              <span class="text-[10px] text-slate-500 uppercase block">Total Debt</span>
              <span class="text-rose-400 font-bold">${fh.totalDebt ? '$' + (fh.totalDebt / 1e9).toFixed(2) + 'B' : '—'}</span>
            </div>
          </div>
        </div>
      `;
    }
    else if (section === 'analysts') {
      const t = data.analystTargets || {};
      const upDown = data.upgradesDowngrades || [];

      let udHtml = upDown.length > 0
        ? upDown.slice(0, 4).map(u => `
            <div class="flex justify-between items-center border-b border-slate-800/60 py-1.5 last:border-0">
              <span class="text-slate-300">${u.firm}</span>
              <span class="text-[10px] font-bold ${u.action === 'up' ? 'text-emerald-400' : u.action === 'down' ? 'text-rose-400' : 'text-cyan-400'}">${u.action.toUpperCase()}: ${u.fromGrade || ''} ➝ ${u.toGrade || ''}</span>
            </div>`).join('')
        : '<div class="text-slate-500">No recent actions</div>';

      content.innerHTML = `
        <div class="p-3 bg-slate-950/60 rounded border border-slate-800 space-y-3 font-mono text-xs mt-2">
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 border-b border-slate-800/60 pb-3">
            <div><span class="text-slate-500 block text-[10px]">Mean Target</span><span class="text-emerald-400 font-bold">$${t.mean ? t.mean.toFixed(2) : '—'}</span></div>
            <div><span class="text-slate-500 block text-[10px]">High Target</span><span class="text-emerald-400 font-bold">$${t.high ? t.high.toFixed(2) : '—'}</span></div>
            <div><span class="text-slate-500 block text-[10px]">Low Target</span><span class="text-rose-400 font-bold">$${t.low ? t.low.toFixed(2) : '—'}</span></div>
            <div><span class="text-slate-500 block text-[10px]">Consensus</span><span class="text-cyan-300 font-bold uppercase">${t.consensusRecommendation || '—'}</span></div>
          </div>
          <div>
            <span class="text-[10px] text-slate-500 uppercase block mb-2">Recent Firm Actions</span>
            ${udHtml}
          </div>
        </div>
      `;
    }
    else if (section === 'earnings') {
      const cal = data.calendar || {};
      const eh = data.earningsHistory || [];

      let ehHtml = eh.length > 0
        ? eh.map(e => `
            <div class="flex justify-between items-center border-b border-slate-800/60 py-1.5 last:border-0">
              <span class="text-slate-300 font-bold">${e.quarter}</span>
              <span class="text-[10px]">Est: ${e.epsEstimate} | Act: <span class="${e.epsDifference >= 0 ? 'text-emerald-400' : 'text-rose-400'} font-bold">${e.epsActual}</span> (${e.surprisePercent})</span>
            </div>`).join('')
        : '<div class="text-slate-500">No recent earnings history</div>';

      content.innerHTML = `
        <div class="p-3 bg-slate-950/60 rounded border border-slate-800 space-y-3 font-mono text-xs mt-2">
          <div class="bg-slate-900/70 p-2.5 rounded border border-slate-800/80 mb-3">
            <span class="text-[10px] text-slate-500 uppercase block">Next Earnings Date</span>
            <span class="text-purple-300 font-bold text-sm">${cal.earningsDate || 'TBD'}</span>
          </div>
          <div>
            <span class="text-[10px] text-slate-500 uppercase block mb-2">Past Earnings Surprises</span>
            ${ehHtml}
          </div>
        </div>
      `;
    }

  } catch (err) {
    content.innerHTML = `<div class="py-3 text-rose-400 text-xs">Failed to load insights: ${err.message}</div>`;
  }
}

function refreshMarketInsight() {
  return loadMarketInsight(activeInsightSection, true);
}

function handleMarketInsightsTabKeydown(event) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = Array.from(document.querySelectorAll('#marketInsightsTabs [role="tab"]'));
  const currentIndex = tabs.indexOf(event.target);
  if (currentIndex < 0 || tabs.length === 0) return;
  event.preventDefault();
  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? tabs.length - 1
      : (currentIndex + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
  const nextTab = tabs[nextIndex];
  nextTab.focus();
  loadMarketInsight(nextTab.dataset.insight);
}

function recordTrackedPrice(ticker, price, sourceName, updatedAt = null, quoteDetails = null) {
  const symbol = ticker.toUpperCase();
  let matched = false;
  const updateQuoteMetadata = holding => {
    holding.quoteSource = sourceName;
    if (updatedAt === null) delete holding.quoteUpdatedAt;
    else holding.quoteUpdatedAt = updatedAt;
    if (quoteDetails) holding.quoteDetails = quoteDetails;
    else delete holding.quoteDetails;
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

  document.getElementById('boardMargin').innerText = `-$${formatUSD(totalDebt)} ($${formatUSD(dailyAccrual)}/day @ ${(getDailyRate() * 100).toFixed(4)}%)`;
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
  const portfolioHoldings = [
    ...Object.values(state.positions),
    ...(state.cashCushion?.holdings || [])
  ];
  const dailySummary = summarizeDailyQuote(portfolioHoldings);

  const moveEl = document.getElementById('boardDailyMove');
  if (moveEl) moveEl.classList.remove('hidden');

  renderBoardAnalystConsensus(tickers[0]);

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
  const boardDailyQuote = document.getElementById('boardDailyQuote');
  const dailyQuoteLabel = createDailyQuoteLabel(pos.quoteDetails);
  boardDailyQuote.textContent = dailyQuoteLabel?.textContent || '';
  boardDailyQuote.className = dailyQuoteLabel?.className || 'block text-[10px] text-slate-500';
  const dailyChange = Number.isFinite(pos.quoteDetails?.change)
    ? pos.quoteDetails.change * pos.shares
    : Number.NaN;

  renderBoardAnalystConsensus(pos.ticker);

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

function renderProjectionTable(gross, totalComms, debtToUse, marginChargedToUse, entryDate) {
  const tableBody = document.getElementById('projectionTableBody');
  tableBody.innerHTML = '';

  if (debtToUse > 0 || gross > 0) {
    getUsEquityProjectionDates(new Date(), entryDate).forEach(({ date, daysFromToday, kind }) => {
      const dateFormatted = date.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric'
      });
      if (kind === 'entry') {
        const entryRow = document.createElement('tr');
        entryRow.className = 'border-b border-slate-800/50 text-slate-500';
        entryRow.innerHTML = `
          <td class="py-1.5 px-3 text-[10px] font-medium">Entry · ${dateFormatted}</td>
          <td colspan="4" class="py-1.5 px-3 text-[10px] italic">Position opened · projection values start today</td>
        `;
        tableBody.appendChild(entryRow);
        return;
      }
      const label = kind === 'today'
        ? `${dateFormatted} <span class="ml-1 text-[9px] font-normal uppercase tracking-wide text-cyan-500/80">Today</span>`
        : kind === 'week-end'
          ? `${dateFormatted} (End of week · +${daysFromToday}d)`
          : `${dateFormatted} (+${daysFromToday}d)`;

      const b_t = debtToUse * Math.pow(1 + getDailyRate(), daysFromToday);
      const additionalAccrual = b_t - debtToUse;
      const m_d = marginChargedToUse + additionalAccrual;
      const fee_c = totalComms + m_d;
      const net_p = gross - fee_c;
      const dr = b_t * getDailyRate();

      const tr = document.createElement('tr');
      tr.className = kind === 'today' ? "bg-slate-900/80 font-bold" : "hover:bg-slate-900/40";
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
      ? recordTrackedPrice(symbol, result.price, result.sourceName, result.updatedAt, result.quoteDetails)
      : false
  }));
  livePriceRequests.set(symbol, request);
  try {
    return await request;
  } finally {
    if (livePriceRequests.get(symbol) === request) livePriceRequests.delete(symbol);
  }
}

async function fetchQuoteProvider(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), QUOTE_PROVIDER_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${QUOTE_PROVIDER_TIMEOUT_MS / 1000} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchLivePriceFromProviders(symbol) {
  symbol = symbol.toUpperCase();
  let price = null;
  let sourceName = "";
  let quoteDetails = null;
  const providerErrors = [];
  const configuredSymbols = state.quoteSymbols?.[symbol] || {};
  const finnhubSymbol = configuredSymbols.finnhub || symbol;
  const stooqSymbol = configuredSymbols.stooq || `${symbol.toLowerCase()}.us`;

  const finnhubKey = localStorage.getItem('finnhub_api_key');
  const alphaVantageKey = localStorage.getItem('alpha_vantage_api_key') || '';
  const twelveDataKey = localStorage.getItem('twelve_data_api_key') || '';
  const rapidApiKey = localStorage.getItem('rapidapi_yahoo_key') || '';

  // 1. ABSOLUTE PRIORITY: Your Cloudflare Yahoo Proxy
  try {
    const data = await fetchYahooStockData(symbol);

    if (data?.price?.current > 0) {
      price = data.price.current;
      sourceName = "Yahoo Proxy";

      const prevClose = data.price.previousClose ?? data.price.regularMarketPreviousClose;
      const change = data.price.change ?? data.price.regularMarketChange ?? (price - prevClose);

      quoteDetails = {
        price: price,
        change: change,
        changePercent: prevClose ? (change / prevClose) * 100 : 0
      };
    }
  } catch (e) {
    console.warn(`[Yahoo Proxy Quote Error]:`, e.message);
  }

  let rapidApiQuote = null;
  if (!price && rapidApiKey) {
    try {
      rapidApiQuote = await fetchRapidApiYahooQuote(rapidApiKey, symbol);
      if (rapidApiQuote.preMarketPrice) {
        price = rapidApiQuote.preMarketPrice;
        sourceName = `Yahoo Finance Premarket via RapidAPI · ${symbol}`;
        quoteDetails = parseFinnhubQuoteDetails({
          d: rapidApiQuote.preMarketChange,
          dp: rapidApiQuote.preMarketChangePercent,
          h: rapidApiQuote.high,
          l: rapidApiQuote.low
        });
      }
    } catch (error) {
      providerErrors.push(`Yahoo Finance via RapidAPI: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!price && finnhubKey) {
    try {
      const res = await fetchQuoteProvider(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(finnhubSymbol)}&token=${encodeURIComponent(finnhubKey)}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.c && Number(data.c) > 0) {
          price = Number(data.c);
          sourceName = `Finnhub Live · ${finnhubSymbol}`;
          quoteDetails = parseFinnhubQuoteDetails(data);
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

  if (!price && twelveDataKey) {
    try {
      const quote = await fetchTwelveDataQuote(twelveDataKey, symbol);
      price = quote.price;
      sourceName = `Twelve Data · ${symbol}`;
      quoteDetails = parseFinnhubQuoteDetails({
        d: quote.change,
        dp: quote.changePercent,
        h: quote.high,
        l: quote.low
      });
    } catch (error) {
      providerErrors.push(`Twelve Data: ${error.message}`);
    }
  }

  if (!price && alphaVantageKey) {
    try {
      const quote = await fetchAlphaVantageQuote(alphaVantageKey, symbol);
      price = quote.price;
      sourceName = `Alpha Vantage · ${symbol}`;
      quoteDetails = parseFinnhubQuoteDetails({
        d: quote.change,
        dp: quote.changePercent,
        h: quote.high,
        l: quote.low
      });
    } catch (error) {
      providerErrors.push(`Alpha Vantage: ${error.message}`);
    }
  }

  if (!price && rapidApiQuote) {
    price = rapidApiQuote.price;
    sourceName = `Yahoo Finance via RapidAPI · ${symbol}`;
    quoteDetails = parseFinnhubQuoteDetails({
      d: rapidApiQuote.change,
      dp: rapidApiQuote.changePercent,
      h: rapidApiQuote.high,
      l: rapidApiQuote.low
    });
  }

  if (!price) {
    try {
      const stooqUrl = `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSymbol.toLowerCase())}&f=sd2t2ohlcv&h&e=csv`;
      const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(stooqUrl)}`;

      const res = await fetchQuoteProvider(proxyUrl);
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
    quoteDetails,
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

  const cashHoldings = state.cashCushion && state.cashCushion.holdings;

  // 1. Gather all unique active tickers
  const allTickers = new Set([
    ...Object.keys(state.positions || {}),
    ...(cashHoldings || []).map(h => h.ticker)
  ]);

  const tickersArray = Array.from(allTickers);
  if (tickersArray.length === 0) return;

  logTerminal(`[System]: Polling live quotes for ${tickersArray.join(', ')}...`);

  // 2. Fire all requests concurrently via your working single-symbol proxy
  const fetchPromises = tickersArray.map(async (ticker) => {
    const data = await fetchYahooStockData(ticker);
    return { ticker, data };
  });

  const results = await Promise.all(fetchPromises);
  let updatedCount = 0;

  // 3. Process results, calculate changes, and attach quoteDetails
  for (const { ticker, data } of results) {
    if (!data || !data.price) continue;

    const current = data.price.current ?? data.regularMarketPrice ?? data.price;
    const previous = data.price.previousClose ?? data.regularMarketPreviousClose;
    const change = data.price.change ?? data.regularMarketChange ?? (current - previous);

    const quoteDetails = {
      price: current,
      change: change,
      changePercent: previous ? (change / previous) * 100 : 0
    };

    // Update Margin Position
    if (state.positions[ticker]) {
      state.positions[ticker].currentPrice = current;
      state.positions[ticker].quoteDetails = quoteDetails;
      state.positions[ticker].quoteUpdatedAt = Date.now();
      updatedCount++;
    }

    // Update Cash/Non-Margin Holdings
    if (Array.isArray(cashHoldings)) {
      const cashPos = cashHoldings.find(h => h.ticker === ticker);
      if (cashPos) {
        cashPos.currentPrice = current;
        cashPos.quoteDetails = quoteDetails;
        cashPos.quoteUpdatedAt = Date.now();
        updatedCount++;
      }
    }
  }

  // 4. Save and re-render only if data was updated
  if (updatedCount > 0) {
    saveState();
    renderBoard();
    logTerminal(`[System]: Live market quotes refreshed for ${updatedCount} assets.`);
  } else {
    logTerminal(`[Market Data Warning]: Failed to fetch updated quotes.`);
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
  const input = event.target;
  const file = input.files[0];
  if (!file) return;
  input.value = '';

  try {
    const parsed = JSON.parse(await file.text());
    const importedState = normalizePortfolioBackup(parsed);
    if (!confirm(`Replace this browser's portfolio with "${file.name}"? If Gist sync is configured, the imported portfolio will replace its remote copy too.`)) {
      logTerminal('[Backup Import]: Import cancelled; the current portfolio was not changed.');
      return;
    }

    importedState.lastUpdated = Date.now();
    const previousState = state;
    state = importedState;
    try {
      saveState();
    } catch (error) {
      state = previousState;
      throw error;
    }
    await pushStateToGist(true);
    renderBoard();
    logTerminal(`[Backup Import]: Imported ${file.name} into this browser. Check Gist status for cloud sync results.`);
    showToast('Backup imported locally. Check Gist status for cloud sync.', 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logTerminal(`[Backup Error]: Could not import backup (${message}).`);
    showToast(`Backup import failed: ${message}`, 'error');
  }
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
    pos.quoteDetails = {
      price: pos.currentPrice,
      // Make sure to use whatever variable names you have in this block for change/prevClose
      change: change,
      changePercent: prevClose ? (change / prevClose) * 100 : 0
    };

    pos.quoteSource = 'Trade input';
    const prevClose = data.price?.previousClose ?? data.regularMarketPreviousClose ?? data.previousClose;
    const change = data.price?.change ?? data.regularMarketChange ?? (pos.currentPrice - prevClose);

    delete pos.quoteUpdatedAt;
    delete pos.quoteDetails;
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

    const hasRequestedShares = action.shares !== null && action.shares !== undefined;
    let sharesToSell;
    try {
      sharesToSell = resolveSaleQuantity(
        Number(pos.shares),
        hasRequestedShares ? Number(action.shares) : null
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logTerminal(`[Sell Error]: ${message}`);
      showToast(message, 'error');
      return;
    }

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

function confirmAiPortfolioAction(action) {
  let ticker = typeof action.ticker === 'string' ? action.ticker.trim().toUpperCase() : '';
  if (!ticker && ['set_pt', 'set_price'].includes(action.action)) {
    ticker = state.positions[state.activeView] ? state.activeView : Object.keys(state.positions)[0] || '';
  }
  const validTicker = /^[A-Z0-9._:-]+$/.test(ticker);
  const isPositiveFinite = value => Number.isFinite(Number(value)) && Number(value) > 0;
  const isFiniteNumber = value =>
    value !== null &&
    value !== undefined &&
    !(typeof value === 'string' && value.trim() === '') &&
    Number.isFinite(Number(value));
  const actionsWithTicker = ['buy', 'sell', 'set_pt', 'set_price', 'add_cash_stock', 'remove_cash_stock'];
  if (actionsWithTicker.includes(action.action) && !validTicker) {
    logTerminal('[AI Action Error]: Gemini returned an invalid ticker. No changes were made.');
    return false;
  }

  if (action.action === 'buy' && (!isPositiveFinite(action.shares) || !isPositiveFinite(action.price))) {
    logTerminal('[AI Action Error]: Gemini returned an invalid buy quantity or price. No changes were made.');
    return false;
  }
  if (action.action === 'sell' &&
    ((action.shares !== null && action.shares !== undefined && !isPositiveFinite(action.shares)) ||
      !isPositiveFinite(action.price))) {
    logTerminal('[AI Action Error]: Gemini returned an invalid sale quantity or price. No changes were made.');
    return false;
  }
  if ((action.action === 'set_pt' && !isPositiveFinite(action.pt)) ||
    (action.action === 'set_price' && !isPositiveFinite(action.price))) {
    logTerminal('[AI Action Error]: Gemini returned an invalid price. No changes were made.');
    return false;
  }
  if (action.action === 'add_cash_stock' &&
    (!isPositiveFinite(action.shares) ||
      (action.price != null && (!Number.isFinite(Number(action.price)) || Number(action.price) < 0)))) {
    logTerminal('[AI Action Error]: Gemini returned invalid cash holding details. No changes were made.');
    return false;
  }
  if (action.action === 'set_balance' && !isFiniteNumber(action.balance)) {
    logTerminal('[AI Action Error]: Gemini returned an invalid margin balance. No changes were made.');
    return false;
  }
  if (action.action === 'set_free_cash' && !isFiniteNumber(action.amount)) {
    logTerminal('[AI Action Error]: Gemini returned an invalid account balance. No changes were made.');
    return false;
  }

  const details = {
    buy: `Buy ${action.shares} ${ticker} at $${action.price}?`,
    sell: `Sell ${action.shares == null ? 'all' : action.shares} ${ticker} at $${action.price}?`,
    set_pt: `Set ${ticker}'s target price to $${action.pt}?`,
    set_price: `Set ${ticker}'s tracked market price to $${action.price}?`,
    set_balance: `Set margin debt/balance to ${action.balance}?`,
    set_free_cash: `Set account balance/debt to ${action.amount}?`,
    add_cash_stock: `Add ${action.shares} shares of ${ticker} to cash holdings?`,
    remove_cash_stock: `Remove ${ticker} from cash holdings?`
  };
  const message = details[action.action];
  if (!message) {
    logTerminal(`[AI Action Error]: Unsupported action "${action.action}". No changes were made.`);
    return false;
  }
  return confirm(`Gemini interpreted your input as this portfolio change:\n\n${message}\n\nApply it?`);
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

  const apiKey = sessionStorage.getItem('gemini_api_key');
  if (!apiKey) {
    logTerminal("[Error]: Missing Gemini API key. Enter your Google AI Studio key above.");
    showToast('Missing Gemini API key.', 'error');
    return;
  }

  document.getElementById('aiStatus').innerText = "CONNECTING...";
  document.getElementById('aiStatus').className = "text-amber-400 text-[10px]";

  try {
    const prompt = buildIntentPrompt({
      text,
      activeTickers: Object.keys(state.positions),
      activeView: state.activeView,
      today: new Date().toISOString().split('T')[0]
    });
    let activeModels = await listGeminiModels(apiKey);
    document.getElementById('aiStatus').innerText = "PARSING...";
    let lastError = null;
    let success = false;
    const attemptedModels = new Set();
    let refreshedModelCatalog = false;

    while (true) {
      const model = activeModels.find(candidate => !attemptedModels.has(candidate));
      if (!model) break;
      attemptedModels.add(model);
      try {
        const rawText = await generateIntentText(apiKey, model, prompt);
        const parsed = parseAiIntent(rawText);

        if (parsed.intent === "ladder") {
          runLadderSimulation(parsed);
          logTerminal(`[Ladder Exit Evaluated via ${model}]`);
        } else if (parsed.intent === "comparison") {
          runComparison(parsed);
          logTerminal(`[Comparison Evaluated via ${model}]`);
        } else if (parsed.intent === "simulation") {
          runSimulation(parsed.simPrice, parsed.daysOffset, parsed.label, parsed.ticker);
          logTerminal(`[Simulation Evaluated via ${model}]`);
        } else if (parsed.intent === "fetch_quote") {
          const tickerToFetch = parsed.ticker ? parsed.ticker.toUpperCase() : (state.activeView !== "COMBINED" && state.activeView !== "CASH_CUSHION" && state.activeView !== "CLOSED_HISTORY" ? state.activeView : Object.keys(state.positions)[0]);
          if (tickerToFetch) fetchLivePrice(tickerToFetch);
          else logTerminal("[Notice]: No active ticker specified to fetch quote for.");
        } else if (parsed.intent === "action") {
          if (confirmAiPortfolioAction(parsed)) await applyPortfolioActions(parsed);
          else logTerminal('[AI Action]: Cancelled. No portfolio changes were made.');
        } else if (parsed.intent === "chat") {
          logTerminal(`[AI Advisor]: ${parsed.response}`);
        }

        document.getElementById('aiStatus').innerText = "READY";
        document.getElementById('aiStatus').className = "text-slate-500 text-[10px]";
        success = true;
        break;
      } catch (err) {
        lastError = err;
        if (shouldTryAnotherGeminiModel(err)) {
          if (err instanceof GeminiApiError && err.status === 404 && !refreshedModelCatalog) {
            refreshedModelCatalog = true;
            try {
              activeModels = await listGeminiModels(apiKey, fetch, Date.now(), true);
            } catch (discoveryError) {
              lastError = new Error(
                `${err.message} Refreshing the Gemini model list also failed: ${discoveryError instanceof Error ? discoveryError.message : String(discoveryError)}`
              );
            }
          }
          continue;
        }
        throw err;
      }
    }

    if (!success) {
      throw lastError || new Error('No available Gemini model could process the request.');
    }
  } catch (err) {
    logTerminal(`[Error]: ${err.message}`);
    document.getElementById('aiStatus').innerText = "ERROR";
    document.getElementById('aiStatus').className = "text-rose-400 text-[10px]";
  }
}

async function initApp() {
  await loadSavedState();

  const credentialsConfigured = areHeaderCredentialsConfigured();
  headerCredentialsHidden = credentialsConfigured || localStorage.getItem('header_credentials_hidden') === 'true';

  ['apiKeyInput', 'finnhubKeyInput', 'alphaVantageKeyInput', 'twelveDataKeyInput', 'rapidApiKeyInput', 'gistIdInput', 'githubTokenInput'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', updateHeaderCredentialsVisibility);
  });

  const quoteRefreshInterval = document.getElementById('quoteRefreshInterval');
  const savedQuoteRefreshInterval = localStorage.getItem(QUOTE_REFRESH_INTERVAL_KEY);
  const parsedQuoteRefreshInterval = savedQuoteRefreshInterval === null ? NaN : Number(savedQuoteRefreshInterval);
  const initialQuoteRefreshInterval = QUOTE_REFRESH_INTERVALS.has(parsedQuoteRefreshInterval)
    ? parsedQuoteRefreshInterval
    : DEFAULT_QUOTE_REFRESH_INTERVAL_MS;

  if (quoteRefreshInterval) {
    quoteRefreshInterval.value = String(initialQuoteRefreshInterval);
    quoteRefreshInterval.addEventListener('change', () => setQuoteRefreshInterval(quoteRefreshInterval.value));
  }
  setQuoteRefreshInterval(initialQuoteRefreshInterval);

  setBrokerRuleInputs();
  document.getElementById('brokerRulesForm')?.addEventListener('submit', saveBrokerRuleInputs);
  document.getElementById('resetBrokerRulesButton')?.addEventListener('click', resetBrokerRules);
  document.getElementById('quoteSymbolForm')?.addEventListener('submit', saveQuoteSymbolMapping);
  document.getElementById('quoteMappingTickerInput')?.addEventListener('change', event => {
    populateQuoteSymbolMapping(event.target.value);
  });
  document.getElementById('marketInsightsTabs')?.addEventListener('keydown', handleMarketInsightsTabKeydown);

  updateHeaderCredentialsVisibility();
  if (credentialsConfigured) {
    document.getElementById('mainDeskContainer')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Initial render from local/gist state, then pull live quotes
  renderBoard();
  await refreshAllLivePrices();

  // Background refresh triggers
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshAllLivePrices();
    }
  });

  window.addEventListener('online', () => {
    refreshAllLivePrices();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

Object.assign(window, {
  addCashStockFromUI,
  executeCommand,
  exportBackupJSON,
  importBackupJSON,
  loadMarketInsight,
  pullCloudAndRewriteLocal,
  refreshAllLivePrices,
  refreshMarketInsight,
  resetToBlankState,
  saveApiKeys,
  saveCurrentBalanceFromInput,
  toggleMarketInsights,
  toggleHeaderCredentialsVisibility
});

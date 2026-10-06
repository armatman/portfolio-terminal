export interface TradeTranche {
  qty: number;
  price: number;
  date?: string;
  acquiredAt?: number;
  buyCommission?: number;
  [key: string]: unknown;
}

export interface MarginPosition {
  ticker: string;
  shares: number;
  tranches: TradeTranche[];
  commBuy: number;
  marginCharged?: number;
  startDate?: string;
  [key: string]: unknown;
}

export interface ClosedTrade {
  ticker: string;
  date: number;
  shares: number;
  holdingDays: number;
  feesAndCommissions: number;
  netProfit: number;
}

export interface PortfolioState {
  activeView: string;
  marginBalance: number;
  realizedMarginCharged: number;
  startDate: string;
  lastRolloverTimestamp: number;
  lastUpdated: number;
  cashCushion: {
    freeCash: number;
    holdings: unknown[];
    [key: string]: unknown;
  };
  closedTrades: ClosedTrade[];
  quoteSymbols: Record<string, unknown>;
  positions: Record<string, MarginPosition>;
  [key: string]: unknown;
}

export interface ClosedTradeResult {
  position: MarginPosition;
  trade: ClosedTrade | null;
  marginFee: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function resolveTradeDateTimestamp(value: unknown, fallbackTimestamp = Date.now()): number {
  if (typeof value !== 'string' || !value.trim()) return fallbackTimestamp;
  const shortDate = value.trim().match(/^(\d{1,2})\s+([a-z]{3,})(?:\s+(\d{4}))?$/i);
  if (shortDate) {
    const monthIndex = new Date(`${shortDate[2]} 1, 2000`).getMonth();
    if (!Number.isNaN(monthIndex)) {
      let year = shortDate[3] ? Number(shortDate[3]) : new Date(fallbackTimestamp).getFullYear();
      let timestamp = new Date(year, monthIndex, Number(shortDate[1])).getTime();
      if (!shortDate[3] && timestamp > fallbackTimestamp) {
        year -= 1;
        timestamp = new Date(year, monthIndex, Number(shortDate[1])).getTime();
      }
      return timestamp;
    }
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallbackTimestamp;
}

export function createBlankState(now = Date.now()): PortfolioState {
  return {
    activeView: 'COMBINED',
    marginBalance: 0,
    realizedMarginCharged: 0,
    startDate: new Date(now).toISOString().split('T')[0],
    lastRolloverTimestamp: now,
    lastUpdated: now,
    cashCushion: {
      freeCash: 0,
      holdings: []
    },
    closedTrades: [],
    quoteSymbols: {},
    positions: {}
  };
}

export function normalizePortfolioState(candidate: unknown, now = Date.now()): PortfolioState {
  if (!isRecord(candidate)) throw new Error('Portfolio state must be an object.');

  const blankState = createBlankState(now);
  const sourceCashCushion = isRecord(candidate.cashCushion) ? candidate.cashCushion : {};
  const positions = isRecord(candidate.positions) ? candidate.positions : {};
  const normalizedPositions: Record<string, MarginPosition> = {};

  Object.entries(positions).forEach(([ticker, position]) => {
    if (!isRecord(position)) return;
    const tranches = Array.isArray(position.tranches)
      ? position.tranches.filter(isRecord).map(tranche => ({
          ...tranche,
          qty: finiteNumber(tranche.qty, 0),
          price: finiteNumber(tranche.price, 0)
        }))
      : [];
    normalizedPositions[ticker] = {
      ...position,
      ticker: typeof position.ticker === 'string' ? position.ticker : ticker,
      shares: finiteNumber(position.shares, 0),
      tranches,
      commBuy: finiteNumber(position.commBuy, 0),
      marginCharged: finiteNumber(position.marginCharged, 0)
    };
  });

  const sourceTimestamp = Number(candidate.lastRolloverTimestamp);
  const closedTrades = Array.isArray(candidate.closedTrades)
    ? candidate.closedTrades.filter(isRecord).map(trade => ({
        ticker: typeof trade.ticker === 'string' ? trade.ticker : '',
        date: finiteNumber(trade.date, now),
        shares: finiteNumber(trade.shares, 0),
        holdingDays: finiteNumber(trade.holdingDays, 0),
        feesAndCommissions: finiteNumber(trade.feesAndCommissions, 0),
        netProfit: finiteNumber(trade.netProfit, 0)
      }))
    : [];
  return {
    ...blankState,
    ...candidate,
    activeView: typeof candidate.activeView === 'string' ? candidate.activeView : blankState.activeView,
    marginBalance: finiteNumber(candidate.marginBalance, blankState.marginBalance),
    realizedMarginCharged: finiteNumber(candidate.realizedMarginCharged, blankState.realizedMarginCharged),
    lastUpdated: finiteNumber(candidate.lastUpdated, blankState.lastUpdated),
    cashCushion: {
      ...blankState.cashCushion,
      ...sourceCashCushion,
      freeCash: finiteNumber(sourceCashCushion.freeCash, 0),
      holdings: Array.isArray(sourceCashCushion.holdings) ? sourceCashCushion.holdings : []
    },
    closedTrades,
    positions: normalizedPositions,
    quoteSymbols: isRecord(candidate.quoteSymbols) ? candidate.quoteSymbols : {},
    lastRolloverTimestamp: Number.isFinite(sourceTimestamp) ? sourceTimestamp : now,
    startDate: typeof candidate.startDate === 'string' && candidate.startDate
      ? candidate.startDate
      : blankState.startDate
  };
}

export function normalizePortfolioBackup(candidate: unknown, now = Date.now()): PortfolioState {
  if (!isRecord(candidate)) throw new Error('Portfolio backup must be an object.');
  const recognizedFields = ['positions', 'marginBalance', 'cashCushion', 'closedTrades', 'activeView', 'startDate'];
  if (!recognizedFields.some(field => Object.hasOwn(candidate, field))) {
    throw new Error('File does not contain a recognized portfolio backup.');
  }
  return normalizePortfolioState(candidate, now);
}

export function resolveSaleQuantity(availableShares: number, requestedShares: number | null): number {
  if (!Number.isFinite(availableShares) || availableShares <= 0) {
    throw new Error('Position has no valid shares to sell.');
  }
  if (requestedShares === null) return availableShares;
  if (!Number.isFinite(requestedShares) || requestedShares <= 0) {
    throw new Error('Sell quantity must be greater than zero.');
  }
  if (requestedShares - availableShares > 1e-8) {
    throw new Error(`Cannot sell ${requestedShares} shares; only ${availableShares} are available.`);
  }
  return Math.min(availableShares, requestedShares);
}

function resolveTrancheAcquiredAt(tranche: TradeTranche, fallbackDate: string | undefined, now: number): number {
  const acquiredAt = Number(tranche.acquiredAt);
  if (Number.isFinite(acquiredAt) && acquiredAt > 0) return acquiredAt;
  return resolveTradeDateTimestamp(tranche.date || fallbackDate, now);
}

export function realizeClosedTrade(
  position: MarginPosition,
  ticker: string,
  shares: number,
  sellPrice: number,
  sellCommission: number,
  closedAt: number
): ClosedTradeResult {
  if (!Number.isFinite(shares) || shares <= 0 || shares > position.shares) {
    throw new Error('Closed share quantity must be positive and no greater than the open position.');
  }
  if (!Number.isFinite(sellPrice) || sellPrice <= 0) {
    throw new Error('Sale price must be a finite positive number.');
  }

  const originalShares = Number(position.shares) || 0;
  const sourceTranches = Array.isArray(position.tranches) ? position.tranches : [];
  const trancheShares = sourceTranches.reduce((total, tranche) => total + Math.max(0, Number(tranche.qty) || 0), 0);
  const scale = trancheShares > originalShares && trancheShares > 0 ? originalShares / trancheShares : 1;
  const lots = sourceTranches
    .map(tranche => ({
      ...tranche,
      qty: Math.max(0, Number(tranche.qty) || 0) * scale,
      price: Math.max(0, Number(tranche.price) || 0),
      buyCommission: Math.max(0, Number(tranche.buyCommission) || 0) * scale
    }))
    .filter(tranche => tranche.qty > 0);
  const scaledCommission = scale < 1 ? (Number(position.commBuy) || 0) * scale : Number(position.commBuy) || 0;
  const scaledTrancheShares = lots.reduce((total, tranche) => total + tranche.qty, 0);
  const fallbackShares = Math.max(0, originalShares - scaledTrancheShares);
  if (fallbackShares > 0) {
    lots.push({
      qty: fallbackShares,
      price: scaledTrancheShares > 0
        ? lots.reduce((total, tranche) => total + (tranche.qty * tranche.price), 0) / scaledTrancheShares
        : 0,
      buyCommission: 0,
      acquiredAt: resolveTradeDateTimestamp(position.startDate, closedAt)
    });
  }

  const lotBuyCommissions = lots.reduce((total, tranche) => total + Math.max(0, Number(tranche.buyCommission) || 0), 0);
  const unassignedBuyCommission = Math.max(0, scaledCommission - lotBuyCommissions);
  const closedLots: { qty: number; cost: number; buyCommission: number; acquiredAt: number }[] = [];
  let remainingToClose = shares;

  lots.forEach(tranche => {
    if (remainingToClose <= 0) return;
    const closedQty = Math.min(tranche.qty, remainingToClose);
    if (closedQty <= 0) return;

    const trancheCommission = Math.max(0, Number(tranche.buyCommission) || 0);
    const legacyCommissionShare = originalShares > 0 ? (unassignedBuyCommission / originalShares) * closedQty : 0;
    closedLots.push({
      qty: closedQty,
      cost: closedQty * tranche.price,
      buyCommission: (trancheCommission * (closedQty / tranche.qty)) + legacyCommissionShare,
      acquiredAt: resolveTrancheAcquiredAt(tranche, position.startDate, closedAt)
    });
    tranche.buyCommission = Math.max(0, trancheCommission * (1 - (closedQty / tranche.qty)));
    tranche.qty -= closedQty;
    remainingToClose -= closedQty;
  });

  const closedShares = shares - remainingToClose;
  const remainingLots = lots.filter(tranche => tranche.qty > 1e-8);
  const costBasis = closedLots.reduce((total, lot) => total + lot.cost, 0);
  const buyCommission = closedLots.reduce((total, lot) => total + lot.buyCommission, 0);
  const durationWeightedMs = closedLots.reduce(
    (total, lot) => total + (Math.max(0, closedAt - lot.acquiredAt) * lot.qty),
    0
  );
  const holdingDays = closedShares > 0
    ? Math.floor(durationWeightedMs / closedShares / 86400000)
    : 0;
  const marginFee = originalShares > 0
    ? (Number(position.marginCharged) || 0) * (closedShares / originalShares)
    : 0;
  const feesAndCommissions = buyCommission + sellCommission + marginFee;
  const trade = closedShares > 0
    ? {
        ticker,
        date: closedAt,
        shares: closedShares,
        holdingDays,
        feesAndCommissions,
        netProfit: (closedShares * sellPrice) - costBasis - feesAndCommissions
      }
    : null;

  return {
    position: {
      ...position,
      shares: Math.max(0, originalShares - closedShares),
      tranches: remainingLots,
      commBuy: Math.max(0, scaledCommission - buyCommission),
      marginCharged: Math.max(0, (Number(position.marginCharged) || 0) - marginFee)
    },
    trade,
    marginFee
  };
}

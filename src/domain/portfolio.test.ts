import { describe, expect, it } from 'vitest';
import {
  createBlankState,
  normalizePortfolioBackup,
  normalizePortfolioState,
  realizeClosedTrade,
  resolveSaleQuantity,
  resolveTradeDateTimestamp,
  type MarginPosition
} from './portfolio';

const basePosition: MarginPosition = {
  ticker: 'TEST',
  shares: 10,
  tranches: [{ qty: 10, price: 10, acquiredAt: 1_000, buyCommission: 2 }],
  commBuy: 2,
  marginCharged: 5
};

describe('portfolio domain', () => {
  it('creates a stable blank state from the supplied clock', () => {
    expect(createBlankState(1_700_000_000_000)).toMatchObject({
      activeView: 'COMBINED',
      closedTrades: [],
      positions: {},
      lastUpdated: 1_700_000_000_000
    });
  });

  it('normalizes missing collections while preserving existing state', () => {
    const normalized = normalizePortfolioState({
      marginBalance: -25,
      positions: { TEST: basePosition },
      cashCushion: { freeCash: 20, holdings: 'invalid' }
    }, 10_000);

    expect(normalized.marginBalance).toBe(-25);
    expect(normalized.positions.TEST).toEqual(basePosition);
    expect(normalized.cashCushion).toMatchObject({ freeCash: 20, holdings: [] });
    expect(normalized.closedTrades).toEqual([]);
  });

  it('rejects non-object imported state', () => {
    expect(() => normalizePortfolioState([])).toThrow('Portfolio state must be an object.');
  });

  it('accepts recognized portfolio backups and rejects unrelated JSON objects', () => {
    expect(normalizePortfolioBackup({ positions: {} }, 10_000).positions).toEqual({});
    expect(() => normalizePortfolioBackup({ settings: {} }, 10_000)).toThrow('recognized portfolio backup');
  });

  it('prevents selling more shares than the position holds', () => {
    expect(resolveSaleQuantity(10, null)).toBe(10);
    expect(resolveSaleQuantity(10, 4)).toBe(4);
    expect(resolveSaleQuantity(10, 10 + 1e-9)).toBe(10);
    expect(() => resolveSaleQuantity(10, 11)).toThrow('only 10 are available');
    expect(() => resolveSaleQuantity(0, 1)).toThrow('no valid shares');
  });

  it('parses short buy dates and falls back for invalid dates', () => {
    const ts = resolveTradeDateTimestamp('05 Oct 2026');
    const d = new Date(ts);

    // Extract local timezone year, month, and day to prevent UTC drift
    const localStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    expect(localStr).toBe('2026-10-05');
    expect(resolveTradeDateTimestamp('not a date', 1234)).toBe(1234);
  });

  it('realizes partial sale and carries remaining lots, commissions, and margin fees', () => {
    const result = realizeClosedTrade(basePosition, 'TEST', 4, 12, 1, 86_401_000);

    expect(result.trade).toMatchObject({
      ticker: 'TEST',
      shares: 4,
      holdingDays: 1,
      feesAndCommissions: 3.8,
      netProfit: 4.2
    });
    expect(result.position).toMatchObject({ shares: 6, commBuy: 1.2, marginCharged: 3 });
    expect(result.position.tranches).toHaveLength(1);
    expect(result.position.tranches[0]).toMatchObject({ qty: 6, buyCommission: 1.2 });
  });

  it('consumes multiple buy lots FIFO and calculates weighted duration', () => {
    const position: MarginPosition = {
      ticker: 'TEST',
      shares: 10,
      tranches: [
        { qty: 5, price: 10, acquiredAt: 1_000, buyCommission: 1 },
        { qty: 5, price: 20, acquiredAt: 86_401_000, buyCommission: 2 }
      ],
      commBuy: 3,
      marginCharged: 0
    };

    const result = realizeClosedTrade(position, 'TEST', 6, 25, 1, 172_801_000);

    expect(result.trade).toMatchObject({
      shares: 6,
      holdingDays: 1,
      feesAndCommissions: 2.4,
      netProfit: 77.6
    });
    expect(result.position.shares).toBe(4);
    expect(result.position.tranches).toHaveLength(1);
    expect(result.position.tranches[0]).toMatchObject({ qty: 4, price: 20, buyCommission: 1.6 });
  });

  it('rejects invalid closed quantities and prices without mutating the input position', () => {
    const original = structuredClone(basePosition);
    expect(() => realizeClosedTrade(basePosition, 'TEST', 0, 12, 1, 10_000)).toThrow();
    expect(() => realizeClosedTrade(basePosition, 'TEST', 11, 12, 1, 10_000)).toThrow();
    expect(() => realizeClosedTrade(basePosition, 'TEST', 1, Number.NaN, 1, 10_000)).toThrow();
    expect(basePosition).toEqual(original);
  });
});

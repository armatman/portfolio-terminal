import { describe, expect, it } from 'vitest';
import { getUsEquityProjectionDates, isUsEquityTradingDay } from './tradingCalendar';

function localDate(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day);
}

function dateLabel(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

describe('US equity trading calendar', () => {
  it('excludes weekends and scheduled exchange holidays', () => {
    expect(isUsEquityTradingDay(localDate(2026, 10, 10))).toBe(false);
    expect(isUsEquityTradingDay(localDate(2026, 10, 12))).toBe(true);
    expect(isUsEquityTradingDay(localDate(2026, 6, 19))).toBe(false);
    expect(isUsEquityTradingDay(localDate(2026, 4, 3))).toBe(false);
  });

  it('starts the schedule at Friday when Friday is a trading day', () => {
    const projections = getUsEquityProjectionDates(localDate(2026, 10, 6));
    expect(projections.map(({ date, daysFromToday }) => [dateLabel(date), daysFromToday])).toEqual([
      ['2026-10-06', 0],
      ['2026-10-09', 3],
      ['2026-10-13', 7],
      ['2026-10-20', 14],
      ['2026-10-27', 21],
      ['2026-11-03', 28],
      ['2026-11-10', 35]
    ]);
  });

  it('puts a historical entry date before today without treating it as a projection', () => {
    const projections = getUsEquityProjectionDates(localDate(2026, 10, 6), '2026-09-22');
    expect(projections.slice(0, 3).map(({ date, daysFromToday, kind }) => [
      dateLabel(date),
      daysFromToday,
      kind
    ])).toEqual([
      ['2026-09-22', -14, 'entry'],
      ['2026-10-06', 0, 'today'],
      ['2026-10-09', 3, 'week-end']
    ]);
  });

  it('does not duplicate the entry date when it is today', () => {
    const projections = getUsEquityProjectionDates(localDate(2026, 10, 6), '2026-10-06');
    expect(projections[0]).toMatchObject({ daysFromToday: 0, kind: 'today' });
    expect(projections.filter(({ kind }) => kind === 'entry')).toHaveLength(0);
  });

  it('moves a Good Friday end-of-week projection to Monday but retains calendar-day accrual', () => {
    const projections = getUsEquityProjectionDates(localDate(2026, 4, 2));
    expect(projections[1]).toMatchObject({ daysFromToday: 4, kind: 'week-end' });
    expect(dateLabel(projections[1].date)).toBe('2026-04-06');
  });

  it('uses the following Monday when today is Friday', () => {
    const projections = getUsEquityProjectionDates(localDate(2026, 10, 9));
    expect(projections[1]).toMatchObject({ daysFromToday: 3, kind: 'week-end' });
    expect(dateLabel(projections[1].date)).toBe('2026-10-12');
  });

  it('uses the upcoming Monday when today is a weekend', () => {
    const projections = getUsEquityProjectionDates(localDate(2026, 10, 11));
    expect(projections[1]).toMatchObject({ daysFromToday: 1, kind: 'week-end' });
    expect(dateLabel(projections[1].date)).toBe('2026-10-12');
  });

  it('rolls the +7-day checkpoint forward when it lands on Juneteenth', () => {
    const projections = getUsEquityProjectionDates(localDate(2026, 6, 12));
    expect(projections[2]).toMatchObject({ daysFromToday: 10, kind: 'weekly' });
    expect(dateLabel(projections[2].date)).toBe('2026-06-22');
  });
});

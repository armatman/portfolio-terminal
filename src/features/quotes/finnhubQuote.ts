export interface FinnhubQuoteDetails {
  change?: number;
  changePercent?: number;
  high?: number;
  low?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteField(record: Record<string, unknown>, field: string): number | undefined {
  return typeof record[field] === 'number' && Number.isFinite(record[field])
    ? record[field]
    : undefined;
}

export function parseFinnhubQuoteDetails(value: unknown): FinnhubQuoteDetails | null {
  if (!isRecord(value)) return null;

  const details: FinnhubQuoteDetails = {
    change: finiteField(value, 'd'),
    changePercent: finiteField(value, 'dp'),
    high: finiteField(value, 'h'),
    low: finiteField(value, 'l')
  };
  return Object.values(details).some(field => field !== undefined) ? details : null;
}

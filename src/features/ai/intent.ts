export interface LadderIntent {
  intent: 'ladder';
  ticker: string | null;
  steps: Array<{ shares: number; price: number; days: number; label?: string }>;
}

export interface ComparisonIntent {
  intent: 'comparison';
  ticker: string | null;
  scenarios: Array<{ label: string; price: number; days: number }>;
}

export interface SimulationIntent {
  intent: 'simulation';
  ticker: string | null;
  simPrice: number;
  daysOffset: number;
  label: string;
}

export interface FetchQuoteIntent {
  intent: 'fetch_quote';
  ticker: string | null;
}

export type PortfolioActionIntent =
  | { intent: 'action'; action: 'buy'; ticker: string; shares: number; price: number; pt: number | null; date: string | null }
  | { intent: 'action'; action: 'sell'; ticker: string; shares: number | null; price: number }
  | { intent: 'action'; action: 'set_pt'; ticker: string | null; pt: number }
  | { intent: 'action'; action: 'set_price'; ticker: string | null; price: number }
  | { intent: 'action'; action: 'set_balance'; balance: number }
  | { intent: 'action'; action: 'set_free_cash'; amount: number }
  | { intent: 'action'; action: 'add_cash_stock'; ticker: string; shares: number; price: number | null }
  | { intent: 'action'; action: 'remove_cash_stock'; ticker: string };

export interface ChatIntent {
  intent: 'chat';
  response: string;
}

export type AiIntent =
  | LadderIntent
  | ComparisonIntent
  | SimulationIntent
  | FetchQuoteIntent
  | PortfolioActionIntent
  | ChatIntent;

export class IntentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntentValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isTicker(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,32}$/.test(value);
}

function isOptionalTicker(value: unknown): value is string | null {
  return value === null || isTicker(value);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new IntentValidationError(message);
}

function parseAction(value: Record<string, unknown>): PortfolioActionIntent {
  switch (value.action) {
    case 'buy':
      assert(isTicker(value.ticker), 'Buy intent requires a valid ticker.');
      assert(isPositiveNumber(value.shares), 'Buy intent requires a positive share quantity.');
      assert(isPositiveNumber(value.price), 'Buy intent requires a positive price.');
      assert(value.pt === null || isPositiveNumber(value.pt), 'Buy target must be null or a positive number.');
      assert(value.date === null || typeof value.date === 'string', 'Buy date must be a string or null.');
      return {
        intent: 'action',
        action: 'buy',
        ticker: value.ticker,
        shares: value.shares,
        price: value.price,
        pt: value.pt,
        date: value.date
      };
    case 'sell':
      assert(isTicker(value.ticker), 'Sell intent requires a valid ticker.');
      assert(value.shares === null || isPositiveNumber(value.shares), 'Sell quantity must be null or positive.');
      assert(isPositiveNumber(value.price), 'Sell intent requires a positive price.');
      return { intent: 'action', action: 'sell', ticker: value.ticker, shares: value.shares, price: value.price };
    case 'set_pt':
      assert(isOptionalTicker(value.ticker), 'Target-price intent requires a valid ticker or null.');
      assert(isPositiveNumber(value.pt), 'Target price must be positive.');
      return { intent: 'action', action: 'set_pt', ticker: value.ticker, pt: value.pt };
    case 'set_price':
      assert(isOptionalTicker(value.ticker), 'Price intent requires a valid ticker or null.');
      assert(isPositiveNumber(value.price), 'Market price must be positive.');
      return { intent: 'action', action: 'set_price', ticker: value.ticker, price: value.price };
    case 'set_balance':
      assert(isFiniteNumber(value.balance), 'Margin balance must be a finite number.');
      return { intent: 'action', action: 'set_balance', balance: value.balance };
    case 'set_free_cash':
      assert(isFiniteNumber(value.amount), 'Account balance must be a finite number.');
      return { intent: 'action', action: 'set_free_cash', amount: value.amount };
    case 'add_cash_stock':
      assert(isTicker(value.ticker), 'Cash holding intent requires a valid ticker.');
      assert(isPositiveNumber(value.shares), 'Cash holding intent requires a positive share quantity.');
      assert(value.price === null || (isFiniteNumber(value.price) && value.price >= 0), 'Cash holding price must be null or non-negative.');
      return { intent: 'action', action: 'add_cash_stock', ticker: value.ticker, shares: value.shares, price: value.price };
    case 'remove_cash_stock':
      assert(isTicker(value.ticker), 'Remove cash holding intent requires a valid ticker.');
      return { intent: 'action', action: 'remove_cash_stock', ticker: value.ticker };
    default:
      throw new IntentValidationError(`Unsupported portfolio action "${String(value.action)}".`);
  }
}

export function parseAiIntent(raw: string): AiIntent {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new IntentValidationError('Gemini returned invalid JSON.');
  }
  assert(isRecord(value) && typeof value.intent === 'string', 'Gemini response must contain an intent.');

  switch (value.intent) {
    case 'action':
      return parseAction(value);
    case 'fetch_quote':
      assert(isOptionalTicker(value.ticker), 'Quote intent requires a valid ticker or null.');
      return { intent: 'fetch_quote', ticker: value.ticker };
    case 'simulation':
      assert(isOptionalTicker(value.ticker), 'Simulation requires a valid ticker or null.');
      assert(isPositiveNumber(value.simPrice), 'Simulation price must be positive.');
      assert(isFiniteNumber(value.daysOffset) && Number.isInteger(value.daysOffset) && value.daysOffset >= 0, 'Simulation days must be a non-negative integer.');
      assert(typeof value.label === 'string' && value.label.length <= 120, 'Simulation label must be a string up to 120 characters.');
      return {
        intent: 'simulation',
        ticker: value.ticker,
        simPrice: value.simPrice,
        daysOffset: value.daysOffset,
        label: value.label
      };
    case 'comparison':
      assert(isOptionalTicker(value.ticker), 'Comparison requires a valid ticker or null.');
      assert(Array.isArray(value.scenarios) && value.scenarios.length === 2, 'Comparison requires exactly two scenarios.');
      return {
        intent: 'comparison',
        ticker: value.ticker,
        scenarios: value.scenarios.map(scenario => {
          assert(isRecord(scenario), 'Comparison scenario must be an object.');
          assert(typeof scenario.label === 'string' && scenario.label.length <= 120, 'Comparison scenario label must be a short string.');
          assert(isPositiveNumber(scenario.price), 'Comparison scenario price must be positive.');
          assert(isFiniteNumber(scenario.days) && Number.isInteger(scenario.days) && scenario.days >= 0, 'Comparison scenario days must be a non-negative integer.');
          return { label: scenario.label, price: scenario.price, days: scenario.days };
        })
      };
    case 'ladder':
      assert(isOptionalTicker(value.ticker), 'Ladder requires a valid ticker or null.');
      assert(Array.isArray(value.steps) && value.steps.length > 0 && value.steps.length <= 20, 'Ladder requires between 1 and 20 steps.');
      return {
        intent: 'ladder',
        ticker: value.ticker,
        steps: value.steps.map(step => {
          assert(isRecord(step), 'Ladder step must be an object.');
          assert(isPositiveNumber(step.shares), 'Ladder shares must be positive.');
          assert(isPositiveNumber(step.price), 'Ladder price must be positive.');
          assert(isFiniteNumber(step.days) && Number.isInteger(step.days) && step.days >= 0, 'Ladder days must be a non-negative integer.');
          assert(step.label === undefined || (typeof step.label === 'string' && step.label.length <= 120), 'Ladder label must be a short string.');
          return {
            shares: step.shares,
            price: step.price,
            days: step.days,
            ...(typeof step.label === 'string' ? { label: step.label } : {})
          };
        })
      };
    case 'chat':
      assert(typeof value.response === 'string' && value.response.trim().length > 0 && value.response.length <= 4000, 'Chat response must be a non-empty string up to 4000 characters.');
      return { intent: 'chat', response: value.response };
    default:
      throw new IntentValidationError(`Unsupported intent "${value.intent}".`);
  }
}

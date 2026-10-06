# Portfolio Terminal

Portfolio Terminal is a browser-based personal tracker and scenario calculator for margin and non-margin stock holdings. It models a configurable broker's margin interest, commissions, balances, and selected risk thresholds so you can review portfolio estimates and compare hypothetical exits.

It is **not** a broker connection, order-entry system, source of official account data, or investment advice. It does not place or route trades. Verify holdings, quotes, fees, margin requirements, and risk calculations with your broker before acting.

## What it does

- Tracks margin positions, purchase tranches, target prices, and partial or full sales.
- Tracks non-margin holdings and available cash separately from margin positions.
- Estimates portfolio value, profit/loss, commissions, margin interest, account equity, break-even timing, and margin risk using the configured assumptions.
- Records closed margin trades and estimates net realized results.
- Retrieves quotes and company insights from third-party data providers when API keys are configured.
- Provides a conversational console for portfolio updates and simulations, using Gemini to interpret requests. Portfolio changes require confirmation.
- Saves portfolio state in this browser and optionally synchronizes it through a GitHub Gist.
- Imports and exports portfolio backups as JSON.

All dollar values and broker-model assumptions are estimates. The app is intended for personal tracking and analysis, not tax, accounting, or trading advice.

## Get started

### Use the hosted app

Open the [Portfolio Terminal GitHub Pages site](https://armave.github.io/portfolio-terminal/). The app runs in your browser; portfolio data is saved in that browser's local storage. No account is required for basic manual tracking.

### Run locally

Requires Node.js and npm.

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. To create the production bundle locally:

```sh
npm run build
```

The GitHub Actions workflow runs tests, builds the site, and deploys it to GitHub Pages when changes are pushed to `main`; it can also be started manually from the repository's Actions tab.

## A typical workflow

1. **Set broker assumptions.** Expand **Broker assumptions & quote symbols**. Review the annual margin rate, interest day-count, rollover time, maintenance and stop-out thresholds, and commission settings. Save assumptions only after comparing them with your broker's current terms. Use **Restore defaults** to return to the app's built-in estimates.
2. **Enter your holdings and balance.** Use the Trading Console examples or quick actions to record margin buys and sales. Use **Add Holding** for a non-margin holding, and set the signed **Current Balance / Margin Debt** in the cash panel: positive means cash, negative means margin debt. You can also update the balance using the console.
3. **Review the board.** Select a ticker tab or the combined portfolio view. The board summarizes holdings, tracked prices, market value, profit/loss, margin debt, commissions, accrued margin charges, equity, and estimated risk. Expand closed-trade history to review completed margin sales.
4. **Refresh market data.** Click **Quotes** to refresh tracked securities. Optional automatic refresh intervals are 15 seconds, 30 seconds, or one minute; refresh can also be turned off. Quotes may be delayed, unavailable, or subject to provider limits.
5. **Explore scenarios.** Ask the console to simulate an exit, compare two possible sale dates/prices, or evaluate a staged/laddered sale. These are estimates only; they never submit orders or change holdings.
6. **Back up or sync.** Export a JSON backup regularly. Optionally configure a GitHub Gist to carry the portfolio between browsers; read the sync notes below before connecting an existing Gist.

## Trading Console

The console supports plain-language requests. Its on-screen **Quick Commands Guide** adapts ticker and tracked-price examples to the selected margin holding. When no margin holding is selected, it shows a `[TICKER]` placeholder. Examples:

```text
bought 10 AAPL for 180, pt 205
sell 4 AAPL for 195
sold all AAPL for 195
add cash stock 5 MSFT
remove cash stock MSFT
balance 5000
balance -5000
set AAPL target to 210
compare selling AAPL today for 195 vs 14 days later for 200
sell 5 AAPL today for 195 and 5 in 7 days for 205
```

Examples are illustrative; provide the ticker, quantity, price, and timing you intend. Use the selected holding's tracked price as a starting point, then edit prices in the request. A comparison does not sell shares. The app rejects margin sale quantities greater than the recorded position rather than silently reducing them.

The following utility commands do not need Gemini:

```text
quote AAPL
pull
quote symbol 7203 finnhub=TSE:7203 stooq=7203.jp
quote symbol 7203 finnhub=default stooq=default
```

Other natural-language console requests require a Gemini API key. Gemini can suggest general information, but its response is generated and may be wrong. Every AI-interpreted portfolio-changing console action is shown for confirmation before it is applied. Review the proposed ticker, price, quantity, and balance carefully.

## Market data and API keys

Keys are optional. Without provider keys, you can still record data manually, use the portfolio calculator, import/export backups, and use the console's non-AI utility commands.

Enter keys in the header and click **Save**. The app calls providers directly from your browser; availability, supported symbols, latency, and request limits depend on each provider's current terms and your account:

| Provider | Used for | Notes |
| --- | --- | --- |
| Finnhub | Primary live quote source; company news, fundamentals, earnings, analyst insights, and board analyst price targets | Some endpoints or symbols may be restricted by plan. A `403` for analyst targets means that endpoint is not available to the configured account. |
| Twelve Data | Quote fallback after Finnhub | Its analyst price-target endpoint is not available on the free plan, so the app does not request it. |
| Alpha Vantage | Quote fallback and insights fallback, including available profile/fundamental, news, earnings, and analyst fields | The free plan has historically had a low daily request allowance; limits and endpoints can change. |
| Yahoo Finance via RapidAPI | Preferred premarket quote when `/stock/v2/get-summary` provides one; otherwise a live quote fallback. Analyst-target fallback uses `/stock/v3/get-insights`, then `/stock/get-company-outlook` if insights has no target. | Uses the regular quote providers in their existing order when no premarket price is present; the Yahoo regular quote remains a later fallback. Analyst targets use provider aggregate mean/median when available; otherwise averages valid, dated report targets from the prior 365 days. Requires a RapidAPI key for the `apidojo-yahoo-finance-v1` listing. |
| Stooq | Last quote fallback where symbol coverage is available | Provider-specific symbols may be needed. |
| Gemini (Google AI Studio) | Interprets natural-language console requests | The key is needed only for AI interpretation and general AI responses. |

When configured, Yahoo Finance via RapidAPI is checked first for a premarket price; if none is available, regular quote selection retains the **Finnhub → Twelve Data → Alpha Vantage → Yahoo Finance via RapidAPI → Stooq** order. Board analyst targets use **Finnhub → Alpha Vantage → Yahoo Finance via RapidAPI**. Market-insights analyst targets also try RapidAPI if Finnhub or Alpha Vantage lacks a target; the other insight sections use Finnhub and Alpha Vantage. Yahoo Finance via RapidAPI requires a key and is subject to the API listing's availability and plan limits. Twelve Data is not queried for analyst targets because that endpoint is not available on its free plan.

Quote and insight data is cached briefly to limit repeat calls. Use the relevant **Refresh** control to request fresh data. A refresh cannot bypass provider permissions, quotas, or symbol coverage.

### Gemini key

Create a personal API key through Google AI Studio, enter it in the **Gemini** field, and click **Save**. The key is kept in browser **session storage** and cleared when that browser session ends. Gemini model availability can vary by API key, region, and Google's current catalog.

### Data-provider keys

Finnhub, Twelve Data, Alpha Vantage, and RapidAPI keys are stored in this browser's **local storage**. When Gist sync is configured, clicking **Save** also stores those provider keys in a separate AES-GCM encrypted Gist file, with a key derived from the Gemini API key. The Gemini key itself is never uploaded; on a browser session without a saved Gemini key, the app prompts for it to unlock the bundle and then saves the recovered provider keys locally.

## Optional GitHub Gist sync

Gist sync is optional; local browser storage works without it. To enable sync:

1. Create a GitHub Gist for your portfolio data. A private Gist is recommended.
2. Create a GitHub personal access token with the `gist` permission/scope.
3. Enter the Gist ID (or Gist URL) and token in the header, then click **Save**.
4. Check the **GIST** status badge and terminal messages. The **Pull** button explicitly fetches the Gist and replaces the local portfolio with its contents.

When a Gist ID is configured, startup attempts to pull remote state; if the Gist can be read, its portfolio replaces local state. Saving portfolio changes schedules an upload to the configured Gist. The status badge indicates whether a pull or push succeeded. A failed sync does not mean the local portfolio was saved to the cloud.

**Encrypted provider keys:** The Gemini key derives an AES-256-GCM encryption key using PBKDF2-SHA-256. Only the encrypted provider-key bundle is uploaded. The Gemini key and GitHub personal access token are not part of that file. Access to a private Gist still requires its Gist ID and GitHub token in that browser; the app cannot fetch a private Gist using only the Gemini key. If the Gemini key is incorrect, the encrypted credentials are not applied.

**Protect your data:** export a backup before connecting a Gist that may contain existing data or before pressing **Pull**. Importing a backup replaces the local portfolio and, when Gist sync is configured, also attempts to replace its remote copy. **Reset** clears portfolio holdings, balances, and history locally and attempts to reset the synchronized state as well.

## Backups and local data

- **Export** downloads the current portfolio state as a JSON file. Store backups somewhere safe; they may contain sensitive financial information.
- **Import** checks that the file looks like a portfolio backup and asks before replacing current state.
- Portfolio state, broker assumptions, quote-symbol mappings, and some interface preferences are stored in this browser's local storage.
- API credentials are separate from portfolio state and portfolio backups. Gemini uses session storage; data-provider and Gist credentials use local storage. Provider keys are also present in the Gist only as an encrypted separate file when configured.
- Clearing site data or using a different browser/device removes access to local state unless you have an export or have synchronized through Gist.

Credential fields are visually masked, but masking is not encryption. Browser storage can be inspected by the person using the browser, and provider keys are sent to their respective services. Do not embed shared or production secrets in this public static app. Use personal keys with appropriate restrictions and quotas.

## Broker assumptions and calculations

The built-in defaults are illustrative assumptions for a Tradernet/Freedom Broker Armenia-style margin model, not verified live terms. The **Broker assumptions & quote symbols** panel allows you to change:

- Annual margin interest rate and 360/365-day basis.
- Daily rollover time in Armenia time.
- Maintenance-equity and stop-out thresholds used for estimated risk indicators.
- Per-share commission, commission by trade value, and minimum order commission.

The app estimates margin accrual and allocates accrued costs across tracked positions. Projections, estimated margin-call/stop-out triggers, commissions, market values, and realized results can differ from your broker's calculations. Risk indicators are not live broker risk alerts.

For securities whose provider symbol differs from the portfolio ticker, use the quote-symbol panel to save Finnhub and/or Stooq symbols. The console also supports `quote symbol TICKER finnhub=SYMBOL stooq=SYMBOL`; use `default` to remove a provider-specific mapping. Refresh quotes after changing a mapping.

## Troubleshooting

- **No live quote:** confirm the key is saved, check the provider's symbol/plan/usage limits, and review the terminal error. Try a provider-specific Finnhub or Stooq symbol where needed.
- **Analyst target unavailable:** Finnhub may restrict price targets for the key or symbol, and Alpha Vantage may have no target or may be rate-limited. Twelve Data is currently only used as a quote fallback.
- **Gemini request fails:** confirm the key is valid and available to the Google AI Studio API, check model access and quota, then save the key again. The portfolio and manual controls remain usable without Gemini.
- **Gist status is offline or failing:** verify the Gist ID, token permissions, network access, and that the Gist contains readable portfolio state. Export a backup before using **Pull** or importing.
- **Unexpected portfolio after opening the app:** if a readable Gist is configured, remote state is pulled and takes precedence over local state. Use the saved backup to restore the version you want.

## Development

The current interface is in `app.js` and `index.html`; Vite loads the app through `src/main.ts`. Domain logic and provider clients are being migrated into `src/` incrementally.

```sh
npm test
npm run typecheck
npm run build
```

Tests use Vitest. `npm run build` runs the TypeScript type check before producing the static site in `dist/`.

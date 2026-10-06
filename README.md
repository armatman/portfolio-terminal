# Portfolio Terminal

## Development

Install dependencies and start the Vite development server:

```sh
npm install
npm run dev
```

## Validation and production build

```sh
npm test
npm run typecheck
npm run build
```

The portfolio accounting and state normalization code lives in `src/domain/portfolio.ts`. Its tests are in `src/domain/portfolio.test.ts`. The current interface still uses the legacy `app.js`; Vite loads it as a module while the UI is migrated incrementally.

The Gemini command flow is split into `src/features/ai/`: `prompt.ts` builds the classifier prompt, `geminiClient.ts` handles model discovery and generation requests, and `intent.ts` validates model output before the existing app dispatcher can act on it. Model discovery prioritizes the newest generation, preferring stable Flash, then Pro, then Lite variants; previews and older generations are fallbacks. Discovery is cached per API key for five minutes and refreshed if a model returns 404. Each Gemini request has a 30-second timeout. Portfolio-changing intents still require explicit confirmation.

Select a margin holding and choose **Market insights** to load recent company news, fundamentals, earnings calendar, and analyst recommendations/price targets. The portfolio board also fetches the selected holding's analyst consensus target and compares it with the tracked current price; on the combined board it displays the first listed holding's ticker. Finnhub is tried first; when it fails or returns no data, Alpha Vantage is used if its key is configured in the header. Alpha Vantage can also provide fallback live quotes, profile fundamentals, news, reported quarterly earnings history, and analyst target/rating counts. Its earnings endpoint is historical rather than a forward calendar, and its analyst endpoint does not provide Finnhub's target high/low/median breakdown. Results are cached in memory by provider and endpoint; **Refresh** bypasses the cache. Data availability and request limits depend on provider plan and symbol coverage.

Backup import validates the file shape and asks before replacing the local portfolio. If Gist sync is configured, the imported state is pushed to the remote Gist; check the Gist status indicator to confirm that upload succeeded.

Finnhub and Alpha Vantage keys are saved in this browser's local storage and sent directly from the browser to those providers. Do not use shared production secrets in the public static app.

## Gemini API key

Enter your Google AI Studio API key in the app and click **Save**. The key is kept in browser session storage and requests are sent directly from the browser to Google's Gemini API. It is cleared when the browser session ends and is not included in portfolio backups or Gist sync.

**Security:** because this is a static GitHub Pages app, a key entered into the browser can be inspected by the person using the page and may be visible in browser developer tools/network requests. Use a personal, restricted key with appropriate quotas; do not embed a shared or production secret in the site. A server-side proxy would be needed to keep a shared key off the client.

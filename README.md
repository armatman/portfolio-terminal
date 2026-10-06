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

The Gemini command flow is split into `src/features/ai/`: `prompt.ts` builds the classifier prompt, `geminiClient.ts` handles model discovery and generation requests, and `intent.ts` validates model output before the existing app dispatcher can act on it. Model discovery is cached per API key for five minutes, and each Gemini request has a 30-second timeout. Portfolio-changing intents still require explicit confirmation.

## Gemini API key

Enter your Google AI Studio API key in the app and click **Save**. The key is kept in browser session storage and requests are sent directly from the browser to Google's Gemini API. It is cleared when the browser session ends and is not included in portfolio backups or Gist sync.

**Security:** because this is a static GitHub Pages app, a key entered into the browser can be inspected by the person using the page and may be visible in browser developer tools/network requests. Use a personal, restricted key with appropriate quotas; do not embed a shared or production secret in the site. A server-side proxy would be needed to keep a shared key off the client.

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

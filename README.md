# chesspermutations

chesspermutations is a deterministic, local-first chess game-tree explorer. A phrase becomes a permanent generated game address, legal branches expand on demand, and a WebGL constellation makes branch geometry and time navigable. Its graph tokens show the moved piece, moving side, special move events, and Stockfish W/D/L probabilities.

## Development

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run dev
npm test
npm run lint
npm run build
npm run preview
```

This is a standard client-side React/Vite application. The production files are written to `dist` and can be served by any static web server; no proprietary hosting integration is required.

The exact Stockfish.js 18.0.8 lite single-thread worker and WebAssembly binary are vendored in `public/stockfish`. The app uses `Threads=1`, `Hash=16`, `MultiPV=6`, and 30,000 nodes per generated ply. Do not replace these files without creating a new game contract version.

Progressive graph probabilities use a separate `graph-analysis:v1` contract. Opened neighborhoods are analyzed locally with `UCI_ShowWDL`, normalized to White's perspective, and cached independently from generated studies. This visual analysis never participates in deterministic move selection.

## Privacy and addresses

Seed phrases are normalized and SHA-256 hashed in the browser with a `chess-game:v1` domain separator. Links contain only the resulting address—not the original phrase. Imported FENs and PGNs, generated studies, positions, and engine analysis remain local to the browser.

Google Analytics 4 is disabled unless a valid `VITE_GA_MEASUREMENT_ID` is
present in the production build. It runs with analytics and advertising storage
denied, sends one basic cookieless page view, and uses a sanitized page URL
without query parameters or fragments. Seed phrases, FENs, PGNs, move paths,
positions, and engine data are not tracked.

For a local production build, copy `.env.example` to `.env.production` and set
the GA4 measurement ID before running `npm run build`. For a hosted static
build, configure the same variable as a build-time environment variable.

## Licensing

chesspermutations is released under GPLv3. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). A corresponding source snapshot is included in production builds.

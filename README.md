# Chess Universe

Chess Universe is a deterministic, local-first chess game-tree explorer. A phrase becomes a permanent generated game address, legal branches expand on demand, and a WebGL universe makes branch geometry and time navigable.

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

## Privacy and addresses

Seed phrases are normalized and SHA-256 hashed in the browser with a `chess-game:v1` domain separator. Links contain only the resulting address—not the original phrase. Imported FENs and PGNs, generated studies, positions, and engine analysis remain local to the browser.

## Licensing

Chess Universe is released under GPLv3. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). A corresponding source snapshot is included in production builds.

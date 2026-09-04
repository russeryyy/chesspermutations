# Third-party notices

## Stockfish.js

- Package/build: `stockfish@18.0.8`, lite single-thread WebAssembly distribution
- License: GNU General Public License v3.0
- Distributed files: `public/stockfish/stockfish-18-lite-single.js` and `public/stockfish/stockfish-18-lite-single.wasm`
- License copy: `public/stockfish/COPYING.txt`
- Exact corresponding source (`npm` package `gitHead`): <https://github.com/nmrugg/stockfish.js/tree/93c994592dcf3b4b21052ab925e9b534df9c0918>
- Upstream engine source and terms: <https://github.com/official-stockfish/Stockfish>

To reproduce the browser distribution, check out the `v18.0.8` tag of `nmrugg/stockfish.js`, install its documented Emscripten toolchain, and run its build with the lite, single-thread target. The unmodified npm-distributed binary is vendored here so the frozen `chess-game:v1` contract can name its exact build.

## Chessground

- Package: `@lichess-org/chessground@10.1.1`
- License: GPL-3.0-or-later
- License copy: `public/CHESSGROUND-LICENSE.txt`
- Corresponding source: <https://github.com/lichess-org/chessground/tree/v10.1.1>

`public/graph-piece-atlas.svg` is a silhouette atlas derived from Chessground's bundled Cburnett artwork and is distributed under the same GPL-3.0-or-later terms.

## Other runtime dependencies

The application also uses chess.js, @echecs/pgn, Three.js, fflate, React, and the dependency set recorded in `package-lock.json`. Their package metadata and license texts are available from the npm packages pinned by that lockfile.

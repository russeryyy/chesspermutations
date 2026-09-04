import { Chess } from 'chess.js';
import {
  ENGINE_CONTRACT,
  GRAPH_ANALYSIS_VERSION,
  type GameNode,
  type StudyModel,
  type WinProbability,
} from './contracts';
import type { AnalysisLine, EngineWdl } from './engine';
import { parseUci } from './study';

export type GraphPiece = 'p' | 'n' | 'b' | 'r' | 'q' | 'k' | 'root';
export type MoveSide = 'white' | 'black' | 'root';

export interface GraphMoveVisual {
  nodeId: string;
  piece: GraphPiece;
  promotedPiece?: Exclude<GraphPiece, 'p' | 'k' | 'root'>;
  side: MoveSide;
  capture: boolean;
  enPassant: boolean;
  check: boolean;
  mate: boolean;
  promotion: boolean;
  castle: boolean;
  terminalDraw: boolean;
}

export function deriveGraphMoveVisual(
  node: GameNode,
  parent?: GameNode,
): GraphMoveVisual {
  if (!parent || !node.uci) {
    return {
      nodeId: node.id,
      piece: 'root',
      side: 'root',
      capture: false,
      enPassant: false,
      check: false,
      mate: false,
      promotion: false,
      castle: false,
      terminalDraw: false,
    };
  }
  try {
    const chess = new Chess(parent.fen);
    const side: MoveSide = chess.turn() === 'w' ? 'white' : 'black';
    const move = chess.move(parseUci(node.uci));
    const mate = chess.isCheckmate();
    const promotedPiece =
      move.promotion && /[nbrq]/.test(move.promotion)
        ? (move.promotion as 'n' | 'b' | 'r' | 'q')
        : undefined;
    return {
      nodeId: node.id,
      piece: move.piece,
      ...(promotedPiece ? { promotedPiece } : {}),
      side,
      capture: move.isCapture() || move.isEnPassant(),
      enPassant: move.isEnPassant(),
      check: chess.inCheck(),
      mate,
      promotion: move.isPromotion(),
      castle: move.isKingsideCastle() || move.isQueensideCastle(),
      terminalDraw: Boolean(
        node.terminal &&
        !mate &&
        (chess.isDraw() || /draw|equality|horizon/i.test(node.terminal)),
      ),
    };
  } catch {
    return {
      nodeId: node.id,
      piece: 'p',
      side: node.ply % 2 ? 'white' : 'black',
      capture: false,
      enPassant: false,
      check: /\+|#/u.test(node.san ?? ''),
      mate: /#/u.test(node.san ?? ''),
      promotion: Boolean(node.uci[4]),
      castle: node.san?.startsWith('O-O') ?? false,
      terminalDraw: /draw|equality|horizon/i.test(node.terminal ?? ''),
    };
  }
}

export function normalizeWdl(
  wdl: EngineWdl,
  turn: 'w' | 'b',
  depth: number,
  nodes: number,
): WinProbability {
  const total = Math.max(1, wdl.win + wdl.draw + wdl.loss);
  const normalized = normalizePerMille(wdl.win, wdl.draw, wdl.loss, total);
  const [white, draw, black] =
    turn === 'w' ? normalized : [normalized[2], normalized[1], normalized[0]];
  return {
    version: GRAPH_ANALYSIS_VERSION,
    white,
    draw,
    black,
    depth,
    nodes,
    engine: ENGINE_CONTRACT.build,
  };
}

function normalizePerMille(
  win: number,
  draw: number,
  loss: number,
  total: number,
): [number, number, number] {
  const raw = [win, draw, loss].map(
    (value) => (Math.max(0, value) * 1_000) / total,
  );
  const values = raw.map(Math.floor);
  let remainder = 1_000 - values.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - values[index] }))
    .sort(
      (left, right) =>
        right.fraction - left.fraction || left.index - right.index,
    );
  for (
    let index = 0;
    index < order.length && remainder > 0;
    index += 1, remainder -= 1
  )
    values[order[index].index] += 1;
  return values as [number, number, number];
}

export function probabilityFromLine(
  line: AnalysisLine,
  turn: 'w' | 'b',
): WinProbability | undefined {
  return line.wdl
    ? normalizeWdl(line.wdl, turn, line.depth, line.nodes)
    : undefined;
}

export function terminalProbability(
  node: GameNode,
): WinProbability | undefined {
  if (!node.terminal) return undefined;
  let split: [number, number, number] | undefined;
  try {
    const chess = new Chess(node.fen);
    if (chess.isCheckmate())
      split = chess.turn() === 'w' ? [0, 0, 1_000] : [1_000, 0, 0];
    else if (chess.isDraw() || /draw|equality|horizon/i.test(node.terminal))
      split = [0, 1_000, 0];
  } catch {
    /* Imported annotations can contain nonstandard terminal descriptions. */
  }
  if (!split && /white wins/i.test(node.terminal)) split = [1_000, 0, 0];
  if (!split && /black wins/i.test(node.terminal)) split = [0, 0, 1_000];
  if (!split) return undefined;
  return {
    version: GRAPH_ANALYSIS_VERSION,
    white: split[0],
    draw: split[1],
    black: split[2],
    depth: 0,
    nodes: 0,
    engine: ENGINE_CONTRACT.build,
  };
}

export function probabilityPercentages(
  probability: WinProbability,
): [number, number, number] {
  const raw = [probability.white, probability.draw, probability.black].map(
    (value) => value / 10,
  );
  const rounded = raw.map(Math.floor);
  let remainder = 100 - rounded.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - rounded[index] }))
    .sort(
      (left, right) =>
        right.fraction - left.fraction || left.index - right.index,
    );
  for (
    let index = 0;
    index < order.length && remainder > 0;
    index += 1, remainder -= 1
  )
    rounded[order[index].index] += 1;
  return rounded as [number, number, number];
}

export function leaderProbabilityLabel(probability?: WinProbability): string {
  if (!probability) return 'Analyzing';
  const percentages = probabilityPercentages(probability);
  const leaders = [
    { label: 'W', value: percentages[0] },
    { label: 'Draw', value: percentages[1] },
    { label: 'B', value: percentages[2] },
  ];
  leaders.sort((left, right) => right.value - left.value);
  return `${leaders[0].label} ${leaders[0].value}%`;
}

export function probabilityDetailLabel(probability?: WinProbability): string {
  if (!probability) return 'Win probability unavailable';
  const [white, draw, black] = probabilityPercentages(probability);
  return `White ${white} · Draw ${draw} · Black ${black}`;
}

/** Stable priority for progressive analysis: active, recent ancestors, then other opened neighborhoods. */
export function openedAnalysisQueue(
  study: StudyModel,
  probabilities: Readonly<Record<string, WinProbability>>,
): GameNode[] {
  const path: GameNode[] = [];
  let selected: GameNode | undefined = study.nodes[study.activeId];
  while (selected) {
    path.unshift(selected);
    selected = selected.parentId ? study.nodes[selected.parentId] : undefined;
  }
  const ancestryRank = new Map(
    path
      .slice()
      .reverse()
      .map((node, index) => [node.id, index]),
  );
  const activePly = study.nodes[study.activeId]?.ply ?? 0;
  return Object.values(study.nodes)
    .filter(
      (node) =>
        node.expanded &&
        !node.terminal &&
        node.children.some((id) => {
          const child = study.nodes[id];
          return child && !probabilities[id] && !terminalProbability(child);
        }),
    )
    .sort((left, right) => {
      const leftRank = ancestryRank.has(left.id)
        ? ancestryRank.get(left.id)!
        : 1_000 + Math.abs(left.ply - activePly);
      const rightRank = ancestryRank.has(right.id)
        ? ancestryRank.get(right.id)!
        : 1_000 + Math.abs(right.ply - activePly);
      return leftRank - rightRank || left.id.localeCompare(right.id);
    });
}

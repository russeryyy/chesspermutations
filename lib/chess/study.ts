import { Chess, DEFAULT_POSITION, type Move, type Square } from 'chess.js';
import type { GameNode, NodeAnnotations, StudyModel, StudySource } from './contracts';
import { nodeIdentity, positionIdentity } from './identity';

export const START_FEN = DEFAULT_POSITION;

export function moveToUci(move: Pick<Move, 'from' | 'to' | 'promotion'>): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}

export function parseUci(uci: string): { from: Square; to: Square; promotion?: 'q' | 'r' | 'b' | 'n' } {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw new Error(`Invalid UCI move: ${uci}`);
  return { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, ...(uci[4] ? { promotion: uci[4] as 'q' | 'r' | 'b' | 'n' } : {}) };
}

export function replayPath(rootFen: string, path: readonly string[]): Chess {
  const chess = new Chess(rootFen);
  for (const uci of path) chess.move(parseUci(uci));
  return chess;
}

export function terminalLabel(chess: Chess): string | undefined {
  if (chess.isCheckmate()) return `checkmate · ${chess.turn() === 'w' ? 'black' : 'white'} wins`;
  if (chess.isStalemate()) return 'draw · stalemate';
  if (chess.isThreefoldRepetition()) return 'draw · threefold repetition';
  if (chess.isDrawByFiftyMoves()) return 'draw · fifty-move rule';
  if (chess.isInsufficientMaterial()) return 'draw · insufficient material';
  if (chess.isDraw()) return 'draw';
  return undefined;
}

async function makeNode(chess: Chess, rootFen: string, path: string[], parentId: string | null, move: Move | null, mainline: boolean, annotations?: NodeAnnotations): Promise<GameNode> {
  return {
    id: await nodeIdentity(rootFen, path),
    positionKey: await positionIdentity(chess.fen()),
    parentId,
    children: [],
    ply: path.length,
    san: move?.san ?? null,
    uci: move ? moveToUci(move) : null,
    fen: chess.fen(),
    path,
    mainline,
    expanded: false,
    terminal: terminalLabel(chess),
    ...(annotations ? { annotations } : {}),
  };
}

export async function createStudy(source: StudySource, rootFen = START_FEN, localTitle?: string): Promise<StudyModel> {
  const chess = new Chess(rootFen);
  const root = await makeNode(chess, rootFen, [], null, null, true);
  return { version: 1, source, rootFen, rootId: root.id, activeId: root.id, nodes: { [root.id]: root }, mainline: [root.id], ...(localTitle ? { localTitle } : {}) };
}

export async function appendMove(study: StudyModel, parentId: string, uci: string, mainline = false, annotations?: NodeAnnotations): Promise<{ study: StudyModel; node: GameNode }> {
  const parent = study.nodes[parentId];
  if (!parent) throw new Error('Parent position is unavailable.');
  const existing = parent.children.map((id) => study.nodes[id]).find((node) => node.uci === uci);
  if (existing) {
    const promoted = mainline && !existing.mainline ? { ...existing, mainline: true } : existing;
    const mainlineIds = mainline && parent.id === study.mainline[study.mainline.length - 1]
      ? [...study.mainline, promoted.id]
      : study.mainline;
    return {
      study: {
        ...study,
        activeId: promoted.id,
        mainline: mainlineIds,
        nodes: promoted === existing ? study.nodes : { ...study.nodes, [promoted.id]: promoted },
      },
      node: promoted,
    };
  }
  const chess = replayPath(study.rootFen, parent.path);
  const move = chess.move(parseUci(uci));
  const path = [...parent.path, uci];
  const node = await makeNode(chess, study.rootFen, path, parentId, move, mainline, annotations);
  const nodes = { ...study.nodes, [parentId]: { ...parent, children: [...parent.children, node.id] }, [node.id]: node };
  const mainlineIds = mainline && parent.id === study.mainline[study.mainline.length - 1] ? [...study.mainline, node.id] : study.mainline;
  return { study: { ...study, nodes, activeId: node.id, mainline: mainlineIds }, node };
}

export async function expandNode(study: StudyModel, nodeId: string): Promise<StudyModel> {
  const parent = study.nodes[nodeId];
  if (!parent || parent.expanded || parent.terminal) return study;
  const chess = replayPath(study.rootFen, parent.path);
  const moves = chess.moves({ verbose: true });
  const created = await Promise.all(moves.map(async (candidate) => {
    const branch = replayPath(study.rootFen, parent.path);
    const move = branch.move({ from: candidate.from, to: candidate.to, ...(candidate.promotion ? { promotion: candidate.promotion } : {}) });
    return makeNode(branch, study.rootFen, [...parent.path, moveToUci(move)], parent.id, move, false);
  }));
  const nodes = { ...study.nodes, [parent.id]: { ...parent, expanded: true, children: created.map((node) => node.id) } };
  for (const node of created) nodes[node.id] = node;
  return { ...study, nodes };
}

export function legalMoves(study: StudyModel, nodeId: string): Move[] {
  const node = study.nodes[nodeId];
  if (!node) return [];
  return replayPath(study.rootFen, node.path).moves({ verbose: true });
}

export function nodePath(study: StudyModel, nodeId: string): GameNode[] {
  const path: GameNode[] = [];
  let node = study.nodes[nodeId];
  while (node) {
    path.unshift(node);
    if (!node.parentId) break;
    node = study.nodes[node.parentId];
  }
  return path;
}

export async function buildStudyFromSan(moves: readonly string[], source: StudySource, localTitle?: string): Promise<StudyModel> {
  let study = await createStudy(source, START_FEN, localTitle);
  let parentId = study.rootId;
  for (const san of moves) {
    const chess = replayPath(study.rootFen, study.nodes[parentId].path);
    const move = chess.move(san);
    const appended = await appendMove(study, parentId, moveToUci(move), true);
    study = appended.study;
    parentId = appended.node.id;
  }
  return { ...study, activeId: parentId };
}

export function pgnForPath(study: StudyModel, nodeId = study.activeId): string {
  if (study.source.kind === 'pgn') return study.source.pgn;
  const node = study.nodes[nodeId];
  const chess = replayPath(study.rootFen, node?.path ?? []);
  chess.setHeader('Event', study.localTitle || study.importedHeaders?.Event || 'Chess Universe study');
  chess.setHeader('Site', 'Chess Universe');
  chess.setHeader('Result', study.result || '*');
  if (study.rootFen !== START_FEN) {
    chess.setHeader('SetUp', '1');
    chess.setHeader('FEN', study.rootFen);
  }
  if (study.termination) chess.setHeader('Termination', study.termination);
  return chess.pgn({ maxWidth: 88, newline: '\n' });
}

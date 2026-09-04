import { describe, expect, it } from 'vitest';
import {
  createStudy,
  appendMove,
  expandNode,
  START_FEN,
} from '@/lib/chess/study';
import { parseInfo } from '@/lib/chess/engine';
import {
  deriveGraphMoveVisual,
  leaderProbabilityLabel,
  normalizeWdl,
  openedAnalysisQueue,
  probabilityPercentages,
  terminalProbability,
} from '@/lib/chess/graph-visuals';
import { layoutGameTree } from '@/lib/chess/layout';

async function line(moves: string[]) {
  let study = await createStudy({ kind: 'fen', fen: START_FEN });
  let parent = study.nodes[study.rootId];
  for (const uci of moves) {
    const appended = await appendMove(study, parent.id, uci);
    study = appended.study;
    parent = appended.node;
  }
  return {
    study,
    node: parent,
    parent: parent.parentId ? study.nodes[parent.parentId] : undefined,
  };
}

describe('chess-semantic graph metadata', () => {
  it('recognizes quiet moves, captures, and en passant', async () => {
    const quiet = await line(['e2e4']);
    expect(deriveGraphMoveVisual(quiet.node, quiet.parent)).toMatchObject({
      piece: 'p',
      side: 'white',
      capture: false,
    });

    const capture = await line(['e2e4', 'd7d5', 'e4d5']);
    expect(deriveGraphMoveVisual(capture.node, capture.parent)).toMatchObject({
      piece: 'p',
      side: 'white',
      capture: true,
      enPassant: false,
    });

    const enPassant = await line(['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6']);
    expect(
      deriveGraphMoveVisual(enPassant.node, enPassant.parent),
    ).toMatchObject({ capture: true, enPassant: true });
  });

  it('recognizes castling, promotion, check, mate, and terminal draws', async () => {
    const castle = await line([
      'g1f3',
      'g8f6',
      'g2g3',
      'g7g6',
      'f1g2',
      'f8g7',
      'e1g1',
    ]);
    expect(deriveGraphMoveVisual(castle.node, castle.parent)).toMatchObject({
      piece: 'k',
      castle: true,
    });

    let promotionStudy = await createStudy(
      { kind: 'fen', fen: '8/P7/8/8/8/8/7k/4K3 w - - 0 1' },
      '8/P7/8/8/8/8/7k/4K3 w - - 0 1',
    );
    const promoted = await appendMove(
      promotionStudy,
      promotionStudy.rootId,
      'a7a8q',
    );
    promotionStudy = promoted.study;
    expect(
      deriveGraphMoveVisual(
        promoted.node,
        promotionStudy.nodes[promoted.node.parentId!],
      ),
    ).toMatchObject({ promotion: true, promotedPiece: 'q' });

    const mate = await line(['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    expect(deriveGraphMoveVisual(mate.node, mate.parent)).toMatchObject({
      piece: 'q',
      side: 'black',
      check: true,
      mate: true,
    });

    const drawNode = { ...mate.node, terminal: 'draw · fifty-move rule' };
    expect(deriveGraphMoveVisual(drawNode, mate.parent).terminalDraw).toBe(
      false,
    );
    const quiet = await line(['e2e4']);
    expect(
      deriveGraphMoveVisual(
        { ...quiet.node, terminal: 'draw · agreed' },
        quiet.parent,
      ).terminalDraw,
    ).toBe(true);
  });
});

describe('Stockfish WDL graph contract', () => {
  it('parses WDL and normalizes side-to-move results to White', () => {
    const line = parseInfo(
      'info depth 17 multipv 2 score cp 21 wdl 580 300 120 nodes 30000 pv e2e4 e7e5',
    );
    expect(line?.wdl).toEqual({ win: 580, draw: 300, loss: 120 });
    expect(normalizeWdl(line!.wdl!, 'w', 17, 30_000)).toMatchObject({
      white: 580,
      draw: 300,
      black: 120,
    });
    expect(normalizeWdl(line!.wdl!, 'b', 17, 30_000)).toMatchObject({
      white: 120,
      draw: 300,
      black: 580,
    });
  });

  it('keeps displayed percentages at exactly 100 and reports the leader', () => {
    const probability = normalizeWdl(
      { win: 333, draw: 333, loss: 334 },
      'w',
      12,
      30_000,
    );
    expect(
      probabilityPercentages(probability).reduce(
        (sum, value) => sum + value,
        0,
      ),
    ).toBe(100);
    expect(leaderProbabilityLabel(probability)).toBe('B 34%');
  });

  it('uses exact known terminal outcomes without engine work', async () => {
    const mate = await line(['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    expect(terminalProbability(mate.node)).toMatchObject({
      white: 0,
      draw: 0,
      black: 1_000,
      nodes: 0,
    });
  });
});

describe('constellation layout', () => {
  it('places the selected ancestry on a narrow helix and preserves exact ply depth', async () => {
    const game = await line(['e2e4', 'e7e5', 'g1f3']);
    const points = layoutGameTree(
      Object.values(game.study.nodes),
      game.node.id,
    );
    for (const node of Object.values(game.study.nodes)) {
      const point = points.find((candidate) => candidate.id === node.id)!;
      expect(point.z).toBe(node.ply === 0 ? 0 : -node.ply * 9);
      expect(Math.hypot(point.x, point.y)).toBeLessThan(2.1);
    }
    expect(
      layoutGameTree(Object.values(game.study.nodes), game.node.id),
    ).toEqual(points);
  });

  it('prioritizes the active opened neighborhood before its ancestors', async () => {
    let study = await createStudy({ kind: 'fen', fen: START_FEN });
    study = await expandNode(study, study.rootId);
    const e4 = Object.values(study.nodes).find((node) => node.uci === 'e2e4')!;
    study = await expandNode({ ...study, activeId: e4.id }, e4.id);
    const queue = openedAnalysisQueue(study, {});
    expect(queue.slice(0, 2).map((node) => node.id)).toEqual([
      e4.id,
      study.rootId,
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { adjudicate } from '@/lib/chess/adjudication';
import { phraseAddress, nodeIdentity } from '@/lib/chess/identity';
import { layoutGameTree, visibleGameTree } from '@/lib/chess/layout';
import { importAnnotatedPgn } from '@/lib/chess/pgn';
import { ancestorSanTrail, placeNodePreview } from '@/lib/chess/preview';
import { readShareHash, shareHash } from '@/lib/chess/share';
import {
  appendMove,
  buildStudyFromSan,
  createStudy,
  expandNode,
  looksLikeFenInput,
  pgnForPath,
  START_FEN,
} from '@/lib/chess/study';

describe('frozen chess-game:v1 identities', () => {
  it('keeps a fixed phrase and path on golden addresses', async () => {
    expect(await phraseAddress('a map with no edge')).toBe(
      'SdticEYWTiJd3gIJ4zM1bV9rVVKodzAPYmPPOGdPduF',
    );
    expect(await phraseAddress('  a map with no edge  ')).toBe(
      'SdticEYWTiJd3gIJ4zM1bV9rVVKodzAPYmPPOGdPduF',
    );
    expect(await nodeIdentity(START_FEN, ['e2e4', 'e7e5'])).toBe(
      'hr32GXTr68MVEiJ1H9XxXtfposatrkgPtWQ1MCxQiZ2',
    );
  });

  it('round-trips all share source types without a phrase', () => {
    const generated = readShareHash(
      shareHash({ kind: 'seed', address: 'abc123' }, ['e2e4'], 'black'),
    );
    expect(generated).toEqual({
      version: 1,
      source: { kind: 'seed', address: 'abc123' },
      activePath: ['e2e4'],
      orientation: 'black',
    });
    expect(
      shareHash({ kind: 'fen', fen: START_FEN }, [], 'white'),
    ).not.toContain('a map with no edge');
    expect(
      readShareHash(shareHash({ kind: 'pgn', pgn: '1. e4 *' }, [], 'white'))
        ?.source,
    ).toEqual({ kind: 'pgn', pgn: '1. e4 *' });
  });
});

describe('rules, paths, and positions', () => {
  it('recognizes fast FEN entry without mistaking normal phrases for positions', () => {
    expect(looksLikeFenInput(START_FEN)).toBe(true);
    expect(looksLikeFenInput('8/8/8/8/8/8/8/8 invalid')).toBe(true);
    expect(looksLikeFenInput('a map with no edge')).toBe(false);
  });

  it('opens a blank standard game with every legal first move', async () => {
    const blank = await createStudy(
      { kind: 'fen', fen: START_FEN },
      START_FEN,
      'New game',
    );
    const expanded = await expandNode(blank, blank.rootId);

    expect(expanded.activeId).toBe(expanded.rootId);
    expect(expanded.mainline).toEqual([expanded.rootId]);
    expect(expanded.nodes[expanded.rootId].children).toHaveLength(20);
    expect(Object.keys(expanded.nodes)).toHaveLength(21);
  });

  it('recognizes castling, promotion, en passant, mate, stalemate, and repetition', async () => {
    const castle = await createStudy(
      { kind: 'fen', fen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1' },
      'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1',
    );
    expect((await appendMove(castle, castle.rootId, 'e1g1')).node.san).toBe(
      'O-O',
    );

    const promotion = await createStudy(
      { kind: 'fen', fen: '7k/P7/8/8/8/8/8/7K w - - 0 1' },
      '7k/P7/8/8/8/8/8/7K w - - 0 1',
    );
    expect(
      (await appendMove(promotion, promotion.rootId, 'a7a8q')).node.san,
    ).toContain('=Q');

    const passant = await buildStudyFromSan(['e4', 'a6', 'e5', 'd5', 'exd6'], {
      kind: 'seed',
      address: 'rules',
    });
    expect(passant.nodes[passant.activeId].uci).toBe('e5d6');

    const mate = await buildStudyFromSan(['f3', 'e5', 'g4', 'Qh4#'], {
      kind: 'seed',
      address: 'mate',
    });
    expect(mate.nodes[mate.activeId].terminal).toContain('checkmate');

    const stalemate = await createStudy(
      { kind: 'fen', fen: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1' },
      '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1',
    );
    expect(stalemate.nodes[stalemate.rootId].terminal).toContain('stalemate');

    const repetition = await buildStudyFromSan(
      ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8'],
      { kind: 'seed', address: 'repeat' },
    );
    expect(repetition.nodes[repetition.activeId].terminal).toContain(
      'threefold',
    );

    const fifty = await createStudy(
      { kind: 'fen', fen: '7k/8/8/8/8/8/8/R6K w - - 99 50' },
      '7k/8/8/8/8/8/8/R6K w - - 99 50',
    );
    expect(
      (await appendMove(fifty, fifty.rootId, 'a1a2')).node.terminal,
    ).toContain('fifty-move');
  });

  it('keeps path identity distinct while recognizing transpositions', async () => {
    const first = await buildStudyFromSan(['e4', 'e5', 'Nf3', 'Nc6'], {
      kind: 'seed',
      address: 'one',
    });
    const second = await buildStudyFromSan(['Nf3', 'Nc6', 'e4', 'e5'], {
      kind: 'seed',
      address: 'two',
    });
    expect(first.nodes[first.activeId].id).not.toBe(
      second.nodes[second.activeId].id,
    );
    expect(first.nodes[first.activeId].positionKey).toBe(
      second.nodes[second.activeId].positionKey,
    );
  });

  it('lays out nodes deterministically with ply on z', async () => {
    const study = await buildStudyFromSan(['e4', 'e5', 'Nf3'], {
      kind: 'seed',
      address: 'layout',
    });
    const nodes = Object.values(study.nodes);
    expect(layoutGameTree(nodes)).toEqual(layoutGameTree(nodes));
    for (const point of layoutGameTree(nodes))
      expect(point.z).toBe(
        study.nodes[point.id].ply === 0 ? 0 : -study.nodes[point.id].ply * 9,
      );
  });

  it('keeps the active path inside the 1,200-node render budget', () => {
    const nodes = Array.from({ length: 1_300 }, (_, index) => ({
      id: `node-${index}`,
      positionKey: `position-${index}`,
      parentId: index ? `node-${index - 1}` : null,
      children: index < 1_299 ? [`node-${index + 1}`] : [],
      ply: index,
      san: index ? 'a3' : null,
      uci: index ? 'a2a3' : null,
      fen: START_FEN,
      path: [],
      mainline: index < 320,
      expanded: true,
    }));
    const visible = visibleGameTree(nodes, 'node-1299', 1_200);
    expect(visible).toHaveLength(1_200);
    expect(visible.some((node) => node.id === 'node-1299')).toBe(true);
  });

  it('formats recent SAN context for graph previews', async () => {
    const study = await buildStudyFromSan(['e4', 'e5', 'Nf3', 'Nc6'], {
      kind: 'seed',
      address: 'preview',
    });
    expect(
      ancestorSanTrail(Object.values(study.nodes), study.activeId, 3),
    ).toEqual(['e5', 'Nf3', 'Nc6']);
  });

  it('keeps graph previews in bounds and away from dock overlays', () => {
    const edge = placeNodePreview(
      { x: 496, y: 396 },
      { width: 500, height: 400 },
      { width: 200, height: 120 },
    );
    expect(edge.left).toBeGreaterThanOrEqual(12);
    expect(edge.left).toBeLessThanOrEqual(288);
    expect(edge.top).toBeGreaterThanOrEqual(12);
    expect(edge.top).toBeLessThanOrEqual(268);

    const avoiding = placeNodePreview(
      { x: 250, y: 80 },
      { width: 500, height: 400 },
      { width: 200, height: 120 },
      [{ left: 300, top: 0, width: 200, height: 400 }],
    );
    expect(avoiding.left + 200).toBeLessThanOrEqual(300);
  });
});

describe('annotated imports and adjudication', () => {
  it('preserves comments and recursive variations after atomic validation', async () => {
    const pgn =
      '[Event "Nested study"]\n\n1. e4 {King pawn} e5 2. Nf3 (2. Bc4 Nf6 (2... Bc5)) Nc6 $1 *';
    const study = await importAnnotatedPgn(pgn);
    expect(study.localTitle).toBe('Nested study');
    expect(
      Object.values(study.nodes).some(
        (node) => node.annotations?.comment === 'King pawn',
      ),
    ).toBe(true);
    expect(
      Object.values(study.nodes).filter((node) => node.ply === 3).length,
    ).toBeGreaterThan(1);
    expect(pgnForPath(study)).toBe(pgn);
  });

  it('rejects multiple games and illegal branches', async () => {
    await expect(importAnnotatedPgn('1. e4 *\n\n1. d4 *')).rejects.toThrow(
      /one PGN|one.*time/i,
    );
    await expect(importAnnotatedPgn('1. e5 *')).rejects.toThrow();
  });

  it('freezes the v1 adjudication windows', () => {
    expect(adjudicate(Array(8).fill(701), 40)).toEqual({
      result: '1-0',
      reason: 'engine adjudication · sustained +7.00',
    });
    expect(adjudicate(Array(20).fill(0), 80)).toEqual({
      result: '1/2-1/2',
      reason: 'engine adjudication · sustained equality',
    });
    expect(adjudicate([], 320)).toEqual({
      result: '1/2-1/2',
      reason: 'generation horizon · 320 plies',
    });
  });

  it('refuses oversized portable PGN links while keeping local imports possible', () => {
    let value = 17;
    const noisy = Array.from({ length: 40_000 }, () => {
      value = (value * 48271) % 0x7fffffff;
      return String.fromCharCode(33 + (value % 90));
    }).join('');
    expect(() => shareHash({ kind: 'pgn', pgn: noisy }, [], 'white')).toThrow(
      /too large/i,
    );
  });
});

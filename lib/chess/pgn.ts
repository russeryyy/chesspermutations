import { parse, type Notation, type NotationList } from '@echecs/pgn';
import { Chess } from 'chess.js';
import type { NodeAnnotations, StudyModel } from './contracts';
import { PGN_IMPORT_LIMIT } from './contracts';
import { appendMove, createStudy, moveToUci, replayPath, START_FEN } from './study';

function notationToSan(move: Notation): string {
  if (move.castling) return `${move.long ? 'O-O-O' : 'O-O'}${move.checkmate ? '#' : move.check ? '+' : ''}`;
  const pieces: Record<string, string> = { pawn: '', knight: 'N', bishop: 'B', rook: 'R', queen: 'Q', king: 'K' };
  const promotion = move.promotion ? `=${pieces[move.promotion]}` : '';
  return `${pieces[move.piece]}${move.from ?? ''}${move.capture ? 'x' : ''}${move.to ?? ''}${promotion}${move.checkmate ? '#' : move.check ? '+' : ''}`;
}

function flatten(list: NotationList): Notation[] {
  return list.flatMap(([, white, black]) => [white, black].filter((move): move is Notation => Boolean(move)));
}

function annotationsFor(move: Notation): NodeAnnotations | undefined {
  const annotations: NodeAnnotations = {
    ...(move.comment ? { comment: move.comment } : {}),
    ...(move.annotations?.length ? { nags: move.annotations } : {}),
    ...(move.arrows?.length ? { arrows: move.arrows } : {}),
    ...(move.squares?.length ? { squares: move.squares } : {}),
    ...(move.eval ? { importedEvaluation: { ...move.eval, depth: move.eval.depth ?? 0, nodes: 0, pv: [] } } : {}),
  };
  return Object.keys(annotations).length ? annotations : undefined;
}

export async function importAnnotatedPgn(input: string): Promise<StudyModel> {
  if (input.length > PGN_IMPORT_LIMIT) throw new Error('PGN imports are limited to 1 MB.');
  const errors: string[] = [];
  const games = parse(input, { onError: (error) => errors.push(`Line ${error.line}, column ${error.column}: ${error.message}`) });
  if (errors.length) throw new Error(errors[0]);
  if (games.length !== 1) throw new Error(games.length ? 'Import one PGN game at a time.' : 'No complete PGN game was found.');
  const game = games[0];
  const rootFen = game.meta.SetUp === '1' && game.meta.FEN ? game.meta.FEN : START_FEN;
  new Chess(rootFen);
  let study = await createStudy({ kind: 'pgn', pgn: input }, rootFen, game.meta.Event || 'Imported study');
  study = { ...study, importedHeaders: Object.fromEntries(Object.entries(game.meta).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), result: game.meta.Result || (game.result === 1 ? '1-0' : game.result === 0 ? '0-1' : game.result === 0.5 ? '1/2-1/2' : '*') };

  const buildSequence = async (list: NotationList, initialParentId: string, isMainline: boolean): Promise<string> => {
    let parentId = initialParentId;
    for (const notation of flatten(list)) {
      const branchParentId = parentId;
      const parent = study.nodes[parentId];
      const chess = replayPath(study.rootFen, parent.path);
      const move = chess.move(notationToSan(notation));
      const appended = await appendMove(study, parentId, moveToUci(move), isMainline, annotationsFor(notation));
      study = appended.study;
      parentId = appended.node.id;
      for (const variation of notation.variants ?? []) await buildSequence(variation, branchParentId, false);
    }
    return parentId;
  };

  const leafId = await buildSequence(game.moves, study.rootId, true);
  return { ...study, activeId: leafId };
}

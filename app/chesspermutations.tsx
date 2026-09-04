'use client';

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess, type Move, type Square } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import type { Key } from '@lichess-org/chessground/types';
import {
  ChevronLeft, ChevronRight, Download, FileInput, FlipHorizontal2, Info,
  ListTree, Maximize2, Orbit, Pause, Play, RotateCcw, Share2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Toaster, toast } from '@/components/ui/toast';
import { adjudicate } from '@/lib/chess/adjudication';
import { readCachedStudy, writeCachedStudy } from '@/lib/chess/cache';
import { ENGINE_CONTRACT, GRAPH_NODE_LIMIT, type Evaluation, type GameNode, type Orientation, type StudyModel } from '@/lib/chess/contracts';
import { chooseSeededLine, scoreAsCentipawns, StockfishClient, type AnalysisLine } from '@/lib/chess/engine';
import { phraseAddress } from '@/lib/chess/identity';
import { importAnnotatedPgn } from '@/lib/chess/pgn';
import { readShareHash, shareHash } from '@/lib/chess/share';
import { appendMove, buildStudyFromSan, createStudy, expandNode, legalMoves, moveToUci, nodePath, parseUci, pgnForPath, replayPath, START_FEN } from '@/lib/chess/study';

const SAMPLE_PHRASE = 'a map with no edge';
const SAMPLE_MOVES = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'd6'];
const PermutationsGraph = lazy(() => import('@/app/permutations-graph').then((module) => ({ default: module.PermutationsGraph })));

interface WebMcpContext {
  registerTool(tool: {
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
    execute(input: unknown): unknown;
  }, options: { signal: AbortSignal }): void | Promise<void>;
}

function webMcpInput(input: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('input must be an object');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) throw new Error('input contains unsupported properties');
  return value;
}

function scoreLabel(evaluation?: Pick<Evaluation, 'type' | 'value'>): string {
  if (!evaluation) return '—';
  if (evaluation.type === 'mate') return evaluation.value > 0 ? `M${evaluation.value}` : `−M${Math.abs(evaluation.value)}`;
  const value = evaluation.value / 100;
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`;
}

function engineStatusLabel(status: string): string {
  if (status.startsWith('GENERATING')) return status.replace('GENERATING · ', 'Generating · ').replace('PLY ', 'ply ');
  if (status.startsWith('ANALYZING')) return 'Analyzing';
  if (status.startsWith('ENGINE UNAVAILABLE')) return 'Engine unavailable';
  if (status === 'SHELL READY') return 'Starting engine';
  return 'Ready';
}

function lineSan(fen: string, uci: string): string {
  try { return new Chess(fen).move(parseUci(uci)).san; }
  catch { return uci; }
}

function evaluationForWhite(line: AnalysisLine, turn: 'w' | 'b'): Evaluation {
  return { ...line, value: turn === 'w' ? line.value : -line.value };
}

async function followSharedPath(study: StudyModel, path: readonly string[]): Promise<StudyModel> {
  let next = study;
  let parentId = study.rootId;
  for (const uci of path) {
    const existing = next.nodes[parentId]?.children.map((id) => next.nodes[id]).find((node) => node.uci === uci);
    if (existing) {
      parentId = existing.id;
      next = { ...next, activeId: parentId };
    } else {
      const appended = await appendMove(next, parentId, uci, false);
      next = appended.study;
      parentId = appended.node.id;
    }
  }
  return { ...next, activeId: parentId };
}

function AnalysisBoard({ node, orientation, onMove }: { node: GameNode; orientation: Orientation; onMove: (uci: string) => void }) {
  const mount = useRef<HTMLDivElement>(null);
  const board = useRef<ReturnType<typeof Chessground> | null>(null);
  const onMoveRef = useRef(onMove);

  useEffect(() => { onMoveRef.current = onMove; }, [onMove]);

  const config = useCallback(() => {
    const chess = new Chess(node.fen);
    const dests = new Map<Key, Key[]>();
    for (const move of chess.moves({ verbose: true })) {
      const from = move.from as Key;
      dests.set(from, [...(dests.get(from) ?? []), move.to as Key]);
    }
    const colorMap: Record<string, string> = { B: 'blue', C: 'blue', G: 'green', O: 'yellow', R: 'red', Y: 'yellow' };
    const autoShapes = [
      ...(node.annotations?.arrows ?? []).map((arrow) => ({ orig: arrow.from as Key, dest: arrow.to as Key, brush: colorMap[arrow.color] ?? 'green' })),
      ...(node.annotations?.squares ?? []).map((square) => ({ orig: square.square as Key, brush: colorMap[square.color] ?? 'green' })),
    ];
    return {
      fen: node.fen,
      orientation,
      turnColor: chess.turn() === 'w' ? 'white' as const : 'black' as const,
      check: chess.inCheck(),
      coordinates: true,
      lastMove: node.uci ? [node.uci.slice(0, 2) as Key, node.uci.slice(2, 4) as Key] : undefined,
      animation: { enabled: !matchMedia('(prefers-reduced-motion: reduce)').matches, duration: 170 },
      movable: {
        free: false,
        color: chess.turn() === 'w' ? 'white' as const : 'black' as const,
        dests,
        showDests: true,
        events: {
          after: (from: Key, to: Key) => {
            const legal = new Chess(node.fen).moves({ square: from as Square, verbose: true }).filter((move) => move.to === to);
            const choice = legal.find((move) => move.promotion === 'q') ?? legal[0];
            if (choice) onMoveRef.current(moveToUci(choice));
          },
        },
      },
      drawable: { enabled: true, visible: true, autoShapes },
    };
  }, [node, orientation]);

  useEffect(() => {
    if (!mount.current) return;
    board.current = Chessground(mount.current, config());
    return () => { board.current?.destroy(); board.current = null; };
  }, [config]);
  return <div ref={mount} className="cg-wrap chess-board" aria-label={`Interactive chess board at ply ${node.ply}`} />;
}

function AccessibleTree({ study, onSelect }: { study: StudyModel; onSelect: (id: string) => void }) {
  const ordered = useMemo(() => Object.values(study.nodes).sort((left, right) => left.ply - right.ply || left.id.localeCompare(right.id)), [study.nodes]);
  return (
    <div className="tree-fallback" role="tree" aria-label="Chess move tree">
      {ordered.slice(0, GRAPH_NODE_LIMIT).map((node) => (
        <button key={node.id} role="treeitem" aria-current={node.id === study.activeId ? 'true' : undefined} aria-level={node.ply + 1} className={node.id === study.activeId ? 'active' : ''} style={{ paddingLeft: `${12 + Math.min(node.ply, 10) * 12}px` }} onClick={() => onSelect(node.id)}>
          <span>{node.ply ? `${node.ply}. ${node.san}` : 'Starting position'}</span>
          <small>{node.terminal ?? scoreLabel(node.evaluation ?? node.annotations?.importedEvaluation)}</small>
        </button>
      ))}
    </div>
  );
}

export function ChessPermutations() {
  const [study, setStudy] = useState<StudyModel | null>(null);
  const studyRef = useRef<StudyModel | null>(null);
  const [phrase, setPhrase] = useState(SAMPLE_PHRASE);
  const [orientation, setOrientation] = useState<Orientation>('white');
  const [engineLines, setEngineLines] = useState<AnalysisLine[]>([]);
  const [engineStatus, setEngineStatus] = useState('SHELL READY');
  const [notice, setNotice] = useState('Loading local permutations…');
  const [importOpen, setImportOpen] = useState(false);
  const [importKind, setImportKind] = useState<'fen' | 'pgn'>('fen');
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const [licensesOpen, setLicensesOpen] = useState(false);
  const [graphMode, setGraphMode] = useState<'3d' | 'list'>(() => typeof window !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'list' : '3d');
  const [mobilePane, setMobilePane] = useState('board');
  const [playing, setPlaying] = useState(false);
  const engineStatusRef = useRef(engineStatus);
  const orientationRef = useRef(orientation);
  const workspace = useRef<HTMLElement>(null);
  const engine = useRef<StockfishClient | null>(null);
  const analysisAbort = useRef<AbortController | null>(null);
  const generationAbort = useRef<AbortController | null>(null);
  const generationRun = useRef(0);
  const generationActive = useRef(false);
  const shouldResume = useRef(false);
  const startGenerationRef = useRef<(base: StudyModel, follow: boolean) => void>(() => undefined);

  useEffect(() => { engineStatusRef.current = engineStatus; }, [engineStatus]);
  useEffect(() => { orientationRef.current = orientation; }, [orientation]);

  const commitStudy = useCallback((next: StudyModel) => { studyRef.current = next; setStudy(next); }, []);
  const getEngine = useCallback(() => { if (!engine.current) engine.current = new StockfishClient(); return engine.current; }, []);
  const notify = useCallback((message: string, type: 'info' | 'success' | 'error' = 'info') => {
    setNotice(message);
    if (studyRef.current) toast.add({ title: message, type, timeout: type === 'error' ? 6_000 : 3_000, priority: type === 'error' ? 'high' : 'low' });
  }, []);

  const startGeneration = useCallback((base: StudyModel, follow: boolean) => {
    if (base.source.kind !== 'seed' || base.result) return;
    generationAbort.current?.abort();
    const controller = new AbortController();
    generationAbort.current = controller;
    const run = ++generationRun.current;
    generationActive.current = true;
    const address = base.source.address;

    void (async () => {
      let generated = base;
      const whiteScores: number[] = [];
      try {
        while (!controller.signal.aborted && generated.mainline.length <= ENGINE_CONTRACT.horizonPlies) {
          const parentId = generated.mainline[generated.mainline.length - 1];
          const parent = generated.nodes[parentId];
          if (!parent || parent.terminal || generated.result) break;
          const position = replayPath(generated.rootFen, parent.path);
          setEngineStatus(`GENERATING · PLY ${String(parent.ply).padStart(3, '0')}`);
          const lines = await getEngine().analyze(generated.rootFen, parent.path, { nodes: ENGINE_CONTRACT.generationNodes, signal: controller.signal });
          if (controller.signal.aborted || run !== generationRun.current) return;
          if (!lines.length) throw new Error('Stockfish returned no legal continuation.');
          setEngineLines(lines);
          const chosen = await chooseSeededLine(lines, address, parent.ply, parent.id);
          const whiteEvaluation = evaluationForWhite(chosen, position.turn());
          whiteScores.push(scoreAsCentipawns(whiteEvaluation));
          generated = { ...generated, nodes: { ...generated.nodes, [parentId]: { ...parent, evaluation: whiteEvaluation } } };
          generated = await expandNode(generated, parentId);
          const appended = await appendMove(generated, parentId, chosen.move, true);
          generated = { ...appended.study, activeId: follow ? appended.node.id : generated.activeId };
          const ruling = adjudicate(whiteScores, appended.node.ply);
          if (ruling) generated = { ...generated, result: ruling.result, termination: ruling.reason, nodes: { ...generated.nodes, [appended.node.id]: { ...generated.nodes[appended.node.id], terminal: ruling.reason } } };
          if (run !== generationRun.current) return;
          commitStudy(generated);
          if (appended.node.terminal || ruling) break;
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        }
        if (!controller.signal.aborted) {
          await writeCachedStudy(address, generated);
          notify(generated.termination ? `Generated line complete · ${generated.termination}` : 'Generated line cached locally.', 'success');
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          notify(error instanceof Error ? error.message : 'Local generation stopped unexpectedly.', 'error');
          setEngineStatus('ENGINE UNAVAILABLE · RULES READY');
        }
      } finally {
        if (run === generationRun.current) {
          generationActive.current = false;
          if (!controller.signal.aborted) setEngineStatus('LOCAL · IDLE');
        }
      }
    })();
  }, [commitStudy, getEngine, notify]);
  useEffect(() => { startGenerationRef.current = startGeneration; }, [startGeneration]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const shared = readShareHash(window.location.hash);
        let initial: StudyModel;
        if (shared?.source.kind === 'pgn') initial = await importAnnotatedPgn(shared.source.pgn);
        else if (shared?.source.kind === 'fen') initial = await createStudy(shared.source, shared.source.fen, 'Shared FEN study');
        else if (shared?.source.kind === 'seed') initial = (await readCachedStudy(shared.source.address)) ?? await createStudy(shared.source, START_FEN, 'Shared generated game');
        else {
          const address = await phraseAddress(SAMPLE_PHRASE);
          initial = await buildStudyFromSan(SAMPLE_MOVES, { kind: 'seed', address }, SAMPLE_PHRASE);
          initial = await expandNode(initial, initial.activeId);
        }
        if (shared?.activePath.length) initial = await followSharedPath(initial, shared.activePath);
        initial = await expandNode(initial, initial.activeId);
        if (!alive) return;
        if (shared) setOrientation(shared.orientation);
        commitStudy(initial);
        if (shared?.source.kind === 'seed' && initial.mainline.length === 1) startGenerationRef.current(initial, true);
      } catch (error) {
        if (!alive) return;
        setNotice(error instanceof Error ? error.message : 'The shared study could not be opened.');
        const address = await phraseAddress(SAMPLE_PHRASE);
        commitStudy(await buildStudyFromSan(SAMPLE_MOVES, { kind: 'seed', address }, SAMPLE_PHRASE));
      }
    })();
    return () => { alive = false; };
  }, [commitStudy]);

  const activeNode = study?.nodes[study.activeId];
  const activeId = activeNode?.id;

  useEffect(() => {
    const currentStudy = studyRef.current;
    const selectedNode = activeId ? currentStudy?.nodes[activeId] : undefined;
    if (!currentStudy || !selectedNode || generationActive.current || selectedNode.terminal) return;
    analysisAbort.current?.abort();
    const controller = new AbortController();
    analysisAbort.current = controller;
    const selectedId = selectedNode.id;
    queueMicrotask(() => { if (!controller.signal.aborted) setEngineStatus('ANALYZING · 30K NODES'); });
    void (async () => {
      try {
        const lines = await getEngine().analyze(currentStudy.rootFen, selectedNode.path, { signal: controller.signal });
        if (controller.signal.aborted || studyRef.current?.activeId !== selectedId) return;
        setEngineLines(lines);
        const best = lines[0];
        if (best) {
          const turn = new Chess(selectedNode.fen).turn();
          const current = studyRef.current;
          if (current?.nodes[selectedId]) commitStudy({ ...current, nodes: { ...current.nodes, [selectedId]: { ...current.nodes[selectedId], evaluation: evaluationForWhite(best, turn) } } });
        }
        setEngineStatus('LOCAL · IDLE');
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setEngineStatus('ENGINE UNAVAILABLE · RULES READY');
          notify(error instanceof Error ? error.message : 'Local analysis failed.', 'error');
        }
      } finally {
        if (!controller.signal.aborted && studyRef.current?.activeId === selectedId && shouldResume.current && studyRef.current.source.kind === 'seed') {
          shouldResume.current = false;
          startGenerationRef.current(studyRef.current, false);
        }
      }
    })();
    return () => controller.abort();
  }, [activeId, commitStudy, getEngine, notify]);

  useEffect(() => () => { analysisAbort.current?.abort(); generationAbort.current?.abort(); engine.current?.destroy(); }, []);

  const pauseGenerationForSelection = useCallback(() => {
    if (generationActive.current) shouldResume.current = true;
    generationAbort.current?.abort();
    generationActive.current = false;
    generationRun.current += 1;
    getEngine().stop();
  }, [getEngine]);

  const selectNode = useCallback(async (id: string) => {
    const current = studyRef.current;
    if (!current?.nodes[id]) return;
    pauseGenerationForSelection();
    const expanded = await expandNode({ ...current, activeId: id }, id);
    commitStudy({ ...expanded, activeId: id });
  }, [commitStudy, pauseGenerationForSelection]);

  const makeMove = useCallback(async (uci: string) => {
    const current = studyRef.current;
    if (!current) return;
    pauseGenerationForSelection();
    try {
      const appended = await appendMove(current, current.activeId, uci, false);
      const expanded = await expandNode(appended.study, appended.node.id);
      commitStudy({ ...expanded, activeId: appended.node.id });
      notify(`Created branch ${appended.node.san}.`, 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'That move is not legal.', 'error'); }
  }, [commitStudy, notify, pauseGenerationForSelection]);

  const openSeed = useCallback(async (value: string) => {
    try {
      setEngineLines([]);
      notify('Hashing phrase locally…');
      analysisAbort.current?.abort();
      generationAbort.current?.abort();
      const address = await phraseAddress(value);
      const cached = await readCachedStudy(address);
      const next = cached ?? await createStudy({ kind: 'seed', address }, START_FEN, value.trim());
      commitStudy(next);
      notify(cached ? 'Opened cached permanent game.' : 'Seed created. Streaming deterministic moves…', 'success');
      if (!cached?.result) startGeneration(next, true);
      return { address, cached: Boolean(cached), activePly: next.nodes[next.activeId].ply };
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The phrase could not be opened.', 'error');
      throw error;
    }
  }, [commitStudy, notify, startGeneration]);

  const openPhrase = useCallback((event: { preventDefault(): void }) => {
    event.preventDefault();
    void openSeed(phrase).catch(() => undefined);
  }, [openSeed, phrase]);

  const openImport = useCallback(async (kind: 'fen' | 'pgn', value: string) => {
    setImportError('');
    try {
      let next: StudyModel;
      if (kind === 'fen') {
        const canonical = new Chess(value.trim()).fen();
        next = await createStudy({ kind: 'fen', fen: canonical }, canonical, 'Imported FEN');
        next = await expandNode(next, next.rootId);
      } else {
        next = await importAnnotatedPgn(value);
        next = await expandNode(next, next.activeId);
      }
      generationAbort.current?.abort();
      analysisAbort.current?.abort();
      commitStudy(next);
      setImportOpen(false);
      setImportText('');
      notify(kind === 'fen' ? 'FEN validated and opened.' : 'Annotated PGN validated and imported.', 'success');
      return { kind, title: next.localTitle ?? null, nodes: Object.keys(next.nodes).length, activePly: next.nodes[next.activeId].ply };
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'Import failed.');
      throw error;
    }
  }, [commitStudy, notify]);

  const submitImport = useCallback(() => { void openImport(importKind, importText).catch(() => undefined); }, [importKind, importText, openImport]);

  const copyShareLink = useCallback(async () => {
    const current = studyRef.current;
    if (!current) return;
    try {
      const hash = shareHash(current.source, current.nodes[current.activeId].path, orientation);
      const url = `${location.origin}${location.pathname}${hash}`;
      history.replaceState(null, '', hash);
      await navigator.clipboard.writeText(url);
      notify('Versioned link copied. The original phrase is not in it.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'The link could not be copied.', 'error'); }
  }, [notify, orientation]);

  const exportPgn = useCallback(() => {
    const current = studyRef.current;
    if (!current) return;
    const blob = new Blob([pgnForPath(current)], { type: 'application/x-chess-pgn;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'chesspermutations-study.pgn';
    link.click();
    URL.revokeObjectURL(url);
    notify('PGN downloaded.', 'success');
  }, [notify]);

  useEffect(() => {
    const context = (document as Document & { modelContext?: WebMcpContext }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = (tool: Parameters<WebMcpContext['registerTool']>[0]) => {
      try { void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => undefined); }
      catch { /* Unsupported or duplicate registries must not affect the visible app. */ }
    };
    register({
      name: 'open_generated_chess_game',
      title: 'Open generated chess game',
      description: 'Hash a phrase locally, open its permanent chess-game:v1 address, and begin deterministic local generation.',
      inputSchema: { type: 'object', properties: { phrase: { type: 'string', minLength: 1, maxLength: 512 } }, required: ['phrase'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: async (input) => {
        const phraseInput = webMcpInput(input, ['phrase']).phrase;
        if (typeof phraseInput !== 'string' || !phraseInput.trim() || phraseInput.length > 512) throw new Error('phrase must be a non-empty string of at most 512 characters');
        setPhrase(phraseInput);
        return openSeed(phraseInput);
      },
    });
    register({
      name: 'import_chess_study',
      title: 'Import chess study',
      description: 'Validate and open one FEN position or one annotated PGN game locally, preserving legal recursive variations.',
      inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['fen', 'pgn'] }, content: { type: 'string', minLength: 1, maxLength: 1000000 } }, required: ['kind', 'content'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async (input) => {
        const value = webMcpInput(input, ['kind', 'content']);
        if ((value.kind !== 'fen' && value.kind !== 'pgn') || typeof value.content !== 'string' || !value.content.trim()) throw new Error('kind must be fen or pgn and content must be non-empty');
        return openImport(value.kind, value.content);
      },
    });
    register({
      name: 'select_chess_path',
      title: 'Select chess path',
      description: 'Navigate the current study to a complete legal path of UCI moves and update the board, notation, and permutation tree together.',
      inputSchema: { type: 'object', properties: { moves: { type: 'array', maxItems: 320, items: { type: 'string', pattern: '^[a-h][1-8][a-h][1-8][qrbn]?$' } } }, required: ['moves'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: async (input) => {
        const moves = webMcpInput(input, ['moves']).moves;
        if (!Array.isArray(moves) || moves.length > 320 || moves.some((move) => typeof move !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move))) throw new Error('moves must be an array of at most 320 legal UCI moves');
        const current = studyRef.current;
        if (!current) throw new Error('No study is loaded');
        pauseGenerationForSelection();
        const next = await followSharedPath(current, moves as string[]);
        commitStudy(next);
        return { activePly: next.nodes[next.activeId].ply, fen: next.nodes[next.activeId].fen, nodeId: next.activeId };
      },
    });
    register({
      name: 'read_chess_study_state',
      title: 'Read chess study state',
      description: 'Read the current local study address, active position, source kind, node count, and engine status without changing it.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: (input) => {
        webMcpInput(input, []);
        const current = studyRef.current;
        if (!current) return { loaded: false };
        const node = current.nodes[current.activeId];
        return { loaded: true, source: current.source.kind, address: current.source.kind === 'seed' ? current.source.address : current.rootId, nodeId: node.id, activePly: node.ply, fen: node.fen, nodes: Object.keys(current.nodes).length, engineStatus: engineStatusRef.current };
      },
    });
    register({
      name: 'create_chess_share_link',
      title: 'Create chess share link',
      description: 'Create a versioned local share link for the active source and move path without serializing an original phrase.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: (input) => {
        webMcpInput(input, []);
        const current = studyRef.current;
        if (!current) throw new Error('No study is loaded');
        const hash = shareHash(current.source, current.nodes[current.activeId].path, orientationRef.current);
        return { url: `${location.origin}${location.pathname}${hash}`, portable: true };
      },
    });
    return () => lifecycle.abort();
  }, [commitStudy, openImport, openSeed, pauseGenerationForSelection]);

  const lineNodes = useMemo(() => study ? nodePath(study, study.activeId) : [], [study]);
  const timelineNodes = useMemo(() => {
    if (!study) return [];
    return study.mainline.includes(study.activeId)
      ? study.mainline.map((id) => study.nodes[id]).filter(Boolean)
      : lineNodes;
  }, [lineNodes, study]);
  const activeTimelineIndex = Math.max(0, timelineNodes.findIndex((node) => node.id === study?.activeId));
  const timelineMax = Math.max(0, timelineNodes.length - 1);
  const candidates: Move[] = study && activeNode ? legalMoves(study, activeNode.id) : [];
  const treeNodes = study ? Object.values(study.nodes) : [];
  const currentEvaluation = activeNode?.evaluation ?? activeNode?.annotations?.importedEvaluation;
  const evalPercent = currentEvaluation ? Math.max(8, Math.min(92, 50 + scoreAsCentipawns(currentEvaluation) / 20)) : 50;

  const stepMainline = useCallback((delta: number) => {
    const current = studyRef.current;
    if (!current) return;
    const active = current.nodes[current.activeId];
    const target = delta < 0
      ? active.parentId
      : active.children.find((id) => current.nodes[id]?.mainline);
    if (target) void selectNode(target);
  }, [selectNode]);

  useEffect(() => {
    if (!playing || !studyRef.current) return;
    const timer = window.setInterval(() => {
      const current = studyRef.current;
      if (!current) return;
      const next = current.nodes[current.activeId].children.find((id) => current.nodes[id]?.mainline);
      if (!next) { setPlaying(false); return; }
      void selectNode(next);
    }, 850);
    return () => window.clearInterval(timer);
  }, [playing, selectNode, study?.rootId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.matches('input, textarea, [contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft') { event.preventDefault(); stepMainline(-1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); stepMainline(1); }
      if (event.key === ' ') { event.preventDefault(); setPlaying((value) => !value); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stepMainline]);

  if (!study || !activeNode) return <main className="loading-shell"><Orbit /><p>{notice}</p></main>;

  return (
    <>
      <main className="chesspermutations-app">
        <header className="app-header">
          <button className="wordmark" type="button" aria-label="chesspermutations home" onClick={() => history.replaceState(null, '', location.pathname)}><Orbit aria-hidden="true" /><span>CHESS<br />PERMUTATIONS</span></button>
          <form className="seed-form" onSubmit={openPhrase}><Input id="seed-input" aria-label="Permanent game phrase" placeholder="Enter a phrase" value={phrase} onChange={(event) => setPhrase(event.target.value)} spellCheck={false} maxLength={512} /><Button type="submit">Open</Button></form>
          <div className="header-actions"><a className="github-link" href="https://github.com/russeryyy/chesspermutations" target="_blank" rel="noreferrer">Github</a><Button variant="outline" title="Import study" onClick={() => setImportOpen(true)}><FileInput /> Import</Button><Button variant="ghost" size="icon" aria-label="Copy share link" title="Copy share link" onClick={copyShareLink}><Share2 /></Button><Button variant="ghost" size="icon" aria-label="About and licenses" title="About and licenses" onClick={() => setLicensesOpen(true)}><Info /></Button></div>
        </header>

        <Tabs value={mobilePane} onValueChange={setMobilePane} className="mobile-pane-tabs"><TabsList><TabsTrigger value="board">Board</TabsTrigger><TabsTrigger value="analysis">Moves</TabsTrigger><TabsTrigger value="permutations">Tree</TabsTrigger></TabsList></Tabs>

        <section ref={workspace} className="workspace" data-mobile-pane={mobilePane}>
          <section className="board-panel" aria-label="Chess board and timeline">
            <div className="board-stage"><div className="eval-track" aria-label={`Evaluation ${scoreLabel(currentEvaluation)}`}><span style={{ height: `${evalPercent}%` }} /></div><AnalysisBoard node={activeNode} orientation={orientation} onMove={makeMove} /></div>
            <div className="transport"><Button variant="outline" size="icon" aria-label="Previous move" onClick={() => stepMainline(-1)}><ChevronLeft /></Button><Button variant="outline" size="icon" aria-label={playing ? 'Pause line' : 'Play line'} onClick={() => setPlaying((value) => !value)}>{playing ? <Pause /> : <Play />}</Button><Slider aria-label="Move timeline" min={0} max={Math.max(1, timelineMax)} value={Math.min(activeTimelineIndex, Math.max(1, timelineMax))} onValueChange={(value) => { const index = typeof value === 'number' ? value : value[0]; const target = timelineNodes[index]; if (target) void selectNode(target.id); }} /><Button variant="outline" size="icon" aria-label="Next move" onClick={() => stepMainline(1)}><ChevronRight /></Button><span>{String(activeTimelineIndex).padStart(2, '0')} / {String(timelineMax).padStart(2, '0')}</span></div>
            <div className="board-utilities"><Button variant="ghost" size="sm" onClick={() => setOrientation((value) => value === 'white' ? 'black' : 'white')}><FlipHorizontal2 /> Flip</Button><div className="board-meta"><strong aria-label={`Evaluation ${scoreLabel(currentEvaluation)}`}>{scoreLabel(currentEvaluation)}</strong>{activeNode.terminal && <span>{activeNode.terminal}</span>}</div></div>
          </section>

          <aside className="analysis-panel" aria-label="Move analysis">
            <div className="analysis-head"><strong className={engineStatus.startsWith('ENGINE UNAVAILABLE') ? 'engine-state engine-error' : 'engine-state'}><i />{engineStatusLabel(engineStatus)}</strong></div>
            <section className="move-path"><header><span>Line</span><small>{activeNode.ply} ply</small></header><div className="move-list" aria-label="Selected move path">{lineNodes.slice(1).reduce<Array<{ number: number; white?: GameNode; black?: GameNode }>>((rows, node) => { const index = Math.floor((node.ply - 1) / 2); rows[index] ??= { number: index + 1 }; if (node.ply % 2) rows[index].white = node; else rows[index].black = node; return rows; }, []).map((row) => <div key={row.number} className={row.white?.id === activeNode.id || row.black?.id === activeNode.id ? 'current-move' : ''}><span>{String(row.number).padStart(2, '0')}</span>{row.white ? <button onClick={() => void selectNode(row.white!.id)}>{row.white.san}</button> : <i />}{row.black ? <button onClick={() => void selectNode(row.black!.id)}>{row.black.san}</button> : <i />}</div>)}</div></section>
            {activeNode.annotations?.comment && <p className="node-comment">{activeNode.annotations.comment}</p>}
            <section className="engine-lines"><header><span>Lines</span><small>{engineLines.length} PV</small></header><div className="analysis-scroll">{engineLines.slice(0, 6).map((line) => <button key={`${line.multipv}-${line.move}`} onClick={() => void makeMove(line.move)}><strong>{lineSan(activeNode.fen, line.move)}</strong><span>{scoreLabel(line)}</span><small>{line.pv.slice(1, 5).join(' ')}</small></button>)}</div></section>
            <section className="continuations"><header><span>Legal moves</span><small>{candidates.length}</small></header><div className="analysis-scroll">{candidates.map((move, index) => { const uci = moveToUci(move); const analyzed = engineLines.find((line) => line.move === uci); return <button key={uci} onClick={() => void makeMove(uci)}><strong>{move.san}</strong><span>{analyzed ? scoreLabel(analyzed) : 'branch'}</span><i style={{ width: `${Math.max(8, 42 - index * 3)}%` }} /></button>; })}</div></section>
            <div className="analysis-actions"><Button variant="outline" onClick={exportPgn}><Download /> Export PGN</Button>{study.source.kind === 'seed' && <Button variant="ghost" onClick={() => startGeneration(studyRef.current!, false)}><RotateCcw /> Continue</Button>}</div>
          </aside>

          <section className="permutations-panel" aria-labelledby="permutations-title">
            <div className="graph-toolbar"><h2 id="permutations-title">Move permutations</h2><div className="graph-actions"><Button variant="ghost" size="sm" onClick={() => setGraphMode((value) => value === '3d' ? 'list' : '3d')}><ListTree /> {graphMode === '3d' ? '2D tree' : '3D view'}</Button><Button variant="ghost" size="icon-sm" aria-label="Fullscreen workspace" title="Fullscreen workspace" onClick={() => void workspace.current?.requestFullscreen()}><Maximize2 /></Button></div></div>
            <div className="permutations-view">{graphMode === '3d' ? <Suspense fallback={<div className="graph-loading">Mapping local branches…</div>}><PermutationsGraph nodes={treeNodes} activeId={activeNode.id} orientation={orientation} onSelect={selectNode} /></Suspense> : <AccessibleTree study={study} onSelect={(id) => void selectNode(id)} />}</div>
            <div className="graph-legend permutations-legend"><span><i className="white-edge" />White edge</span><span><i className="equal" />Balanced</span><span><i className="black-edge" />Black edge</span><strong>{Math.min(treeNodes.length, GRAPH_NODE_LIMIT).toLocaleString()} / {GRAPH_NODE_LIMIT.toLocaleString()}</strong></div>
          </section>
        </section>

      <Dialog open={importOpen} onOpenChange={setImportOpen}><DialogContent className="import-dialog"><DialogHeader><DialogTitle>Import a local study</DialogTitle><DialogDescription>FEN and one annotated PGN are validated entirely in this browser. Nothing is uploaded.</DialogDescription></DialogHeader><Tabs value={importKind} onValueChange={(value) => { setImportKind(value as 'fen' | 'pgn'); setImportError(''); }}><TabsList><TabsTrigger value="fen">FEN</TabsTrigger><TabsTrigger value="pgn">Annotated PGN</TabsTrigger></TabsList><TabsContent value="fen"><Textarea rows={5} value={importText} onChange={(event) => setImportText(event.target.value)} placeholder={START_FEN} aria-label="FEN position" /></TabsContent><TabsContent value="pgn"><Textarea rows={12} value={importText} onChange={(event) => setImportText(event.target.value)} placeholder={'[Event "Study"]\n\n1. e4 e5 2. Nf3 (2. Bc4) Nc6 *'} aria-label="Annotated PGN" /></TabsContent></Tabs>{importError && <p className="form-error" role="alert">{importError}</p>}<DialogFooter><Button variant="outline" onClick={() => setImportOpen(false)}>Cancel</Button><Button onClick={submitImport} disabled={!importText.trim()}>Validate and open</Button></DialogFooter></DialogContent></Dialog>

        <Dialog open={licensesOpen} onOpenChange={setLicensesOpen}><DialogContent className="license-dialog"><DialogHeader><DialogTitle>About chesspermutations</DialogTitle><DialogDescription>Games, positions, and Stockfish analysis stay in this browser. chesspermutations is GPLv3 software using the exact vendored builds below.</DialogDescription></DialogHeader><div className="license-list"><p><strong>chesspermutations</strong><br />GPLv3 · <a href="/chesspermutations-source-v1.zip" download>download this build’s source</a> · <a href="/SOURCE.txt" target="_blank">source notice</a></p><p><strong>Stockfish.js 18.0.8 lite single-thread</strong><br />GPLv3 · 30,000 nodes · Threads 1 · Hash 16 · <a href="https://github.com/nmrugg/stockfish.js/tree/93c994592dcf3b4b21052ab925e9b534df9c0918" target="_blank" rel="noreferrer">source and build instructions</a> · <a href="/stockfish/COPYING.txt" target="_blank">license</a></p><p><strong>Chessground 10.1.1</strong><br />GPL-3.0-or-later · <a href="https://github.com/lichess-org/chessground/tree/v10.1.1" target="_blank" rel="noreferrer">source</a> · <a href="/CHESSGROUND-LICENSE.txt" target="_blank">license</a></p></div><DialogFooter showCloseButton /></DialogContent></Dialog>
      </main>
      <Toaster />
    </>
  );
}

import type { Evaluation } from './contracts';
import { ENGINE_CONTRACT } from './contracts';
import { deterministicModulo } from './identity';

export interface AnalysisLine extends Evaluation {
  multipv: number;
  move: string;
  wdl?: EngineWdl;
}

export interface EngineWdl {
  win: number;
  draw: number;
  loss: number;
}

export function parseInfo(line: string): AnalysisLine | null {
  if (
    !line.startsWith('info ') ||
    !line.includes(' score ') ||
    !line.includes(' pv ')
  )
    return null;
  const depth = Number(line.match(/\bdepth (\d+)/)?.[1] ?? 0);
  const multipv = Number(line.match(/\bmultipv (\d+)/)?.[1] ?? 1);
  const score = line.match(/\bscore (cp|mate) (-?\d+)/);
  const nodes = Number(line.match(/\bnodes (\d+)/)?.[1] ?? 0);
  const wdl = line.match(/\bwdl (\d+) (\d+) (\d+)/);
  const pv =
    line
      .match(/\bpv (.+)$/)?.[1]
      .trim()
      .split(/\s+/) ?? [];
  if (!score || !pv[0]) return null;
  return {
    type: score[1] as 'cp' | 'mate',
    value: Number(score[2]),
    depth,
    nodes,
    pv,
    multipv,
    move: pv[0],
    ...(wdl
      ? {
          wdl: {
            win: Number(wdl[1]),
            draw: Number(wdl[2]),
            loss: Number(wdl[3]),
          },
        }
      : {}),
  };
}

export function scoreAsCentipawns(
  line: Pick<Evaluation, 'type' | 'value'>,
): number {
  if (line.type === 'cp') return line.value;
  return (
    Math.sign(line.value || 1) *
    (100_000 - Math.min(99_000, Math.abs(line.value) * 100))
  );
}

function candidateWeight(loss: number): number {
  if (loss <= 20) return 8;
  if (loss <= 50) return 4;
  if (loss <= 80) return 2;
  return 1;
}

export async function chooseSeededLine(
  lines: readonly AnalysisLine[],
  address: string,
  ply: number,
  nodeId: string,
): Promise<AnalysisLine> {
  if (!lines.length) throw new Error('The engine returned no candidate moves.');
  const sorted = [...lines].sort((left, right) => left.multipv - right.multipv);
  const best = Math.max(...sorted.map(scoreAsCentipawns));
  const candidates = sorted.flatMap((line) => {
    const loss = best - scoreAsCentipawns(line);
    return loss <= ENGINE_CONTRACT.candidateWindowCp
      ? [{ line, weight: candidateWeight(loss) }]
      : [];
  });
  const total = candidates.reduce(
    (sum, candidate) => sum + candidate.weight,
    0,
  );
  let ticket = await deterministicModulo([address, String(ply), nodeId], total);
  for (const candidate of candidates) {
    if (ticket < candidate.weight) return candidate.line;
    ticket -= candidate.weight;
  }
  return candidates[0]?.line ?? sorted[0];
}

interface PendingAnalysis {
  lines: Map<number, AnalysisLine>;
  resolve: (lines: AnalysisLine[]) => void;
  reject: (error: Error) => void;
  aborted: boolean;
}

export class StockfishClient {
  private worker: Worker | null = null;
  private initialization: Promise<void> | null = null;
  private waiters: Array<{
    match: (line: string) => boolean;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: number;
  }> = [];
  private pending: PendingAnalysis | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(line: string) => void>();

  onOutput(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(line: string): void {
    this.listeners.forEach((listener) => listener(line));
    for (const waiter of this.waiters.slice()) {
      if (!waiter.match(line)) continue;
      window.clearTimeout(waiter.timer);
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
    const info = parseInfo(line);
    if (info && this.pending) this.pending.lines.set(info.multipv, info);
    if (line.startsWith('bestmove ') && this.pending) {
      const pending = this.pending;
      this.pending = null;
      if (pending.aborted)
        pending.reject(new DOMException('Analysis cancelled', 'AbortError'));
      else
        pending.resolve(
          [...pending.lines.values()].sort(
            (left, right) => left.multipv - right.multipv,
          ),
        );
    }
  }

  private waitFor(
    match: (line: string) => boolean,
    timeoutMs = 60_000,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve, reject, timer: 0 };
      waiter.timer = window.setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new Error('The local engine did not become ready in time.'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async init(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      this.worker = new Worker('/stockfish/stockfish-18-lite-single.js');
      this.worker.onmessage = (event: MessageEvent<unknown>) => {
        if (typeof event.data === 'string') this.emit(event.data);
      };
      this.worker.onerror = () => {
        const error = new Error(
          'The local Stockfish engine could not start. Rules-only exploration is still available.',
        );
        this.pending?.reject(error);
        this.pending = null;
        this.waiters.splice(0).forEach((waiter) => waiter.reject(error));
      };
      const uciReady = this.waitFor((line) => line === 'uciok');
      this.worker.postMessage('uci');
      await uciReady;
      this.worker.postMessage('setoption name Threads value 1');
      this.worker.postMessage(
        `setoption name Hash value ${ENGINE_CONTRACT.hashMb}`,
      );
      this.worker.postMessage(
        `setoption name MultiPV value ${ENGINE_CONTRACT.multiPv}`,
      );
      this.worker.postMessage('setoption name UCI_ShowWDL value true');
      const ready = this.waitFor((line) => line === 'readyok');
      this.worker.postMessage('isready');
      await ready;
    })();
    return this.initialization;
  }

  analyze(
    rootFen: string,
    path: readonly string[],
    options: { nodes?: number; multiPv?: number; signal?: AbortSignal } = {},
  ): Promise<AnalysisLine[]> {
    const task = this.queue.then(async () => {
      await this.init();
      if (options.signal?.aborted)
        throw new DOMException('Analysis cancelled', 'AbortError');
      const worker = this.worker;
      if (!worker) throw new Error('The local engine is unavailable.');
      const result = new Promise<AnalysisLine[]>((resolve, reject) => {
        this.pending = { lines: new Map(), resolve, reject, aborted: false };
      });
      const abort = () => {
        if (this.pending) {
          this.pending.aborted = true;
          worker.postMessage('stop');
        }
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      const position = path.length
        ? `position fen ${rootFen} moves ${path.join(' ')}`
        : `position fen ${rootFen}`;
      worker.postMessage(
        `setoption name MultiPV value ${options.multiPv ?? ENGINE_CONTRACT.multiPv}`,
      );
      worker.postMessage(position);
      worker.postMessage(
        `go nodes ${options.nodes ?? ENGINE_CONTRACT.analysisNodes}`,
      );
      try {
        return await result;
      } finally {
        options.signal?.removeEventListener('abort', abort);
      }
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  stop(): void {
    if (this.pending && this.worker) {
      this.pending.aborted = true;
      this.worker.postMessage('stop');
    }
  }
  destroy(): void {
    this.worker?.postMessage('quit');
    this.worker?.terminate();
    this.worker = null;
    this.initialization = null;
  }
}

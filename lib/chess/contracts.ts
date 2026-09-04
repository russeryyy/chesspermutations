export const GAME_CONTRACT_VERSION = 'chess-game:v1' as const;
export const SHARE_VERSION = 1 as const;
export const GRAPH_NODE_LIMIT = 1_200;
export const PGN_IMPORT_LIMIT = 1_000_000;
export const PORTABLE_LINK_LIMIT = 12_000;

export type Orientation = 'white' | 'black';

export type StudySource =
  | { kind: 'seed'; address: string }
  | { kind: 'fen'; fen: string }
  | { kind: 'pgn'; pgn: string };

export interface Evaluation {
  type: 'cp' | 'mate';
  value: number;
  depth: number;
  nodes: number;
  pv: string[];
}

export interface NodeAnnotations {
  comment?: string;
  nags?: string[];
  arrows?: Array<{ color: string; from: string; to: string }>;
  squares?: Array<{ color: string; square: string }>;
  importedEvaluation?: Evaluation;
}

export interface GameNode {
  id: string;
  positionKey: string;
  parentId: string | null;
  children: string[];
  ply: number;
  san: string | null;
  uci: string | null;
  fen: string;
  path: string[];
  mainline: boolean;
  expanded: boolean;
  terminal?: string;
  evaluation?: Evaluation;
  annotations?: NodeAnnotations;
}

export interface StudyModel {
  version: 1;
  source: StudySource;
  rootFen: string;
  rootId: string;
  activeId: string;
  nodes: Record<string, GameNode>;
  mainline: string[];
  localTitle?: string;
  importedHeaders?: Record<string, string>;
  result?: string;
  termination?: string;
}

export interface EngineContract {
  version: typeof GAME_CONTRACT_VERSION;
  engine: 'Stockfish 18';
  build: '18.0.8-lite-single';
  threads: 1;
  hashMb: 16;
  multiPv: 6;
  generationNodes: 30_000;
  analysisNodes: 30_000;
  candidateWindowCp: 120;
  horizonPlies: 320;
}

export const ENGINE_CONTRACT: EngineContract = {
  version: GAME_CONTRACT_VERSION,
  engine: 'Stockfish 18',
  build: '18.0.8-lite-single',
  threads: 1,
  hashMb: 16,
  multiPv: 6,
  generationNodes: 30_000,
  analysisNodes: 30_000,
  candidateWindowCp: 120,
  horizonPlies: 320,
};

export interface ShareState {
  version: typeof SHARE_VERSION;
  source: StudySource;
  activePath: string[];
  orientation: Orientation;
}

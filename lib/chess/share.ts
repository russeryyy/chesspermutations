import { compressSync, decompressSync, strFromU8, strToU8 } from 'fflate';
import type { Orientation, ShareState, StudySource } from './contracts';
import { PORTABLE_LINK_LIMIT, SHARE_VERSION } from './contracts';

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeText(value: string, compress = false): string {
  const bytes = strToU8(value);
  return base64Url(compress ? compressSync(bytes, { level: 9 }) : bytes);
}

function decodeText(value: string, compressed = false): string {
  const bytes = fromBase64Url(value);
  return strFromU8(compressed ? decompressSync(bytes) : bytes);
}

export function shareHash(source: StudySource, activePath: readonly string[], orientation: Orientation): string {
  const params = new URLSearchParams({ v: String(SHARE_VERSION), o: orientation === 'black' ? 'b' : 'w' });
  if (source.kind === 'seed') params.set('s', source.address);
  if (source.kind === 'fen') params.set('f', encodeText(source.fen));
  if (source.kind === 'pgn') params.set('p', encodeText(source.pgn, true));
  if (activePath.length) params.set('m', activePath.join('.'));
  const hash = `#${params.toString()}`;
  if (source.kind === 'pgn' && hash.length > PORTABLE_LINK_LIMIT) throw new Error('This annotated PGN is too large for a portable link. Download the PGN instead.');
  return hash;
}

export function readShareHash(hash: string): ShareState | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (params.get('v') !== String(SHARE_VERSION)) return null;
  let source: StudySource | null = null;
  if (params.get('s')) source = { kind: 'seed', address: params.get('s')! };
  else if (params.get('f')) source = { kind: 'fen', fen: decodeText(params.get('f')!) };
  else if (params.get('p')) source = { kind: 'pgn', pgn: decodeText(params.get('p')!, true) };
  if (!source) return null;
  const activePath = params.get('m')?.split('.').filter(Boolean) ?? [];
  return { version: SHARE_VERSION, source, activePath, orientation: params.get('o') === 'b' ? 'black' : 'white' };
}

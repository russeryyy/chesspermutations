import { GAME_CONTRACT_VERSION } from './contracts';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = BigInt(0);
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function encodeBase62(value: bigint): string {
  if (value === BigInt(0)) return '0';
  let encoded = '';
  while (value > BigInt(0)) {
    encoded = BASE62[Number(value % BigInt(62))] + encoded;
    value /= BigInt(62);
  }
  return encoded;
}

export async function digestBytes(value: string): Promise<Uint8Array> {
  const input = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

export async function digestAddress(value: string): Promise<string> {
  return encodeBase62(bytesToBigInt(await digestBytes(value)));
}

export async function phraseAddress(phrase: string): Promise<string> {
  const normalized = phrase.trim().normalize('NFC');
  if (!normalized) throw new Error('Enter a phrase.');
  if (normalized.length > 512) throw new Error('Phrases are limited to 512 characters.');
  return digestAddress(`${GAME_CONTRACT_VERSION}\0phrase\0${normalized}`);
}

export async function nodeIdentity(rootFen: string, path: readonly string[]): Promise<string> {
  return digestAddress(`${GAME_CONTRACT_VERSION}\0node\0${rootFen}\0${path.join(' ')}`);
}

export async function positionIdentity(fen: string): Promise<string> {
  return digestAddress(`${GAME_CONTRACT_VERSION}\0position\0${fen.split(/\s+/).slice(0, 4).join(' ')}`);
}

export async function deterministicModulo(parts: readonly string[], modulo: number): Promise<number> {
  if (modulo <= 0) return 0;
  const bytes = await digestBytes(`${GAME_CONTRACT_VERSION}\0choice\0${parts.join('\0')}`);
  let value = BigInt(0);
  for (let index = 0; index < 8; index += 1) value = (value << 8n) | BigInt(bytes[index]);
  return Number(value % BigInt(modulo));
}

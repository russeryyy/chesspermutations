import { ENGINE_CONTRACT } from './contracts';

export interface Adjudication { result: '1-0' | '0-1' | '1/2-1/2'; reason: string; }

export function adjudicate(evaluations: readonly number[], ply: number): Adjudication | null {
  if (ply >= 40 && evaluations.length >= 8) {
    const tail = evaluations.slice(-8);
    if (tail.every((score) => score >= 700)) return { result: '1-0', reason: 'engine adjudication · sustained +7.00' };
    if (tail.every((score) => score <= -700)) return { result: '0-1', reason: 'engine adjudication · sustained −7.00' };
  }
  if (ply >= 80 && evaluations.length >= 20 && evaluations.slice(-20).every((score) => Math.abs(score) <= 20)) return { result: '1/2-1/2', reason: 'engine adjudication · sustained equality' };
  if (ply >= ENGINE_CONTRACT.horizonPlies) return { result: '1/2-1/2', reason: 'generation horizon · 320 plies' };
  return null;
}

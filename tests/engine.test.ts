import { describe, expect, it } from 'vitest';
import { chooseSeededLine, type AnalysisLine } from '@/lib/chess/engine';

const lines: AnalysisLine[] = [
  { multipv: 1, move: 'e2e4', type: 'cp', value: 30, depth: 10, nodes: 30_000, pv: ['e2e4'] },
  { multipv: 2, move: 'd2d4', type: 'cp', value: 12, depth: 10, nodes: 30_000, pv: ['d2d4'] },
  { multipv: 3, move: 'g1f3', type: 'cp', value: -70, depth: 10, nodes: 30_000, pv: ['g1f3'] },
  { multipv: 4, move: 'a2a3', type: 'cp', value: -200, depth: 10, nodes: 30_000, pv: ['a2a3'] },
];

describe('deterministic candidate policy', () => {
  it('chooses the same weighted candidate independently for a node', async () => {
    const first = await chooseSeededLine(lines, 'address', 0, 'node');
    const second = await chooseSeededLine([...lines].reverse(), 'address', 0, 'node');
    expect(second.move).toBe(first.move);
    expect(first.move).not.toBe('a2a3');
  });
});

import type { GameNode } from './contracts';

export interface PreviewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PreviewPoint {
  left: number;
  top: number;
}

function overlapArea(left: PreviewRect, right: PreviewRect): number {
  const width = Math.max(0, Math.min(left.left + left.width, right.left + right.width) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.top + left.height, right.top + right.height) - Math.max(left.top, right.top));
  return width * height;
}

export function placeNodePreview(
  pointer: { x: number; y: number },
  bounds: { width: number; height: number },
  size: { width: number; height: number },
  avoid: readonly PreviewRect[] = [],
  margin = 12,
  gap = 16,
): PreviewPoint {
  const maximumLeft = Math.max(margin, bounds.width - size.width - margin);
  const maximumTop = Math.max(margin, bounds.height - size.height - margin);
  const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
  const candidates = [
    { left: pointer.x + gap, top: pointer.y + gap },
    { left: pointer.x - size.width - gap, top: pointer.y + gap },
    { left: pointer.x + gap, top: pointer.y - size.height - gap },
    { left: pointer.x - size.width - gap, top: pointer.y - size.height - gap },
  ].map((candidate) => ({
    left: clamp(candidate.left, margin, maximumLeft),
    top: clamp(candidate.top, margin, maximumTop),
  }));

  return candidates
    .map((candidate, index) => ({
      ...candidate,
      score: avoid.reduce((total, rect) => total + overlapArea({ ...candidate, ...size }, rect), 0) + index * .01,
    }))
    .sort((left, right) => left.score - right.score)[0];
}

export function ancestorSanTrail(nodes: readonly GameNode[], nodeId: string, limit = 4): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const trail: string[] = [];
  let node = byId.get(nodeId);
  while (node && trail.length < limit) {
    if (node.san) trail.push(node.san);
    node = node.parentId ? byId.get(node.parentId) : undefined;
  }
  return trail.reverse();
}

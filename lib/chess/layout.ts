import type { GameNode } from './contracts';

export interface GraphPoint {
  id: string;
  x: number;
  y: number;
  z: number;
}

export function visibleGameTree(
  nodes: readonly GameNode[],
  activeId: string,
  limit = 1_200,
): GameNode[] {
  if (nodes.length <= limit) return [...nodes];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const active = byId.get(activeId) ?? nodes[0];
  const retained = new Set<string>();
  const retainWithAncestors = (id: string) => {
    let node = byId.get(id);
    while (node && retained.size < limit) {
      retained.add(node.id);
      node = node.parentId ? byId.get(node.parentId) : undefined;
    }
  };
  retainWithAncestors(active.id);
  for (const node of nodes) if (node.mainline) retainWithAncestors(node.id);
  for (const id of [active.parentId, ...active.children].filter(
    (value): value is string => Boolean(value),
  ))
    retainWithAncestors(id);
  if (active.parentId)
    for (const id of byId.get(active.parentId)?.children ?? [])
      retainWithAncestors(id);
  const nearest = [...nodes].sort(
    (left, right) =>
      Math.abs(left.ply - active.ply) - Math.abs(right.ply - active.ply) ||
      left.id.localeCompare(right.id),
  );
  for (const node of nearest) {
    if (retained.size >= limit) break;
    retainWithAncestors(node.id);
  }
  return nodes.filter((node) => retained.has(node.id)).slice(0, limit);
}

function hash32(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function ancestry(nodes: readonly GameNode[], activeId: string): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path = new Set<string>();
  let node = byId.get(activeId);
  while (node) {
    path.add(node.id);
    node = node.parentId ? byId.get(node.parentId) : undefined;
  }
  return path;
}

export function layoutGameTree(
  nodes: readonly GameNode[],
  activeId = nodes.find(
    (node) =>
      node.mainline &&
      !node.children.some((id) =>
        nodes.some((candidate) => candidate.id === id && candidate.mainline),
      ),
  )?.id ??
    nodes[0]?.id ??
    '',
): GraphPoint[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const selectedPath = ancestry(nodes, activeId);
  const positions = new Map<string, GraphPoint>();
  const ordered = [...nodes].sort(
    (left, right) => left.ply - right.ply || left.id.localeCompare(right.id),
  );
  for (const node of ordered) {
    if (!node.parentId || !byId.has(node.parentId)) {
      positions.set(node.id, { id: node.id, x: 0, y: 0, z: 0 });
      continue;
    }
    if (selectedPath.has(node.id)) {
      const angle = node.ply * 0.54;
      const radius =
        node.ply === 0 ? 0 : 0.78 + Math.min(1.2, node.ply * 0.018);
      positions.set(node.id, {
        id: node.id,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        z: -node.ply * 9,
      });
      continue;
    }
    const parent = positions.get(node.parentId) ?? {
      id: node.parentId,
      x: 0,
      y: 0,
      z: 0,
    };
    const siblings =
      byId.get(node.parentId)?.children.filter((id) => byId.has(id)) ?? [];
    const index = Math.max(0, siblings.indexOf(node.id));
    const base =
      (hash32(`${node.parentId}:${node.id}`) / 0xffffffff) * Math.PI * 2;
    const angle = base + index * 2.399963229728653;
    const spread = 4.8 + Math.sqrt(index + 1) * 1.7;
    const depthDamping = selectedPath.has(node.parentId) ? 1 : 0.92;
    positions.set(node.id, {
      id: node.id,
      x: parent.x * depthDamping + Math.cos(angle) * spread,
      y: parent.y * depthDamping + Math.sin(angle) * spread,
      z: -node.ply * 9,
    });
  }
  return ordered.map((node) => positions.get(node.id)!);
}

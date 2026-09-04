export interface GraphHitTarget {
  id: string;
  x: number;
  y: number;
  radius: number;
  depth: number;
}

/** Selects the closest visible billboard token under a screen-space pointer. */
export function graphNodeAt(
  targets: readonly GraphHitTarget[],
  x: number,
  y: number,
): string | null {
  let best: GraphHitTarget | undefined;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const target of targets) {
    const radius = Math.max(1, target.radius);
    const distance = Math.hypot(x - target.x, y - target.y);
    if (distance > radius) continue;
    const score = distance / radius;
    if (
      score < bestScore - 0.0001 ||
      (Math.abs(score - bestScore) <= 0.0001 &&
        (!best ||
          target.depth < best.depth ||
          (target.depth === best.depth &&
            target.id.localeCompare(best.id) < 0)))
    ) {
      best = target;
      bestScore = score;
    }
  }

  return best?.id ?? null;
}

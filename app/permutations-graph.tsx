'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { Chessground } from '@lichess-org/chessground';
import type { Key } from '@lichess-org/chessground/types';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Evaluation, GameNode, Orientation } from '@/lib/chess/contracts';
import { layoutGameTree, visibleGameTree } from '@/lib/chess/layout';
import { ancestorSanTrail, placeNodePreview, type PreviewRect } from '@/lib/chess/preview';

interface PermutationsGraphProps {
  nodes: GameNode[];
  activeId: string;
  orientation: Orientation;
  onSelect: (id: string) => void;
}

interface HoveredNode {
  id: string;
  left: number;
  top: number;
}

function scoreLabel(evaluation?: Pick<Evaluation, 'type' | 'value'>): string {
  if (!evaluation) return 'Not analyzed';
  if (evaluation.type === 'mate') return evaluation.value > 0 ? `Mate ${evaluation.value}` : `Mate −${Math.abs(evaluation.value)}`;
  const value = evaluation.value / 100;
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`;
}

function moveLabel(node: GameNode): string {
  if (!node.ply) return 'Starting position';
  const number = Math.ceil(node.ply / 2);
  return `${number}${node.ply % 2 ? '.' : '…'} ${node.san ?? node.uci ?? 'Move'}`;
}

function nodeColor(node: GameNode, active: boolean): THREE.Color {
  if (active) return new THREE.Color('#efb25d');
  if (node.terminal) return new THREE.Color('#ef756f');
  const evaluation = node.evaluation ?? node.annotations?.importedEvaluation;
  if (!evaluation) return new THREE.Color(node.mainline ? '#78ddd0' : '#496b70');
  const score = evaluation.type === 'mate' ? Math.sign(evaluation.value) * 1_000 : evaluation.value;
  if (score > 80) return new THREE.Color('#d8f4ee');
  if (score < -80) return new THREE.Color('#ee9b61');
  return new THREE.Color('#78ddd0');
}

const PositionPreview = memo(function PositionPreview({ node, orientation }: { node: GameNode; orientation: Orientation }) {
  const mount = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mount.current) return;
    const board = Chessground(mount.current, {
      fen: node.fen,
      orientation,
      coordinates: false,
      viewOnly: true,
      lastMove: node.uci ? [node.uci.slice(0, 2) as Key, node.uci.slice(2, 4) as Key] : undefined,
      animation: { enabled: false },
      drawable: { enabled: false, visible: false },
    });
    return () => board.destroy();
  }, [node, orientation]);

  return <div ref={mount} className="cg-wrap graph-preview-board" aria-hidden="true" />;
});

export function PermutationsGraph({ nodes, activeId, orientation, onSelect }: PermutationsGraphProps) {
  const mount = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const latest = useRef({ nodes, activeId, orientation, onSelect });
  const rebuild = useRef<(() => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<HoveredNode | null>(null);

  useEffect(() => {
    latest.current = { nodes, activeId, orientation, onSelect };
  }, [nodes, activeId, orientation, onSelect]);

  useEffect(() => {
    rebuild.current?.();
  }, [nodes, activeId]);

  useEffect(() => {
    const host = mount.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' }); }
    catch { queueMicrotask(() => setError('WebGL is unavailable. Use the accessible tree list instead.')); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor(0x080d12, 0);
    renderer.domElement.setAttribute('aria-label', 'Interactive three-dimensional chess variation tree');
    renderer.domElement.setAttribute('role', 'img');
    renderer.domElement.style.cursor = 'grab';
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x080d12, 0.0038);
    const camera = new THREE.PerspectiveCamera(48, 1, .1, 2_000);
    camera.position.set(34, 28, 66);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    controls.dampingFactor = .065;
    controls.minDistance = 12;
    controls.maxDistance = 210;
    controls.target.set(0, 0, -24);

    const grid = new THREE.GridHelper(260, 26, 0x24434a, 0x13242a);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -90;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = .28;
    scene.add(grid);

    let mesh: THREE.InstancedMesh | null = null;
    let edges: THREE.LineSegments | null = null;
    let terminalMesh: THREE.InstancedMesh | null = null;
    let activeRing: THREE.Mesh | null = null;
    let hoverRing: THREE.Mesh | null = null;
    let nodeIds: string[] = [];
    let pointById = new Map<string, { x: number; y: number; z: number }>();
    const activeTarget = new THREE.Vector3(0, 0, -24);
    const cameraTarget = new THREE.Vector3(34, 28, 66);
    let cameraTransitionFrames = 0;
    let hoverTimer = 0;
    let hoverFrame = 0;
    let pendingHoverId: string | null = null;
    let visibleHoverId: string | null = null;
    let pointerDown: { x: number; y: number } | null = null;
    let pointerMoved = false;

    const clearHover = (updateState = true) => {
      window.clearTimeout(hoverTimer);
      pendingHoverId = null;
      visibleHoverId = null;
      if (hoverRing) hoverRing.visible = false;
      renderer.domElement.style.cursor = pointerDown ? 'grabbing' : 'grab';
      if (updateState) setHovered(null);
    };

    const disposeGraph = () => {
      if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); mesh = null; }
      if (edges) { scene.remove(edges); edges.geometry.dispose(); (edges.material as THREE.Material).dispose(); edges = null; }
      if (terminalMesh) { scene.remove(terminalMesh); terminalMesh.geometry.dispose(); (terminalMesh.material as THREE.Material).dispose(); terminalMesh = null; }
      if (activeRing) { scene.remove(activeRing); activeRing.geometry.dispose(); (activeRing.material as THREE.Material).dispose(); activeRing = null; }
      if (hoverRing) { scene.remove(hoverRing); hoverRing.geometry.dispose(); (hoverRing.material as THREE.Material).dispose(); hoverRing = null; }
    };

    rebuild.current = () => {
      clearHover();
      disposeGraph();
      const visible = visibleGameTree(latest.current.nodes, latest.current.activeId, 1_200);
      const points = layoutGameTree(visible);
      pointById = new Map(points.map((point) => [point.id, point]));
      nodeIds = visible.map((node) => node.id);
      const geometry = new THREE.SphereGeometry(1, 12, 8);
      const material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: .96 });
      mesh = new THREE.InstancedMesh(geometry, material, visible.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const matrix = new THREE.Matrix4();
      visible.forEach((node, index) => {
        const point = pointById.get(node.id)!;
        const scale = node.id === latest.current.activeId ? 1.85 : node.mainline ? 1.18 : .82;
        matrix.compose(new THREE.Vector3(point.x, point.y, point.z), new THREE.Quaternion(), new THREE.Vector3(scale, scale, scale));
        mesh!.setMatrixAt(index, matrix);
        mesh!.setColorAt(index, nodeColor(node, node.id === latest.current.activeId));
        if (node.id === latest.current.activeId) {
          activeTarget.set(point.x, point.y, point.z);
          cameraTarget.set(point.x + 34, point.y + 28, point.z + 66);
          if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
            controls.target.copy(activeTarget);
            camera.position.copy(cameraTarget);
            cameraTransitionFrames = 0;
          } else cameraTransitionFrames = 54;
        }
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      scene.add(mesh);

      const terminals = visible.filter((node) => node.terminal);
      if (terminals.length) {
        terminalMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(2.4, 2.4, 2.4), new THREE.MeshBasicMaterial({ color: 0xef756f, wireframe: true }), terminals.length);
        terminals.forEach((node, index) => {
          const point = pointById.get(node.id)!;
          matrix.makeTranslation(point.x, point.y, point.z);
          terminalMesh!.setMatrixAt(index, matrix);
        });
        terminalMesh.instanceMatrix.needsUpdate = true;
        scene.add(terminalMesh);
      }

      activeRing = new THREE.Mesh(new THREE.TorusGeometry(2.35, .18, 6, 18), new THREE.MeshBasicMaterial({ color: 0xffd99d }));
      activeRing.position.copy(activeTarget);
      scene.add(activeRing);
      hoverRing = new THREE.Mesh(new THREE.TorusGeometry(1.75, .12, 6, 18), new THREE.MeshBasicMaterial({ color: 0x8bf0e2 }));
      hoverRing.visible = false;
      scene.add(hoverRing);

      const segments: THREE.Vector3[] = [];
      visible.forEach((node) => {
        if (!node.parentId) return;
        const from = pointById.get(node.parentId);
        const to = pointById.get(node.id);
        if (from && to) segments.push(new THREE.Vector3(from.x, from.y, from.z), new THREE.Vector3(to.x, to.y, to.z));
      });
      const edgeGeometry = new THREE.BufferGeometry().setFromPoints(segments);
      const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x5a9093, transparent: true, opacity: .36 });
      edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
      scene.add(edges);
    };
    rebuild.current();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const hitAt = (clientX: number, clientY: number): string | null => {
      if (!mesh) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(mesh)[0];
      return hit?.instanceId === undefined ? null : nodeIds[hit.instanceId] ?? null;
    };

    const previewPosition = (clientX: number, clientY: number) => {
      const hostRect = host.getBoundingClientRect();
      const workspace = host.closest('.workspace');
      const avoid: PreviewRect[] = [];
      for (const element of workspace?.querySelectorAll('.board-panel, .analysis-panel, .graph-toolbar, .graph-legend') ?? []) {
        const rect = element.getBoundingClientRect();
        avoid.push({ left: rect.left - hostRect.left, top: rect.top - hostRect.top, width: rect.width, height: rect.height });
      }
      return placeNodePreview(
        { x: clientX - hostRect.left, y: clientY - hostRect.top },
        { width: hostRect.width, height: hostRect.height },
        { width: preview.current?.offsetWidth || 228, height: preview.current?.offsetHeight || 310 },
        avoid,
      );
    };

    const positionVisiblePreview = (clientX: number, clientY: number) => {
      if (!preview.current) return;
      const position = previewPosition(clientX, clientY);
      preview.current.style.left = `${position.left}px`;
      preview.current.style.top = `${position.top}px`;
    };

    const updateHover = (clientX: number, clientY: number) => {
      const id = hitAt(clientX, clientY);
      renderer.domElement.style.cursor = id ? 'pointer' : 'grab';
      if (!id) { clearHover(); return; }
      const point = pointById.get(id);
      if (point && hoverRing) {
        hoverRing.position.set(point.x, point.y, point.z);
        hoverRing.visible = id !== latest.current.activeId;
      }
      if (id === visibleHoverId) {
        positionVisiblePreview(clientX, clientY);
        return;
      }
      if (id === pendingHoverId) return;
      window.clearTimeout(hoverTimer);
      pendingHoverId = id;
      hoverTimer = window.setTimeout(() => {
        pendingHoverId = null;
        visibleHoverId = id;
        const position = previewPosition(clientX, clientY);
        setHovered({ id, ...position });
      }, 90);
    };

    const onPointerDown = (event: PointerEvent) => {
      pointerDown = { x: event.clientX, y: event.clientY };
      pointerMoved = false;
      clearHover();
      renderer.domElement.style.cursor = 'grabbing';
    };
    const onPointerMove = (event: PointerEvent) => {
      if (pointerDown && Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 5) pointerMoved = true;
      if (event.pointerType === 'touch' || event.buttons !== 0) return;
      cancelAnimationFrame(hoverFrame);
      hoverFrame = requestAnimationFrame(() => updateHover(event.clientX, event.clientY));
    };
    const onPointerUp = (event: PointerEvent) => {
      const shouldSelect = Boolean(pointerDown && !pointerMoved);
      pointerDown = null;
      renderer.domElement.style.cursor = 'grab';
      if (shouldSelect) {
        const id = hitAt(event.clientX, event.clientY);
        if (id) latest.current.onSelect(id);
      }
      if (event.pointerType !== 'touch') updateHover(event.clientX, event.clientY);
    };
    const onPointerLeave = () => {
      pointerDown = null;
      pointerMoved = false;
      clearHover();
    };
    const onControlsStart = () => clearHover();
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointercancel', onPointerLeave);
    renderer.domElement.addEventListener('pointerleave', onPointerLeave);
    controls.addEventListener('start', onControlsStart);
    const lost = (event: Event) => { event.preventDefault(); setError('The 3D context was lost. The tree list remains available.'); };
    renderer.domElement.addEventListener('webglcontextlost', lost);

    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      if (cameraTransitionFrames > 0) {
        controls.target.lerp(activeTarget, .075);
        camera.position.lerp(cameraTarget, .065);
        cameraTransitionFrames -= 1;
      }
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(hoverFrame);
      window.clearTimeout(hoverTimer);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointercancel', onPointerLeave);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      controls.removeEventListener('start', onControlsStart);
      controls.dispose();
      disposeGraph();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.domElement.remove();
      rebuild.current = null;
      clearHover(false);
    };
  }, []);

  const hoveredNode = hovered ? nodes.find((node) => node.id === hovered.id) : undefined;
  const trail = hoveredNode ? ancestorSanTrail(nodes, hoveredNode.id) : [];
  const evaluation = hoveredNode?.evaluation ?? hoveredNode?.annotations?.importedEvaluation;

  return (
    <div className="graph-surface">
      <div ref={mount} className="permutations-canvas" />
      {hovered && hoveredNode && (
        <div ref={preview} className="node-preview" role="tooltip" style={{ left: hovered.left, top: hovered.top }}>
          <PositionPreview node={hoveredNode} orientation={orientation} />
          <div className="node-preview-copy">
            <div><strong>{moveLabel(hoveredNode)}</strong><span>{scoreLabel(evaluation)}</span></div>
            {trail.length > 0 && <p>{trail.join('  ')}</p>}
            <small>{hoveredNode.terminal ?? (hoveredNode.mainline ? 'Main line' : `Branch · ply ${hoveredNode.ply}`)}</small>
          </div>
        </div>
      )}
      {error && <p className="canvas-error" role="alert">{error}</p>}
    </div>
  );
}

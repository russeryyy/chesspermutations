'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { GameNode } from '@/lib/chess/contracts';
import { layoutGameTree, visibleGameTree } from '@/lib/chess/layout';

interface UniverseGraphProps {
  nodes: GameNode[];
  activeId: string;
  onSelect: (id: string) => void;
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

export function UniverseGraph({ nodes, activeId, onSelect }: UniverseGraphProps) {
  const mount = useRef<HTMLDivElement>(null);
  const latest = useRef({ nodes, activeId, onSelect });
  const rebuild = useRef<(() => void) | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    latest.current = { nodes, activeId, onSelect };
    rebuild.current?.();
  }, [nodes, activeId, onSelect]);

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
    let nodeIds: string[] = [];
    const activeTarget = new THREE.Vector3(0, 0, -24);
    const cameraTarget = new THREE.Vector3(34, 28, 66);
    let cameraTransitionFrames = 0;

    const disposeGraph = () => {
      if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); mesh = null; }
      if (edges) { scene.remove(edges); edges.geometry.dispose(); (edges.material as THREE.Material).dispose(); edges = null; }
      if (terminalMesh) { scene.remove(terminalMesh); terminalMesh.geometry.dispose(); (terminalMesh.material as THREE.Material).dispose(); terminalMesh = null; }
      if (activeRing) { scene.remove(activeRing); activeRing.geometry.dispose(); (activeRing.material as THREE.Material).dispose(); activeRing = null; }
    };

    rebuild.current = () => {
      disposeGraph();
      const visible = visibleGameTree(latest.current.nodes, latest.current.activeId, 1_200);
      const points = layoutGameTree(visible);
      const byPoint = new Map(points.map((point) => [point.id, point]));
      nodeIds = visible.map((node) => node.id);
      const geometry = new THREE.SphereGeometry(1, 12, 8);
      const material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: .96 });
      mesh = new THREE.InstancedMesh(geometry, material, visible.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const matrix = new THREE.Matrix4();
      visible.forEach((node, index) => {
        const point = byPoint.get(node.id)!;
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
          const point = byPoint.get(node.id)!;
          matrix.makeTranslation(point.x, point.y, point.z);
          terminalMesh!.setMatrixAt(index, matrix);
        });
        terminalMesh.instanceMatrix.needsUpdate = true;
        scene.add(terminalMesh);
      }

      activeRing = new THREE.Mesh(new THREE.TorusGeometry(2.35, .18, 6, 18), new THREE.MeshBasicMaterial({ color: 0xffd99d }));
      activeRing.position.copy(activeTarget);
      scene.add(activeRing);

      const segments: THREE.Vector3[] = [];
      visible.forEach((node) => {
        if (!node.parentId) return;
        const from = byPoint.get(node.parentId);
        const to = byPoint.get(node.id);
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
    const select = (event: PointerEvent) => {
      if (!mesh) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(mesh)[0];
      if (hit?.instanceId !== undefined) latest.current.onSelect(nodeIds[hit.instanceId]);
    };
    renderer.domElement.addEventListener('pointerup', select);
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
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerup', select);
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      controls.dispose();
      disposeGraph();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.domElement.remove();
      rebuild.current = null;
    };
  }, []);

  return <div ref={mount} className="universe-canvas">{error && <p className="canvas-error" role="alert">{error}</p>}</div>;
}

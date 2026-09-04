'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { Chessground } from '@lichess-org/chessground';
import type { Key } from '@lichess-org/chessground/types';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type {
  GameNode,
  Orientation,
  WinProbability,
} from '@/lib/chess/contracts';
import {
  deriveGraphMoveVisual,
  leaderProbabilityLabel,
  probabilityDetailLabel,
  terminalProbability,
  type GraphMoveVisual,
} from '@/lib/chess/graph-visuals';
import { layoutGameTree, visibleGameTree } from '@/lib/chess/layout';
import {
  ancestorSanTrail,
  placeNodePreview,
  type PreviewRect,
} from '@/lib/chess/preview';

interface PermutationsGraphProps {
  nodes: GameNode[];
  activeId: string;
  orientation: Orientation;
  probabilities: Readonly<Record<string, WinProbability>>;
  analysisUnavailable?: boolean;
  onSelect: (id: string) => void;
}

interface HoveredNode {
  id: string;
  left: number;
  top: number;
}
interface LabelProjection {
  element: HTMLDivElement;
  point: THREE.Vector3;
  priority: number;
}

const PIECE_INDEX: Record<GraphMoveVisual['piece'], number> = {
  p: 0,
  n: 1,
  b: 2,
  r: 3,
  q: 4,
  k: 5,
  root: 6,
};
const WHITE_MOVE = new THREE.Color('#d9fff7');
const BLACK_MOVE = new THREE.Color('#f0ad63');
const PIECE_ATLAS = new THREE.TextureLoader().load('/graph-piece-atlas.svg');
PIECE_ATLAS.minFilter = THREE.LinearFilter;
PIECE_ATLAS.magFilter = THREE.LinearFilter;
PIECE_ATLAS.colorSpace = THREE.SRGBColorSpace;

function moveLabel(node: GameNode): string {
  if (!node.ply) return 'Starting position';
  const number = Math.ceil(node.ply / 2);
  return `${number}${node.ply % 2 ? '.' : '…'} ${node.san ?? node.uci ?? 'Move'}`;
}

function selectedAncestry(
  nodes: readonly GameNode[],
  activeId: string,
): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ids = new Set<string>();
  let node = byId.get(activeId);
  while (node) {
    ids.add(node.id);
    node = node.parentId ? byId.get(node.parentId) : undefined;
  }
  return ids;
}

function pieceIndex(visual: GraphMoveVisual): number {
  return PIECE_INDEX[visual.promotedPiece ?? visual.piece];
}
function eventVector(
  visual: GraphMoveVisual,
): [number, number, number, number] {
  return [
    visual.capture ? 1 : 0,
    visual.check ? 1 : 0,
    visual.mate ? 1 : 0,
    visual.terminalDraw ? 1 : 0,
  ];
}

const PositionPreview = memo(function PositionPreview({
  node,
  orientation,
}: {
  node: GameNode;
  orientation: Orientation;
}) {
  const mount = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!mount.current) return;
    const board = Chessground(mount.current, {
      fen: node.fen,
      orientation,
      coordinates: false,
      viewOnly: true,
      lastMove: node.uci
        ? [node.uci.slice(0, 2) as Key, node.uci.slice(2, 4) as Key]
        : undefined,
      animation: { enabled: false },
      drawable: { enabled: false, visible: false },
    });
    return () => board.destroy();
  }, [node, orientation]);
  return (
    <div
      ref={mount}
      className="cg-wrap graph-preview-board"
      aria-hidden="true"
    />
  );
});

function tokenMaterial(): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { pieceAtlas: { value: PIECE_ATLAS } },
    vertexShader: `
      attribute float aPiece; attribute float aSide; attribute vec3 aWdl; attribute vec4 aEvent; attribute vec4 aMisc;
      varying vec2 vUv; varying float vPiece; varying float vSide; varying vec3 vWdl; varying vec4 vEvent; varying vec4 vMisc;
      void main() {
        vUv=uv; vPiece=aPiece; vSide=aSide; vWdl=aWdl; vEvent=aEvent; vMisc=aMisc;
        vec4 center=modelViewMatrix*instanceMatrix*vec4(0.0,0.0,0.0,1.0);
        float scale=length(instanceMatrix[0].xyz); center.xy+=position.xy*scale; gl_Position=projectionMatrix*center;
      }`,
    fragmentShader: `
      uniform sampler2D pieceAtlas;
      varying vec2 vUv; varying float vPiece; varying float vSide; varying vec3 vWdl; varying vec4 vEvent; varying vec4 vMisc;
      float lineMask(float value,float target,float width){return 1.0-smoothstep(width,width+0.012,abs(value-target));}
      void main(){
        vec2 p=vUv-0.5; float radius=length(p);
        vec3 whiteMove=vec3(0.79,1.0,0.96); vec3 blackMove=vec3(0.95,0.62,0.31);
        vec3 moveColor=vSide<0.5?vec3(0.55,0.93,0.88):(vSide<1.5?whiteMove:blackMove);
        vec3 color=vec3(0.0); float alpha=0.0;
        float focusGlow=(1.0-smoothstep(0.30,0.40,radius))*vMisc.z; color+=moveColor*focusGlow*0.35; alpha=max(alpha,focusGlow*0.62);
        float body=1.0-smoothstep(0.295,0.31,radius); color+=mix(vec3(0.045,0.075,0.09),moveColor*0.18,vSide<0.5?0.3:0.58)*body; alpha=max(alpha,body*0.96);
        float wdlTotal=vWdl.x+vWdl.y+vWdl.z; float angle=fract((atan(p.y,p.x)+3.14159265)/6.2831853); vec3 haloColor=vec3(0.32,0.48,0.51);
        if(wdlTotal>0.5) haloColor=angle<vWdl.x?vec3(0.80,1.0,0.95):(angle<vWdl.x+vWdl.y?vec3(0.47,0.59,0.62):vec3(0.96,0.57,0.26));
        else if(mod(floor(angle*24.0),2.0)<1.0) haloColor*=0.28;
        float halo=(1.0-smoothstep(0.485,0.5,radius))*smoothstep(0.405,0.423,radius); color=mix(color,haloColor,halo); alpha=max(alpha,halo*(wdlTotal>0.5?0.98:0.55));
        vec2 atlasUv=vec2((clamp(vUv.x,0.08,0.92)+floor(vPiece+0.5))/7.0,clamp(vUv.y,0.08,0.92)); vec4 piece=texture2D(pieceAtlas,atlasUv);
        float pieceMask=piece.a*smoothstep(0.13,0.22,vUv.x)*smoothstep(0.13,0.22,vUv.y)*smoothstep(0.13,0.22,1.0-vUv.x)*smoothstep(0.13,0.22,1.0-vUv.y);
        color=mix(color,moveColor,pieceMask); alpha=max(alpha,pieceMask);
        float eventAlpha=0.0;
        if(vEvent.x>0.5) eventAlpha=max(eventAlpha,lineMask(abs(p.x)+abs(p.y),0.57,0.016));
        if(vEvent.y>0.5){float spike=max(abs(p.x),abs(p.y))+min(abs(p.x),abs(p.y))*0.34; eventAlpha=max(eventAlpha,lineMask(spike,0.54,0.018));}
        if(vEvent.z>0.5){float a=atan(p.y,p.x)*4.0; float star=radius*(1.0+0.18*cos(a)); eventAlpha=max(eventAlpha,lineMask(star,0.53,0.022));}
        if(vEvent.w>0.5) eventAlpha=max(eventAlpha,lineMask(max(abs(p.x),abs(p.y)),0.49,0.017));
        if(vMisc.x>0.5) eventAlpha=max(eventAlpha,lineMask(radius,0.365,0.012));
        if(vMisc.y>0.5){float link=(1.0-smoothstep(0.025,0.045,abs(p.y+0.31)))*(1.0-smoothstep(0.31,0.37,abs(p.x))); float rookDots=1.0-smoothstep(0.065,0.085,min(length(p-vec2(-0.3,-0.31)),length(p-vec2(0.3,-0.31)))); eventAlpha=max(eventAlpha,max(link,rookDots));}
        color=mix(color,vEvent.z>0.5?vec3(1.0,0.75,0.36):moveColor,eventAlpha); alpha=max(alpha,eventAlpha);
        if(alpha<0.025) discard; gl_FragColor=vec4(color,alpha*vMisc.w);
      }`,
  });
  return material;
}

function curvePoints(
  from: THREE.Vector3,
  to: THREE.Vector3,
  seed: number,
): THREE.Vector3[] {
  const middle = from.clone().lerp(to, 0.5);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const magnitude = Math.min(3.4, length * 0.16 + 0.35);
  const direction = seed % 2 ? 1 : -1;
  middle.x += ((-dy * direction) / length) * magnitude;
  middle.y += ((dx * direction) / length) * magnitude;
  return Array.from({ length: 8 }, (_, index) => {
    const t = index / 7;
    return from
      .clone()
      .multiplyScalar((1 - t) * (1 - t))
      .add(middle.clone().multiplyScalar(2 * (1 - t) * t))
      .add(to.clone().multiplyScalar(t * t));
  });
}

export function PermutationsGraph({
  nodes,
  activeId,
  orientation,
  probabilities,
  analysisUnavailable = false,
  onSelect,
}: PermutationsGraphProps) {
  const mount = useRef<HTMLDivElement>(null);
  const labelLayer = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const latest = useRef({
    nodes,
    activeId,
    orientation,
    probabilities,
    analysisUnavailable,
    onSelect,
  });
  const rebuild = useRef<(() => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<HoveredNode | null>(null);
  useEffect(() => {
    latest.current = {
      nodes,
      activeId,
      orientation,
      probabilities,
      analysisUnavailable,
      onSelect,
    };
  }, [
    nodes,
    activeId,
    orientation,
    probabilities,
    analysisUnavailable,
    onSelect,
  ]);
  useEffect(() => {
    rebuild.current?.();
  }, [nodes, activeId, probabilities, analysisUnavailable]);

  useEffect(() => {
    const host = mount.current;
    const labels = labelLayer.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
      });
    } catch {
      queueMicrotask(() =>
        setError('WebGL is unavailable. Use the accessible tree list instead.'),
      );
      return;
    }
    const reducedMotion = matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor(0x080d12, 0);
    renderer.domElement.setAttribute(
      'aria-label',
      'Interactive three-dimensional chess variation constellation',
    );
    renderer.domElement.setAttribute('role', 'img');
    renderer.domElement.style.cursor = 'grab';
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x080d12, 0.0035);
    const camera = new THREE.PerspectiveCamera(47, 1, 0.1, 2500);
    camera.position.set(30, 24, 62);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !reducedMotion;
    controls.dampingFactor = 0.065;
    controls.minDistance = 12;
    controls.maxDistance = 230;
    controls.target.set(0, 0, -24);
    let mesh: THREE.InstancedMesh | null = null;
    let graphGroup = new THREE.Group();
    scene.add(graphGroup);
    let nodeIds: string[] = [];
    let pointById = new Map<string, THREE.Vector3>();
    let previousPoints = new Map<string, THREE.Vector3>();
    let targetPoints = new Map<string, THREE.Vector3>();
    let nodeSizes: number[] = [];
    let labelProjections: LabelProjection[] = [];
    let transitionStart = 0;
    const transitionDuration = reducedMotion ? 0 : 280;
    const activeTarget = new THREE.Vector3(0, 0, -24);
    const cameraTarget = new THREE.Vector3(30, 24, 62);
    let cameraTransitionStart = 0;
    let hoverTimer = 0,
      hoverFrame = 0;
    let pendingHoverId: string | null = null,
      visibleHoverId: string | null = null;
    let pointerDown: { x: number; y: number } | null = null,
      pointerMoved = false;
    const clearHover = (updateState = true) => {
      window.clearTimeout(hoverTimer);
      pendingHoverId = null;
      visibleHoverId = null;
      renderer.domElement.style.cursor = pointerDown ? 'grabbing' : 'grab';
      if (updateState) setHovered(null);
    };
    const disposeObject = (object: THREE.Object3D) =>
      object.traverse((child) => {
        const drawable = child as THREE.Mesh;
        drawable.geometry?.dispose();
        const material = drawable.material;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else material?.dispose();
      });
    const makeLine = (
      segments: THREE.Vector3[],
      colors: THREE.Color[],
      opacity: number,
    ) => {
      if (!segments.length) return;
      const geometry = new THREE.BufferGeometry().setFromPoints(segments);
      geometry.setAttribute(
        'color',
        new THREE.Float32BufferAttribute(
          colors.flatMap((color) => [color.r, color.g, color.b]),
          3,
        ),
      );
      graphGroup.add(
        new THREE.LineSegments(
          geometry,
          new THREE.LineBasicMaterial({
            vertexColors: true,
            transparent: true,
            opacity,
            depthWrite: false,
          }),
        ),
      );
    };
    const applyTokenPositions = (progress: number) => {
      if (!mesh) return;
      const matrix = new THREE.Matrix4();
      nodeIds.forEach((id, index) => {
        const target = targetPoints.get(id)!;
        const from = previousPoints.get(id) ?? target;
        const point = from.clone().lerp(target, progress);
        pointById.set(id, point);
        const size = nodeSizes[index];
        matrix.compose(
          point,
          new THREE.Quaternion(),
          new THREE.Vector3(size, size, size),
        );
        mesh!.setMatrixAt(index, matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    };
    const buildLabels = (visible: GameNode[], path: Set<string>) => {
      const layer = labelLayer.current;
      if (!layer) return;
      layer.replaceChildren();
      labelProjections = [];
      const active = visible.find(
        (node) => node.id === latest.current.activeId,
      );
      const mobile = host.clientWidth < 900;
      const priority = visible
        .map((node) => {
          const activeChild = active?.children.includes(node.id) ?? false;
          const recentAncestor =
            path.has(node.id) && (active?.ply ?? 0) - node.ply <= 8;
          const value =
            node.id === active?.id
              ? 0
              : activeChild
                ? 1
                : recentAncestor
                  ? 2
                  : 3 + Math.abs(node.ply - (active?.ply ?? 0));
          return { node, value, activeChild };
        })
        .filter(
          (item) => !mobile || item.node.id === active?.id || item.activeChild,
        )
        .sort(
          (left, right) =>
            left.value - right.value ||
            left.node.id.localeCompare(right.node.id),
        )
        .slice(0, mobile ? 18 : 36);
      priority.forEach(({ node, value }) => {
        const probability =
          latest.current.probabilities[node.id] ?? terminalProbability(node);
        const element = document.createElement('div');
        element.className = `graph-node-label ${node.ply % 2 ? 'white-move-label' : 'black-move-label'}${node.id === active?.id ? ' active' : ''}`;
        const probabilityText = probability
          ? leaderProbabilityLabel(probability)
          : latest.current.analysisUnavailable
            ? 'Unavailable'
            : 'Analyzing';
        element.textContent = `${node.san ?? 'Start'} · ${probabilityText}`;
        element.setAttribute('aria-hidden', 'true');
        layer.appendChild(element);
        labelProjections.push({
          element,
          point: targetPoints.get(node.id)!,
          priority: value,
        });
      });
    };
    const buildGraph = () => {
      clearHover();
      previousPoints = new Map(pointById);
      disposeObject(graphGroup);
      scene.remove(graphGroup);
      graphGroup = new THREE.Group();
      scene.add(graphGroup);
      const visible = visibleGameTree(
        latest.current.nodes,
        latest.current.activeId,
        1200,
      );
      const byId = new Map(visible.map((node) => [node.id, node]));
      const path = selectedAncestry(visible, latest.current.activeId);
      const points = layoutGameTree(visible, latest.current.activeId);
      targetPoints = new Map(
        points.map((point) => [
          point.id,
          new THREE.Vector3(point.x, point.y, point.z),
        ]),
      );
      pointById = new Map();
      nodeIds = visible.map((node) => node.id);
      nodeSizes = [];
      const geometry = new THREE.PlaneGeometry(2, 2);
      const pieces: number[] = [],
        sides: number[] = [],
        wdls: number[] = [],
        events: number[] = [],
        misc: number[] = [];
      const active = byId.get(latest.current.activeId);
      visible.forEach((node) => {
        const visual = deriveGraphMoveVisual(
          node,
          node.parentId ? byId.get(node.parentId) : undefined,
        );
        const probability =
          latest.current.probabilities[node.id] ?? terminalProbability(node);
        const activeChild = active?.children.includes(node.id) ?? false;
        const inPath = path.has(node.id);
        const near = Math.abs(node.ply - (active?.ply ?? 0)) <= 4;
        pieces.push(pieceIndex(visual));
        sides.push(
          visual.side === 'root' ? 0 : visual.side === 'white' ? 1 : 2,
        );
        wdls.push(
          (probability?.white ?? 0) / 1000,
          (probability?.draw ?? 0) / 1000,
          (probability?.black ?? 0) / 1000,
        );
        events.push(...eventVector(visual));
        const opacity =
          node.id === active?.id
            ? 1
            : inPath
              ? 0.96
              : activeChild
                ? 0.92
                : near
                  ? 0.72
                  : 0.4;
        misc.push(
          visual.promotion ? 1 : 0,
          visual.castle ? 1 : 0,
          node.id === active?.id ? 1 : 0,
          opacity,
        );
        nodeSizes.push(
          node.id === active?.id
            ? 2.35
            : activeChild
              ? 1.9
              : inPath
                ? 1.7
                : near
                  ? 1.48
                  : 1.28,
        );
      });
      geometry.setAttribute(
        'aPiece',
        new THREE.InstancedBufferAttribute(new Float32Array(pieces), 1),
      );
      geometry.setAttribute(
        'aSide',
        new THREE.InstancedBufferAttribute(new Float32Array(sides), 1),
      );
      geometry.setAttribute(
        'aWdl',
        new THREE.InstancedBufferAttribute(new Float32Array(wdls), 3),
      );
      geometry.setAttribute(
        'aEvent',
        new THREE.InstancedBufferAttribute(new Float32Array(events), 4),
      );
      geometry.setAttribute(
        'aMisc',
        new THREE.InstancedBufferAttribute(new Float32Array(misc), 4),
      );
      mesh = new THREE.InstancedMesh(geometry, tokenMaterial(), visible.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      graphGroup.add(mesh);
      applyTokenPositions(transitionDuration ? 0 : 1);
      transitionStart = performance.now();
      const lineGroups: Array<{
        points: THREE.Vector3[];
        colors: THREE.Color[];
      }> = Array.from({ length: 4 }, () => ({ points: [], colors: [] }));
      visible.forEach((node, index) => {
        if (!node.parentId) return;
        const from = targetPoints.get(node.parentId),
          to = targetPoints.get(node.id);
        if (!from || !to) return;
        const level =
          path.has(node.id) && path.has(node.parentId)
            ? 0
            : active?.children.includes(node.id)
              ? 1
              : Math.abs(node.ply - (active?.ply ?? 0)) <= 4
                ? 2
                : 3;
        const curve = curvePoints(from, to, index);
        const segments: THREE.Vector3[] = [];
        for (let pointIndex = 1; pointIndex < curve.length; pointIndex += 1)
          segments.push(curve[pointIndex - 1], curve[pointIndex]);
        const color = node.ply % 2 ? WHITE_MOVE : BLACK_MOVE;
        lineGroups[level].points.push(...segments);
        lineGroups[level].colors.push(...segments.map(() => color));
      });
      makeLine(lineGroups[3].points, lineGroups[3].colors, 0.13);
      makeLine(lineGroups[2].points, lineGroups[2].colors, 0.3);
      makeLine(lineGroups[1].points, lineGroups[1].colors, 0.68);
      makeLine(lineGroups[0].points, lineGroups[0].colors, 0.96);
      const maxPly = Math.max(0, ...visible.map((node) => node.ply));
      const depthGroup = new THREE.Group();
      for (let ply = 2; ply <= maxPly; ply += 2) {
        const strong = (ply / 2) % 5 === 0;
        const ring = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(
            Array.from({ length: 33 }, (_, index) => {
              const angle = (index / 32) * Math.PI * 2;
              const radius = strong ? 5.2 : 3.3;
              return new THREE.Vector3(
                Math.cos(angle) * radius,
                Math.sin(angle) * radius,
                -ply * 9,
              );
            }),
          ),
          new THREE.LineBasicMaterial({
            color: strong ? 0x557a7d : 0x36565b,
            transparent: true,
            opacity: strong ? 0.22 : 0.09,
            depthWrite: false,
          }),
        );
        depthGroup.add(ring);
      }
      graphGroup.add(depthGroup);
      const activePoint = targetPoints.get(latest.current.activeId);
      if (activePoint) {
        activeTarget.copy(activePoint);
        cameraTarget.set(
          activePoint.x + 30,
          activePoint.y + 24,
          activePoint.z + 62,
        );
        if (reducedMotion) {
          controls.target.copy(activeTarget);
          camera.position.copy(cameraTarget);
        } else cameraTransitionStart = performance.now();
      }
      buildLabels(visible, path);
    };
    rebuild.current = buildGraph;
    buildGraph();
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const hitAt = (clientX: number, clientY: number) => {
      if (!mesh) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(mesh)[0];
      return hit?.instanceId === undefined
        ? null
        : (nodeIds[hit.instanceId] ?? null);
    };
    const previewPosition = (clientX: number, clientY: number) => {
      const hostRect = host.getBoundingClientRect();
      const workspace = host.closest('.workspace');
      const avoid: PreviewRect[] = [];
      for (const element of workspace?.querySelectorAll(
        '.board-panel, .analysis-panel, .graph-toolbar, .graph-legend',
      ) ?? []) {
        const rect = element.getBoundingClientRect();
        avoid.push({
          left: rect.left - hostRect.left,
          top: rect.top - hostRect.top,
          width: rect.width,
          height: rect.height,
        });
      }
      return placeNodePreview(
        { x: clientX - hostRect.left, y: clientY - hostRect.top },
        { width: hostRect.width, height: hostRect.height },
        {
          width: preview.current?.offsetWidth || 228,
          height: preview.current?.offsetHeight || 332,
        },
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
      if (!id) {
        clearHover();
        return;
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
        setHovered({ id, ...previewPosition(clientX, clientY) });
      }, 90);
    };
    const onPointerDown = (event: PointerEvent) => {
      pointerDown = { x: event.clientX, y: event.clientY };
      pointerMoved = false;
      clearHover();
      renderer.domElement.style.cursor = 'grabbing';
    };
    const onPointerMove = (event: PointerEvent) => {
      if (
        pointerDown &&
        Math.hypot(
          event.clientX - pointerDown.x,
          event.clientY - pointerDown.y,
        ) > 5
      )
        pointerMoved = true;
      if (event.pointerType === 'touch' || event.buttons !== 0) return;
      cancelAnimationFrame(hoverFrame);
      hoverFrame = requestAnimationFrame(() =>
        updateHover(event.clientX, event.clientY),
      );
    };
    const onPointerUp = (event: PointerEvent) => {
      const shouldSelect = Boolean(pointerDown && !pointerMoved);
      pointerDown = null;
      renderer.domElement.style.cursor = 'grab';
      if (shouldSelect) {
        const id = hitAt(event.clientX, event.clientY);
        if (id) latest.current.onSelect(id);
      }
      if (event.pointerType !== 'touch')
        updateHover(event.clientX, event.clientY);
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
    const lost = (event: Event) => {
      event.preventDefault();
      setError('The 3D context was lost. The tree list remains available.');
    };
    renderer.domElement.addEventListener('webglcontextlost', lost);
    const resize = () => {
      const width = Math.max(1, host.clientWidth),
        height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    const updateLabels = () => {
      const width = host.clientWidth,
        height = host.clientHeight;
      const occupied: Array<{
        left: number;
        top: number;
        right: number;
        bottom: number;
      }> = [];
      labelProjections
        .sort((left, right) => left.priority - right.priority)
        .forEach((label) => {
          const projected = label.point.clone().project(camera);
          const left = (projected.x * 0.5 + 0.5) * width + 13,
            top = (-projected.y * 0.5 + 0.5) * height - 12;
          const rect = {
            left,
            top,
            right: left + Math.max(84, label.element.offsetWidth),
            bottom: top + 24,
          };
          const visible =
            projected.z < 1 &&
            left > 0 &&
            left < width - 70 &&
            top > 0 &&
            top < height - 24 &&
            !occupied.some(
              (other) =>
                rect.left < other.right + 5 &&
                rect.right + 5 > other.left &&
                rect.top < other.bottom + 4 &&
                rect.bottom + 4 > other.top,
            );
          label.element.style.display = visible ? '' : 'none';
          if (visible) {
            label.element.style.transform = `translate3d(${left}px,${top}px,0)`;
            occupied.push(rect);
          }
        });
    };
    let frame = 0;
    const animate = (now: number) => {
      frame = requestAnimationFrame(animate);
      if (transitionDuration && now - transitionStart < transitionDuration) {
        const linear = Math.min(
          1,
          (now - transitionStart) / transitionDuration,
        );
        applyTokenPositions(1 - Math.pow(1 - linear, 3));
      } else if (
        transitionDuration &&
        now - transitionStart >= transitionDuration &&
        now - transitionStart < transitionDuration + 20
      )
        applyTokenPositions(1);
      if (!reducedMotion && cameraTransitionStart) {
        const progress = Math.min(1, (now - cameraTransitionStart) / 280),
          eased = 1 - Math.pow(1 - progress, 3);
        controls.target.lerp(activeTarget, eased * 0.16);
        camera.position.lerp(cameraTarget, eased * 0.13);
        if (progress >= 1) cameraTransitionStart = 0;
      }
      controls.update();
      updateLabels();
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(animate);
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
      disposeObject(graphGroup);
      scene.remove(graphGroup);
      renderer.dispose();
      renderer.domElement.remove();
      labels?.replaceChildren();
      rebuild.current = null;
      clearHover(false);
    };
  }, []);

  const hoveredNode = hovered
    ? nodes.find((node) => node.id === hovered.id)
    : undefined;
  const trail = hoveredNode ? ancestorSanTrail(nodes, hoveredNode.id) : [];
  const probability = hoveredNode
    ? (probabilities[hoveredNode.id] ?? terminalProbability(hoveredNode))
    : undefined;
  return (
    <div className="graph-surface">
      <div ref={mount} className="permutations-canvas" />
      <div ref={labelLayer} className="graph-label-layer" aria-hidden="true" />
      {hovered && hoveredNode && (
        <div
          ref={preview}
          className="node-preview"
          role="tooltip"
          style={{ left: hovered.left, top: hovered.top }}
        >
          <PositionPreview node={hoveredNode} orientation={orientation} />
          <div className="node-preview-copy">
            <div>
              <strong>{moveLabel(hoveredNode)}</strong>
              <span>
                {probability
                  ? leaderProbabilityLabel(probability)
                  : analysisUnavailable
                    ? 'Unavailable'
                    : 'Analyzing'}
              </span>
            </div>
            <p className="probability-split">
              {probabilityDetailLabel(probability)}
            </p>
            {trail.length > 0 && <p>{trail.join('  ')}</p>}
            <small>
              {hoveredNode.terminal ??
                (hoveredNode.mainline
                  ? 'Selected game line'
                  : `Variation · ply ${hoveredNode.ply}`)}
            </small>
          </div>
        </div>
      )}
      {error && (
        <p className="canvas-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

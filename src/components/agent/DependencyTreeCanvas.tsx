"use client";

import { useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  AlertTriangle,
  Check,
  GitBranch,
  Layers,
  Link2,
  Lock,
  MessageSquare,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  Unlink,
  Unlock,
  Workflow,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Badge, Button, Card, Field, Input, Select } from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  parseCalleesList,
  type Subagent,
  type SubagentRoutingMode,
  type TreeNodeDraft,
} from "./subagentTypes";

export type DependencyTreeNodePayload = {
  id: number;
  isActive?: boolean;
  parentSubagentId?: number | null;
  orchestratorCanCall?: boolean;
  allowedCallees?: string[];
};

type Props = {
  subagents: Subagent[];
  orchestratorModel?: string;
  maxActive: number;
  routingMode?: SubagentRoutingMode;
  onChangeRoutingMode?: (mode: SubagentRoutingMode) => Promise<void>;
  onSave: (nodes: DependencyTreeNodePayload[]) => Promise<void>;
  onCreateNew?: () => void;
  onEditSubagent?: (subagent: Subagent) => void;
  onOpenChat?: (subagentId: number) => void;
  onClose?: () => void;
};

type TierTheme = {
  primary: string;
  secondary: string;
  glowFilter: string;
  label: string;
};

const TIER_THEMES: TierTheme[] = [
  { primary: "#ff5533", secondary: "#ff884d", glowFilter: "orange", label: "Оркестратор" },
  { primary: "#f59e0b", secondary: "#fb923c", glowFilter: "amber", label: "Уровень 1" },
  { primary: "#38bdf8", secondary: "#22d3ee", glowFilter: "cyan", label: "Уровень 2" },
  { primary: "#06b6d4", secondary: "#2dd4bf", glowFilter: "cyan", label: "Уровень 3+" },
];

const INACTIVE_THEME: TierTheme = {
  primary: "#475569",
  secondary: "#64748b",
  glowFilter: "none",
  label: "Отключён",
};

function hexPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 3;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(" ");
}

/** Мини-иконка нейронной сети / мозга внутри шестиугольного узла — в стиле схемы. */
function BrainCoreGlyph({
  cx,
  cy,
  scale = 1,
  color,
  dim = false,
}: {
  cx: number;
  cy: number;
  scale?: number;
  color: string;
  dim?: boolean;
}) {
  return (
    <g
      transform={`translate(${cx}, ${cy}) scale(${scale})`}
      opacity={dim ? 0.35 : 0.95}
      pointerEvents="none"
    >
      {/* Левое и правое полушарие */}
      <path
        d="M -1.5 -11 C -7 -11 -11 -7 -11 -2 C -12 1 -10.5 4.5 -8.5 6.5 C -7.5 9.5 -4.5 11 -1.5 10 Z"
        fill={`${color}22`}
        stroke={color}
        strokeWidth={1.35}
      />
      <path
        d="M 1.5 -11 C 7 -11 11 -7 11 -2 C 12 1 10.5 4.5 8.5 6.5 C 7.5 9.5 4.5 11 1.5 10 Z"
        fill={`${color}22`}
        stroke={color}
        strokeWidth={1.35}
      />
      {/* Нейронные извилины и узлы */}
      <path
        d="M -7 -5 Q -4 -3 -6 0 M -8 2 Q -5 4 -3.5 7 M 7 -5 Q 4 -3 6 0 M 8 2 Q 5 4 3.5 7"
        fill="none"
        stroke="#e0f2fe"
        strokeWidth={1.05}
        strokeLinecap="round"
        opacity={0.75}
      />
      <circle cx={-5} cy={-3.5} r={1.3} fill="#fff" opacity={0.85} />
      <circle cx={5} cy={-3.5} r={1.3} fill="#fff" opacity={0.85} />
      <circle cx={-4.5} cy={3} r={1.15} fill={color} />
      <circle cx={4.5} cy={3} r={1.15} fill={color} />
      <line x1={0} y1={-9.5} x2={0} y2={9.5} stroke={color} strokeWidth={0.9} opacity={0.6} />
    </g>
  );
}

function collectDescendantIds(
  rootId: number,
  draftById: Record<number, TreeNodeDraft>,
): Set<number> {
  const blocked = new Set<number>([rootId]);
  let added = true;
  while (added) {
    added = false;
    for (const [idStr, node] of Object.entries(draftById)) {
      const id = Number(idStr);
      if (!blocked.has(id) && node.parentSubagentId !== null && blocked.has(node.parentSubagentId)) {
        blocked.add(id);
        added = true;
      }
    }
  }
  return blocked;
}

type LayoutNode = {
  subagent: Subagent;
  draft: TreeNodeDraft;
  tier: number; // >= 1
  x: number;
  y: number;
  parentNodeId: number | "orchestrator" | null;
  manualDetached: boolean;
  isLeaf: boolean;
};

type EdgeInfo = {
  id: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  fromTier: number;
  toTier: number;
  active: boolean;
  fromNodeId: number | "orchestrator";
  toNodeId: number;
};

export function DependencyTreeCanvas({
  subagents,
  orchestratorModel,
  maxActive,
  routingMode = "linear",
  onChangeRoutingMode,
  onSave,
  onCreateNew,
  onEditSubagent,
  onOpenChat,
  onClose,
}: Props) {
  const uid = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [overrides, setOverrides] = useState<Record<number, Partial<TreeNodeDraft>>>({});
  const [selectedNodeId, setSelectedNodeId] = useState<number | "orchestrator" | null>(() =>
    subagents[0]?.id ?? "orchestrator",
  );
  const [connectFrom, setConnectFrom] = useState<number | "orchestrator" | null>(null);
  const [cursorSvgPos, setCursorSvgPos] = useState<{ x: number; y: number } | null>(null);
  const [routingBusy, setRoutingBusy] = useState(false);
  const [showCrossLinks, setShowCrossLinks] = useState(true);
  const [zoomed, setZoomed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedToast, setSavedToast] = useState<string | null>(null);

  const draftById = useMemo<Record<number, TreeNodeDraft>>(() => {
    const out: Record<number, TreeNodeDraft> = {};
    for (const s of subagents) {
      const ov = overrides[s.id];
      out[s.id] = {
        isActive: ov?.isActive ?? s.isActive,
        parentSubagentId: ov?.parentSubagentId !== undefined ? ov.parentSubagentId : s.parentSubagentId,
        orchestratorCanCall: ov?.orchestratorCanCall ?? s.orchestratorCanCall,
        allowedCalleesText:
          ov?.allowedCalleesText !== undefined
            ? ov.allowedCalleesText
            : (s.allowedCallees && s.allowedCallees.length > 0 ? s.allowedCallees : ["*"]).join(", "),
      };
    }
    return out;
  }, [subagents, overrides]);

  const isDirty = useMemo(() => {
    for (const s of subagents) {
      const d = draftById[s.id];
      if (!d) continue;
      const baseCallees = (s.allowedCallees && s.allowedCallees.length > 0 ? s.allowedCallees : ["*"]).join(", ");
      if (
        d.isActive !== s.isActive ||
        d.parentSubagentId !== s.parentSubagentId ||
        d.orchestratorCanCall !== s.orchestratorCanCall ||
        d.allowedCalleesText.trim() !== baseCallees.trim()
      ) {
        return true;
      }
    }
    return false;
  }, [subagents, draftById]);

  const updateDraft = (id: number, patch: Partial<TreeNodeDraft>) => {
    setSavedToast(null);
    setError(null);
    setOverrides((prev) => ({
      ...prev,
      [id]: {
        ...prev[id],
        ...patch,
      },
    }));
  };

  const resetDraft = () => {
    setOverrides({});
    setError(null);
    setSavedToast(null);
  };

  const activeCount = useMemo(
    () => subagents.filter((s) => draftById[s.id]?.isActive).length,
    [subagents, draftById],
  );
  const orchestratorDirectCount = useMemo(
    () => subagents.filter((s) => draftById[s.id]?.isActive && draftById[s.id]?.orchestratorCanCall).length,
    [subagents, draftById],
  );

  // Вычисляем иерархическую геометрию дерева зависимостей
  const layout = useMemo(() => {
    const byId = new Map(subagents.map((s) => [s.id, s]));
    const depthOf = new Map<number, number>();
    const childrenMap = new Map<number, number[]>();

    for (const s of subagents) {
      const p = draftById[s.id]?.parentSubagentId ?? null;
      if (p !== null && p !== s.id && byId.has(p)) {
        const list = childrenMap.get(p) ?? [];
        list.push(s.id);
        childrenMap.set(p, list);
      }
    }

    // BFS по дереву с защитой от циклов
    const queue: Array<{ id: number; tier: number }> = [];
    for (const s of subagents) {
      const p = draftById[s.id]?.parentSubagentId ?? null;
      if (p === null || p === s.id || !byId.has(p)) {
        queue.push({ id: s.id, tier: 1 });
      }
    }
    const visited = new Set<number>();
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (visited.has(cur.id)) continue;
      visited.add(cur.id);
      depthOf.set(cur.id, cur.tier);
      for (const childId of childrenMap.get(cur.id) ?? []) {
        if (!visited.has(childId)) {
          queue.push({ id: childId, tier: Math.min(cur.tier + 1, 5) });
        }
      }
    }
    // Если вдруг осталась циклическая компонента — положим её на уровень 1
    for (const s of subagents) {
      if (!depthOf.has(s.id)) depthOf.set(s.id, 1);
    }

    const maxTier = subagents.length > 0 ? Math.max(1, ...Array.from(depthOf.values())) : 1;
    const tiersRaw: Subagent[][] = Array.from({ length: maxTier }, () => []);
    for (const s of subagents) {
      const t = (depthOf.get(s.id) ?? 1) - 1;
      tiersRaw[t]?.push(s);
    }

    const maxCols = Math.max(3, ...tiersRaw.map((row) => row.length));
    const width = Math.max(960, maxCols * 185 + 210);
    const rootX = width / 2;
    const rootY = 104;
    const tierGap = 136;
    const firstTierY = rootY + 132;
    const lastTierY = firstTierY + Math.max(0, maxTier - 1) * tierGap;
    const terminalY = lastTierY + 148;
    const height = terminalY + 46;

    const nodesMap = new Map<number, LayoutNode>();

    // Выравниваем каждый уровень с учётом X родителя для чистых переплетений кабелей
    tiersRaw.forEach((row, tierIdx) => {
      const tierNum = tierIdx + 1;
      const sortedRow = [...row].sort((a, b) => {
        const dA = draftById[a.id];
        const dB = draftById[b.id];
        const pAx =
          dA?.parentSubagentId && nodesMap.has(dA.parentSubagentId)
            ? nodesMap.get(dA.parentSubagentId)!.x
            : dA?.orchestratorCanCall
              ? rootX
              : rootX + 9999;
        const pBx =
          dB?.parentSubagentId && nodesMap.has(dB.parentSubagentId)
            ? nodesMap.get(dB.parentSubagentId)!.x
            : dB?.orchestratorCanCall
              ? rootX
              : rootX + 9999;
        if (pAx !== pBx) return pAx - pBx;
        return a.id - b.id;
      });

      const usableWidth = width - 190;
      const count = sortedRow.length;
      const step = count <= 1 ? 0 : Math.min(220, usableWidth / Math.max(count - 1, 1));
      const startX = rootX - ((count - 1) * step) / 2;
      const y = firstTierY + tierIdx * tierGap;

      sortedRow.forEach((s, idx) => {
        const d = draftById[s.id]!;
        const hasValidParent = d.parentSubagentId !== null && d.parentSubagentId !== s.id && byId.has(d.parentSubagentId);
        const parentNodeId: number | "orchestrator" | null = hasValidParent
          ? d.parentSubagentId
          : d.orchestratorCanCall
            ? "orchestrator"
            : null;
        const activeChildren = (childrenMap.get(s.id) ?? []).filter((cid) => draftById[cid]?.isActive);
        nodesMap.set(s.id, {
          subagent: s,
          draft: d,
          tier: tierNum,
          x: count === 1 ? rootX : startX + idx * step,
          y,
          parentNodeId,
          manualDetached: !hasValidParent && !d.orchestratorCanCall,
          isLeaf: activeChildren.length === 0,
        });
      });
    });

    const nodes = Array.from(nodesMap.values());
    const edges: EdgeInfo[] = [];

    for (const node of nodes) {
      // Прямая связь от Оркестратора
      if (node.draft.orchestratorCanCall && node.parentNodeId === "orchestrator") {
        edges.push({
          id: `orch-${node.subagent.id}`,
          fromX: rootX,
          fromY: rootY + 38,
          toX: node.x,
          toY: node.y - 29,
          fromTier: 0,
          toTier: node.tier,
          active: node.draft.isActive,
          fromNodeId: "orchestrator",
          toNodeId: node.subagent.id,
        });
      }
      // Связь от родительского субагента
      if (typeof node.parentNodeId === "number") {
        const pNode = nodesMap.get(node.parentNodeId);
        if (pNode) {
          edges.push({
            id: `p-${pNode.subagent.id}-${node.subagent.id}`,
            fromX: pNode.x,
            fromY: pNode.y + 30,
            toX: node.x,
            toY: node.y - 29,
            fromTier: pNode.tier,
            toTier: node.tier,
            active: node.draft.isActive && pNode.draft.isActive,
            fromNodeId: pNode.subagent.id,
            toNodeId: node.subagent.id,
          });
          // Если у подчинённого субагента также разрешён прямой вызов Оркестратором — покажем дополнительную тонкую связь!
          if (node.draft.orchestratorCanCall) {
            edges.push({
              id: `orch-direct-${node.subagent.id}`,
              fromX: rootX,
              fromY: rootY + 38,
              toX: node.x,
              toY: node.y - 29,
              fromTier: 0,
              toTier: node.tier,
              active: node.draft.isActive,
              fromNodeId: "orchestrator",
              toNodeId: node.subagent.id,
            });
          }
        }
      }
    }

    // Нижние терминальные веерные выходы (fan-out strands -> micro-hex pads, как на картинке)
    const fanSourceNodes = nodes.filter((n) => n.isLeaf);
    const terminalPads: Array<{
      id: string;
      ownerId: number;
      startX: number;
      startY: number;
      endX: number;
      endY: number;
      active: boolean;
      strandIdx: number;
    }> = [];

    const strandsPerNode = fanSourceNodes.length <= 4 ? 5 : 4;
    const totalPads = fanSourceNodes.length * strandsPerNode;
    if (totalPads > 0) {
      const padMargin = 72;
      const padSpan = width - padMargin * 2;
      const padStep = totalPads > 1 ? padSpan / (totalPads - 1) : 0;
      let padCounter = 0;
      const sortedFans = [...fanSourceNodes].sort((a, b) => a.x - b.x);
      for (const n of sortedFans) {
        for (let k = 0; k < strandsPerNode; k += 1) {
          const endX = totalPads === 1 ? rootX : padMargin + padCounter * padStep;
          terminalPads.push({
            id: `pad-${n.subagent.id}-${k}`,
            ownerId: n.subagent.id,
            startX: n.x + (k - (strandsPerNode - 1) / 2) * 5.5,
            startY: n.y + 31,
            endX,
            endY: terminalY,
            active: n.draft.isActive,
            strandIdx: k,
          });
          padCounter += 1;
        }
      }
    }

    return {
      width,
      height,
      rootX,
      rootY,
      terminalY,
      nodes,
      nodesMap,
      edges,
      terminalPads,
      maxTier,
    };
  }, [subagents, draftById]);

  // Перекрёстные связи (allowedCallees / handoff) от выбранного или всех узлов
  const handoffArcs = useMemo(() => {
    if (!showCrossLinks) return [];
    const arcs: Array<{
      id: string;
      from: LayoutNode;
      to: LayoutNode;
      highlighted: boolean;
    }> = [];
    const sourceNodes =
      typeof selectedNodeId === "number"
        ? layout.nodes.filter((n) => n.subagent.id === selectedNodeId)
        : layout.nodes.filter((n) => n.draft.isActive);

    for (const src of sourceNodes) {
      if (!src.draft.isActive) continue;
      const callees = parseCalleesList(src.draft.allowedCalleesText);
      const allowAll = callees.includes("*");
      const targets = layout.nodes.filter(
        (t) =>
          t.subagent.id !== src.subagent.id &&
          t.draft.isActive &&
          (allowAll || callees.includes(t.subagent.slug)),
      );
      for (const dst of targets) {
        // Если уже есть прямая вертикальная родительско-дочерняя связь — не дублируем арку при общем просмотре
        if (typeof selectedNodeId !== "number" && dst.parentNodeId === src.subagent.id) continue;
        arcs.push({
          id: `handoff-${src.subagent.id}-${dst.subagent.id}`,
          from: src,
          to: dst,
          highlighted: selectedNodeId === src.subagent.id,
        });
      }
    }
    return arcs;
  }, [layout.nodes, selectedNodeId, showCrossLinks]);

  const effectiveSelectedId =
    selectedNodeId === "orchestrator"
      ? "orchestrator"
      : typeof selectedNodeId === "number" && layout.nodesMap.has(selectedNodeId)
        ? selectedNodeId
        : (subagents[0]?.id ?? "orchestrator");

  const selectedLayoutNode =
    typeof effectiveSelectedId === "number" ? layout.nodesMap.get(effectiveSelectedId) ?? null : null;

  const blockedParentIds = useMemo(() => {
    if (!selectedLayoutNode) return new Set<number>();
    return collectDescendantIds(selectedLayoutNode.subagent.id, draftById);
  }, [selectedLayoutNode, draftById]);

  const selectedCalleesList = useMemo(() => {
    if (!selectedLayoutNode) return [];
    return parseCalleesList(selectedLayoutNode.draft.allowedCalleesText);
  }, [selectedLayoutNode]);

  const toggleCalleeSlug = (subagentId: number, slug: string) => {
    const cur = parseCalleesList(draftById[subagentId]?.allowedCalleesText ?? "");
    if (slug === "*") {
      const next = cur.includes("*") ? cur.filter((x) => x !== "*") : ["*"];
      updateDraft(subagentId, { allowedCalleesText: next.join(", ") });
      return;
    }
    const base = cur.filter((x) => x !== "*");
    const next = base.includes(slug) ? base.filter((x) => x !== slug) : [...base, slug];
    updateDraft(subagentId, { allowedCalleesText: next.join(", ") });
  };

  const handleRoutingSwitch = async (nextMode: SubagentRoutingMode) => {
    if (nextMode === routingMode || !onChangeRoutingMode || routingBusy) return;
    setRoutingBusy(true);
    setError(null);
    setSavedToast(null);
    try {
      await onChangeRoutingMode(nextMode);
      setSavedToast(
        nextMode === "layered"
          ? "Режим изменён: По уровням (строгая иерархия Оркестратор ↔ Уровень 1 ↔ Уровень 2…)"
          : "Режим изменён: Линейно (Оркестратор напрямую координирует субагентов)",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось переключить режим");
    } finally {
      setRoutingBusy(false);
    }
  };

  const startConnectFrom = (src: number | "orchestrator") => {
    setError(null);
    setSavedToast(null);
    setConnectFrom(src);
    setSelectedNodeId(src);
  };

  const cancelConnect = () => {
    setConnectFrom(null);
    setCursorSvgPos(null);
  };

  const connectTargetNode = (targetId: number) => {
    if (connectFrom === null) return;
    if (connectFrom === "orchestrator") {
      updateDraft(targetId, {
        orchestratorCanCall: true,
        ...(routingMode === "layered" ? { parentSubagentId: null } : {}),
      });
      setSelectedNodeId(targetId);
      setSavedToast("Связь «Оркестратор → субагент» добавлена (не забудьте сохранить дерево)");
      cancelConnect();
      return;
    }
    if (connectFrom === targetId) {
      cancelConnect();
      return;
    }
    const targetBlocked = collectDescendantIds(targetId, draftById);
    if (targetBlocked.has(connectFrom)) {
      setError("Нельзя создать циклическую связь (выбранный узел уже является родителем источника).");
      cancelConnect();
      return;
    }
    const parentSub = subagents.find((s) => s.id === connectFrom);
    const targetSub = subagents.find((s) => s.id === targetId);
    updateDraft(targetId, {
      parentSubagentId: connectFrom,
      ...(routingMode === "layered" ? { orchestratorCanCall: false } : {}),
    });
    if (parentSub && targetSub) {
      const parentCallees = parseCalleesList(draftById[parentSub.id]?.allowedCalleesText ?? "");
      if (!parentCallees.includes("*") && !parentCallees.includes(targetSub.slug)) {
        updateDraft(parentSub.id, {
          allowedCalleesText: [...parentCallees, targetSub.slug].join(", "),
        });
      }
    }
    setSelectedNodeId(targetId);
    setSavedToast(`Связь «${parentSub?.name ?? connectFrom} → ${targetSub?.name ?? targetId}» добавлена`);
    cancelConnect();
  };

  const disconnectEdge = (edge: EdgeInfo) => {
    setError(null);
    setSavedToast(null);
    if (edge.fromNodeId === "orchestrator") {
      updateDraft(edge.toNodeId, { orchestratorCanCall: false });
      setSavedToast("Прямая связь с Оркестратором удалена");
    } else {
      updateDraft(edge.toNodeId, { parentSubagentId: null });
      setSavedToast("Иерархическая связь с родителем удалена");
    }
  };

  const handleSvgPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (connectFrom === null || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = ((e.clientX - rect.left) / rect.width) * layout.width;
    const y = ((e.clientY - rect.top) / rect.height) * layout.height;
    setCursorSvgPos({ x, y });
  };

  const connectSourcePoint = useMemo(() => {
    if (connectFrom === null) return null;
    if (connectFrom === "orchestrator") {
      return { x: layout.rootX, y: layout.rootY + 38, label: "Оркестратор" };
    }
    const n = layout.nodesMap.get(connectFrom);
    if (!n) return null;
    return { x: n.x, y: n.y + 30, label: n.subagent.name };
  }, [connectFrom, layout.nodesMap, layout.rootX, layout.rootY]);

  const handleSave = async () => {
    setBusy(true);
    setError(null);
    setSavedToast(null);
    try {
      if (activeCount > maxActive) {
        throw new Error(`Одновременно может быть активно не более ${maxActive} субагентов (сейчас ${activeCount})`);
      }
      const payload: DependencyTreeNodePayload[] = subagents.map((s) => {
        const d = draftById[s.id];
        return {
          id: s.id,
          isActive: d.isActive,
          parentSubagentId: d.parentSubagentId,
          orchestratorCanCall: d.orchestratorCanCall,
          allowedCallees: parseCalleesList(d.allowedCalleesText),
        };
      });
      await onSave(payload);
      setOverrides({});
      setSavedToast("Топология дерева сохранена");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить дерево");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      className="border-cyan-500/25"
      title={
        <span className="flex flex-wrap items-center gap-2">
          <GitBranch size={15} className="text-cyan-400" />
          Дерево зависимостей «Оркестратор ↔ Субагенты»
          <Badge className="border-cyan-500/30 bg-cyan-500/10 text-cyan-400">
            Активно: {activeCount}/{maxActive}
          </Badge>
          {isDirty && (
            <Badge className="border-amber-500/40 bg-amber-500/15 text-amber-400">
              Есть несохранённые изменения
            </Badge>
          )}
        </span>
      }
      subtitle="Интерактивная нейронная топология: нажмите на любой шестиугольник, чтобы перенастроить связи, родителя, handoff-вызовы и активность."
      action={
        <div className="flex flex-wrap items-center gap-1.5">
          {onChangeRoutingMode && (
            <div
              role="group"
              aria-label="Режим маршрутизации субагентов"
              className="inline-flex rounded-xl border border-border bg-card2 p-0.5"
            >
              <button
                type="button"
                disabled={routingBusy}
                onClick={() => void handleRoutingSwitch("linear")}
                className={cn(
                  "inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium transition",
                  routingMode === "linear"
                    ? "bg-accent text-white shadow-sm"
                    : "text-muted hover:text-text",
                )}
              >
                <Workflow size={12} />
                Линейно
              </button>
              <button
                type="button"
                disabled={routingBusy}
                onClick={() => void handleRoutingSwitch("layered")}
                className={cn(
                  "inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium transition",
                  routingMode === "layered"
                    ? "bg-cyan-500 text-slate-950 shadow-sm"
                    : "text-muted hover:text-text",
                )}
              >
                <Layers size={12} />
                По уровням
              </button>
            </div>
          )}
          {subagents.length > 0 && (
            <Button
              size="sm"
              variant={connectFrom !== null ? "primary" : "secondary"}
              onClick={() => {
                if (connectFrom !== null) cancelConnect();
                else startConnectFrom(effectiveSelectedId);
              }}
              title="Нажмите и кликните целевой узел на схеме, чтобы провести связь"
            >
              <Link2 size={12} />
              {connectFrom !== null ? "Отменить связь" : "Провести связь"}
            </Button>
          )}
          <Button
            size="sm"
            variant={showCrossLinks ? "secondary" : "ghost"}
            onClick={() => setShowCrossLinks((v) => !v)}
            title="Показать перекрёстные вызовы allowedCallees между субагентами"
          >
            <Sparkles size={12} className="text-cyan-400" />
            Handoff-связи
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setZoomed((v) => !v)}
            title={zoomed ? "Вписать дерево по ширине" : "Увеличить схему (130%)"}
          >
            {zoomed ? <ZoomOut size={12} /> : <ZoomIn size={12} />}
            {zoomed ? "100%" : "130%"}
          </Button>
          {onClose && (
            <Button size="sm" variant="ghost" onClick={onClose}>
              Свернуть
            </Button>
          )}
        </div>
      }
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card2/70 px-3 py-2 text-[11px]">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            className={
              routingMode === "layered"
                ? "border-cyan-500/40 bg-cyan-500/15 text-cyan-300"
                : "border-accent/40 bg-accent/15 text-accent2"
            }
          >
            {routingMode === "layered" ? "Режим: По уровням" : "Режим: Линейно"}
          </Badge>
          <span className="text-muted">
            {routingMode === "layered"
              ? "Каждый уровень общается только с соседним (Оркестратор ↔ Уровень 1 ↔ Уровень 2…); вверх — через эскалацию к верхнему узлу."
              : "Оркестратор вызывает субагентов напрямую и координирует handoff между ветками."}
          </span>
        </div>
        {connectFrom !== null && connectSourcePoint && (
          <div className="flex items-center gap-2 text-cyan-300">
            <span className="font-medium">
              Проводим связь от «{connectSourcePoint.label}» — кликните по целевому шестиугольнику
            </span>
            <button
              type="button"
              onClick={cancelConnect}
              className="rounded-md border border-cyan-500/40 bg-card px-2 py-0.5 text-[10px] text-text hover:bg-cyan-500/15"
            >
              Отмена
            </button>
          </div>
        )}
      </div>
      {error && (
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          <AlertTriangle size={14} className="shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {savedToast && (
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">
          <Check size={14} className="shrink-0" />
          <span>{savedToast}</span>
        </div>
      )}

      {/* Интерактивный SVG-холст нейронного дерева по мотивам референса */}
      <div className="relative overflow-hidden rounded-2xl border border-cyan-500/30 bg-[#030812] shadow-[0_18px_50px_-22px_rgba(6,182,212,0.45)]">
        {/* Лёгкое радиальное свечение сверху и снизу как на схеме */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-44 opacity-70"
          style={{
            background:
              "radial-gradient(ellipse 46% 75% at 50% 6%, rgba(255,85,51,0.22), rgba(245,158,11,0.08) 48%, transparent 78%)",
          }}
        />
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-40 opacity-80"
          style={{
            background:
              "radial-gradient(ellipse 75% 70% at 50% 96%, rgba(6,182,212,0.24), rgba(34,211,238,0.08) 55%, transparent 85%)",
          }}
        />

        <div className="overflow-x-auto">
          <svg
            ref={svgRef}
            role="img"
            aria-label="Схема зависимостей Оркестратора и субагентов"
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            onPointerMove={handleSvgPointerMove}
            onPointerLeave={() => setCursorSvgPos(null)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && connectFrom !== null) {
                e.preventDefault();
                cancelConnect();
              }
            }}
            className={cn(
              "block select-none transition-all duration-300",
              connectFrom !== null && "cursor-crosshair",
              zoomed ? "min-w-[1180px] w-[130%]" : "w-full min-w-[680px]",
            )}
            style={{
              background: "linear-gradient(180deg, #030914 0%, #051120 52%, #030a15 100%)",
            }}
          >
            <defs>
              {/* Чертёжная сетка */}
              <pattern id={`${uid}-grid-minor`} width="24" height="24" patternUnits="userSpaceOnUse">
                <path
                  d="M 24 0 L 0 0 0 24"
                  fill="none"
                  stroke="rgba(34,211,238,0.05)"
                  strokeWidth="0.7"
                />
              </pattern>
              <pattern id={`${uid}-grid-major`} width="120" height="120" patternUnits="userSpaceOnUse">
                <rect width="120" height="120" fill={`url(#${uid}-grid-minor)`} />
                <path
                  d="M 120 0 L 0 0 0 120"
                  fill="none"
                  stroke="rgba(34,211,238,0.11)"
                  strokeWidth="0.85"
                />
                <circle cx="0" cy="0" r="1.4" fill="rgba(56,189,248,0.38)" />
              </pattern>

              {/* Световые фильтры для вершин и кабелей */}
              <filter id={`${uid}-glow-orange`} x="-40%" y="-40%" width="180%" height="180%">
                <feGaussianBlur stdDeviation="4" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <filter id={`${uid}-glow-cyan`} x="-35%" y="-35%" width="170%" height="170%">
                <feGaussianBlur stdDeviation="3.2" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>

              {/* Градиенты переходов по глубине */}
              <linearGradient id={`${uid}-stream-top`} x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#ff3b1f" stopOpacity="0.15" />
                <stop offset="55%" stopColor="#ff5533" stopOpacity="0.9" />
                <stop offset="100%" stopColor="#ff884d" stopOpacity="1" />
              </linearGradient>

              <linearGradient id={`${uid}-terminal-cyan`} x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.92" />
                <stop offset="55%" stopColor="#22d3ee" stopOpacity="0.95" />
                <stop offset="100%" stopColor="#06b6d4" stopOpacity="1" />
              </linearGradient>

              {layout.edges.map((edge) => {
                const fromC = TIER_THEMES[Math.min(edge.fromTier, TIER_THEMES.length - 1)].primary;
                const toC = TIER_THEMES[Math.min(edge.toTier, TIER_THEMES.length - 1)].primary;
                return (
                  <linearGradient
                    key={`grad-${edge.id}`}
                    id={`${uid}-edge-${edge.id}`}
                    x1={edge.fromX}
                    y1={edge.fromY}
                    x2={edge.toX}
                    y2={edge.toY}
                    gradientUnits="userSpaceOnUse"
                  >
                    <stop offset="0%" stopColor={fromC} />
                    <stop offset="100%" stopColor={toC} />
                  </linearGradient>
                );
              })}
            </defs>

            {/* 1. Подложка blueprint-сетки */}
            <rect width={layout.width} height={layout.height} fill={`url(#${uid}-grid-major)`} />

            {/* 2. Боковая техно-телеметрия HUD как на референсе */}
            <g opacity="0.72" pointerEvents="none">
              {/* Левая рамка телеметрии */}
              <rect
                x="24"
                y="22"
                width="172"
                height="94"
                rx="6"
                fill="rgba(6,18,32,0.58)"
                stroke="rgba(34,211,238,0.22)"
                strokeWidth="1"
              />
              <text x="36" y="42" fill="#38bdf8" fontSize="9.5" fontFamily="monospace" fontWeight="700">
                TOPOLOGY // NEURAL GRID
              </text>
              <text x="36" y="60" fill="#94a3b8" fontSize="8.5" fontFamily="monospace">
                NODES: {subagents.length} · ACTIVE: {activeCount}/{maxActive}
              </text>
              <text x="36" y="75" fill="#94a3b8" fontSize="8.5" fontFamily="monospace">
                DIRECT ORCH: {orchestratorDirectCount} · TIERS: {layout.maxTier}
              </text>
              <text x="36" y="96" fill="#22d3ee" fontSize="8" fontFamily="monospace" opacity="0.65">
                01011001 11001010 00101110
              </text>

              {/* Правая рамка телеметрии */}
              <rect
                x={layout.width - 196}
                y="22"
                width="172"
                height="94"
                rx="6"
                fill="rgba(6,18,32,0.58)"
                stroke="rgba(34,211,238,0.22)"
                strokeWidth="1"
              />
              <text
                x={layout.width - 184}
                y="42"
                fill="#fb923c"
                fontSize="9.5"
                fontFamily="monospace"
                fontWeight="700"
              >
                ORCHESTRATOR CORE
              </text>
              <text x={layout.width - 184} y="60" fill="#cbd5e1" fontSize="8.5" fontFamily="monospace">
                MODEL: {(orchestratorModel || "default").slice(0, 18)}
              </text>
              <text x={layout.width - 184} y="75" fill="#94a3b8" fontSize="8.5" fontFamily="monospace">
                CUSTOM API: {subagents.filter((s) => s.unlockApi).length} · LOCKED:{" "}
                {subagents.filter((s) => !s.unlockApi).length}
              </text>
              <text x={layout.width - 184} y="96" fill="#38bdf8" fontSize="8" fontFamily="monospace" opacity="0.7">
                ISOLATED SUB-CHATS // READY
              </text>

              {/* Ортогональные PCB-шины по флангам схемы */}
              <path
                d={`M 48 145 L 118 145 L 146 173 L 146 ${layout.terminalY - 40} L 122 ${layout.terminalY - 16} L 68 ${layout.terminalY - 16}`}
                fill="none"
                stroke="rgba(34,211,238,0.18)"
                strokeWidth="1.2"
              />
              <path
                d={`M ${layout.width - 48} 145 L ${layout.width - 118} 145 L ${layout.width - 146} 173 L ${layout.width - 146} ${layout.terminalY - 40} L ${layout.width - 122} ${layout.terminalY - 16} L ${layout.width - 68} ${layout.terminalY - 16}`}
                fill="none"
                stroke="rgba(34,211,238,0.18)"
                strokeWidth="1.2"
              />
              {/* Центральная бинарная ось внизу, как 0101 на изображении */}
              <g opacity="0.45">
                {["0", "1", "0", "1"].map((bit, i) => (
                  <text
                    key={`bit-${i}`}
                    x={layout.rootX}
                    y={layout.terminalY - 62 + i * 13}
                    textAnchor="middle"
                    fill="#38bdf8"
                    fontSize="9.5"
                    fontFamily="monospace"
                    fontWeight="700"
                  >
                    {bit}
                  </text>
                ))}
              </g>
            </g>

            {/* 3. Верхние огненно-оранжевые потоки, входящие в Оркестратор */}
            <g pointerEvents="none" filter={`url(#${uid}-glow-orange)`}>
              {[-28, -17, -7, 0, 7, 17, 28].map((dx, i) => {
                const startX = layout.rootX + dx * 2.1;
                const endX = layout.rootX + dx * 0.65;
                const d = `M ${startX} 0 C ${startX} 34, ${endX} 36, ${endX} ${layout.rootY - 38}`;
                return (
                  <path
                    key={`top-stream-${i}`}
                    d={d}
                    fill="none"
                    stroke={`url(#${uid}-stream-top)`}
                    strokeWidth={i === 3 ? 2.4 : 1.15}
                    opacity={i === 3 ? 0.95 : 0.68}
                  />
                );
              })}
            </g>

            {/* 4. Иерархические многожильные кривые Безье (Оркестратор -> Уровень 1 -> Уровень 2 -> ...) */}
            <g>
              {layout.edges.map((edge) => {
                const dy = edge.toY - edge.fromY;
                const isSelectedEdge =
                  effectiveSelectedId === edge.fromNodeId || effectiveSelectedId === edge.toNodeId;
                const gradUrl = `url(#${uid}-edge-${edge.id})`;
                const baseStroke = edge.active ? gradUrl : "#475569";
                const offsets = edge.active ? [-4.5, 0, 4.5] : [0];
                const midX = (edge.fromX + edge.toX) / 2;
                const midY = (edge.fromY + edge.toY) / 2;
                const fromLabel =
                  edge.fromNodeId === "orchestrator"
                    ? "Оркестратор"
                    : subagents.find((s) => s.id === edge.fromNodeId)?.name ?? `#${edge.fromNodeId}`;
                const toLabel = subagents.find((s) => s.id === edge.toNodeId)?.name ?? `#${edge.toNodeId}`;
                return (
                  <g key={edge.id} opacity={edge.active ? (isSelectedEdge ? 1 : 0.86) : 0.42}>
                    {/* Ортогональная фоновая PCB-направляющая для техно-эффекта */}
                    <path
                      d={`M ${edge.fromX} ${edge.fromY + 8} L ${edge.fromX} ${edge.fromY + dy * 0.34} L ${edge.toX} ${edge.fromY + dy * 0.34} L ${edge.toX} ${edge.toY - 8}`}
                      fill="none"
                      stroke={edge.active ? "rgba(56,189,248,0.16)" : "rgba(100,116,139,0.14)"}
                      strokeWidth="1"
                    />
                    {offsets.map((off, idx) => {
                      const d = `M ${edge.fromX + off * 0.45} ${edge.fromY} C ${edge.fromX + off * 0.7} ${edge.fromY + dy * 0.48}, ${edge.toX - off * 0.7} ${edge.toY - dy * 0.48}, ${edge.toX + off * 0.45} ${edge.toY}`;
                      const isCenter = off === 0;
                      return (
                        <path
                          key={`strand-${idx}`}
                          d={d}
                          fill="none"
                          stroke={baseStroke}
                          strokeWidth={isCenter ? (isSelectedEdge ? 3.2 : 2.3) : 1}
                          strokeDasharray={edge.active ? undefined : "5 5"}
                          filter={
                            edge.active && isCenter
                              ? `url(#${uid}-${edge.fromTier === 0 ? "glow-orange" : "glow-cyan"})`
                              : undefined
                          }
                          opacity={isCenter ? 1 : 0.55}
                        />
                      );
                    })}
                    {/* Импульсный пунктирный сигнал по центральной жиле активной линии */}
                    {edge.active && (
                      <path
                        d={`M ${edge.fromX} ${edge.fromY} C ${edge.fromX} ${edge.fromY + dy * 0.48}, ${edge.toX} ${edge.toY - dy * 0.48}, ${edge.toX} ${edge.toY}`}
                        fill="none"
                        stroke="#ffffff"
                        strokeWidth={isSelectedEdge ? 1.4 : 0.9}
                        strokeDasharray="4 14"
                        opacity={isSelectedEdge ? 0.85 : 0.48}
                      />
                    )}
                    {/* Кликабельная кнопка удаления связи на линии */}
                    <g
                      role="button"
                      tabIndex={0}
                      aria-label={`Удалить связь ${fromLabel} → ${toLabel}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        disconnectEdge(edge);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          disconnectEdge(edge);
                        }
                      }}
                      transform={`translate(${midX}, ${midY})`}
                      className="cursor-pointer opacity-75 transition hover:opacity-100 focus:outline-none"
                    >
                      <title>Удалить связь {fromLabel} → {toLabel}</title>
                      <circle
                        r={9}
                        fill="#071222"
                        stroke={isSelectedEdge ? "#f87171" : "rgba(148,163,184,0.6)"}
                        strokeWidth="1.2"
                      />
                      <line x1={-3} y1={-3} x2={3} y2={3} stroke="#fca5a5" strokeWidth="1.5" strokeLinecap="round" />
                      <line x1={3} y1={-3} x2={-3} y2={3} stroke="#fca5a5" strokeWidth="1.5" strokeLinecap="round" />
                    </g>
                  </g>
                );
              })}

              {/* Предпросмотр проводимой линии связи */}
              {connectFrom !== null && connectSourcePoint && cursorSvgPos && (
                <path
                  d={`M ${connectSourcePoint.x} ${connectSourcePoint.y} C ${connectSourcePoint.x} ${(connectSourcePoint.y + cursorSvgPos.y) / 2}, ${cursorSvgPos.x} ${(connectSourcePoint.y + cursorSvgPos.y) / 2}, ${cursorSvgPos.x} ${cursorSvgPos.y}`}
                  fill="none"
                  stroke="#22d3ee"
                  strokeWidth="2.4"
                  strokeDasharray="6 4"
                  pointerEvents="none"
                />
              )}
            </g>

            {/* 5. Перекрёстные handoff-дуги (allowedCallees) */}
            <g pointerEvents="none">
              {handoffArcs.map((arc) => {
                const sameRow = Math.abs(arc.from.y - arc.to.y) < 10;
                const midX = (arc.from.x + arc.to.x) / 2;
                const lift = sameRow ? -52 : 0;
                const midY = (arc.from.y + arc.to.y) / 2 + lift;
                return (
                  <path
                    key={arc.id}
                    d={`M ${arc.from.x} ${arc.from.y} Q ${midX} ${midY} ${arc.to.x} ${arc.to.y}`}
                    fill="none"
                    stroke={arc.highlighted ? "#22d3ee" : "#38bdf8"}
                    strokeWidth={arc.highlighted ? 1.85 : 1}
                    strokeDasharray="4 4"
                    opacity={arc.highlighted ? 0.9 : 0.32}
                  />
                );
              })}
            </g>

            {/* 6. Нижние веерные кибер-волокна и терминальные микро-шестиугольники */}
            <g pointerEvents="none">
              {/* Горизонтальная шина терминалов */}
              <line
                x1="48"
                y1={layout.terminalY}
                x2={layout.width - 48}
                y2={layout.terminalY}
                stroke="rgba(34,211,238,0.16)"
                strokeWidth="1"
              />
              {layout.terminalPads.map((pad) => {
                const dy = pad.endY - pad.startY;
                const d = `M ${pad.startX} ${pad.startY} C ${pad.startX} ${pad.startY + dy * 0.52}, ${pad.endX} ${pad.endY - dy * 0.45}, ${pad.endX} ${pad.endY - 7}`;
                return (
                  <g key={pad.id} opacity={pad.active ? 0.9 : 0.25}>
                    <path
                      d={d}
                      fill="none"
                      stroke={pad.active ? `url(#${uid}-terminal-cyan)` : "#475569"}
                      strokeWidth={pad.active ? 1.7 : 0.95}
                      filter={pad.active && pad.strandIdx % 2 === 0 ? `url(#${uid}-glow-cyan)` : undefined}
                    />
                    <polygon
                      points={hexPoints(pad.endX, pad.endY, 6.2)}
                      fill="#04111f"
                      stroke={pad.active ? "#22d3ee" : "#475569"}
                      strokeWidth="1.25"
                    />
                    <circle cx={pad.endX} cy={pad.endY} r={1.8} fill={pad.active ? "#67e8f9" : "#64748b"} />
                  </g>
                );
              })}
            </g>

            {/* 7. Если субагентов пока нет — голографический preview-скелет 3 слотов как на картинке */}
            {subagents.length === 0 && (
              <g>
                {[-220, 0, 220].map((dx, idx) => {
                  const sx = layout.rootX + dx;
                  const sy = layout.rootY + 136;
                  const endBase = layout.rootX + dx * 1.15;
                  return (
                    <g key={`ghost-${idx}`}>
                      {[-3, 0, 3].map((off, si) => (
                        <path
                          key={`ghost-edge-${si}`}
                          d={`M ${layout.rootX + off} ${layout.rootY + 38} C ${layout.rootX} ${layout.rootY + 95}, ${sx} ${sy - 72}, ${sx + off} ${sy - 29}`}
                          fill="none"
                          stroke={si === 1 ? "#f59e0b" : "#fb923c"}
                          strokeWidth={si === 1 ? 1.8 : 0.85}
                          strokeDasharray="5 4"
                          opacity={0.55}
                        />
                      ))}
                      {[-2, -1, 0, 1, 2].map((f) => (
                        <g key={`ghost-fan-${f}`} opacity={0.45}>
                          <path
                            d={`M ${sx + f * 4} ${sy + 30} C ${sx + f * 4} ${sy + 95}, ${endBase + f * 26} ${layout.terminalY - 45}, ${endBase + f * 26} ${layout.terminalY - 7}`}
                            fill="none"
                            stroke="#22d3ee"
                            strokeWidth={1.3}
                          />
                          <polygon
                            points={hexPoints(endBase + f * 26, layout.terminalY, 5.8)}
                            fill="#04111f"
                            stroke="#22d3ee"
                            strokeWidth="1.1"
                          />
                        </g>
                      ))}
                      <g
                        onClick={onCreateNew}
                        className={onCreateNew ? "cursor-pointer" : undefined}
                      >
                        <polygon
                          points={hexPoints(sx, sy, 29)}
                          fill="#061220"
                          stroke="#f59e0b"
                          strokeWidth="1.4"
                          strokeDasharray="4 3"
                          opacity={0.78}
                        />
                        <BrainCoreGlyph cx={sx} cy={sy} scale={0.85} color="#f59e0b" dim />
                        <text
                          x={sx}
                          y={sy + 44}
                          textAnchor="middle"
                          fill="#94a3b8"
                          fontSize="10"
                          fontFamily="sans-serif"
                        >
                          Слот субагента #{idx + 1}
                        </text>
                      </g>
                    </g>
                  );
                })}
              </g>
            )}

            {/* 8. Главный узел (Оркестратор) сверху по центру */}
            <g
              role="button"
              tabIndex={0}
              aria-label="Узел Оркестратор (Главный Агент)"
              onClick={() => {
                if (connectFrom !== null) cancelConnect();
                else setSelectedNodeId("orchestrator");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (connectFrom !== null) cancelConnect();
                  else setSelectedNodeId("orchestrator");
                }
              }}
              className="cursor-pointer focus:outline-none"
            >
              {(effectiveSelectedId === "orchestrator" || connectFrom === "orchestrator") && (
                <polygon
                  points={hexPoints(layout.rootX, layout.rootY, 47)}
                  fill="none"
                  stroke={connectFrom === "orchestrator" ? "#22d3ee" : "#fb923c"}
                  strokeWidth={connectFrom === "orchestrator" ? "2" : "1.5"}
                  strokeDasharray="4 3"
                  opacity="0.95"
                />
              )}
              <polygon
                points={hexPoints(layout.rootX, layout.rootY, 40)}
                fill="#0b101d"
                stroke="#ff5533"
                strokeWidth="2.4"
                filter={`url(#${uid}-glow-orange)`}
              />
              <polygon
                points={hexPoints(layout.rootX, layout.rootY, 33)}
                fill="#120b12"
                stroke="#ff884d"
                strokeWidth="1.15"
                opacity="0.9"
              />
              <BrainCoreGlyph cx={layout.rootX} cy={layout.rootY} scale={1.18} color="#ff6b4a" />
              <rect
                x={layout.rootX - 78}
                y={layout.rootY + 46}
                width="156"
                height="22"
                rx="11"
                fill="rgba(12,18,32,0.92)"
                stroke="rgba(255,107,74,0.58)"
                strokeWidth="1"
              />
              <text
                x={layout.rootX}
                y={layout.rootY + 60}
                textAnchor="middle"
                fill="#fff1ed"
                fontSize="10.5"
                fontWeight="700"
              >
                ОРКЕСТРАТОР · ГЛАВНЫЙ АГЕНТ
              </text>
              {/* Нижний выходной порт для протягивания связи */}
              {subagents.length > 0 && (
                <g
                  role="button"
                  tabIndex={0}
                  aria-label="Провести связь от Оркестратора"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (connectFrom === "orchestrator") cancelConnect();
                    else startConnectFrom("orchestrator");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      if (connectFrom === "orchestrator") cancelConnect();
                      else startConnectFrom("orchestrator");
                    }
                  }}
                  transform={`translate(${layout.rootX}, ${layout.rootY + 39})`}
                  className="cursor-crosshair"
                >
                  <circle
                    r={6.5}
                    fill={connectFrom === "orchestrator" ? "#22d3ee" : "#0b101d"}
                    stroke="#ff884d"
                    strokeWidth="1.5"
                  />
                  <line x1={-2.5} y1={0} x2={2.5} y2={0} stroke="#fff" strokeWidth="1.3" />
                  <line x1={0} y1={-2.5} x2={0} y2={2.5} stroke="#fff" strokeWidth="1.3" />
                </g>
              )}
            </g>

            {/* 9. Шестиугольные узлы субагентов */}
            {layout.nodes.map((node) => {
              const s = node.subagent;
              const d = node.draft;
              const theme = d.isActive
                ? TIER_THEMES[Math.min(node.tier, TIER_THEMES.length - 1)]
                : INACTIVE_THEME;
              const isSelected = effectiveSelectedId === s.id;
              const isConnectSource = connectFrom === s.id;
              const isConnectTarget = connectFrom !== null && connectFrom !== s.id;
              const labelText = s.name.length > 18 ? `${s.name.slice(0, 17)}…` : s.name;
              const subTag = node.manualDetached
                ? "вручную"
                : d.orchestratorCanCall
                  ? "прямой"
                  : "подчинён";

              return (
                <g
                  key={s.id}
                  role="button"
                  tabIndex={0}
                  aria-label={isConnectTarget ? `Соединить с субагентом ${s.name}` : `Субагент ${s.name}`}
                  onClick={() => {
                    if (connectFrom !== null) {
                      connectTargetNode(s.id);
                    } else {
                      setSelectedNodeId(s.id);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      if (connectFrom !== null) {
                        connectTargetNode(s.id);
                      } else {
                        setSelectedNodeId(s.id);
                      }
                    }
                  }}
                  className="cursor-pointer focus:outline-none"
                >
                  {(isSelected || isConnectSource || isConnectTarget) && (
                    <polygon
                      points={hexPoints(node.x, node.y, 37)}
                      fill="none"
                      stroke={isConnectSource ? "#22d3ee" : isConnectTarget ? "#34d399" : "#ffffff"}
                      strokeWidth={isConnectTarget || isConnectSource ? "2" : "1.5"}
                      strokeDasharray="4 3"
                      opacity="0.92"
                    />
                  )}
                  <polygon
                    points={hexPoints(node.x, node.y, 30)}
                    fill="#061220"
                    stroke={isConnectTarget ? "#34d399" : theme.primary}
                    strokeWidth={isSelected || isConnectTarget ? 2.6 : 1.9}
                    filter={d.isActive ? `url(#${uid}-${theme.glowFilter === "amber" ? "glow-orange" : "glow-cyan"})` : undefined}
                  />
                  <polygon
                    points={hexPoints(node.x, node.y, 24)}
                    fill="#040b15"
                    stroke={theme.secondary}
                    strokeWidth="0.95"
                    opacity={d.isActive ? 0.88 : 0.4}
                  />
                  <BrainCoreGlyph
                    cx={node.x}
                    cy={node.y}
                    scale={0.86}
                    color={theme.primary}
                    dim={!d.isActive}
                  />

                  {/* Маркер личного цвета субагента на верхней грани */}
                  <circle
                    cx={node.x}
                    cy={node.y - 29}
                    r={4.2}
                    fill={s.color || theme.primary}
                    stroke="#030812"
                    strokeWidth="1.3"
                  />

                  {/* Нижний выходной порт для протягивания связи к дочерним субагентам */}
                  <g
                    role="button"
                    tabIndex={0}
                    aria-label={`Провести связь от субагента ${s.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (connectFrom === s.id) cancelConnect();
                      else startConnectFrom(s.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        if (connectFrom === s.id) cancelConnect();
                        else startConnectFrom(s.id);
                      }
                    }}
                    transform={`translate(${node.x}, ${node.y + 30})`}
                    className="cursor-crosshair"
                  >
                    <circle
                      r={5.5}
                      fill={isConnectSource ? "#22d3ee" : "#071222"}
                      stroke={theme.primary}
                      strokeWidth="1.3"
                    />
                    <line x1={-2} y1={0} x2={2} y2={0} stroke="#e2e8f0" strokeWidth="1.2" />
                    <line x1={0} y1={-2} x2={0} y2={2} stroke="#e2e8f0" strokeWidth="1.2" />
                  </g>

                  {/* Индикатор API на правой верхней грани */}
                  <g transform={`translate(${node.x + 22}, ${node.y - 16})`}>
                    <circle
                      r={7.5}
                      fill="#071222"
                      stroke={s.unlockApi ? "#f59e0b" : "#38bdf8"}
                      strokeWidth="1"
                    />
                    <text
                      x="0"
                      y="3"
                      textAnchor="middle"
                      fill={s.unlockApi ? "#fbbf24" : "#7dd3fc"}
                      fontSize="7.5"
                      fontWeight="700"
                    >
                      {s.unlockApi ? "API" : "LOCK"}
                    </text>
                  </g>

                  {/* Подпись узла под шестиугольником */}
                  <g transform={`translate(${node.x}, ${node.y + 44})`}>
                    <rect
                      x="-64"
                      y="-11"
                      width="128"
                      height="31"
                      rx="8"
                      fill="rgba(5,13,24,0.92)"
                      stroke={isSelected ? "#ffffff" : d.isActive ? `${theme.primary}88` : "rgba(71,85,105,0.65)"}
                      strokeWidth={isSelected ? 1.3 : 1}
                    />
                    <text
                      x="0"
                      y="1"
                      textAnchor="middle"
                      fill={d.isActive ? "#f8fafc" : "#94a3b8"}
                      fontSize="10.5"
                      fontWeight="600"
                    >
                      {labelText}
                    </text>
                    <text
                      x="0"
                      y="13.5"
                      textAnchor="middle"
                      fill={d.isActive ? theme.secondary : "#64748b"}
                      fontSize="8.2"
                      fontFamily="monospace"
                    >
                      Ур.{node.tier} · {d.isActive ? subTag : "выкл"} · {parseCalleesList(d.allowedCalleesText).includes("*") ? "*" : parseCalleesList(d.allowedCalleesText).length}
                    </text>
                  </g>
                </g>
              );
            })}
          </svg>
        </div>

        {/* Компактная легенда прямо внизу холста */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-cyan-500/20 bg-[#040c18]/95 px-3 py-2 text-[10px] text-slate-300">
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[#ff5533] shadow-[0_0_8px_#ff5533]" />
              Оркестратор
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[#f59e0b] shadow-[0_0_8px_#f59e0b]" />
              Уровень 1
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[#38bdf8] shadow-[0_0_8px_#38bdf8]" />
              Уровень 2
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[#06b6d4] shadow-[0_0_8px_#06b6d4]" />
              Уровень 3+ / Терминалы
            </span>
            <span className="inline-flex items-center gap-1.5 text-slate-400">
              <span className="h-0.5 w-4 border-t border-dashed border-cyan-400" />
              Handoff (allowedCallees)
            </span>
          </div>
          <span className="font-mono text-[10px] text-cyan-400/80">
            Кликните по любому узлу для настройки
          </span>
        </div>
      </div>

      {/* Быстрый выбор узлов + интерактивный инспектор выбранного узла */}
      {subagents.length > 0 && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setSelectedNodeId("orchestrator")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1 text-xs font-medium transition",
                effectiveSelectedId === "orchestrator"
                  ? "border-orange-500/60 bg-orange-500/15 text-text"
                  : "border-border bg-card2 text-muted hover:text-text",
              )}
            >
              <span className="h-2 w-2 rounded-full bg-[#ff5533]" />
              Оркестратор
            </button>
            {subagents.map((s) => {
              const d = draftById[s.id];
              const isSel = effectiveSelectedId === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSelectedNodeId(s.id)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1 text-xs font-medium transition",
                    isSel
                      ? "border-accent bg-accent/15 text-text ring-1 ring-accent/30"
                      : "border-border bg-card2 text-muted hover:text-text",
                    !d?.isActive && "opacity-60",
                  )}
                >
                  <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                  {s.name}
                  {!d?.isActive && <span className="text-[10px]">(выкл)</span>}
                </button>
              );
            })}
          </div>

          {effectiveSelectedId === "orchestrator" && (
            <div className="rounded-xl border border-orange-500/30 bg-card2/70 p-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-semibold text-text">Оркестратор (Главный Агент)</p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    Вершина дерева. Может вызывать {orchestratorDirectCount} активных субагентов напрямую через{" "}
                    <code className="rounded bg-card px-1 py-0.5 font-mono text-[10px]">call_subagent</code>.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    size="sm"
                    variant={connectFrom === "orchestrator" ? "primary" : "secondary"}
                    onClick={() => {
                      if (connectFrom === "orchestrator") cancelConnect();
                      else startConnectFrom("orchestrator");
                    }}
                  >
                    <Link2 size={12} /> {connectFrom === "orchestrator" ? "Отменить связь" : "Связать с субагентом"}
                  </Button>
                  {onCreateNew && (
                    <Button size="sm" variant="secondary" onClick={onCreateNew}>
                      <Plus size={13} /> Добавить субагента
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}

          {selectedLayoutNode && (() => {
            const s = selectedLayoutNode.subagent;
            const d = selectedLayoutNode.draft;
            const otherSubagents = subagents.filter((o) => o.id !== s.id);
            const allowAll = selectedCalleesList.includes("*");

            return (
              <div className="rounded-2xl border border-border bg-card2/70 p-3.5">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="h-3 w-3 rounded-full" style={{ background: s.color }} />
                    <span className="text-sm font-semibold text-text">{s.name}</span>
                    <Badge className="border-border bg-card text-muted font-mono">{s.slug}</Badge>
                    <Badge
                      className={
                        s.unlockApi
                          ? "border-amber-500/35 bg-amber-500/10 text-amber-500"
                          : "border-accent/30 bg-accent/10 text-accent2"
                      }
                    >
                      {s.unlockApi ? <Unlock size={10} /> : <Lock size={10} />}
                      {s.unlockApi ? (s.model || "Свой API") : "API Оркестратора"}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant={connectFrom === s.id ? "primary" : "secondary"}
                      onClick={() => {
                        if (connectFrom === s.id) cancelConnect();
                        else startConnectFrom(s.id);
                      }}
                    >
                      <Link2 size={12} /> {connectFrom === s.id ? "Отменить связь" : "Связать с…"}
                    </Button>
                    {(d.parentSubagentId !== null || d.orchestratorCanCall) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          updateDraft(s.id, { parentSubagentId: null, orchestratorCanCall: false });
                          setSavedToast(`Входящие связи для «${s.name}» сброшены`);
                        }}
                      >
                        <Unlink size={12} /> Отвязать
                      </Button>
                    )}
                    {onOpenChat && (
                      <Button size="sm" variant="secondary" onClick={() => onOpenChat(s.id)}>
                        <MessageSquare size={12} /> Чаты
                      </Button>
                    )}
                    {onEditSubagent && (
                      <Button size="sm" variant="secondary" onClick={() => onEditSubagent(s)}>
                        <Pencil size={12} /> Профиль
                      </Button>
                    )}
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                  <div className="space-y-2">
                    <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-medium text-text transition hover:border-accent/40">
                      <input
                        type="checkbox"
                        checked={d.isActive}
                        onChange={(e) => updateDraft(s.id, { isActive: e.target.checked })}
                        className="h-4 w-4 accent-[#7c5cff]"
                      />
                      <span>Активен в дереве вызовов</span>
                    </label>
                    <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-medium text-text transition hover:border-accent/40">
                      <input
                        type="checkbox"
                        checked={d.orchestratorCanCall}
                        onChange={(e) => updateDraft(s.id, { orchestratorCanCall: e.target.checked })}
                        className="h-4 w-4 accent-[#7c5cff]"
                      />
                      <span>Оркестратор вызывает напрямую</span>
                    </label>
                  </div>

                  <Field label="Родительский узел в дереве">
                    <Select
                      aria-label={`Родительский узел для ${s.name}`}
                      value={d.parentSubagentId ?? ""}
                      onChange={(e) =>
                        updateDraft(s.id, {
                          parentSubagentId: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                    >
                      <option value="">— Прямо под Оркестратором —</option>
                      {otherSubagents.map((o) => {
                        const createsCycle = blockedParentIds.has(o.id);
                        return (
                          <option key={o.id} value={o.id} disabled={createsCycle}>
                            {o.name}{createsCycle ? " (создаст цикл)" : ""}
                          </option>
                        );
                      })}
                    </Select>
                  </Field>

                  <Field label="Разрешённые вызовы (allowedCallees)">
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap gap-1">
                        <button
                          type="button"
                          onClick={() => toggleCalleeSlug(s.id, "*")}
                          className={cn(
                            "rounded-lg border px-2 py-0.5 text-[11px] font-medium transition",
                            allowAll
                              ? "border-cyan-500/50 bg-cyan-500/15 text-cyan-400"
                              : "border-border bg-card text-muted hover:text-text",
                          )}
                        >
                          * Все активные
                        </button>
                        {otherSubagents.map((o) => {
                          const picked = !allowAll && selectedCalleesList.includes(o.slug);
                          return (
                            <button
                              key={o.id}
                              type="button"
                              onClick={() => toggleCalleeSlug(s.id, o.slug)}
                              className={cn(
                                "inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11px] transition",
                                picked
                                  ? "border-accent/60 bg-accent/15 text-text"
                                  : "border-border bg-card text-muted hover:text-text",
                              )}
                            >
                              <span className="h-1.5 w-1.5 rounded-full" style={{ background: o.color }} />
                              {o.slug}
                            </button>
                          );
                        })}
                      </div>
                      <Input
                        value={d.allowedCalleesText}
                        onChange={(e) => updateDraft(s.id, { allowedCalleesText: e.target.value })}
                        placeholder="* — любые, или slug через запятую"
                        className="h-8 text-xs font-mono"
                      />
                    </div>
                  </Field>
                </div>
              </div>
            );
          })()}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <span className="text-[11px] text-muted">
              Ограничение на одновременную активность: не более {maxActive} субагентов.
            </span>
            <div className="flex items-center gap-2">
              {isDirty && (
                <Button size="sm" variant="secondary" onClick={resetDraft} disabled={busy}>
                  <RotateCcw size={12} /> Сбросить
                </Button>
              )}
              <Button size="sm" variant="primary" onClick={() => void handleSave()} disabled={busy || !isDirty}>
                <Save size={13} />
                {busy ? "Сохраняю…" : "Сохранить дерево"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {subagents.length === 0 && onCreateNew && (
        <div className="mt-3 flex items-center justify-between rounded-xl border border-dashed border-border bg-card2/40 px-3.5 py-2.5 text-xs">
          <span className="text-muted">
            Создайте первого субагента, чтобы заменить голографические слоты живыми узлами.
          </span>
          <Button size="sm" variant="primary" onClick={onCreateNew}>
            <Plus size={13} /> Создать субагента
          </Button>
        </div>
      )}
    </Card>
  );
}

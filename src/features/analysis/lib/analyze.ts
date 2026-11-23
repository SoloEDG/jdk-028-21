import type {
  AnalysisSettings,
  CircuitDocument,
  GateKind,
  GateNode,
  Signal,
  Wire,
} from "@/shared/types";
import { getSpec } from "@/features/catalog/lib/specs";
import { evaluate } from "@/features/simulation/lib/evaluate";
import { gateValue } from "@/features/simulation/lib/logic";
import { PUBLISHED_DEFAULTS, DEFAULT_BUDGET } from "./defaults";

/**
 * 预算判定。pending 表示“分析未完成”，与真正的超预算分开显示，
 * 未完成绝不会被渲染成“通过”或“超预算”。
 */
export type BudgetState = "pending" | "no-path" | "within" | "over";

export type OutputStatusKind =
  | "conditional" // 存在真正可激活的传播路径
  | "constant" // 输出恒定，任何输入翻转都不会改变它
  | "blocked" // 输出会随输入组合变化，但没有单次翻转能激活
  | "undetermined"; // 输出含未确定 X，无法确认是否恒值

export interface SideCondition {
  nodeId: string;
  label: string;
  port: number;
  /** 该旁路脚必须保持 / 到达的电平；any 表示不影响传播 */
  required: 0 | 1 | "any";
  /** 翻转前该旁路脚的实际电平 */
  value: Signal;
  sourceLabel: string | null;
  /** 该脚本次是否也翻转（同源扇出），true 时不能独立设置 */
  changes: boolean;
  /** 该条件是否满足 */
  satisfied: boolean;
  note: string;
}

export interface ArrivalStage {
  nodeId: string;
  label: string;
  kind: GateKind;
  /** 从翻转发生的 0 时刻到该级输出稳定的累计时间 */
  time: number;
}

export interface ActivationEvent {
  inputId: string;
  inputLabel: string;
  before: 0 | 1;
  after: 0 | 1;
  inputsBefore: { id: string; label: string; value: 0 | 1 }[];
  inputsAfter: { id: string; label: string; value: 0 | 1 }[];
  sideConditions: SideCondition[];
  arrival: ArrivalStage[];
  nodeIds: string[];
  wireIds: string[];
  ports: { nodeId: string; port: number }[];
  time: number;
  /** 结构最长路径本身比这条可激活路径更长（结构值高估了瓶颈） */
  structuralBlocked: boolean;
  note: string | null;
}

export interface OutputReport {
  nodeId: string;
  label: string;
  status: OutputStatusKind;
  current: Signal;
  constantValue: 0 | 1 | null;
  /** 结构最长路径：只按连线与延迟，不做逻辑放行检验 */
  structural: number;
  structuralPath: string[];
  structuralPathLabels: string[];
  /** 有可激活路径且其时间等于结构最长路径 */
  structuralActivatable: boolean;
  /** 确实能被某次单输入翻转激活的最长路径 */
  activatable: number | null;
  activatablePath: string[];
  activatablePathLabels: string[];
  event: ActivationEvent | null;
  /** 结构最长路径被阻断 / 被高估的原因 */
  blockedNotes: string[];
  budget: number;
  budgetState: BudgetState;
  headroom: number | null;
  /** 仅按结构值判断会超预算（用于区分“结构超预算”和真正超预算） */
  structuralOverBudget: boolean;
}

export interface KindCostRow {
  kind: GateKind;
  count: number;
  unit: number;
  delay: number;
  subtotal: number;
}

export interface AnalysisReport {
  complete: boolean;
  incompleteReason: "cycle" | "too-many-inputs" | "event-budget" | null;
  incompleteDetail: string | null;
  totalCost: number;
  costByKind: KindCostRow[];
  outputs: OutputReport[];
  inputCount: number;
  structuralMax: { value: number; nodeId: string | null; label: string | null };
  activatableMax: {
    value: number | null;
    nodeId: string | null;
    label: string | null;
  };
  /** 结构最长路径长于可激活最长路径：结构值把阻断长支路当成了瓶颈 */
  structuralOverstates: boolean;
  overBudgetOutputs: string[];
  pendingOutputs: string[];
  withinOutputs: string[];
  noPathOutputs: string[];
  constantOutputs: string[];
  settings: AnalysisSettings;
  searchedEvents: number;
  budgetDefault: number;
}

const MAX_INPUTS = 10;
const MAX_EVENTS = 30_000;

interface Prepared {
  nodes: GateNode[];
  index: Map<string, number>;
  order: number[];
  incoming: Wire[][];
  pinWire: (Wire | null)[][];
  pinSource: number[][];
  drivenInputs: number[];
  inputPosition: Map<number, number>;
  outputs: number[];
}

function prepare(document: CircuitDocument): Prepared | { cycle: true } {
  const nodes = document.nodes;
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const incoming: Wire[][] = nodes.map(() => []);
  const next: number[][] = nodes.map(() => []);
  const indegree = nodes.map(() => 0);
  for (const wire of document.wires) {
    const from = index.get(wire.from.nodeId),
      to = index.get(wire.to.nodeId);
    if (from === undefined || to === undefined) continue;
    incoming[to].push(wire);
    next[from].push(to);
    indegree[to] += 1;
  }
  const queue = nodes.map((_, i) => i).filter((i) => indegree[i] === 0);
  for (let i = 0; i < queue.length; i++)
    for (const to of next[queue[i]]) {
      indegree[to] -= 1;
      if (indegree[to] === 0) queue.push(to);
    }
  if (queue.length !== nodes.length) return { cycle: true };
  const pinWire: (Wire | null)[][] = nodes.map((node) =>
    Array.from({ length: getSpec(node.kind).inputs }, () => null),
  );
  const pinSource: number[][] = nodes.map((node) =>
    Array.from({ length: getSpec(node.kind).inputs }, () => -1),
  );
  for (let to = 0; to < incoming.length; to++)
    for (const wire of incoming[to]) {
      const port = wire.to.port;
      if (port >= 0 && port < pinWire[to].length) {
        pinWire[to][port] = wire;
        pinSource[to][port] = index.get(wire.from.nodeId)!;
      }
    }
  const inputIndices = nodes
    .map((node, i) => ({ node, i }))
    .filter(({ node }) => node.kind === "INPUT")
    .map(({ i }) => i);
  const drivenInputs = inputIndices.filter((i) =>
    document.wires.some((wire) => wire.from.nodeId === nodes[i].id),
  );
  const inputPosition = new Map(
    drivenInputs.map((value, position) => [value, position]),
  );
  const outputs = nodes
    .map((node, i) => ({ node, i }))
    .filter(({ node }) => node.kind === "OUTPUT")
    .map(({ i }) => i);
  return {
    nodes,
    index,
    order: queue,
    incoming,
    pinWire,
    pinSource,
    drivenInputs,
    inputPosition,
    outputs,
  };
}

function evaluateAll(
  p: Prepared,
  inputValues: Uint8Array,
  out: Signal[],
): Signal[] {
  const pins: Signal[] = [];
  for (const v of p.order) {
    const node = p.nodes[v];
    if (node.kind === "INPUT") {
      const position = p.inputPosition.get(v);
      out[v] =
        position === undefined ? node.value : (inputValues[position] as 0 | 1);
      continue;
    }
    const sources = p.pinSource[v];
    pins.length = sources.length;
    for (let port = 0; port < sources.length; port++) {
      const source = sources[port];
      pins[port] = source < 0 ? "X" : out[source];
    }
    out[v] = gateValue(node.kind, pins);
  }
  return out;
}

/** 结构最长路径：按延迟做拓扑 DP，不检查逻辑是否放行。 */
function structuralLongest(
  p: Prepared,
  delayOf: (kind: GateKind) => number,
): { time: number[]; path: number[][] } {
  const incoming = new Map<number, number[]>();
  for (const v of p.order) incoming.set(v, []);
  for (let to = 0; to < p.incoming.length; to++)
    for (const wire of p.incoming[to]) {
      const from = p.index.get(wire.from.nodeId);
      if (from !== undefined) incoming.get(to)!.push(from);
    }
  const time = new Array<number>(p.nodes.length).fill(0);
  const path = new Array<number[]>(p.nodes.length);
  for (const v of p.order) {
    const node = p.nodes[v];
    if (node.kind === "INPUT") {
      time[v] = delayOf(node.kind);
      path[v] = [v];
      continue;
    }
    const delay = delayOf(node.kind);
    let best = -1,
      bestFrom: number | null = null;
    for (const from of incoming.get(v)!) {
      const candidate = time[from] + delay;
      if (candidate > best) {
        best = candidate;
        bestFrom = from;
      }
    }
    time[v] = Math.max(0, best);
    path[v] = bestFrom === null ? [v] : [...path[bestFrom], v];
  }
  return { time, path };
}

/**
 * 门输出向哪个方向翻转，以及由哪些输入脚“决定”这个翻转时刻：
 *  - "max"：输出要等所有相关输入就位（与门上升、或门下降等），取最晚到达；
 *  - "min"：任一相关输入即可让输出翻转（与门下降、或门上升等），取最早到达；
 *  - "single"：只有一个输入（非门/输出灯/异或）。
 *
 * 这样同源扇出时也不会把“不可能更晚生效”的支路当成实际瓶颈。
 */
function governedPorts(
  kind: GateKind,
  before: Signal[],
  after: Signal[],
): { rule: "max" | "min" | "single"; ports: number[] } | null {
  const outBefore = gateValue(kind, before);
  const outAfter = gateValue(kind, after);
  if (outBefore === "X" || outAfter === "X" || outBefore === outAfter) return null;
  const rose: number[] = [],
    fell: number[] = [],
    changed: number[] = [];
  for (let port = 0; port < before.length; port++) {
    if (before[port] === after[port]) continue;
    if (before[port] === "X" || after[port] === "X") continue;
    changed.push(port);
    if (after[port] === 1) rose.push(port);
    else fell.push(port);
  }
  if (!changed.length) return null;
  const rising = outAfter === 1;
  if (kind === "NOT" || kind === "OUTPUT")
    return { rule: "single", ports: changed };
  if (kind === "XOR")
    return changed.length === 1
      ? { rule: "single", ports: changed }
      : null;
  if (kind === "AND")
    return rising ? { rule: "max", ports: rose } : { rule: "min", ports: fell };
  if (kind === "NAND")
    return rising ? { rule: "min", ports: fell } : { rule: "max", ports: rose };
  if (kind === "OR")
    return rising ? { rule: "min", ports: rose } : { rule: "max", ports: fell };
  if (kind === "NOR")
    return rising ? { rule: "max", ports: fell } : { rule: "min", ports: rose };
  return null;
}

function governedRule(
  kind: GateKind,
  before: Signal[],
  after: Signal[],
): "max" | "min" | "single" {
  return governedPorts(kind, before, after)?.rule ?? "single";
}

function constantOf(mask: number): 0 | 1 | null {
  const zero = (mask & 1) !== 0,
    one = (mask & 2) !== 0,
    unknown = (mask & 4) !== 0;
  if (zero && !one && !unknown) return 0;
  if (one && !zero && !unknown) return 1;
  return null;
}

function signalBit(value: Signal): number {
  return value === 0 ? 1 : value === 1 ? 2 : 4;
}

interface BestPath {
  time: number;
  path: number[];
  ports: number[];
  event: ActivationEvent;
}

export function analyzeCircuit(
  document: CircuitDocument,
  settings: AnalysisSettings,
): AnalysisReport {
  const delayOf = (kind: GateKind) =>
    settings.gates[kind]?.delay ?? PUBLISHED_DEFAULTS[kind].delay;
  const costOf = (kind: GateKind) =>
    settings.gates[kind]?.cost ?? PUBLISHED_DEFAULTS[kind].cost;

  const byKind = new Map<GateKind, KindCostRow>();
  for (const node of document.nodes) {
    const row = byKind.get(node.kind) ?? {
      kind: node.kind,
      count: 0,
      unit: costOf(node.kind),
      delay: delayOf(node.kind),
      subtotal: 0,
    };
    row.count += 1;
    row.subtotal += row.unit;
    byKind.set(node.kind, row);
  }
  const costByKind = [...byKind.values()];

  const prepared = prepare(document);
  const current =
    "cycle" in prepared ? ({} as Record<string, Signal>) : evaluate(document).values;
  const base: AnalysisReport = {
    complete: false,
    incompleteReason: null,
    incompleteDetail: null,
    totalCost: costByKind.reduce((sum, row) => sum + row.subtotal, 0),
    costByKind,
    outputs: [],
    inputCount: document.nodes.filter((node) => node.kind === "INPUT").length,
    structuralMax: { value: 0, nodeId: null, label: null },
    activatableMax: { value: null, nodeId: null, label: null },
    structuralOverstates: false,
    overBudgetOutputs: [],
    pendingOutputs: [],
    withinOutputs: [],
    noPathOutputs: [],
    constantOutputs: [],
    settings,
    searchedEvents: 0,
    budgetDefault: DEFAULT_BUDGET,
  };

  if ("cycle" in prepared) {
    const outputs = document.nodes
      .filter((node) => node.kind === "OUTPUT")
      .map((node) =>
        pendingOutput(node.id, node.label, current[node.id] ?? "X", settings),
      );
    return {
      ...base,
      outputs,
      pendingOutputs: outputs.map((output) => output.nodeId),
      incompleteReason: "cycle",
      incompleteDetail:
        "电路含反馈环，组合逻辑无法求值。预算判定为“计算未完成”，不是超预算。",
    };
  }

  const p = prepared;
  const structural = structuralLongest(p, delayOf);
  const budgetFor = (nodeId: string) =>
    settings.budgets[nodeId] ?? DEFAULT_BUDGET;

  if (!p.outputs.length)
    return {
      ...base,
      complete: true,
      incompleteDetail: "电路尚无输出指示灯，暂无可分析的目标输出。",
    };

  const blocked = (reason: "too-many-inputs" | "event-budget", detail: string) => {
    const outputs = p.outputs.map((v) => {
      const node = p.nodes[v];
      return pendingOutput(node.id, node.label, current[node.id] ?? "X", settings, {
        structural: structural.time[v],
        structuralPath: structural.path[v].map((i) => p.nodes[i].id),
        structuralPathLabels: structural.path[v].map((i) => p.nodes[i].label),
      });
    });
    return {
      ...base,
      outputs,
      pendingOutputs: outputs.map((output) => output.nodeId),
      incompleteReason: reason,
      incompleteDetail: detail,
    } as AnalysisReport;
  };

  const drivenCount = p.drivenInputs.length;
  if (drivenCount > MAX_INPUTS)
    return blocked(
      "too-many-inputs",
      `有效输入 ${drivenCount} 路，超过单输入翻转穷举上限 ${MAX_INPUTS} 路；预算判定为“计算未完成”。`,
    );
  const configCount = 1 << drivenCount;
  const totalEvents = configCount * Math.max(1, drivenCount);
  if (totalEvents > MAX_EVENTS)
    return blocked(
      "event-budget",
      `需要检查约 ${totalEvents} 个翻转事件，超过上限 ${MAX_EVENTS}；预算判定为“计算未完成”。`,
    );

  const nodeCount = p.nodes.length;
  const seen = new Array<number>(nodeCount).fill(0);
  const best = new Map<number, BestPath>();
  /** 结构最长路径是否在某一事件中真的成为到达瓶颈（到达时间 = 结构时间） */
  const structuralReached = new Map<number, boolean>(
    p.outputs.map((output) => [output, structural.time[output] === 0 && false]),
  );

  const maskValues = new Uint8Array(drivenCount);
  const inputValues = new Uint8Array(drivenCount);
  const before = new Array<Signal>(nodeCount).fill("X");
  const after = new Array<Signal>(nodeCount).fill("X");
  const changed = new Uint8Array(nodeCount);
  const arrival = new Float64Array(nodeCount);
  const predecessor = new Int32Array(nodeCount);
  const predecessorPort = new Int32Array(nodeCount);
  const pinBefore: Signal[] = [];
  const pinAfter: Signal[] = [];
  const channel: number[] = [];
  const stageGoverned: (number[] | null)[] = [];

  for (let mask = 0; mask < configCount; mask++) {
    for (let bit = 0; bit < drivenCount; bit++)
      maskValues[bit] = (mask >> bit) & 1;
    inputValues.set(maskValues);
    evaluateAll(p, inputValues, before);
    for (let v = 0; v < nodeCount; v++) seen[v] |= signalBit(before[v]);

    for (let flip = 0; flip < drivenCount; flip++) {
      inputValues.set(maskValues);
      inputValues[flip] ^= 1;
      evaluateAll(p, inputValues, after);

      for (let v = 0; v < nodeCount; v++)
        changed[v] =
          before[v] !== after[v] && before[v] !== "X" && after[v] !== "X"
            ? 1
            : 0;
      arrival.fill(-1);
      predecessor.fill(-1);
      predecessorPort.fill(-1);

      for (const v of p.order) {
        const node = p.nodes[v];
        if (node.kind === "INPUT") {
          arrival[v] = changed[v] ? delayOf(node.kind) : -1;
          continue;
        }
        const sources = p.pinSource[v];
        pinBefore.length = sources.length;
        pinAfter.length = sources.length;
        for (let port = 0; port < sources.length; port++) {
          const source = sources[port];
          pinBefore[port] = source < 0 ? "X" : before[source];
          pinAfter[port] = source < 0 ? "X" : after[source];
        }
        const governed = governedPorts(node.kind, pinBefore, pinAfter);
        stageGoverned[v] = governed ? governed.ports.slice() : null;
        if (!governed) {
          arrival[v] = -1;
          continue;
        }
        const delay = delayOf(node.kind);
        channel.length = 0;
        for (const port of governed.ports) {
          const from = sources[port];
          if (from >= 0 && changed[from] && arrival[from] >= 0)
            channel.push(port);
        }
        if (!channel.length) {
          arrival[v] = -1;
          continue;
        }
        if (governed.rule === "max" && channel.length !== governed.ports.length) {
          // 需要所有相关输入就位，但有一条来路没有翻转，无法判定稳定时刻
          arrival[v] = -1;
          continue;
        }
        let bestTime = governed.rule === "max" ? -Infinity : Infinity;
        let bestFrom = -1,
          bestPort = -1;
        for (const port of channel) {
          const from = sources[port];
          const candidate = arrival[from] + delay;
          if (
            governed.rule === "max"
              ? candidate > bestTime
              : candidate < bestTime
          ) {
            bestTime = candidate;
            bestFrom = from;
            bestPort = port;
          }
        }
        arrival[v] = bestTime;
        predecessor[v] = bestFrom;
        predecessorPort[v] = bestPort;
      }

      for (const output of p.outputs) {
        if (!changed[output] || arrival[output] < 0) continue;
        if (arrival[output] >= structural.time[output])
          structuralReached.set(output, true);
        const existing = best.get(output);
        if (existing && arrival[output] <= existing.time) continue;
        const path: number[] = [];
        const ports: number[] = [];
        let cursor = output,
          guard = 0;
        while (cursor >= 0 && guard++ <= nodeCount) {
          path.push(cursor);
          const from = predecessor[cursor];
          if (from >= 0) {
            ports.push(predecessorPort[cursor]);
            cursor = from;
          } else cursor = -1;
        }
        path.reverse();
        ports.reverse();
        const root = path[0];
        if (p.nodes[root].kind !== "INPUT") continue;
        if (p.inputPosition.get(root) !== flip) continue;
        const event = buildEvent(
          p,
          before,
          after,
          path,
          ports,
          flip,
          arrival[output],
          arrival,
          path.slice(1).map((index) => stageGoverned[index] ?? null),
        );
        best.set(output, { time: arrival[output], path, ports, event });
      }
    }
  }

  const constantValues = new Map<number, 0 | 1 | null>();
  const hasUnknown = new Map<number, boolean>();
  for (let v = 0; v < nodeCount; v++) {
    constantValues.set(v, constantOf(seen[v]));
    hasUnknown.set(v, (seen[v] & 4) !== 0);
  }

  const outputs: OutputReport[] = p.outputs.map((output) => {
    const node = p.nodes[output];
    const bestEntry = best.get(output);
    const constantValue = constantValues.get(output) ?? null;
    const status: OutputStatusKind = bestEntry
      ? "conditional"
      : constantValue !== null
        ? "constant"
        : hasUnknown.get(output)
          ? "undetermined"
          : "blocked";
    const structuralTime = structural.time[output];
    const budget = budgetFor(node.id);
    const activatable = bestEntry ? bestEntry.time : null;
    const budgetState: BudgetState = !bestEntry
      ? "no-path"
      : bestEntry.time > budget
        ? "over"
        : "within";
    const reached = structuralReached.get(output) ?? false;
    const structuralBlocked = bestEntry !== undefined && !reached;
    const blockedNotes = bestEntry
      ? structuralBlocked
        ? explainStructural(p, structural.path[output], constantValues)
        : []
      : explainNoActivation(
          p,
          output,
          structural.path[output],
          constantValues,
          status,
        );
    const event = bestEntry
      ? {
          ...bestEntry.event,
          structuralBlocked,
          note: structuralBlocked
            ? `结构最长路径 ${structuralTime} 不是实际瓶颈：${blockedNotes.join("；")}。真正可激活的最长路径为 ${bestEntry.time}。`
            : null,
        }
      : null;
    return {
      nodeId: node.id,
      label: node.label,
      status,
      current: current[node.id] ?? "X",
      constantValue,
      structural: structuralTime,
      structuralPath: structural.path[output].map((i) => p.nodes[i].id),
      structuralPathLabels: structural.path[output].map((i) => p.nodes[i].label),
      structuralActivatable: reached,
      activatable,
      activatablePath: bestEntry ? bestEntry.path.map((i) => p.nodes[i].id) : [],
      activatablePathLabels: bestEntry
        ? bestEntry.path.map((i) => p.nodes[i].label)
        : [],
      event,
      blockedNotes,
      budget,
      budgetState,
      headroom: activatable === null ? null : budget - activatable,
      structuralOverBudget: structuralTime > budget,
    };
  });

  let structuralBest = {
    value: 0,
    nodeId: null as string | null,
    label: null as string | null,
  };
  let activatableBest = {
    value: null as number | null,
    nodeId: null as string | null,
    label: null as string | null,
  };
  for (const output of outputs) {
    if (output.structural > structuralBest.value)
      structuralBest = {
        value: output.structural,
        nodeId: output.nodeId,
        label: output.label,
      };
    if (
      output.activatable !== null &&
      (activatableBest.value === null ||
        output.activatable > activatableBest.value)
    )
      activatableBest = {
        value: output.activatable,
        nodeId: output.nodeId,
        label: output.label,
      };
  }
  const structuralOverstates =
    structuralBest.nodeId !== null &&
    (activatableBest.value === null ||
      structuralBest.value > activatableBest.value);

  return {
    ...base,
    complete: true,
    outputs,
    structuralMax: structuralBest,
    activatableMax: activatableBest,
    structuralOverstates,
    overBudgetOutputs: outputs
      .filter((output) => output.budgetState === "over")
      .map((output) => output.nodeId),
    pendingOutputs: [],
    withinOutputs: outputs
      .filter((output) => output.budgetState === "within")
      .map((output) => output.nodeId),
    noPathOutputs: outputs
      .filter((output) => output.budgetState === "no-path")
      .map((output) => output.nodeId),
    constantOutputs: outputs
      .filter((output) => output.status === "constant")
      .map((output) => output.nodeId),
    searchedEvents: totalEvents,
  };
}

function pendingOutput(
  nodeId: string,
  label: string,
  current: Signal,
  settings: AnalysisSettings,
  structural?: {
    structural: number;
    structuralPath: string[];
    structuralPathLabels: string[];
  },
): OutputReport {
  return {
    nodeId,
    label,
    status: "undetermined",
    current,
    constantValue: null,
    structural: structural?.structural ?? 0,
    structuralPath: structural?.structuralPath ?? [],
    structuralPathLabels: structural?.structuralPathLabels ?? [],
    structuralActivatable: false,
    activatable: null,
    activatablePath: [],
    activatablePathLabels: [],
    event: null,
    blockedNotes: [],
    budget: settings.budgets[nodeId] ?? DEFAULT_BUDGET,
    budgetState: "pending",
    headroom: null,
    structuralOverBudget: false,
  };
}

function buildEvent(
  p: Prepared,
  before: Signal[],
  after: Signal[],
  path: number[],
  ports: number[],
  flip: number,
  time: number,
  arrival: Float64Array,
  governed: (number[] | null)[],
): ActivationEvent {
  const root = p.drivenInputs[flip];
  const rootNode = p.nodes[root];
  const inputsBefore = p.drivenInputs.map((index) => ({
    id: p.nodes[index].id,
    label: p.nodes[index].label,
    value: (before[index] === 1 ? 1 : 0) as 0 | 1,
  }));
  const inputsAfter = inputsBefore.map((entry) =>
    entry.id === rootNode.id
      ? { ...entry, value: (entry.value === 1 ? 0 : 1) as 0 | 1 }
      : { ...entry },
  );
  const arrivalStages: ArrivalStage[] = [
    {
      nodeId: rootNode.id,
      label: rootNode.label,
      kind: rootNode.kind,
      time: Math.max(0, arrival[root]),
    },
  ];
  const sideConditions: SideCondition[] = [];
  const wireIds: string[] = [];
  const nodeIds: string[] = [rootNode.id];
  const portList: { nodeId: string; port: number }[] = [];
  for (let i = 1; i < path.length; i++) {
    const to = path[i];
    const port = ports[i - 1];
    const node = p.nodes[to];
    nodeIds.push(node.id);
    portList.push({ nodeId: node.id, port });
    arrivalStages.push({
      nodeId: node.id,
      label: node.label,
      kind: node.kind,
      time: arrival[to] >= 0 ? arrival[to] : time,
    });
    const wire = p.pinWire[to][port];
    if (wire) wireIds.push(wire.id);
    const sources = p.pinSource[to];
    const pinBefore = sources.map((source) =>
      source < 0 ? ("X" as Signal) : before[source],
    );
    const pinAfter = sources.map((source) =>
      source < 0 ? ("X" as Signal) : after[source],
    );
    const active = governed[i];
    const activeSet = new Set(active ?? []);
    const rule = governedRule(node.kind, pinBefore, pinAfter);
    const needsHigh =
      rule === "max" && (node.kind === "AND" || node.kind === "NAND");
    const needsLow =
      rule === "max" && (node.kind === "OR" || node.kind === "NOR");
    for (let q = 0; q < sources.length; q++) {
      if (q === port) continue;
      const source = sources[q];
      const changedPin = source >= 0 && before[source] !== after[source];
      let required: 0 | 1 | "any" = "any";
      let note = "";
      if (changedPin) {
        if (activeSet.has(q) && rule === "max")
          required = (pinAfter[q] === 1 ? 1 : 0) as 0 | 1;
        note = activeSet.has(q)
          ? "与传播脚同源扇出，本次同时翻转，是该门翻转时刻的成因之一"
          : "与传播脚同源扇出，本次一起翻转，但不能独立设置";
      } else if (needsHigh) {
        required = 1;
        note = "须保持高电平，翻转才能通过该门";
      } else if (needsLow) {
        required = 0;
        note = "须保持低电平，翻转才能通过该门";
      } else if (
        pinBefore[q] !== "X" &&
        before.length > 1 &&
        rule !== "single"
      ) {
        note = "不参与决定该门输出翻转的时刻，但电平关系到该门是否放行";
      }
      // 随翻转一起变化的脚，条件针对翻转后的电平；稳定的脚针对翻转前电平。
      const value = changedPin ? pinAfter[q] : pinBefore[q];
      sideConditions.push({
        nodeId: node.id,
        label: node.label,
        port: q,
        required,
        value,
        sourceLabel: source < 0 ? null : p.nodes[source].label,
        changes: changedPin,
        satisfied:
          required === "any" || (value !== "X" && value === required),
        note,
      });
    }
  }
  return {
    inputId: rootNode.id,
    inputLabel: rootNode.label,
    before: (before[root] === 1 ? 1 : 0) as 0 | 1,
    after: (after[root] === 1 ? 1 : 0) as 0 | 1,
    inputsBefore,
    inputsAfter,
    sideConditions,
    arrival: arrivalStages,
    nodeIds,
    wireIds,
    ports: portList,
    time,
    structuralBlocked: false,
    note: null,
  };
}

/** 结构最长路径被阻断 / 高估的原因，尽量具体到门和引脚。 */
function explainStructural(
  p: Prepared,
  path: number[],
  constants: Map<number, 0 | 1 | null>,
): string[] {
  const notes: string[] = [];
  if (path.length <= 1) {
    notes.push(`结构路径起点 ${p.nodes[path[0]].label} 没有上游连线`);
    return notes;
  }
  const root = p.nodes[path[0]];
  if (root.kind !== "INPUT")
    notes.push(`结构路径起点 ${root.label} 不是输入开关，无法由单次翻转驱动`);
  for (let i = 1; i < path.length; i++) {
    const to = path[i],
      from = path[i - 1];
    const node = p.nodes[to];
    const sources = p.pinSource[to];
    const pathPort = sources.findIndex((source) => source === from);
    if (pathPort < 0) continue;
    const bypass = sources
      .map((source, port) => ({ source, port }))
      .filter(({ port }) => port !== pathPort);
    if (
      (node.kind === "AND" || node.kind === "NAND" || node.kind === "OR" || node.kind === "NOR") &&
      bypass.length
    ) {
      const shared = bypass.filter(({ source }) => source === from);
      if (shared.length)
        notes.push(
          `${node.label} 的输入 ${shared.map(({ port }) => port + 1).join("、")} 与传播脚同源，不能独立变化`,
        );
      for (const { source, port } of bypass) {
        if (source === from) continue;
        if (source < 0) {
          notes.push(`${node.label} 的旁路输入 ${port + 1} 悬空`);
          continue;
        }
        const constant = constants.get(source) ?? null;
        if (constant === null) continue;
        if (
          (node.kind === "AND" || node.kind === "NAND") &&
          constant === 0
        )
          notes.push(
            `${node.label} 的旁路输入 ${port + 1}（${p.nodes[source].label}）恒为 0，该门无法输出上升沿`,
          );
        if (
          (node.kind === "OR" || node.kind === "NOR") &&
          constant === 1
        )
          notes.push(
            `${node.label} 的旁路输入 ${port + 1}（${p.nodes[source].label}）恒为 1，该门无法输出下降沿`,
          );
      }
    }
  }
  if (!notes.length)
    notes.push(
      "长支路的逻辑条件在单次输入翻转下无法同时成立（或该门只接受最早到达的翻转），结构值高估了实际延迟",
    );
  return notes;
}

/** 没有可激活路径时的说明：恒定，还是条件无法同时成立。 */
function explainNoActivation(
  p: Prepared,
  output: number,
  structuralPath: number[],
  constants: Map<number, 0 | 1 | null>,
  status: OutputStatusKind,
): string[] {
  if (status === "constant") {
    const value = constants.get(output);
    return [
      `该输出恒为 ${value ?? "X"}，与输入开关的翻转无关，因此不存在可激活路径。`,
      ...explainStructural(p, structuralPath, constants).slice(0, 3),
    ];
  }
  if (status === "undetermined") {
    return [
      "输出含有未确定 X（例如输入脚悬空），无法确认它是否恒定，也无法给出可激活路径。",
    ];
  }
  const notes: string[] = [];
  // 找出同源分叉进入同一门的情况，这是“条件无法同时成立”的典型来源。
  for (const node of p.nodes) {
    if (
      node.kind !== "AND" &&
      node.kind !== "OR" &&
      node.kind !== "NAND" &&
      node.kind !== "NOR" &&
      node.kind !== "XOR"
    )
      continue;
    const sources = p.pinSource[p.index.get(node.id)!].filter((s) => s >= 0);
    const unique = new Set(sources);
    if (unique.size < sources.length)
      notes.push(
        `${node.label} 有两个输入来自同一上游（${p.nodes[sources[0] ?? 0]?.label}），它们只能一起变化，无法独立满足放行条件`,
      );
  }
  for (const node of p.nodes) {
    if (node.kind !== "AND" && node.kind !== "NAND" && node.kind !== "OR" && node.kind !== "NOR")
      continue;
    const index = p.index.get(node.id)!;
    const sources = p.pinSource[index];
    for (let port = 0; port < sources.length; port++) {
      const source = sources[port];
      const constant = source < 0 ? null : constants.get(source) ?? null;
      if (source < 0)
        notes.push(`${node.label} 的输入 ${port + 1} 悬空`);
      else if (
        constant !== null &&
        ((node.kind === "AND" || node.kind === "NAND") && constant === 0)
      )
        notes.push(
          `${node.label} 的输入 ${port + 1}（${p.nodes[source].label}）恒为 0，该门被恒定阻断`,
        );
      else if (
        constant !== null &&
        ((node.kind === "OR" || node.kind === "NOR") && constant === 1)
      )
        notes.push(
          `${node.label} 的输入 ${port + 1}（${p.nodes[source].label}）恒为 1，该门被恒定阻断`,
        );
    }
  }
  if (!notes.length)
    notes.push("没有任何一次单输入翻转能同时满足路径上各门的放行条件。");
  return [...new Set(notes)].slice(0, 6);
}

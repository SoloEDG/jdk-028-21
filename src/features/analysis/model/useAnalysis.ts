import { computed, ref, type Ref } from "vue";
import type {
  AnalysisVersion,
  AnalysisVersionOutput,
  CircuitDocument,
  GateKind,
} from "@/shared/types";
import { createId } from "@/shared/document";
import { analyzeCircuit, type AnalysisReport, type OutputReport } from "../lib/analyze";
import {
  BUDGET_LIMITS,
  COST_LIMITS,
  DELAY_LIMITS,
  cloneSettings,
  clampInt,
  publishedDefaults,
} from "../lib/defaults";

export interface VersionRow {
  nodeId: string;
  label: string;
  previous: AnalysisVersionOutput | null;
  current: AnalysisVersionOutput;
  budgetDelta: number;
  structuralDelta: number;
  activatableDelta: number | null;
  headroomDelta: number | null;
  stateChanged: boolean;
}

export interface VersionComparison {
  version: AnalysisVersion;
  totalCostDelta: number;
  structuralDelta: number;
  activatableDelta: number | null;
  rows: VersionRow[];
}

export function circuitFingerprint(document: CircuitDocument): string {
  const nodes = document.nodes
    .map((node) => `${node.id}:${node.kind}:${node.label}`)
    .join("|");
  const wires = document.wires
    .map(
      (wire) =>
        `${wire.from.nodeId}.${wire.from.port}>${wire.to.nodeId}.${wire.to.port}`,
    )
    .join("|");
  let hash = 2166136261;
  const text = `${nodes}#${wires}`;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function summarizeOutput(output: OutputReport): AnalysisVersionOutput {
  return {
    nodeId: output.nodeId,
    label: output.label,
    budget: output.budget,
    structural: output.structural,
    activatable: output.activatable,
    budgetState: output.budgetState,
    status: output.status,
  };
}

export function versionFromReport(
  document: CircuitDocument,
  report: AnalysisReport,
  label: string,
): AnalysisVersion {
  return {
    id: createId("version"),
    label,
    createdAt: new Date().toISOString(),
    fingerprint: circuitFingerprint(document),
    settings: cloneSettings(document.analysis),
    totals: {
      totalCost: report.totalCost,
      structuralMax: report.structuralMax.value,
      activatableMax: report.activatableMax.value,
      complete: report.complete,
    },
    outputs: report.outputs.map(summarizeOutput),
  };
}

export function useAnalysis(
  document: Ref<CircuitDocument>,
  selected: Ref<string | null>,
) {
  const report = computed(() =>
    analyzeCircuit(document.value, document.value.analysis),
  );
  const activeOutputId = ref<string | null>(null);
  const activeVersionId = ref<string | null>(null);

  const outputs = computed(() => report.value.outputs);

  const activeOutput = computed<OutputReport | null>(() => {
    if (!activeOutputId.value) return null;
    return (
      outputs.value.find(
        (output) => output.nodeId === activeOutputId.value,
      ) ?? null
    );
  });

  const highlight = computed<{
    nodeIds: Set<string>;
    wireIds: Set<string>;
    outputId: string | null;
    active: boolean;
  }>(() => {
    const output = activeOutput.value;
    const event = output?.event;
    if (!output || !event)
      return {
        nodeIds: new Set<string>(),
        wireIds: new Set<string>(),
        outputId: null,
        active: false,
      };
    return {
      nodeIds: new Set(event.nodeIds),
      wireIds: new Set(event.wireIds),
      outputId: output.nodeId,
      active: true,
    };
  });

  function focusOutput(nodeId: string) {
    activeOutputId.value = nodeId;
    selected.value = nodeId;
  }

  function toggleHighlight(nodeId: string) {
    if (activeOutputId.value === nodeId) activeOutputId.value = null;
    else focusOutput(nodeId);
  }

  function setCost(kind: GateKind, value: number) {
    document.value.analysis.gates[kind].cost = clampInt(
      value,
      COST_LIMITS.min,
      COST_LIMITS.max,
    );
  }
  function setDelay(kind: GateKind, value: number) {
    document.value.analysis.gates[kind].delay = clampInt(
      value,
      DELAY_LIMITS.min,
      DELAY_LIMITS.max,
    );
  }
  function setBudget(nodeId: string, value: number) {
    document.value.analysis.budgets[nodeId] = clampInt(
      value,
      BUDGET_LIMITS.min,
      BUDGET_LIMITS.max,
    );
  }
  function budgetOf(nodeId: string): number {
    return (
      document.value.analysis.budgets[nodeId] ??
      report.value.outputs.find((output) => output.nodeId === nodeId)?.budget ??
      report.value.budgetDefault
    );
  }
  function resetDefaults() {
    const budgets = document.value.analysis.budgets;
    document.value.analysis = publishedDefaults();
    for (const [nodeId, value] of Object.entries(budgets)) {
      if (document.value.nodes.some((node) => node.id === nodeId))
        document.value.analysis.budgets[nodeId] = value;
    }
  }

  const versions = computed<AnalysisVersion[]>(
    () => document.value.analysisVersions ?? [],
  );

  function snapshot(label?: string) {
    const version = versionFromReport(
      document.value,
      report.value,
      label?.trim() ||
        `版本 ${versions.value.length + 1} · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`,
    );
    document.value.analysisVersions = [...versions.value, version].slice(-20);
    activeVersionId.value = version.id;
    return version;
  }

  function selectVersion(id: string) {
    activeVersionId.value = id;
  }

  function removeVersion(id: string) {
    document.value.analysisVersions = versions.value.filter(
      (version) => version.id !== id,
    );
    if (activeVersionId.value === id) activeVersionId.value = null;
  }

  const activeVersion = computed<AnalysisVersion | null>(() => {
    const list = versions.value;
    const found = list.find((version) => version.id === activeVersionId.value);
    return found ?? list[list.length - 1] ?? null;
  });

  const comparison = computed<VersionComparison | null>(() => {
    const version = activeVersion.value;
    if (!version) return null;
    const currentByOutput = new Map(
      outputs.value.map((output) => [output.nodeId, summarizeOutput(output)]),
    );
    const rows: VersionRow[] = [];
    const seen = new Set<string>();
    for (const previous of version.outputs) {
      const current = currentByOutput.get(previous.nodeId);
      if (!current) continue;
      seen.add(previous.nodeId);
      rows.push(compareRow(previous, current));
    }
    for (const current of currentByOutput.values()) {
      if (seen.has(current.nodeId)) continue;
      rows.push(compareRow(null, current));
    }
    return {
      version,
      totalCostDelta: report.value.totalCost - version.totals.totalCost,
      structuralDelta:
        report.value.structuralMax.value - version.totals.structuralMax,
      activatableDelta:
        report.value.activatableMax.value === null ||
        version.totals.activatableMax === null
          ? null
          : report.value.activatableMax.value - version.totals.activatableMax,
      rows,
    };
  });

  function versionSettingsSummary(version: AnalysisVersion): string {
    return Object.entries(version.settings.gates)
      .map(([kind, profile]) => `${kind} ${profile.cost}/${profile.delay}`)
      .join(" · ");
  }

  return {
    report,
    outputs,
    activeOutputId,
    activeOutput,
    activeVersion,
    activeVersionId,
    comparison,
    highlight,
    versions,
    focusOutput,
    toggleHighlight,
    setCost,
    setDelay,
    setBudget,
    budgetOf,
    resetDefaults,
    snapshot,
    selectVersion,
    removeVersion,
    versionSettingsSummary,
    fingerprint: computed(() => circuitFingerprint(document.value)),
  };
}

export function compareRow(
  previous: AnalysisVersionOutput | null,
  current: AnalysisVersionOutput,
): VersionRow {
  const activatableDelta =
    previous === null || previous.activatable === null || current.activatable === null
      ? null
      : current.activatable - previous.activatable;
  const headroom = (value: AnalysisVersionOutput) =>
    value.activatable === null ? null : value.budget - value.activatable;
  const previousHeadroom = previous ? headroom(previous) : null;
  const currentHeadroom = headroom(current);
  return {
    nodeId: current.nodeId,
    label: current.label,
    previous,
    current,
    budgetDelta: previous ? current.budget - previous.budget : 0,
    structuralDelta: previous ? current.structural - previous.structural : 0,
    activatableDelta,
    headroomDelta:
      previousHeadroom === null || currentHeadroom === null
        ? null
        : currentHeadroom - previousHeadroom,
    stateChanged:
      previous !== null &&
      (previous.budgetState !== current.budgetState ||
        previous.status !== current.status),
  };
}


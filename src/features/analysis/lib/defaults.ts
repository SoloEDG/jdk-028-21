import type {
  AnalysisSettings,
  AnalysisVersion,
  AnalysisVersionOutput,
  GateCostProfile,
  GateKind,
} from "@/shared/types";

/**
 * 公布的默认代价表。旧存档（没有 analysis 字段的文档）一律使用这里的数值，
 * 因此历史实验在打开后仍能得到可复现的成本报告。
 * 单位：成本为任意一致的成本单位，延迟为同一时间单位（纳秒量级）。
 */
export const PUBLISHED_DEFAULTS: Readonly<
  Record<GateKind, Readonly<GateCostProfile>>
> = Object.freeze({
  INPUT: Object.freeze({ cost: 1, delay: 0 }),
  OUTPUT: Object.freeze({ cost: 1, delay: 1 }),
  NOT: Object.freeze({ cost: 1, delay: 1 }),
  AND: Object.freeze({ cost: 2, delay: 2 }),
  OR: Object.freeze({ cost: 2, delay: 2 }),
  NAND: Object.freeze({ cost: 2, delay: 2 }),
  NOR: Object.freeze({ cost: 2, delay: 2 }),
  XOR: Object.freeze({ cost: 3, delay: 3 }),
});

export const DEFAULT_BUDGET = 24;

export const COST_LIMITS = { min: 0, max: 999, maxTotal: 999_999 } as const;
export const DELAY_LIMITS = { min: 0, max: 99 } as const;
export const BUDGET_LIMITS = { min: 0, max: 99_999 } as const;

export function isGateKind(value: unknown): value is GateKind {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(PUBLISHED_DEFAULTS, value)
  );
}

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function publishedDefaults(): AnalysisSettings {
  const gates = {} as Record<GateKind, GateCostProfile>;
  for (const kind of Object.keys(PUBLISHED_DEFAULTS) as GateKind[])
    gates[kind] = { ...PUBLISHED_DEFAULTS[kind] };
  return { gates, budgets: {} };
}

export function sanitizeSettings(value: unknown): AnalysisSettings {
  const fallback = publishedDefaults();
  if (!value || typeof value !== "object") return fallback;
  const raw = value as Record<string, unknown>;
  const gates = {} as Record<GateKind, GateCostProfile>;
  const rawGates =
    raw.gates && typeof raw.gates === "object"
      ? (raw.gates as Record<string, unknown>)
      : {};
  for (const kind of Object.keys(PUBLISHED_DEFAULTS) as GateKind[]) {
    const base = PUBLISHED_DEFAULTS[kind];
    const entry =
      rawGates[kind] && typeof rawGates[kind] === "object"
        ? (rawGates[kind] as Record<string, unknown>)
        : {};
    gates[kind] = {
      cost: clampInt(
        Number(entry.cost ?? base.cost),
        COST_LIMITS.min,
        COST_LIMITS.max,
      ),
      delay: clampInt(
        Number(entry.delay ?? base.delay),
        DELAY_LIMITS.min,
        DELAY_LIMITS.max,
      ),
    };
  }
  const budgets: Record<string, number> = {};
  if (raw.budgets && typeof raw.budgets === "object")
    for (const [nodeId, budget] of Object.entries(
      raw.budgets as Record<string, unknown>,
    )) {
      const numeric = Number(budget);
      if (Number.isFinite(numeric))
        budgets[nodeId] = clampInt(
          numeric,
          BUDGET_LIMITS.min,
          BUDGET_LIMITS.max,
        );
    }
  return { gates, budgets };
}

export function sanitizeVersions(value: unknown): AnalysisVersion[] {
  if (!Array.isArray(value)) return [];
  const versions: AnalysisVersion[] = [];
  for (const item of value.slice(-40)) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string" || !entry.id || entry.id.length > 100)
      continue;
    if (versions.some((version) => version.id === entry.id)) continue;
    const totals = (entry.totals ?? {}) as Record<string, unknown>;
    const rawOutputs = Array.isArray(entry.outputs) ? entry.outputs : [];
    const outputs: AnalysisVersionOutput[] = [];
    for (const raw of rawOutputs.slice(0, 200)) {
      if (!raw || typeof raw !== "object") continue;
      const output = raw as Record<string, unknown>;
      if (typeof output.nodeId !== "string" || !output.nodeId) continue;
      const budget = Number(output.budget);
      const structural = Number(output.structural);
      const activatable =
        output.activatable === null ? null : Number(output.activatable);
      outputs.push({
        nodeId: output.nodeId,
        label:
          typeof output.label === "string" ? output.label.slice(0, 40) : "输出",
        budget: Number.isFinite(budget) ? Math.max(0, Math.round(budget)) : 0,
        structural: Number.isFinite(structural)
          ? Math.max(0, Math.round(structural))
          : 0,
        activatable:
          activatable === null || !Number.isFinite(activatable)
            ? null
            : Math.max(0, Math.round(activatable)),
        budgetState: versionBudgetState(output.budgetState),
        status: versionStatus(output.status),
      });
    }
    versions.push({
      id: entry.id,
      label:
        typeof entry.label === "string" && entry.label
          ? entry.label.slice(0, 80)
          : "分析版本",
      createdAt:
        typeof entry.createdAt === "string" && entry.createdAt
          ? entry.createdAt.slice(0, 40)
          : new Date(0).toISOString(),
      fingerprint:
        typeof entry.fingerprint === "string"
          ? entry.fingerprint.slice(0, 40)
          : "",
      settings: sanitizeSettings(entry.settings),
      totals: {
        totalCost: numericOr(totals.totalCost, 0),
        structuralMax: numericOr(totals.structuralMax, 0),
        activatableMax:
          totals.activatableMax === null
            ? null
            : numericOr(totals.activatableMax, 0),
        complete: totals.complete !== false,
      },
      outputs,
    });
  }
  return versions;
}

function numericOr(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : fallback;
}

function versionBudgetState(value: unknown): AnalysisVersionOutput["budgetState"] {
  return value === "pending" || value === "no-path" || value === "within" || value === "over"
    ? value
    : "pending";
}

function versionStatus(value: unknown): AnalysisVersionOutput["status"] {
  return value === "conditional" ||
    value === "constant" ||
    value === "blocked" ||
    value === "undetermined"
    ? value
    : "undetermined";
}

export function cloneSettings(settings: AnalysisSettings): AnalysisSettings {
  return JSON.parse(JSON.stringify(settings)) as AnalysisSettings;
}

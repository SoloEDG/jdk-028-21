export type Signal = 0 | 1 | "X";
export type GateKind =
  "INPUT" | "OUTPUT" | "AND" | "OR" | "XOR" | "NOT" | "NAND" | "NOR";
export interface Point {
  x: number;
  y: number;
}
export interface GateNode extends Point {
  id: string;
  kind: GateKind;
  label: string;
  value: 0 | 1;
}
export interface Endpoint {
  nodeId: string;
  port: number;
}
export interface Wire {
  id: string;
  from: Endpoint;
  to: Endpoint;
}
export interface GateCostProfile {
  /** 每个实例计入总成本的代价 */
  cost: number;
  /** 任意输入脚到本门输出的传播延迟 */
  delay: number;
}
export interface AnalysisSettings {
  gates: Record<GateKind, GateCostProfile>;
  /** 目标输出节点 id -> 最长传播预算 */
  budgets: Record<string, number>;
}
export interface AnalysisVersionOutput {
  nodeId: string;
  label: string;
  budget: number;
  structural: number;
  activatable: number | null;
  budgetState: "pending" | "no-path" | "within" | "over";
  status: "conditional" | "constant" | "blocked" | "undetermined";
}
export interface AnalysisVersion {
  id: string;
  label: string;
  createdAt: string;
  /** 记录版本时的电路指纹，用于提示“电路已改动” */
  fingerprint: string;
  settings: AnalysisSettings;
  totals: {
    totalCost: number;
    structuralMax: number;
    activatableMax: number | null;
    complete: boolean;
  };
  outputs: AnalysisVersionOutput[];
}
export interface CircuitDocument {
  version: 1;
  name: string;
  nodes: GateNode[];
  wires: Wire[];
  targetId: string;
  analysis: AnalysisSettings;
  analysisVersions?: AnalysisVersion[];
}
export interface GateSpec {
  kind: GateKind;
  name: string;
  symbol: string;
  inputs: number;
  outputs: number;
  description: string;
}
export interface SimulationResult {
  values: Record<string, Signal>;
  pins: Record<string, Signal[]>;
  wires: Record<string, Signal>;
  order: string[];
}

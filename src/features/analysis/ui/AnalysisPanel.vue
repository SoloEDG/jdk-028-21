<script setup lang="ts">
import { computed, ref } from "vue";
import type {
  AnalysisVersion,
  CircuitDocument,
  GateKind,
} from "@/shared/types";
import type { AnalysisReport, OutputReport } from "../lib/analyze";
import type { VersionComparison } from "../model/useAnalysis";
import { PUBLISHED_DEFAULTS } from "../lib/defaults";
import { getSpec } from "@/features/catalog";

const props = defineProps<{
  document: CircuitDocument;
  report: AnalysisReport;
  outputs: OutputReport[];
  activeOutputId: string | null;
  activeVersion: AnalysisVersion | null;
  activeVersionId: string | null;
  comparison: VersionComparison | null;
  versions: AnalysisVersion[];
  fingerprint: string;
}>();
const emit = defineEmits<{
  focus: [nodeId: string];
  toggle: [nodeId: string];
  "update-budget": [nodeId: string, value: number];
  "update-cost": [kind: GateKind, value: number];
  "update-delay": [kind: GateKind, value: number];
  "reset-defaults": [];
  snapshot: [label: string];
  "select-version": [id: string];
  "remove-version": [id: string];
}>();

const tab = ref<"outputs" | "settings" | "versions">("outputs");
const versionLabel = ref("");

const STATUS_TEXT: Record<OutputReport["status"], string> = {
  conditional: "存在可激活路径",
  constant: "输出恒定",
  blocked: "条件无法同时成立",
  undetermined: "含未确定 X",
};
const BUDGET_TEXT: Record<OutputReport["budgetState"], string> = {
  pending: "计算未完成",
  "no-path": "无可激活路径",
  within: "预算内",
  over: "超预算",
};
const KIND_ORDER: GateKind[] = [
  "INPUT",
  "OUTPUT",
  "NOT",
  "AND",
  "OR",
  "NAND",
  "NOR",
  "XOR",
];

function kindName(kind: GateKind): string {
  return getSpec(kind).name;
}
function signed(value: number, unit = ""): string {
  if (value === 0) return `±0${unit}`;
  return `${value > 0 ? "+" : ""}${value}${unit}`;
}
function stateLabel(state: string): string {
  return (
    {
      pending: "计算未完成",
      "no-path": "无可激活路径",
      within: "预算内",
      over: "超预算",
    } as Record<string, string>
  )[state] ?? state;
}

const settings = computed(() => props.document.analysis);
const budgetRows = computed(() =>
  props.outputs.map((output) => ({
    nodeId: output.nodeId,
    label: output.label,
    budget: output.budget,
    structural: output.structural,
    activatable: output.activatable,
    state: output.budgetState,
  })),
);
const currentTotals = computed(() => ({
  cost: props.report.totalCost,
  structural: props.report.structuralMax,
  activatable: props.report.activatableMax,
}));

function saveVersion() {
  emit("snapshot", versionLabel.value);
  versionLabel.value = "";
}
function onChangeNumber(event: Event, apply: (value: number) => void) {
  const value = Number((event.target as HTMLInputElement).value);
  apply(Number.isFinite(value) ? value : 0);
}
</script>

<template>
  <aside class="analysis panel">
    <div class="panel-heading"><span>电路代价</span><small>COST / TIMING</small></div>
    <div class="analysis-tabs" role="tablist">
      <button
        role="tab"
        :aria-selected="tab === 'outputs'"
        :class="{ active: tab === 'outputs' }"
        @click="tab = 'outputs'"
      >
        目标输出
      </button>
      <button
        role="tab"
        :aria-selected="tab === 'settings'"
        :class="{ active: tab === 'settings' }"
        @click="tab = 'settings'"
      >
        代价与预算
      </button>
      <button
        role="tab"
        :aria-selected="tab === 'versions'"
        :class="{ active: tab === 'versions' }"
        @click="tab = 'versions'"
      >
        版本对比
      </button>
    </div>

    <div class="cost-summary">
      <div>
        <small>总成本</small><strong>{{ currentTotals.cost }}</strong>
      </div>
      <div>
        <small>结构最长</small
        ><strong>{{ currentTotals.structural.value }}</strong
        ><em>{{ currentTotals.structural.label ?? "—" }}</em>
      </div>
      <div>
        <small>可激活最长</small
        ><strong>{{
          currentTotals.activatable.value === null
            ? "—"
            : currentTotals.activatable.value
        }}</strong
        ><em>{{ currentTotals.activatable.label ?? "—" }}</em>
      </div>
    </div>
    <p
      v-if="report.structuralOverstates"
      class="inline-warning"
      role="note"
    >
      结构最长路径比可激活路径更长：长支路被恒定阻断或同源分叉卡住，不能当作实际瓶颈。
    </p>

    <template v-if="tab === 'outputs'">
      <p v-if="!outputs.length" class="panel-help">
        添加一个“输出指示灯”后，这里会给出每个目标输出的成本与传播预算报告。
      </p>
      <p v-else-if="!report.complete" class="inline-error">
        分析未完成：{{ report.incompleteDetail }}
      </p>
      <div v-for="output in outputs" :key="output.nodeId" class="output-card">
        <button
          class="output-card-head"
          :class="{ highlight: activeOutputId === output.nodeId }"
          :aria-pressed="activeOutputId === output.nodeId"
          @click="emit('toggle', output.nodeId)"
        >
          <b>{{ output.label }}</b>
          <span class="badge" :class="`budget-${output.budgetState}`">{{
            BUDGET_TEXT[output.budgetState]
          }}</span>
          <span class="badge status" :class="`status-${output.status}`">{{
            STATUS_TEXT[output.status]
          }}</span>
        </button>
        <dl class="metric-grid">
          <div>
            <dt>结构最长</dt>
            <dd>{{ output.structural }}</dd>
          </div>
          <div>
            <dt>可激活最长</dt>
            <dd>
              {{ output.activatable === null ? "—" : output.activatable }}
            </dd>
          </div>
          <div>
            <dt>预算</dt>
            <dd>{{ output.budget }}</dd>
          </div>
          <div>
            <dt>余量</dt>
            <dd
              :class="{
                negative: output.headroom !== null && output.headroom < 0,
              }"
            >
              {{ output.headroom === null ? "—" : signed(output.headroom) }}
            </dd>
          </div>
        </dl>

        <p
          v-if="output.budgetState === 'over'"
          class="inline-error"
          role="status"
        >
          可激活路径 {{ output.activatable }} 超过预算 {{ output.budget }}，超时
          {{ (output.activatable ?? 0) - output.budget }}。逻辑正确也算超预算。
        </p>
        <p
          v-else-if="output.structuralOverBudget"
          class="inline-note"
          role="status"
        >
          结构路径 {{ output.structural }} 超过预算，但它不可激活；按可激活路径
          {{ output.activatable }} 判定为{{ BUDGET_TEXT[output.budgetState] }}。
        </p>

        <div v-if="output.status !== 'conditional'" class="explain">
          <p v-for="(note, i) in output.blockedNotes" :key="i">{{ note }}</p>
        </div>

        <div v-if="output.event" class="event-block">
          <div class="event-head">
            <b>可激活事件</b
            ><span
              >翻转 {{ output.event.inputLabel }}：{{
                output.event.before
              }}
              → {{ output.event.after }}</span
            >
          </div>
          <p class="event-inputs">
            <span
              v-for="entry in output.event.inputsBefore"
              :key="entry.id"
              :class="{ flipped: entry.id === output.event.inputId }"
              >{{ entry.label }}={{ entry.value }}</span
            >
            →
            <span
              v-for="entry in output.event.inputsAfter"
              :key="entry.id"
              :class="{ flipped: entry.id === output.event.inputId }"
              >{{ entry.label }}={{ entry.value }}</span
            >
          </p>
          <p v-if="output.event.note" class="inline-warning">
            {{ output.event.note }}
          </p>
          <div v-if="output.event.sideConditions.length" class="side-list">
            <b>旁路条件</b>
            <ul>
              <li
                v-for="(cond, i) in output.event.sideConditions"
                :key="i"
                :class="{ satisfied: cond.satisfied, unsatisfied: !cond.satisfied }"
              >
                {{ cond.label }} IN{{ cond.port + 1 }} 需为
                {{ cond.required === "any" ? "任意" : cond.required }}，
                实际 {{ cond.value
                }}<span v-if="cond.sourceLabel">（来自 {{ cond.sourceLabel }}）</span
                >{{ cond.note ? ` · ${cond.note}` : "" }}
              </li>
            </ul>
          </div>
          <ol class="arrival-list">
            <li
              v-for="stage in output.event.arrival"
              :key="stage.nodeId"
              :style="{ marginLeft: `${Math.min(stage.time, 40) * 2}px` }"
            >
              <b>{{ stage.label }}</b>
              <span>{{ kindName(stage.kind) }}</span>
              <em>t={{ stage.time }}</em>
            </li>
          </ol>
          <button class="text-button" @click="emit('focus', output.nodeId)">
            在画布高亮此路径
          </button>
        </div>

        <div v-if="output.structuralPath.length > 1" class="structural-note">
          <span>结构路径：{{ output.structuralPathLabels.join(" → ") }}</span>
        </div>
        <div class="budget-edit">
          <label
            >此输出预算
            <input
              type="number"
              min="0"
              max="99999"
              :value="output.budget"
              @change="
                onChangeNumber($event, (value) =>
                  emit('update-budget', output.nodeId, value),
                )
              "
            />
          </label>
        </div>
      </div>
    </template>

    <template v-else-if="tab === 'settings'">
      <p class="panel-help">
        调整门成本与延迟不会改变电路逻辑，只影响本次分析；改动会随实验保存。
      </p>
      <table class="cost-table">
        <thead>
          <tr>
            <th>元件</th>
            <th>数量</th>
            <th>单件成本</th>
            <th>输入→输出延迟</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="kind in KIND_ORDER" :key="kind">
            <td>
              {{ kindName(kind) }}<small>{{ kind }}</small>
            </td>
            <td>{{ report.costByKind.find((r) => r.kind === kind)?.count ?? 0 }}</td>
            <td>
              <input
                type="number"
                min="0"
                max="999"
                :aria-label="`${kindName(kind)} 单件成本`"
                :value="settings.gates[kind].cost"
                @change="
                  onChangeNumber($event, (value) => emit('update-cost', kind, value))
                "
              />
            </td>
            <td>
              <input
                type="number"
                min="0"
                max="99"
                :aria-label="`${kindName(kind)} 延迟`"
                :value="settings.gates[kind].delay"
                @change="
                  onChangeNumber($event, (value) => emit('update-delay', kind, value))
                "
              />
            </td>
          </tr>
        </tbody>
      </table>
      <div class="budget-table">
        <div class="table-heading">每个目标输出的最长传播预算</div>
        <label v-for="row in budgetRows" :key="row.nodeId">
          <span>{{ row.label }}</span
          ><input
            type="number"
            min="0"
            max="99999"
            :value="row.budget"
            @change="
              onChangeNumber($event, (value) =>
                emit('update-budget', row.nodeId, value),
              )
            "
          /><em>{{ stateLabel(row.state) }}</em>
        </label>
      </div>
      <p class="small-note">
        默认预算 {{ report.budgetDefault }}；默认代价与延迟为公布值：{{
          KIND_ORDER.map(
            (kind) =>
              `${kind} ${PUBLISHED_DEFAULTS[kind].cost}/${PUBLISHED_DEFAULTS[kind].delay}`,
          ).join("，")
        }}。
      </p>
      <button class="text-button" @click="emit('reset-defaults')">
        恢复公布默认代价（保留各输出预算）
      </button>
    </template>

    <template v-else>
      <div class="version-save">
        <input
          v-model="versionLabel"
          maxlength="80"
          placeholder="版本备注（可选）"
          aria-label="分析版本备注"
        /><button class="primary" @click="saveVersion">保存当前分析</button>
      </div>
      <p v-if="!versions.length" class="panel-help">
        保存一次分析后，改动门成本或预算即可与旧版本逐项对比。
      </p>
      <div v-else class="version-list">
        <button
          v-for="version in versions"
          :key="version.id"
          class="version-row"
          :class="{ active: version.id === activeVersionId }"
          @click="emit('select-version', version.id)"
        >
          <b>{{ version.label }}</b>
          <small
            >成本 {{ version.totals.totalCost }} · 结构
            {{ version.totals.structuralMax }} · 可激活
            {{
              version.totals.activatableMax === null
                ? "—"
                : version.totals.activatableMax
            }}</small
          >
          <span
            v-if="version.fingerprint !== fingerprint"
            class="badge status-blocked"
            >电路已改动</span
          >
        </button>
      </div>
      <div v-if="comparison" class="comparison">
        <div class="table-heading">
          对比：{{ comparison.version.label }} → 当前
          <button
            class="text-button inline"
            @click="emit('remove-version', comparison.version.id)"
          >
            删除此版本
          </button>
        </div>
        <p class="delta-line">
          总成本 {{ signed(comparison.totalCostDelta) }} · 结构最长
          {{ signed(comparison.structuralDelta) }} · 可激活最长
          {{
            comparison.activatableDelta === null
              ? "—"
              : signed(comparison.activatableDelta)
          }}
        </p>
        <table class="version-table">
          <thead>
            <tr>
              <th>输出</th>
              <th>可激活</th>
              <th>预算</th>
              <th>余量</th>
              <th>结论</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in comparison.rows" :key="row.nodeId">
              <td>{{ row.label }}</td>
              <td>
                {{
                  row.previous?.activatable === null ||
                  row.previous?.activatable === undefined
                    ? "—"
                    : row.previous.activatable
                }}
                →
                {{ row.current.activatable === null ? "—" : row.current.activatable }}
                <small v-if="row.activatableDelta !== null">{{
                  signed(row.activatableDelta)
                }}</small>
              </td>
              <td>
                {{
                  row.previous ? row.previous.budget : "—"
                }}
                → {{ row.current.budget }}
                <small v-if="row.budgetDelta">{{
                  signed(row.budgetDelta)
                }}</small>
              </td>
              <td>
                <small v-if="row.headroomDelta !== null">{{
                  signed(row.headroomDelta)
                }}</small>
                <small v-else>—</small>
              </td>
              <td>
                <span
                  class="badge"
                  :class="`budget-${row.current.budgetState}`"
                  >{{ stateLabel(row.current.budgetState) }}</span
                >
                <em v-if="row.stateChanged" class="state-change">结论改变</em>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </aside>
</template>

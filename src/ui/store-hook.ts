// 全局 store 单例 + React 订阅 hook + 展示辅助。
// 离线优先：localStorage 持久化，无网络依赖。

import { useSyncExternalStore } from "react";
import { createStore, type Store } from "../domain/store";
import { evalTankRisk } from "../domain/engine";
import {
  ACTION_LABEL,
  RISK_LABEL,
  SPECIES_LABEL,
  STATUS_LABEL,
  TANK_TYPE_LABEL,
  type Case,
  type EventPayload,
  type FishSpecies,
  type Tank,
  type TankType,
  type TimelineEvent,
} from "../domain/types";

export const store: Store = createStore();

export function useStore(): {
  state: ReturnType<Store["getState"]>;
  revision: number;
} {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const revision = useSyncExternalStore(
    store.subscribe,
    store.getRevision,
    store.getRevision,
  );
  return { state, revision };
}

// ---------- 格式化 ----------

export function dt(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function riskClass(level: string): string {
  return level === "danger" ? "r-danger" : level === "watch" ? "r-watch" : "r-ok";
}

export function tankRiskView(tank: Tank, state: ReturnType<Store["getState"]>) {
  const groups = state.groups.filter((g) => g.tankId === tank.id);
  return evalTankRisk(tank, groups, state.tests);
}

export function latestTest(tankId: string, state: ReturnType<Store["getState"]>) {
  return state.tests
    .filter((t) => t.tankId === tankId)
    .sort((a, b) => b.at - a.at)[0];
}

export const TANK_TYPE_OPTIONS = Object.entries(TANK_TYPE_LABEL) as [TankType, string][];
export const SPECIES_OPTIONS = Object.entries(SPECIES_LABEL) as [FishSpecies, string][];

export const READING_FIELDS: { key: "ph" | "ammonia" | "nitrite" | "nitrate" | "temp"; label: string; unit: string; step: string }[] = [
  { key: "ph", label: "pH", unit: "", step: "0.01" },
  { key: "ammonia", label: "氨氮", unit: "ppm", step: "0.001" },
  { key: "nitrite", label: "亚硝酸盐", unit: "ppm", step: "0.01" },
  { key: "nitrate", label: "硝酸盐", unit: "ppm", step: "1" },
  { key: "temp", label: "水温", unit: "℃", step: "0.1" },
];

export const SYMPTOM_OPTIONS = [
  { key: "whiteSpot", label: "白点病" },
  { key: "fungus", label: "白膜/水霉" },
  { key: "finRot", label: "烂鳍" },
];

export function actionSummary(p: Extract<EventPayload, { type: never }> | EventPayload): string {
  switch (p.type) {
    case "tankCreated":
      return `新建鱼缸「${p.tank.name}」（${TANK_TYPE_LABEL[p.tank.type]}，${p.tank.volumeL}L）`;
    case "tankDeleted":
      return `删除鱼缸 ${p.tankId}`;
    case "groupCreated":
      return `新增鱼群：${SPECIES_LABEL[p.group.species]} ×${p.group.count}`;
    case "groupMoved":
      return `跨缸转移鱼群 ${p.groupId}：${p.fromTankId} → ${p.toTankId}`;
    case "groupDeleted":
      return `移出鱼群 ${p.groupId}`;
    case "testAdded": {
      const r = p.test.readings;
      const parts = [
        r.ph !== undefined ? `pH ${r.ph}` : "",
        r.ammonia !== undefined ? `氨氮 ${r.ammonia}` : "",
        r.nitrite !== undefined ? `亚硝 ${r.nitrite}` : "",
        r.nitrate !== undefined ? `硝酸 ${r.nitrate}` : "",
        r.temp !== undefined ? `水温 ${r.temp}℃` : "",
      ].filter(Boolean);
      return `登记检测：${parts.join("，") || "无读数"}${p.test.symptoms?.length ? "；症状：" + p.test.symptoms.join("、") : ""}`;
    }
    case "caseSuggested":
      return `生成处置建议：${p.caseData.title}（${RISK_LABEL[p.caseData.risk]}，${p.caseData.actions.map((a) => ACTION_LABEL[a.kind]).join("、")}）`;
    case "caseTransition":
      return `工单流转：${STATUS_LABEL[p.from]} → ${STATUS_LABEL[p.to]}${p.note ? `（${p.note}）` : ""}`;
    case "caseExecuted":
      return `执行处置：${p.actions.map((a) => ACTION_LABEL[a.kind]).join("、")}`;
    case "caseClosed":
      return `关闭工单：${p.note}`;
    case "batchUndone":
      return `整批撤销 ${p.batchIds.length} 个批次：${p.reason}`;
  }
}

export function caseTankName(c: Case, state: ReturnType<Store["getState"]>): string {
  return state.tanks.find((t) => t.id === c.tankId)?.name ?? c.tankId;
}

/** 工单事件的缸 id 需要查当前状态；工单已随撤销消失时返回 undefined */
export function eventTankId(e: TimelineEvent, state: ReturnType<Store["getState"]>): string | undefined {
  const p = e.payload;
  switch (p.type) {
    case "tankCreated":
      return p.tank.id;
    case "tankDeleted":
      return p.tankId;
    case "groupCreated":
      return p.group.tankId;
    case "groupMoved":
      return p.toTankId;
    case "groupDeleted": {
      // 鱼群可能已随撤销消失，无法定位缸
      return state.groups.find((g) => g.id === p.groupId)?.tankId;
    }
    case "testAdded":
      return p.test.tankId;
    case "caseSuggested":
      return p.caseData.tankId;
    case "caseTransition":
    case "caseExecuted":
    case "caseClosed":
      return state.cases.find((c) => c.id === p.caseId)?.tankId;
    case "batchUndone":
      return undefined;
  }
}

/** 防重复提交：同一表单意图生成稳定令牌（挂载期内唯一） */
let tokenSeq = 0;
export function clientToken(prefix: string): string {
  tokenSeq += 1;
  return `${prefix}-${tokenSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

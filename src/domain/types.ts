// 领域核心类型：鱼缸、鱼群、检测记录、处置工单与时间线事件

export type TankType = "planted" | "marine" | "cichlid" | "breeding" | "quarantine";

export const TANK_TYPE_LABEL: Record<TankType, string> = {
  planted: "草缸",
  marine: "海缸",
  cichlid: "三湖缸",
  breeding: "繁殖缸",
  quarantine: "隔离缸",
};

export type FishSpecies = "neon" | "goldfish" | "marine" | "cichlid" | "betta" | "guppy";

export const SPECIES_LABEL: Record<FishSpecies, string> = {
  neon: "灯鱼(热带淡水)",
  goldfish: "金鱼(冷水淡水)",
  marine: "海水鱼",
  cichlid: "三湖慈鲷",
  betta: "斗鱼",
  guppy: "孔雀鱼(繁殖)",
};

/** 连续检测趋势方向（按最近两次有效检测比较） */
export type Trend = "improving" | "stable" | "worsening";

export interface Tank {
  id: string;
  name: string;
  type: TankType;
  /** 缸容水量（升），用于换水量上限判断 */
  volumeL: number;
  createdAt: number;
}

export interface FishGroup {
  id: string;
  tankId: string;
  species: FishSpecies;
  count: number;
  note?: string;
  createdAt: number;
}

/** 检测指标读数；缺省字段表示本次未检测该指标 */
export interface Reading {
  ph?: number;
  ammonia?: number; // 氨氮 NH3/NH4+ ppm
  nitrite?: number; // 亚硝酸盐 ppm
  nitrate?: number; // 硝酸盐 ppm
  temp?: number; // 水温 ℃
}

export interface TestRecord {
  id: string;
  tankId: string;
  at: number;
  readings: Reading;
  /** 本次换水比例 0~0.9（执行换水时登记） */
  waterChangePct?: number;
  /** 观察到的鱼病症状（whiteSpot/fungus/finRot），触发用药建议 */
  symptoms?: string[];
  note?: string;
}

export type RiskLevel = "ok" | "watch" | "danger";

export const RISK_LABEL: Record<RiskLevel, string> = {
  ok: "正常",
  watch: "关注",
  danger: "危急",
};

/** 处置动作类型 */
export type ActionKind = "isolate" | "waterChange" | "retest" | "medicate";

export const ACTION_LABEL: Record<ActionKind, string> = {
  isolate: "隔离转移",
  waterChange: "换水",
  retest: "复测",
  medicate: "用药",
};

/** 处置工单四阶段：建议 -> 执行 -> 复测 -> 关闭 */
export type CaseStatus = "suggested" | "executed" | "retested" | "closed";

export const STATUS_LABEL: Record<CaseStatus, string> = {
  suggested: "建议",
  executed: "执行",
  retested: "复测",
  closed: "关闭",
};

/** 允许的阶段流转；不存在的跳跃一律拒绝 */
export const STATUS_FLOW: Record<CaseStatus, CaseStatus[]> = {
  suggested: ["executed"],
  executed: ["retested"],
  retested: ["closed"],
  closed: [],
};

export interface CaseAction {
  kind: ActionKind;
  /** isolate: 目标缸（通常是隔离缸）；waterChange: 不必填；medicate: 药品名 */
  targetTankId?: string;
  medName?: string;
  dose?: string;
  waterChangePct?: number;
}

export interface Case {
  id: string;
  tankId: string;
  fishGroupId?: string;
  title: string;
  risk: RiskLevel;
  /** 建议生成时的理由（阈值命中、鱼种/缸型、趋势） */
  reasons: string[];
  /** 建议生成的处置动作清单 */
  actions: CaseAction[];
  status: CaseStatus;
  testRecordId: string;
  createdAt: number;
  updatedAt: number;
  /** 阶段流转留痕 */
  history: { at: number; from: CaseStatus; to: CaseStatus; note?: string }[];
  /** 执行留痕：实际执行的动作、用药名等 */
  executions: { at: number; action: CaseAction; note?: string }[];
  /** 关闭结论 */
  closeNote?: string;
}

/** 风险评估结果 */
export interface TankRisk {
  tankId: string;
  level: RiskLevel;
  hits: string[];
  trend: Trend;
  latest?: TestRecord;
  prev?: TestRecord;
}

// ---- 时间线事件（事件溯源 + 撤销单位 = 批次） ----

export type EventPayload =
  | { type: "tankCreated"; tank: Tank }
  | { type: "tankDeleted"; tankId: string }
  | { type: "groupCreated"; group: FishGroup }
  | { type: "groupMoved"; groupId: string; fromTankId: string; toTankId: string }
  | { type: "groupDeleted"; groupId: string }
  | { type: "testAdded"; test: TestRecord }
  | { type: "caseSuggested"; caseData: Case }
  | { type: "caseTransition"; caseId: string; from: CaseStatus; to: CaseStatus; at: number; note?: string }
  | { type: "caseExecuted"; caseId: string; at: number; actions: CaseAction[]; note?: string }
  | { type: "caseClosed"; caseId: string; at: number; note: string }
  | { type: "batchUndone"; batchIds: string[]; reason: string };

export interface TimelineEvent {
  id: string;
  batchId: string;
  at: number;
  payload: EventPayload;
}

export interface AppData {
  tanks: Tank[];
  groups: FishGroup[];
  tests: TestRecord[];
  cases: Case[];
}

/** 持久化装载结果：损坏数据被隔离到 quarantine，主数据继续可用 */
export interface LoadResult {
  data: AppData;
  events: TimelineEvent[];
  quarantine: { raw: string; reason: string; at: number } | null;
}

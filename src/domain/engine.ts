// 纯领域逻辑：风险评估、处置建议、拦截规则、阶段状态机、事件回放。
// 不依赖 React / localStorage，便于 node --test 直接验证。

import {
  MAX_WATER_CHANGE_PCT,
  MEDICATION_COOLDOWN_MS,
  SHOCK_RATIO,
  bandLevel,
  ruleFor,
} from "./thresholds";
import type {
  ActionKind,
  AppData,
  Case,
  CaseAction,
  CaseStatus,
  FishGroup,
  Reading,
  RiskLevel,
  Tank,
  TankRisk,
  TestRecord,
  TimelineEvent,
  Trend,
} from "./types";
import { STATUS_FLOW } from "./types";

// ---------- 工具 ----------

export function emptyData(): AppData {
  return { tanks: [], groups: [], tests: [], cases: [] };
}

export function levelRank(l: RiskLevel): number {
  return l === "danger" ? 2 : l === "watch" ? 1 : 0;
}

const METRIC_LABEL: Record<keyof Reading, string> = {
  ph: "pH",
  ammonia: "氨氮",
  nitrite: "亚硝酸盐",
  nitrate: "硝酸盐",
  temp: "水温",
};

const METRIC_UNIT: Partial<Record<keyof Reading, string>> = {
  ammonia: "ppm",
  nitrite: "ppm",
  nitrate: "ppm",
  temp: "℃",
};

function fmtMetric(k: keyof Reading, v: number): string {
  const u = METRIC_UNIT[k];
  return `${METRIC_LABEL[k]} ${v}${u ?? ""}`;
}

// ---------- 事件回放（含撤销集） ----------

/** 重放全部事件；batchUndone 事件声明被撤销的批次，重放时整体跳过。
 *  strict=true 时收集悬空引用（如检测指向已不存在的缸），供装载期损坏检测使用。 */
export function replay(
  events: TimelineEvent[],
): AppData {
  return replayInternal(events, false).data;
}

export function replayStrict(events: TimelineEvent[]): { data: AppData; dangling: string[] } {
  return replayInternal(events, true);
}

function replayInternal(
  events: TimelineEvent[],
  strict: boolean,
): { data: AppData; dangling: string[] } {
  const undone = new Set<string>();
  for (const e of events) {
    if (e.payload.type === "batchUndone") {
      e.payload.batchIds.forEach((b) => undone.add(b));
    }
  }
  const data = emptyData();
  const dangling: string[] = [];
  for (const e of events) {
    if (undone.has(e.batchId)) continue;
    if (strict) {
      const problem = danglingRef(data, e);
      if (problem) dangling.push(`事件 ${e.id}：${problem}`);
    }
    applyEvent(data, e);
  }
  return { data, dangling };
}

function applyEvent(data: AppData, e: TimelineEvent): void {
  const p = e.payload;
  switch (p.type) {
    case "tankCreated":
      if (!data.tanks.some((t) => t.id === p.tank.id)) data.tanks.push(structuredClone(p.tank));
      break;
    case "tankDeleted": {
      // 删缸连带移除检测与工单（悬空场景，store 层正常删缸前已要求清空鱼群）
      data.tanks = data.tanks.filter((x) => x.id !== p.tankId);
      data.groups = data.groups.filter((g) => g.tankId !== p.tankId);
      data.tests = data.tests.filter((t2) => t2.tankId !== p.tankId);
      data.cases = data.cases.filter((c) => c.tankId !== p.tankId);
      break;
    }
    case "groupCreated":
      if (!data.groups.some((g) => g.id === p.group.id)) data.groups.push(structuredClone(p.group));
      break;
    case "groupMoved": {
      const g = data.groups.find((x) => x.id === p.groupId);
      if (g) g.tankId = p.toTankId;
      break;
    }
    case "groupDeleted":
      data.groups = data.groups.filter((x) => x.id !== p.groupId);
      break;
    case "testAdded":
      if (!data.tests.some((t) => t.id === p.test.id)) data.tests.push(structuredClone(p.test));
      break;
    case "caseSuggested":
      if (!data.cases.some((c) => c.id === p.caseData.id))
        data.cases.push(structuredClone(p.caseData));
      break;
    case "caseTransition": {
      const c = data.cases.find((x) => x.id === p.caseId);
      if (c && c.status === p.from) {
        c.history.push({ at: p.at, from: p.from, to: p.to, note: p.note });
        c.status = p.to;
        c.updatedAt = p.at;
      }
      break;
    }
    case "caseExecuted": {
      const c = data.cases.find((x) => x.id === p.caseId);
      if (c) {
        for (const action of p.actions) c.executions.push({ at: p.at, action, note: p.note });
        c.updatedAt = p.at;
      }
      break;
    }
    case "caseClosed": {
      const c = data.cases.find((x) => x.id === p.caseId);
      if (c) {
        c.closeNote = p.note;
        c.updatedAt = p.at;
      }
      break;
    }
    case "batchUndone":
      break; // 已在重放开头处理
  }
}

// ---------- 风险评估 ----------

export function testsForTank(tests: TestRecord[], tankId: string): TestRecord[] {
  return tests
    .filter((t) => t.tankId === tankId)
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

interface SingleHit {
  metric: keyof Reading;
  level: RiskLevel;
  text: string;
}

function evalReading(
  r: Reading,
  rule: ReturnType<typeof ruleFor>,
  scopeLabel: string,
): SingleHit[] {
  const hits: SingleHit[] = [];
  (Object.keys(r) as (keyof Reading)[]).forEach((k) => {
    const v = r[k];
    if (v === undefined || Number.isNaN(v)) return;
    const lvl = bandLevel(v, rule[k]);
    if (lvl === "ok") return;
    let text = `${scopeLabel}：${fmtMetric(k, v)} 超出正常区间`;
    if (k === "ph") text = `${scopeLabel}：pH ${v} 超出正常区间 [${rule.ph.okLo}, ${rule.ph.okHi})`;
    if (lvl === "danger" && k === "ammonia" && v >= rule.ammoniaAcute) {
      text += `，达到急性中毒线（≥${rule.ammoniaAcute}ppm）`;
    }
    hits.push({ metric: k, level: lvl, text });
  });
  return hits;
}

/** 连续检测变化：与上一次读数比较，计算趋势与冲击 */
function evalTrend(latest: TestRecord, prev: TestRecord | undefined, rule: ReturnType<typeof ruleFor>) {
  const hits: SingleHit[] = [];
  let trend: Trend = "stable";
  if (!prev) return { hits, trend };

  const r1 = latest.readings;
  const r0 = prev.readings;

  const worse = (k: keyof Reading) => {
    if (r1[k] === undefined || r0[k] === undefined) return false;
    const l0 = bandLevel(r0[k]!, rule[k]);
    const l1 = bandLevel(r1[k]!, rule[k]);
    return levelRank(l1) > levelRank(l0);
  };
  const better = (k: keyof Reading) => {
    if (r1[k] === undefined || r0[k] === undefined) return false;
    const l0 = bandLevel(r0[k]!, rule[k]);
    const l1 = bandLevel(r1[k]!, rule[k]);
    return levelRank(l1) < levelRank(l0);
  };

  if ((["ammonia", "nitrite", "nitrate"] as const).some(worse)) trend = "worsening";
  else if ((["ammonia", "nitrite", "nitrate", "ph", "temp"] as const).some(better))
    trend = "improving";

  if (r1.ammonia !== undefined && r0.ammonia !== undefined) {
    if (r0.ammonia > 0 && r1.ammonia >= r0.ammonia * SHOCK_RATIO.ammonia && r1.ammonia >= 0.02) {
      hits.push({
        metric: "ammonia",
        level: "danger",
        text: `连续检测氨氮由 ${r0.ammonia} 翻倍升至 ${r1.ammonia}ppm，过滤系统可能崩溃`,
      });
    }
  }
  if (r1.nitrite !== undefined && r0.nitrite !== undefined) {
    if (r0.nitrite > 0 && r1.nitrite >= r0.nitrite * SHOCK_RATIO.nitrite && r1.nitrite >= 0.1) {
      hits.push({
        metric: "nitrite",
        level: "danger",
        text: `连续检测亚硝酸盐由 ${r0.nitrite} 翻倍升至 ${r1.nitrite}ppm`,
      });
    }
  }
  if (r1.ph !== undefined && r0.ph !== undefined) {
    const d = Math.abs(r1.ph - r0.ph);
    if (d >= SHOCK_RATIO.phJump) {
      hits.push({
        metric: "ph",
        level: "danger",
        text: `pH 单次跳变 ${d.toFixed(2)}（${r0.ph} → ${r1.ph}），超过 ±${SHOCK_RATIO.phJump} 冲击线`,
      });
    }
  }
  if (r1.nitrate !== undefined && r0.nitrate !== undefined && r1.nitrate - r0.nitrate >= SHOCK_RATIO.nitrateJump) {
    hits.push({
      metric: "nitrate",
      level: "watch",
      text: `硝酸盐连续上升 ${r1.nitrate - r0.nitrate}ppm（${r0.nitrate} → ${r1.nitrate}）`,
    });
  }
  if (r1.temp !== undefined && r0.temp !== undefined) {
    const d = Math.abs(r1.temp - r0.temp);
    if (d >= SHOCK_RATIO.tempJump) {
      hits.push({
        metric: "temp",
        level: "watch",
        text: `水温单次变化 ${d}℃（${r0.temp} → ${r1.temp}），超过 ${SHOCK_RATIO.tempJump}℃`,
      });
    }
  }
  return { hits, trend };
}

export function evalTankRisk(tank: Tank, groups: FishGroup[], tests: TestRecord[]): TankRisk {
  const series = testsForTank(tests, tank.id);
  const latest = series[series.length - 1];
  const prev = series[series.length - 2];
  if (!latest) {
    return { tankId: tank.id, level: "ok", hits: ["尚无检测记录"], trend: "stable" };
  }

  // 缸型基础规则 + 缸内各鱼种偏好，命中最严格的结果
  const scopes: { label: string; rule: ReturnType<typeof ruleFor> }[] = [
    { label: "缸型基准", rule: ruleFor(tank.type) },
  ];
  const speciesSeen = new Set(groups.map((g) => g.species));
  speciesSeen.forEach((sp) => {
    scopes.push({ label: "鱼种偏好", rule: ruleFor(tank.type, sp) });
  });

  let level: RiskLevel = "ok";
  const hitTexts: string[] = [];
  const pushHits = (hs: SingleHit[]) => {
    for (const h of hs) {
      if (levelRank(h.level) > levelRank(level)) level = h.level;
      if (!hitTexts.includes(h.text)) hitTexts.push(h.text);
    }
  };

  for (const s of scopes) pushHits(evalReading(latest.readings, s.rule, s.label));

  const { hits: trendHits, trend } = evalTrend(latest, prev, ruleFor(tank.type));
  pushHits(trendHits);

  if (trend === "worsening" && levelRank(level) < 2) {
    level = levelRank(level) >= 1 ? level : "watch";
    hitTexts.push("连续检测呈恶化趋势");
  }

  return { tankId: tank.id, level, hits: hitTexts, trend, latest, prev };
}

// ---------- 建议生成 ----------

const SYMPTOM_MED: Record<string, { med: string; dose: string }> = {
  whiteSpot: { med: "甲基蓝", dose: "按说明书 1ml/10L" },
  fungus: { med: "抗菌剂(土霉素)", dose: "按说明书药浴 5 天" },
  finRot: { med: "黄粉", dose: "按说明书 1g/20L" },
};

export const SYMPTOM_LABEL: Record<string, string> = {
  whiteSpot: "白点病",
  fungus: "白膜/水霉",
  finRot: "烂鳍",
};

export interface Suggestion {
  title: string;
  risk: RiskLevel;
  reasons: string[];
  actions: CaseAction[];
  /** 建议复测间隔（小时），仅展示用 */
  retestHours: number;
}

export function buildSuggestion(
  tank: Tank,
  groups: FishGroup[],
  allTanks: Tank[],
  risk: TankRisk,
): Suggestion | null {
  if (!risk.latest) return null;
  const r = risk.latest.readings;
  const reasons = [...risk.hits];
  const rawActions: CaseAction[] = [];
  const hasFish = groups.length > 0;

  const acuteAmmonia =
    r.ammonia !== undefined &&
    bandLevel(r.ammonia, ruleFor(tank.type).ammonia) === "danger";

  if (acuteAmmonia || (r.nitrite !== undefined && bandLevel(r.nitrite, ruleFor(tank.type).nitrite) === "danger")) {
    // 急性氨氮/亚硝：大量换水但不超过 50% 安全上限
    rawActions.push({ kind: "waterChange", waterChangePct: acuteAmmonia ? 0.5 : 0.3 });
  } else if (
    (r.ammonia !== undefined && bandLevel(r.ammonia, ruleFor(tank.type).ammonia) === "watch") ||
    (r.nitrite !== undefined && bandLevel(r.nitrite, ruleFor(tank.type).nitrite) === "watch")
  ) {
    rawActions.push({ kind: "waterChange", waterChangePct: 0.3 });
  }
  if (r.nitrate !== undefined && bandLevel(r.nitrate, ruleFor(tank.type).nitrate) !== "ok") {
    rawActions.push({ kind: "waterChange", waterChangePct: 0.2 });
  }
  if (r.ph !== undefined && bandLevel(r.ph, ruleFor(tank.type).ph) !== "ok") {
    rawActions.push({ kind: "waterChange", waterChangePct: 0.15 });
  }

  // 多次换水建议合并为单次（取最大比例，仍受 50% 安全上限约束）
  const actions: CaseAction[] = [];
  const wcPct = Math.max(
    0,
    ...rawActions.filter((a) => a.kind === "waterChange").map((a) => a.waterChangePct ?? 0),
  );
  if (wcPct > 0) actions.push({ kind: "waterChange", waterChangePct: wcPct });

  // 危急且有鱼：建议转入隔离缸
  const qTank = allTanks.find((t) => t.type === "quarantine" && t.id !== tank.id);
  if (risk.level === "danger" && hasFish && qTank) {
    actions.push({ kind: "isolate", targetTankId: qTank.id });
  } else if (risk.level === "danger" && hasFish && !qTank) {
    reasons.push("店内无可用隔离缸：建议立即备缸，禁止向其他展示缸转移");
  }

  // 症状用药（同药去重）
  const medNames = new Set<string>();
  const symptoms = risk.latest.symptoms ?? [];
  for (const s of symptoms) {
    const m = SYMPTOM_MED[s];
    if (m && !medNames.has(m.med)) {
      medNames.add(m.med);
      actions.push({ kind: "medicate", medName: m.med, dose: m.dose });
    }
  }

  if (r.temp !== undefined && bandLevel(r.temp, ruleFor(tank.type, groups[0]?.species).temp) !== "ok") {
    reasons.push("检查加热棒/制冷机并校正水温");
  }

  // 任何非正常评估都需要复测
  if (risk.level !== "ok" || actions.length > 0) {
    actions.push({ kind: "retest" });
  }
  if (actions.length === 0) return null;

  const retestHours = acuteAmmonia ? 24 : risk.level === "danger" ? 24 : 48;
  const dangerName = acuteAmmonia ? "氨氮危急" : risk.level === "danger" ? "水质危急" : "指标异常";
  const title = `${tank.name} ${dangerName}处置`;
  return { title, risk: risk.level, reasons, actions, retestHours };
}

// ---------- 拦截规则 ----------

export interface GuardResult {
  ok: boolean;
  errors: string[];
}

function ok(): GuardResult {
  return { ok: true, errors: [] };
}
function fail(errors: string[]): GuardResult {
  return { ok: false, errors };
}

/**
 * 用药冷却校验：同一种药 72 小时内禁止重复使用。
 * 命中范围 = 同一缸（水体药物残留）或同一鱼群（鱼只随转移带走药效），跨工单同样拦截。
 */
export function checkMedication(
  tankId: string,
  medName: string,
  at: number,
  data: AppData,
  fishGroupId?: string,
): GuardResult {
  const errors: string[] = [];
  for (const c of data.cases) {
    const sameTank = c.tankId === tankId;
    const sameGroup = fishGroupId !== undefined && c.fishGroupId === fishGroupId;
    if (!sameTank && !sameGroup) continue;
    for (const ex of c.executions) {
      if (ex.action.kind === "medicate" && ex.action.medName === medName) {
        const gap = at - ex.at;
        if (gap < MEDICATION_COOLDOWN_MS) {
          const hours = (MEDICATION_COOLDOWN_MS - gap) / 3_600_000;
          const scope = sameGroup && !sameTank ? "该鱼群" : "本缸";
          errors.push(
            `重复用药拦截：${medName} 已于 ${new Date(ex.at).toLocaleString("zh-CN")} 在${scope}使用，` +
              `安全间隔 72 小时，仍需等待约 ${Math.ceil(hours)} 小时；重复用药会造成药物蓄积、硝化系统崩溃`,
          );
        }
      }
    }
  }
  return errors.length ? fail(errors) : ok();
}

/** 换水量边界：0 < pct <= 50% */
export function checkWaterChange(pct: number | undefined): GuardResult {
  if (pct === undefined || Number.isNaN(pct)) return fail(["换水量缺失"]);
  if (pct <= 0) return fail([`换水量 ${(pct * 100).toFixed(0)}% 非法：必须大于 0`]);
  if (pct > MAX_WATER_CHANGE_PCT) {
    return fail([
      `换水量 ${(pct * 100).toFixed(0)}% 超过单次安全上限 50%：大量新水会引起 pH/温度震荡，建议分两次换水`,
    ]);
  }
  return ok();
}

/**
 * 跨缸转移拦截：
 * 1) 不能转入本缸；2) 目标缸不存在；3) 目标缸最近检测危急；
 * 4) 源缸处于危急处置期时只能进隔离缸；5) 鱼群仍在用药观察期（72h）禁止转移
 */
export function checkMoveGroup(
  group: FishGroup,
  toTankId: string,
  data: AppData,
  at: number,
): GuardResult {
  const errors: string[] = [];
  if (toTankId === group.tankId) {
    return fail(["跨缸转移拦截：目标缸与当前缸相同，无需转移"]);
  }
  const target = data.tanks.find((t) => t.id === toTankId);
  if (!target) errors.push("目标缸不存在或已被删除");

  if (target) {
    const tr = evalTankRisk(
      target,
      data.groups.filter((g) => g.tankId === target.id),
      data.tests,
    );
    if (tr.level === "danger") {
      errors.push(
        `跨缸转移拦截：目标缸「${target.name}」最近检测为危急（${tr.hits[0] ?? "水质异常"}），转入将扩大损失`,
      );
    }
  }

  const source = data.tanks.find((t) => t.id === group.tankId);
  if (source && target) {
    const sr = evalTankRisk(
      source,
      data.groups.filter((g) => g.tankId === source.id),
      data.tests,
    );
    if (sr.level === "danger" && target.type !== "quarantine") {
      errors.push(
        `跨缸转移拦截：源缸「${source.name}」处于危急处置期，只允许转入隔离缸；转入展示缸会扩散病原`,
      );
    }
  }

  // 用药观察期：鱼群在任意缸的用药记录（随鱼转移），或当前缸水体用药记录
  for (const c of data.cases) {
    if (c.status === "closed") continue;
    const followsGroup = c.fishGroupId === group.id;
    const sameTank = c.tankId === group.tankId;
    if (!followsGroup && !sameTank) continue;
    for (const ex of c.executions) {
      if (ex.action.kind === "medicate" && at - ex.at < MEDICATION_COOLDOWN_MS) {
        errors.push(
          `跨缸转移拦截：该鱼群仍在「${ex.action.medName}」用药观察期（72 小时内），转移会造成药物与病原交叉污染`,
        );
      }
    }
  }
  return errors.length ? fail(errors) : ok();
}

/** 执行处置动作清单前的综合校验 */
export function checkExecute(
  c: Case,
  actions: CaseAction[],
  data: AppData,
  at: number,
): GuardResult {
  const errors: string[] = [];
  if (actions.length === 0) errors.push("至少执行一项处置动作");
  const medSeen = new Set<string>();
  actions.forEach((a, i) => {
    const where = `第 ${i + 1} 项（${actionText(a)}）`;
    if (!["isolate", "waterChange", "retest", "medicate"].includes(a.kind)) {
      errors.push(`${where}：未知动作类型`);
    }
    if (a.kind === "waterChange") {
      const r = checkWaterChange(a.waterChangePct);
      if (!r.ok) errors.push(...r.errors);
    }
    if (a.kind === "medicate") {
      if (!a.medName) errors.push(`${where}：药品名缺失`);
      else {
        if (medSeen.has(a.medName)) errors.push(`重复用药拦截：本次执行清单中药品「${a.medName}」重复`);
        medSeen.add(a.medName);
        errors.push(...checkMedication(c.tankId, a.medName, at, data, c.fishGroupId).errors);
      }
    }
    if (a.kind === "isolate") {
      const group = data.groups.find((g) => g.id === c.fishGroupId) ?? data.groups.find((g) => g.tankId === c.tankId);
      if (!a.targetTankId) errors.push(`${where}：隔离目标缸缺失`);
      else if (!data.tanks.some((t) => t.id === a.targetTankId))
        errors.push(`${where}：目标缸不存在或已被删除`);
      else if (group) errors.push(...checkMoveGroup(group, a.targetTankId, data, at).errors);
    }
  });
  return errors.length ? fail(errors) : ok();
}

export function actionText(a: CaseAction): string {
  switch (a.kind) {
    case "waterChange":
      return `换水 ${Math.round((a.waterChangePct ?? 0) * 100)}%`;
    case "medicate":
      return `用药 ${a.medName ?? ""}（${a.dose ?? ""}）`;
    case "isolate":
      return "隔离转移";
    case "retest":
      return "复测";
  }
}

/** 阶段状态机：只允许 建议→执行→复测→关闭 的相邻流转 */
export function checkTransition(c: Case | undefined, to: CaseStatus): GuardResult {
  if (!c) return fail(["工单不存在（可能已随撤销被移除）"]);
  const allowed = STATUS_FLOW[c.status];
  if (!allowed.includes(to)) {
    return fail([
      `非法状态跳跃：${c.status}（${statusZh(c.status)}）不能直接变为 ${to}（${statusZh(to)}）；` +
        `允许的下一阶段：${allowed.length ? allowed.map(statusZh).join("、") : "无（工单已关闭）"}`,
    ]);
  }
  return ok();
}

export function statusZh(s: CaseStatus): string {
  return { suggested: "建议", executed: "执行", retested: "复测", closed: "关闭" }[s];
}

/** 复测校验：必须带本缸新检测，且时间晚于建单检测 */
export function checkRetest(c: Case, test: TestRecord | undefined): GuardResult {
  const errors: string[] = [];
  if (!test) return fail(["缺少复测记录"]);
  if (test.tankId !== c.tankId) errors.push("复测记录不属于本工单鱼缸");
  if (test.at <= c.createdAt) errors.push("复测时间必须晚于建议生成时间");
  if (Object.values(test.readings).every((v) => v === undefined))
    errors.push("复测至少录入一项指标");
  return errors.length ? fail(errors) : ok();
}

// ---------- 撤销依赖分析 ----------

/**
 * 撤销某批次后，检查后续批次事件是否会变成悬空引用。
 * 返回受影响事件的说明列表；非空则 store 层拒绝撤销。
 */
export function undoDependencies(
  events: TimelineEvent[],
  batchId: string,
): { laterBatchId: string; desc: string }[] {
  // 模拟删除该批次，按顺序回放剩余事件；若某事件引用的实体在当前状态中不存在，
  // 说明撤销会让后续批次悬空 -> 拒绝撤销并给出依赖说明。
  const kept = events.filter((e) => e.batchId !== batchId);
  const undone = collectUndone(kept);
  const live = emptyData();
  const problems: { laterBatchId: string; desc: string }[] = [];
  for (const e of kept) {
    if (undone.has(e.batchId)) continue;
    const dangling = danglingRef(live, e);
    if (dangling) problems.push({ laterBatchId: e.batchId, desc: dangling });
    applyEvent(live, e);
  }
  return problems;
}

function collectUndone(events: TimelineEvent[]): Set<string> {
  const s = new Set<string>();
  events.forEach((e) => {
    if (e.payload.type === "batchUndone") e.payload.batchIds.forEach((b) => s.add(b));
  });
  return s;
}

function danglingRef(data: AppData, e: TimelineEvent): string | null {
  const p = e.payload;
  switch (p.type) {
    case "groupCreated":
      return data.tanks.some((t) => t.id === p.group.tankId) ? null : "鱼群所属缸已不存在";
    case "groupMoved":
      if (!data.groups.some((g) => g.id === p.groupId)) return "被转移的鱼群已不存在";
      return data.tanks.some((t) => t.id === p.toTankId) ? null : "转移目标缸已不存在";
    case "groupDeleted":
      return data.groups.some((g) => g.id === p.groupId) ? null : "待删除鱼群已不存在";
    case "testAdded":
      return data.tanks.some((t) => t.id === p.test.tankId) ? null : "检测记录所属缸已不存在";
    case "caseSuggested":
      if (!data.tanks.some((t) => t.id === p.caseData.tankId)) return "工单所属缸已不存在";
      if (p.caseData.fishGroupId && !data.groups.some((g) => g.id === p.caseData.fishGroupId))
        return "工单关联鱼群已不存在";
      return data.tests.some((t) => t.id === p.caseData.testRecordId)
        ? null
        : "工单依据的检测记录已不存在";
    case "caseTransition":
    case "caseExecuted":
    case "caseClosed":
      return data.cases.some((c) => c.id === p.caseId) ? null : "被流转/执行的工单已不存在";
    default:
      return null;
  }
}

// ---------- 输入校验 ----------

export function validateReading(input: Partial<Record<keyof Reading, string>>): {
  values: Reading;
  errors: string[];
} {
  const values: Reading = {};
  const errors: string[] = [];
  const ranges: Record<keyof Reading, [number, number]> = {
    ph: [0, 14],
    ammonia: [0, 20],
    nitrite: [0, 20],
    nitrate: [0, 500],
    temp: [0, 40],
  };
  (Object.keys(input) as (keyof Reading)[]).forEach((k) => {
    const raw = input[k];
    if (raw === undefined || raw.trim() === "") return;
    const v = Number(raw);
    if (Number.isNaN(v)) {
      errors.push(`${METRIC_LABEL[k]} 不是数字`);
      return;
    }
    const [lo, hi] = ranges[k];
    if (v < lo || v > hi) errors.push(`${METRIC_LABEL[k]} ${v} 超出物理范围 [${lo}, ${hi}]`);
    values[k] = v;
  });
  return { values, errors };
}

/** 建议中允许出现的动作类型（供执行清单校验去重逻辑复用） */
export const ALL_ACTION_KINDS: ActionKind[] = ["isolate", "waterChange", "retest", "medicate"];

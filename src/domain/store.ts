// 事件溯源 store：命令 -> 守卫 -> 事件批次 -> 持久化。
// 时钟与 id 生成器可注入，node 测试可确定性运行。

import {
  buildSuggestion,
  checkExecute,
  checkMoveGroup,
  checkRetest,
  checkTransition,
  emptyData,
  evalTankRisk,
  replay,
  replayStrict,
  undoDependencies,
  validateReading,
} from "./engine";
import type {
  AppData,
  Case,
  CaseAction,
  EventPayload,
  FishGroup,
  FishSpecies,
  Reading,
  Tank,
  TankType,
  TestRecord,
  TimelineEvent,
} from "./types";

const STORAGE_KEY = "aquarium-desk-state-v1";

export class StoreError extends Error {
  constructor(
    public errors: string[],
    public code = "guard",
  ) {
    super(errors.join("；"));
    this.name = "StoreError";
  }
}

export interface QuarantineEntry {
  raw: string;
  reason: string;
  at: number;
}

interface Persisted {
  version: 1;
  events: TimelineEvent[];
  quarantine: QuarantineEntry | null;
}

const PAYLOAD_TYPES = new Set([
  "tankCreated",
  "tankDeleted",
  "groupCreated",
  "groupMoved",
  "groupDeleted",
  "testAdded",
  "caseSuggested",
  "caseTransition",
  "caseExecuted",
  "caseClosed",
  "batchUndone",
]);

type Listener = () => void;

export interface StoreDeps {
  now?: () => number;
  id?: () => string;
  storage?: Storage | null;
  seed?: boolean;
}

export function createStore(deps: StoreDeps = {}) {
  const now = deps.now ?? (() => Date.now());
  const idGen =
    deps.id ??
    (() => {
      if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
      return "id-" + Math.random().toString(36).slice(2) + "-" + now().toString(36);
    });
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;

  let events: TimelineEvent[] = [];
  let data: AppData = emptyData();
  let quarantine: QuarantineEntry | null = null;
  let loaded = false;
  let revision = 0;
  /** 会话内提交幂等：clientToken -> batchId，防止重复提交 */
  const clientTokens = new Map<string, string>();
  const listeners = new Set<Listener>();

  function defaultStorage(): Storage | null {
    try {
      if (typeof localStorage !== "undefined") return localStorage;
    } catch {
      /* 隐私模式等 */
    }
    return null;
  }

  function emit() {
    revision += 1;
    listeners.forEach((l) => l());
  }
  function subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  }

  function persist() {
    if (!storage) return;
    const blob: Persisted = { version: 1, events, quarantine };
    storage.setItem(STORAGE_KEY, JSON.stringify(blob));
  }

  // ---------- 装载与损坏隔离 ----------

  function validatePersisted(raw: string): Persisted {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error("JSON 解析失败：" + (e as Error).message);
    }
    const obj = parsed as Partial<Persisted>;
    if (typeof obj !== "object" || obj === null) throw new Error("根节点不是对象");
    if (obj.version !== 1) throw new Error(`未知数据版本 ${String(obj.version)}`);
    if (!Array.isArray(obj.events)) throw new Error("events 不是数组");
    const seen = new Set<string>();
    obj.events.forEach((e, i) => {
      const ev = e as TimelineEvent;
      if (!ev || typeof ev !== "object") throw new Error(`第 ${i + 1} 条事件不是对象`);
      if (typeof ev.id !== "string" || typeof ev.batchId !== "string" || typeof ev.at !== "number")
        throw new Error(`第 ${i + 1} 条事件缺少 id/batchId/at`);
      if (seen.has(ev.id)) throw new Error(`第 ${i + 1} 条事件 id 重复`);
      seen.add(ev.id);
      if (!ev.payload || typeof ev.payload !== "object" || typeof ev.payload.type !== "string")
        throw new Error(`第 ${i + 1} 条事件载荷损坏`);
      if (!PAYLOAD_TYPES.has(ev.payload.type))
        throw new Error(`第 ${i + 1} 条事件类型未知：${ev.payload.type}`);
    });
    return {
      version: 1,
      events: obj.events,
      quarantine:
        obj.quarantine && typeof obj.quarantine.raw === "string"
          ? (obj.quarantine as QuarantineEntry)
          : null,
    };
  }

  function load() {
    if (loaded) return;
    loaded = true;
    if (!storage) {
      data = emptyData();
      if (deps.seed ?? true) seedDemo();
      return;
    }
    let raw: string | null = null;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch {
      raw = null;
    }
    if (!raw) {
      if (deps.seed ?? true) seedDemo();
      return;
    }
    try {
      const parsed = validatePersisted(raw);
      // 回放也要能跑完；任何悬空引用都视为损坏并隔离
      const { data: replayed, dangling } = replayStrict(parsed.events);
      if (dangling.length > 0) throw new Error("事件存在悬空引用：" + dangling.join("；"));
      events = parsed.events;
      data = replayed;
      quarantine = parsed.quarantine;
    } catch (e) {
      quarantine = { raw, reason: (e as Error).message, at: now() };
      events = [];
      data = emptyData();
      persist(); // 主数据清空落盘，损坏原文隔离保存
    }
  }

  function quarantineInfo() {
    return quarantine;
  }
  function discardQuarantine() {
    quarantine = null;
    persist();
    emit();
  }

  // ---------- 提交 ----------

  function commit(payloads: EventPayload[], clientToken?: string): string {
    if (clientToken) {
      const existing = clientTokens.get(clientToken);
      if (existing) return existing; // 重复提交：直接返回原批次，不产生新事件
    }
    const batchId = "b-" + idGen();
    const at = now();
    const newEvents: TimelineEvent[] = payloads.map((payload) => ({
      id: "e-" + idGen(),
      batchId,
      at,
      payload,
    }));
    // 先在临时状态上回放，提交期异常不落盘
    const probe = replay(events.concat(newEvents));
    events = events.concat(newEvents);
    data = probe;
    if (clientToken) clientTokens.set(clientToken, batchId);
    persist();
    emit();
    return batchId;
  }

  function getState(): AppData {
    return data;
  }
  function getEvents(): TimelineEvent[] {
    return events;
  }

  // ---------- 命令 ----------

  function addTank(name: string, type: TankType, volumeL: number, clientToken?: string): string {
    const errors: string[] = [];
    if (!name.trim()) errors.push("缸名不能为空");
    if (!Number.isFinite(volumeL) || volumeL <= 0) errors.push("水量必须为正数（升）");
    if (data.tanks.some((t) => t.name === name.trim())) errors.push(`已存在同名缸「${name.trim()}」`);
    if (errors.length) throw new StoreError(errors, "invalid");
    const tank: Tank = { id: "t-" + idGen(), name: name.trim(), type, volumeL, createdAt: now() };
    return commit([{ type: "tankCreated", tank }], clientToken);
  }

  function deleteTank(tankId: string): string {
    const tank = data.tanks.find((t) => t.id === tankId);
    if (!tank) throw new StoreError(["鱼缸不存在"], "notfound");
    const groups = data.groups.filter((g) => g.tankId === tankId);
    if (groups.length > 0) {
      throw new StoreError([
        `缸内仍有 ${groups.length} 个鱼群，请先转移或移出鱼群后再删缸`,
      ]);
    }
    return commit([{ type: "tankDeleted", tankId }]);
  }

  function addGroup(
    tankId: string,
    species: FishSpecies,
    count: number,
    note: string | undefined,
    clientToken?: string,
  ): string {
    if (!data.tanks.some((t) => t.id === tankId)) throw new StoreError(["鱼缸不存在"]);
    if (!Number.isInteger(count) || count <= 0) throw new StoreError(["鱼只数量必须为正整数"]);
    const group: FishGroup = {
      id: "g-" + idGen(),
      tankId,
      species,
      count,
      note: note?.trim() || undefined,
      createdAt: now(),
    };
    return commit([{ type: "groupCreated", group }], clientToken);
  }

  function moveGroup(groupId: string, toTankId: string, clientToken?: string): string {
    const group = data.groups.find((g) => g.id === groupId);
    if (!group) throw new StoreError(["鱼群不存在"]);
    const guard = checkMoveGroup(group, toTankId, data, now());
    if (!guard.ok) throw new StoreError(guard.errors, "guard");
    return commit(
      [{ type: "groupMoved", groupId, fromTankId: group.tankId, toTankId }],
      clientToken,
    );
  }

  function deleteGroup(groupId: string): string {
    if (!data.groups.some((g) => g.id === groupId)) throw new StoreError(["鱼群不存在"]);
    return commit([{ type: "groupDeleted", groupId }]);
  }

  function addTest(
    tankId: string,
    input: Partial<Record<keyof Reading, string>>,
    symptoms: string[],
    note: string | undefined,
    atOverride?: number,
    clientToken?: string,
  ): string {
    const tank = data.tanks.find((t) => t.id === tankId);
    if (!tank) throw new StoreError(["鱼缸不存在"]);
    const { values, errors } = validateReading(input);
    if (Object.keys(values).length === 0) errors.push("至少录入一项检测指标");
    if (errors.length) throw new StoreError(errors, "invalid");
    const test: TestRecord = {
      id: "r-" + idGen(),
      tankId,
      at: atOverride ?? now(),
      readings: values,
      symptoms: symptoms.length ? symptoms : undefined,
      note: note?.trim() || undefined,
    };
    return commit([{ type: "testAdded", test }], clientToken);
  }

  function suggestCase(tankId: string, testRecordId: string, clientToken?: string): string {
    const tank = data.tanks.find((t) => t.id === tankId);
    if (!tank) throw new StoreError(["鱼缸不存在"]);
    const test = data.tests.find((t) => t.id === testRecordId && t.tankId === tankId);
    if (!test) throw new StoreError(["检测记录不存在或不属于该缸"]);
    const open = data.cases.find((c) => c.testRecordId === testRecordId && c.status !== "closed");
    if (open) {
      throw new StoreError([
        `重复提交拦截：该检测已生成进行中的处置工单「${open.title}」，关闭后才能重新建议`,
      ]);
    }
    const groups = data.groups.filter((g) => g.tankId === tankId);
    const risk = evalTankRisk(tank, groups, data.tests);
    const suggestion = buildSuggestion(tank, groups, data.tanks, risk);
    if (!suggestion) {
      throw new StoreError(["各项指标正常，无需生成处置工单"]);
    }
    const ts = now();
    const c: Case = {
      id: "c-" + idGen(),
      tankId,
      fishGroupId: groups[0]?.id,
      title: suggestion.title,
      risk: suggestion.risk,
      reasons: suggestion.reasons,
      actions: suggestion.actions,
      status: "suggested",
      testRecordId,
      createdAt: ts,
      updatedAt: ts,
      history: [],
      executions: [],
    };
    return commit([{ type: "caseSuggested", caseData: c }], clientToken);
  }

  function executeCase(caseId: string, actions: CaseAction[], note: string | undefined, clientToken?: string): string {
    const c = data.cases.find((x) => x.id === caseId);
    const transition = checkTransition(c, "executed");
    if (!transition.ok) throw new StoreError(transition.errors, "guard");
    const guard = checkExecute(c!, actions, data, now());
    if (!guard.ok) throw new StoreError(guard.errors, "guard");

    // 建议清单之外的动作类型不允许夹带（按 kind+medName 匹配）
    const allowed = c!.actions;
    for (const a of actions) {
      const match = allowed.some((x) =>
        x.kind === a.kind &&
        (x.kind !== "medicate" || x.medName === a.medName) &&
        (x.kind !== "isolate" || x.targetTankId === a.targetTankId),
      );
      if (!match) {
        throw new StoreError([`执行清单包含建议之外的动作，已拦截：${a.kind}`]);
      }
    }

    const ts = now();
    const payloads: EventPayload[] = [];
    for (const a of actions) {
      if (a.kind === "isolate" && c!.fishGroupId) {
        const group = data.groups.find((g) => g.id === c!.fishGroupId);
        if (!group) throw new StoreError(["隔离动作关联的鱼群已不存在，无法执行"]);
        payloads.push({
          type: "groupMoved",
          groupId: group.id,
          fromTankId: group.tankId,
          toTankId: a.targetTankId!,
        });
      }
    }
    payloads.push({ type: "caseExecuted", caseId, at: ts, actions, note: note?.trim() || undefined });
    payloads.push({
      type: "caseTransition",
      caseId,
      from: "suggested",
      to: "executed",
      at: ts,
      note: note?.trim() || undefined,
    });
    return commit(payloads, clientToken);
  }

  function retestCase(
    caseId: string,
    input: Partial<Record<keyof Reading, string>>,
    note: string | undefined,
    clientToken?: string,
  ): string {
    const c = data.cases.find((x) => x.id === caseId);
    const transition = checkTransition(c, "retested");
    if (!transition.ok) throw new StoreError(transition.errors, "guard");
    const { values, errors } = validateReading(input);
    if (Object.keys(values).length === 0) errors.push("复测至少录入一项指标");
    const test: TestRecord = {
      id: "r-" + idGen(),
      tankId: c!.tankId,
      at: now(),
      readings: values,
      note: note?.trim() || undefined,
    };
    const check = checkRetest(c!, test);
    if (!check.ok || errors.length) throw new StoreError([...errors, ...check.errors], "invalid");

    const ts = now();
    return commit(
      [
        { type: "testAdded", test },
        {
          type: "caseTransition",
          caseId,
          from: "executed",
          to: "retested",
          at: ts,
          note: note?.trim() || undefined,
        },
      ],
      clientToken,
    );
  }

  function closeCase(caseId: string, note: string, clientToken?: string): string {
    const c = data.cases.find((x) => x.id === caseId);
    const transition = checkTransition(c, "closed");
    if (!transition.ok) throw new StoreError(transition.errors, "guard");
    if (!note.trim()) throw new StoreError(["关闭工单必须填写处置结论"]);
    const ts = now();
    return commit(
      [
        { type: "caseClosed", caseId, at: ts, note: note.trim() },
        { type: "caseTransition", caseId, from: "retested", to: "closed", at: ts, note: note.trim() },
      ],
      clientToken,
    );
  }

  // ---------- 撤销 ----------

  function undoBatch(batchId: string, reason: string): string {
    const target = events.find((e) => e.batchId === batchId);
    if (!target) throw new StoreError([`批次 ${batchId} 不存在`]);
    if (target.payload.type === "batchUndone") {
      throw new StoreError(["撤销批次本身不可撤销（如需恢复，请重新操作）"]);
    }
    // 已撤销的批次不能重复撤销
    for (const e of events) {
      if (e.payload.type === "batchUndone" && e.payload.batchIds.includes(batchId)) {
        throw new StoreError(["该批次已经被撤销，请勿重复操作"]);
      }
    }
    const deps = undoDependencies(events, batchId);
    if (deps.length > 0) {
      throw new StoreError([
        "撤销被拦截：存在依赖该批次的后续操作 — " +
          deps.map((d) => d.desc).join("；") +
          "。请先撤销后续批次。",
      ]);
    }
    return commit([{ type: "batchUndone", batchIds: [batchId], reason: reason.trim() || "整批撤销" }]);
  }

  function batches(): { batchId: string; at: number; events: TimelineEvent[]; undone: boolean }[] {
    const undone = new Set<string>();
    events.forEach((e) => {
      if (e.payload.type === "batchUndone") e.payload.batchIds.forEach((b) => undone.add(b));
    });
    const map = new Map<string, { batchId: string; at: number; events: TimelineEvent[]; undone: boolean }>();
    for (const e of events) {
      const key = e.batchId;
      if (!map.has(key)) map.set(key, { batchId: key, at: e.at, events: [], undone: undone.has(key) });
      map.get(key)!.events.push(e);
    }
    return [...map.values()].sort((a, b) => b.at - a.at);
  }

  // ---------- 演示数据 ----------

  function seedDemo() {
    const t0 = now();
    const H = 3_600_000;
    let seq = 0;
    const sid = () => "seed-" + ++seq;
    const tanks: Tank[] = [
      { id: "t-seed-a", name: "草缸A", type: "planted", volumeL: 120, createdAt: t0 - 30 * 24 * H },
      { id: "t-seed-b", name: "海缸B", type: "marine", volumeL: 200, createdAt: t0 - 30 * 24 * H },
      { id: "t-seed-c", name: "繁殖缸C", type: "breeding", volumeL: 60, createdAt: t0 - 20 * 24 * H },
      { id: "t-seed-q", name: "隔离缸Q", type: "quarantine", volumeL: 40, createdAt: t0 - 20 * 24 * H },
    ];
    const groups: FishGroup[] = [
      { id: "g-seed-1", tankId: "t-seed-a", species: "neon", count: 30, createdAt: t0 - 28 * 24 * H },
      { id: "g-seed-2", tankId: "t-seed-b", species: "marine", count: 12, createdAt: t0 - 25 * 24 * H },
      { id: "g-seed-3", tankId: "t-seed-c", species: "guppy", count: 40, createdAt: t0 - 18 * 24 * H },
    ];
    const mk = (
      id: string,
      tankId: string,
      at: number,
      readings: Reading,
      extra?: Partial<TestRecord>,
    ): TestRecord => ({ id, tankId, at, readings, ...extra });
    const tests: TestRecord[] = [
      mk("r-seed-a1", "t-seed-a", t0 - 6 * 24 * H, { ph: 6.8, ammonia: 0, nitrite: 0, nitrate: 15, temp: 25 }),
      mk("r-seed-a2", "t-seed-a", t0 - 2 * 24 * H, { ph: 6.9, ammonia: 0.01, nitrite: 0, nitrate: 18, temp: 25.5 }),
      mk("r-seed-b1", "t-seed-b", t0 - 5 * 24 * H, { ph: 8.2, ammonia: 0, nitrite: 0, nitrate: 8, temp: 26 }),
      mk("r-seed-b2", "t-seed-b", t0 - 1 * 24 * H, { ph: 8.35, ammonia: 0.01, nitrite: 0.02, nitrate: 9, temp: 26.5 }),
      mk("r-seed-c1", "t-seed-c", t0 - 4 * 24 * H, { ph: 7.2, ammonia: 0, nitrite: 0, nitrate: 12, temp: 26 }),
      // 危急：亚硝酸盐翻倍至 0.3 + 白点症状 -> 换水/复测/隔离/用药建议
      mk("r-seed-c2", "t-seed-c", t0 - 3 * H, { ph: 7.1, ammonia: 0.01, nitrite: 0.3, nitrate: 16, temp: 27 }, { symptoms: ["whiteSpot"] }),
    ];
    const seedEvents: TimelineEvent[] = [
      ...tanks.map((tank) => ({ id: "e-" + sid(), batchId: "b-seed", at: tank.createdAt, payload: { type: "tankCreated", tank } as EventPayload })),
      ...groups.map((group) => ({ id: "e-" + sid(), batchId: "b-seed", at: group.createdAt, payload: { type: "groupCreated", group } as EventPayload })),
      ...tests.map((test) => ({ id: "e-" + sid(), batchId: "b-seed", at: test.at, payload: { type: "testAdded", test } as EventPayload })),
    ];
    events = seedEvents;
    data = replay(events);
    // 为繁殖缸C预生成一个"建议"阶段工单，便于进店即见处置流
    const tank = data.tanks.find((t) => t.id === "t-seed-c")!;
    const risk = evalTankRisk(tank, data.groups.filter((g) => g.tankId === tank.id), data.tests);
    const suggestion = buildSuggestion(tank, data.groups.filter((g) => g.tankId === tank.id), data.tanks, risk)!;
    const ts = now();
    const c: Case = {
      id: "c-seed-1",
      tankId: tank.id,
      fishGroupId: "g-seed-3",
      title: suggestion.title,
      risk: suggestion.risk,
      reasons: suggestion.reasons,
      actions: suggestion.actions,
      status: "suggested",
      testRecordId: "r-seed-c2",
      createdAt: ts,
      updatedAt: ts,
      history: [],
      executions: [],
    };
    events.push({ id: "e-" + sid(), batchId: "b-seed-case", at: ts, payload: { type: "caseSuggested", caseData: c } });
    data = replay(events);
    persist();
  }

  function resetAll() {
    events = [];
    data = emptyData();
    quarantine = null;
    clientTokens.clear();
    persist();
    seedDemo();
    emit();
  }

  function exportJson(): string {
    return JSON.stringify({ version: 1 as const, events, quarantine }, null, 2);
  }

  function importJson(raw: string) {
    const parsed = validatePersisted(raw);
    events = parsed.events;
    data = replay(events);
    quarantine = parsed.quarantine;
    clientTokens.clear();
    persist();
    emit();
  }

  load();

  return {
    subscribe,
    getState,
    getEvents,
    getRevision: () => revision,
    batches,
    quarantineInfo,
    discardQuarantine,
    addTank,
    deleteTank,
    addGroup,
    moveGroup,
    deleteGroup,
    addTest,
    suggestCase,
    executeCase,
    retestCase,
    closeCase,
    undoBatch,
    resetAll,
    exportJson,
    importJson,
    STORAGE_KEY,
  };
}

export type Store = ReturnType<typeof createStore>;

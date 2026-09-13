// 鱼缸健康处置台 — 领域规则与事件溯源测试
// 运行：node test/run.cjs（先 esbuild 转译，再 node --test）
import test from "node:test";
import assert from "node:assert/strict";

import { bandLevel, ruleFor, MAX_WATER_CHANGE_PCT } from "../src/domain/thresholds";
import {
  buildSuggestion,
  checkExecute,
  checkMedication,
  checkMoveGroup,
  checkRetest,
  checkTransition,
  checkWaterChange,
  evalTankRisk,
  replay,
  testsForTank,
  undoDependencies,
  validateReading,
} from "../src/domain/engine";
import { createStore, StoreError } from "../src/domain/store";
import type { AppData, FishGroup, Tank, TestRecord, TimelineEvent } from "../src/domain/types";

const H = 3_600_000;

// ---------- 可控时钟 / 内存存储 ----------

class FakeStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

let clock = 0;
function makeStore(opts: { seed?: boolean; storage?: FakeStorage | null } = {}) {
  clock = 1_700_000_000_000;
  const storage = opts.storage === undefined ? new FakeStorage() : opts.storage;
  return createStore({
    now: () => clock,
    id: (() => {
      let n = 0;
      return () => "gen" + ++n;
    })(),
    storage,
    seed: opts.seed ?? false,
  });
}

function errMessages(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof StoreError, "应抛出 StoreError");
    return (e as StoreError).errors.join("｜");
  }
  throw new Error("预期抛错但未抛出");
}

// 辅助：造缸+鱼群+检测
function setupTank(
  store: ReturnType<typeof createStore>,
  type: Tank["type"] = "planted",
  species: FishGroup["species"] = "neon",
) {
  clock = 1_700_000_000_000;
  store.addTank("测试缸", type, 100, "tk1");
  store.addGroup(
    store.getState().tanks[0].id,
    species,
    10,
    undefined,
    "grp1",
  );
  return {
    tankId: store.getState().tanks[0].id,
    groupId: store.getState().groups[0].id,
  };
}

// =====================================================================
// 1. 阈值边界
// =====================================================================

test("pH 淡水基准边界：6.0/6.5/7.5/8.5 临界归类", () => {
  const rule = ruleFor("planted");
  // [6.5,7.5) ok；[6.0,6.5) 或 [7.5,8.5) watch；其余 danger
  assert.equal(bandLevel(6.0, rule.ph), "watch", "6.0 含于 watch 下界");
  assert.equal(bandLevel(6.49, rule.ph), "watch");
  assert.equal(bandLevel(6.5, rule.ph), "ok", "6.5 含于 ok 下界");
  assert.equal(bandLevel(7.49, rule.ph), "ok");
  assert.equal(bandLevel(7.5, rule.ph), "watch", "7.5 不含于 ok，落 watch");
  assert.equal(bandLevel(8.49, rule.ph), "watch");
  assert.equal(bandLevel(8.5, rule.ph), "danger", "8.5 不含于 watch，落 danger");
  assert.equal(bandLevel(5.99, rule.ph), "danger");
});

test("氨氮边界：0 / 0.02 / 0.05 / 0.2", () => {
  const rule = ruleFor("planted");
  assert.equal(bandLevel(0, rule.ammonia), "ok");
  assert.equal(bandLevel(0.0199, rule.ammonia), "ok");
  assert.equal(bandLevel(0.02, rule.ammonia), "watch", "0.02 为关注下界（含）");
  assert.equal(bandLevel(0.0499, rule.ammonia), "watch");
  assert.equal(bandLevel(0.05, rule.ammonia), "danger", "0.05 为危急（含）");
  assert.equal(bandLevel(0.2, rule.ammonia), "danger");
  assert.ok(0.2 >= rule.ammoniaAcute, "0.2 达急性中毒线");
});

test("亚硝酸盐/硝酸盐边界", () => {
  const rule = ruleFor("planted");
  assert.equal(bandLevel(0.1, rule.nitrite), "watch");
  assert.equal(bandLevel(0.25, rule.nitrite), "danger");
  assert.equal(bandLevel(20, rule.nitrate), "watch");
  assert.equal(bandLevel(40, rule.nitrate), "danger");
});

test("缸型差异：海缸 pH 8.1 正常，淡水中 8.1 为关注", () => {
  assert.equal(bandLevel(8.1, ruleFor("marine").ph), "ok");
  assert.equal(bandLevel(8.1, ruleFor("planted").ph), "watch");
  assert.equal(bandLevel(8.4, ruleFor("marine").ph), "watch");
});

test("鱼种差异：金鱼 20℃ 正常，灯鱼 20℃ 为关注", () => {
  assert.equal(bandLevel(20, ruleFor("planted", "goldfish").temp), "ok");
  assert.equal(bandLevel(20, ruleFor("planted", "neon").temp), "danger");
  // 三湖慈鲷 pH 8.0 正常；通用淡水规则 8.0 仅关注
  assert.equal(bandLevel(8.0, ruleFor("cichlid", "cichlid").ph), "ok");
});

test("繁殖缸氨氮零容忍：0.015 在普通缸正常、在繁殖缸关注", () => {
  assert.equal(bandLevel(0.015, ruleFor("planted").ammonia), "ok");
  assert.equal(bandLevel(0.015, ruleFor("breeding", "guppy").ammonia), "watch");
});

test("连续检测变化：氨氮翻倍且 >=0.02 判危急趋势", () => {
  const store = makeStore();
  const { tankId } = setupTank(store);
  store.addTest(tankId, { ammonia: "0.01" }, [], undefined, clock, "t1");
  clock += 24 * H;
  store.addTest(tankId, { ammonia: "0.025" }, [], undefined, clock, "t2");
  const tank = store.getState().tanks[0];
  const risk = evalTankRisk(tank, store.getState().groups, store.getState().tests);
  assert.equal(risk.level, "danger");
  assert.ok(risk.hits.some((h) => h.includes("翻倍")), "应给出翻倍说明");
  assert.equal(risk.trend, "worsening");
});

test("连续检测变化：改善趋势被识别（氨氮 danger→watch）", () => {
  const store = makeStore();
  const { tankId } = setupTank(store);
  store.addTest(tankId, { ammonia: "0.1" }, [], undefined, clock, "t1");
  clock += 24 * H;
  store.addTest(tankId, { ammonia: "0.03" }, [], undefined, clock, "t2");
  const risk = evalTankRisk(store.getState().tanks[0], store.getState().groups, store.getState().tests);
  assert.equal(risk.trend, "improving");
});

test("pH 单次跳变 0.5 触发冲击危急", () => {
  const store = makeStore();
  const { tankId } = setupTank(store);
  store.addTest(tankId, { ph: "6.8" }, [], undefined, clock, "t1");
  clock += 12 * H;
  store.addTest(tankId, { ph: "7.3" }, [], undefined, clock, "t2"); // 跳变 0.5，两值本身都在正常区间
  const risk = evalTankRisk(store.getState().tanks[0], store.getState().groups, store.getState().tests);
  assert.equal(risk.level, "danger");
  assert.ok(risk.hits.some((h) => h.includes("跳变")));
});

test("风险取最严格鱼种规则：草缸内灯鱼 pH 5.8 危急", () => {
  const store = makeStore();
  const { tankId } = setupTank(store, "planted", "neon");
  store.addTest(tankId, { ph: "5.8", temp: "25" }, [], undefined, clock, "t1");
  const risk = evalTankRisk(store.getState().tanks[0], store.getState().groups, store.getState().tests);
  assert.equal(risk.level, "danger");
});

// =====================================================================
// 2. 建议生成
// =====================================================================

test("氨氮危急建议：换水50%(上限) + 隔离 + 复测，且只有一条换水动作", () => {
  const store = makeStore();
  const { tankId } = setupTank(store);
  store.addTank("隔离缸Q", "quarantine", 40, "q1");
  store.addTest(tankId, { ammonia: "0.2", nitrite: "0.3", nitrate: "50", ph: "8.6" }, ["whiteSpot"], undefined, clock, "t1");
  const s = store.getState();
  const tank = s.tanks.find((t) => t.id === tankId)!;
  const risk = evalTankRisk(tank, s.groups, s.tests);
  const sug = buildSuggestion(tank, s.groups.filter((g) => g.tankId === tankId), s.tanks, risk)!;
  const wc = sug.actions.filter((a) => a.kind === "waterChange");
  assert.equal(wc.length, 1, "多次换水建议合并为一条");
  assert.equal(wc[0].waterChangePct, 0.5);
  assert.ok(sug.actions.some((a) => a.kind === "isolate"));
  assert.ok(sug.actions.some((a) => a.kind === "medicate" && a.medName === "甲基蓝"));
  assert.ok(sug.actions.some((a) => a.kind === "retest"));
  assert.equal(sug.retestHours, 24);
});

test("无隔离缸时危急建议给出说明且不产生隔离动作", () => {
  const store = makeStore();
  const { tankId } = setupTank(store);
  store.addTest(tankId, { ammonia: "0.1" }, [], undefined, clock, "t1");
  const s = store.getState();
  const risk = evalTankRisk(s.tanks[0], s.groups, s.tests);
  const sug = buildSuggestion(s.tanks[0], s.groups, s.tanks, risk)!;
  assert.ok(!sug.actions.some((a) => a.kind === "isolate"));
  assert.ok(sug.reasons.some((r) => r.includes("无可用隔离缸")));
});

test("全部正常不产生建议", () => {
  const store = makeStore();
  const { tankId } = setupTank(store);
  store.addTest(tankId, { ph: "6.8", ammonia: "0", nitrite: "0", nitrate: "10", temp: "25" }, [], undefined, clock, "t1");
  const s = store.getState();
  const risk = evalTankRisk(s.tanks[0], s.groups, s.tests);
  assert.equal(buildSuggestion(s.tanks[0], s.groups, s.tanks, risk), null);
});

// =====================================================================
// 3. 非法状态跳跃
// =====================================================================

test("状态机：建议不能直接关闭/复测；关闭后不能再流转", () => {
  const store = makeStore();
  const { tankId } = setupTank(store);
  store.addTest(tankId, { ammonia: "0.1" }, [], undefined, clock, "t1");
  const testId = store.getState().tests[0].id;
  clock += H; // 检测 1 小时后生成处置建议
  store.suggestCase(tankId, testId, "sug1");
  const c = () => store.getState().cases[0];

  assert.match(errMessages(() => store.closeCase(c().id, "结束")), /非法状态跳跃/);
  assert.match(
    errMessages(() => store.retestCase(c().id, { ammonia: "0.01" }, undefined)),
    /suggested（建议）不能直接变为 retested（复测）/,
  );

  store.executeCase(c().id, c().actions.filter((a) => a.kind !== "isolate"), undefined, "exe1");
  assert.equal(c().status, "executed");
  // 不能重复执行
  assert.match(errMessages(() => store.executeCase(c().id, [], undefined)), /非法状态跳跃/);
  // 不能从执行直接关闭
  assert.match(errMessages(() => store.closeCase(c().id, "结束")), /不能直接变为/);

  clock += 24 * H; // 处置 24 小时后复测
  store.retestCase(c().id, { ammonia: "0.01" }, undefined, "rt1");
  assert.equal(c().status, "retested");
  // 复测阶段不能再次复测
  assert.match(errMessages(() => store.retestCase(c().id, { ammonia: "0" }, undefined)), /非法状态跳跃/);

  assert.throws(() => store.closeCase(c().id, "   "), StoreError, "关闭必须写结论");
  store.closeCase(c().id, "指标恢复，关闭工单", "cl1");
  assert.equal(c().status, "closed");
  assert.match(errMessages(() => store.closeCase(c().id, "再关")), /工单已关闭/);
});

test("复测时间必须晚于建单时间（补录旧数据被拒）", () => {
  const store = makeStore();
  const { tankId } = setupTank(store);
  store.addTest(tankId, { ammonia: "0.1" }, [], undefined, clock - 10 * H, "old-test");
  const testId = store.getState().tests[0].id;
  store.suggestCase(tankId, testId, "sug");
  // 时钟已在 test 之后；checkRetest 用 now()>createdAt，正常路径通过
  store.executeCase(store.getState().cases[0].id, store.getState().cases[0].actions, undefined, "ex");
  // 直接构造一个旧 TestRecord 验证 checkRetest 规则
  const c = store.getState().cases[0];
  const old: TestRecord = { id: "x", tankId, at: c.createdAt - 1, readings: { ammonia: 0 } };
  const guard = checkRetest(c, old);
  assert.equal(guard.ok, false);
  assert.match(guard.errors.join(), /晚于建议生成时间/);
});

// =====================================================================
// 4. 重复提交 / 重复用药
// =====================================================================

test("clientToken 幂等：同一令牌重复提交只产生一个批次", () => {
  const store = makeStore();
  const before = store.getEvents().length;
  const b1 = store.addTank("缸一", "planted", 100, "token-1");
  const b2 = store.addTank("缸一-重复请求", "marine", 50, "token-1");
  assert.equal(b1, b2, "同 token 返回同一批次");
  assert.equal(store.getState().tanks.length, 1, "重试不新增缸");
  assert.equal(store.getEvents().length - before, 1);
});

test("同一检测不能重复生成进行中工单", () => {
  const store = makeStore();
  const { tankId } = setupTank(store);
  store.addTest(tankId, { ammonia: "0.1" }, [], undefined, clock, "t1");
  const id = store.getState().tests[0].id;
  store.suggestCase(tankId, id, "a");
  assert.match(errMessages(() => store.suggestCase(tankId, id, "b")), /重复提交拦截/);
});

test("换水边界：0%、超过50% 拦截；恰好50% 允许", () => {
  assert.equal(checkWaterChange(0).ok, false);
  assert.equal(checkWaterChange(-0.1).ok, false);
  assert.equal(checkWaterChange(MAX_WATER_CHANGE_PCT + 0.01).ok, false);
  assert.match(checkWaterChange(0.8).errors.join(), /安全上限 50%/);
  assert.equal(checkWaterChange(0.5).ok, true);
});

test("重复用药：72 小时内同药拦截，跨工单同样拦截；72h 后放行", () => {
  const store = makeStore();
  const { tankId, groupId } = setupTank(store);
  store.addTank("隔离缸Q", "quarantine", 40, "q");
  store.addTest(tankId, { ammonia: "0.1" }, ["whiteSpot"], undefined, clock, "t1");
  const id = store.getState().tests[0].id;
  store.suggestCase(tankId, id, "sug");
  let c = store.getState().cases[0];
  // 执行含用药的建议
  store.executeCase(c.id, c.actions, undefined, "exec");
  assert.equal(store.getState().groups.find((g) => g.id === groupId)!.tankId, store.getState().tanks[1].id, "鱼已进隔离缸");

  // 同批次清单内夹带重复药品
  const dup = checkExecute(c, [
    { kind: "medicate", medName: "甲基蓝", dose: "x" },
    { kind: "medicate", medName: "甲基蓝", dose: "x" },
  ], store.getState(), clock);
  assert.match(dup.errors.join(), /清单中药品.*重复/);

  // 71h 后另一工单再次用甲基蓝 → 拦截
  clock += 71 * H;
  store.addTest(tankId, { nitrite: "0.3" }, ["fungus"], undefined, clock, "t2");
  store.suggestCase(tankId, store.getState().tests[1].id, "sug2");
  c = store.getState().cases.find((x) => x.status === "suggested")!;
  // 用药发生在原缸，新工单也在原缸
  const guard = checkMedication(tankId, "甲基蓝", clock, store.getState());
  assert.equal(guard.ok, false);
  assert.match(guard.errors.join(), /安全间隔 72 小时/);

  // 73h 后放行
  clock += 2 * H;
  assert.equal(checkMedication(tankId, "甲基蓝", clock, store.getState()).ok, true);
});

test("执行清单不能夹带建议之外的动作", () => {
  const store = makeStore();
  const { tankId } = setupTank(store);
  store.addTest(tankId, { nitrate: "30" }, [], undefined, clock, "t1"); // 仅换水+复测
  store.suggestCase(tankId, store.getState().tests[0].id, "s");
  const c = store.getState().cases[0];
  assert.match(
    errMessages(() => store.executeCase(c.id, [{ kind: "medicate", medName: "私自下药", dose: "" }], undefined)),
    /建议之外/,
  );
});

// =====================================================================
// 5. 跨缸转移拦截
// =====================================================================

test("跨缸转移：同缸、目标危急、危急期只能进隔离缸、用药观察期", () => {
  const store = makeStore();
  const { tankId, groupId } = setupTank(store, "planted", "neon");
  store.addTank("海缸B", "marine", 200, "b");
  store.addTank("隔离缸Q", "quarantine", 40, "q");
  const s = () => store.getState();
  const group = () => s().groups.find((g) => g.id === groupId)!;

  // 同缸转移
  assert.match(errMessages(() => store.moveGroup(groupId, tankId)), /目标缸与当前缸相同/);

  // 目标缸危急
  const marine = s().tanks.find((t) => t.name === "海缸B")!;
  store.addTest(marine.id, { ammonia: "0.2" }, [], undefined, clock, "bt");
  assert.match(errMessages(() => store.moveGroup(groupId, marine.id)), /目标缸.*危急/);

  // 源缸危急：只能进隔离缸
  store.addTest(tankId, { ammonia: "0.15" }, [], undefined, clock, "ct");
  const healthy = store.addTank("三湖缸D", "cichlid", 150, "d");
  void healthy;
  const d = s().tanks.find((t) => t.name === "三湖缸D")!;
  const g1 = checkMoveGroup(group(), d.id, s(), clock);
  assert.equal(g1.ok, false);
  assert.match(g1.errors.join(), /只允许转入隔离缸/);
  // 进隔离缸放行
  const q = s().tanks.find((t) => t.name === "隔离缸Q")!;
  assert.equal(checkMoveGroup(group(), q.id, s(), clock).ok, true);

  // 用药观察期：在隔离缸内用药（健康水质+白点症状，仅产生用药建议），随后转健康缸被拦
  store.moveGroup(groupId, q.id, "mv1");
  const qTankId = q.id;
  const eId = store.addTank("草缸E", "planted", 100, "e"); // 无检测记录视为健康
  void eId;
  const e = s().tanks.find((t) => t.name === "草缸E")!;
  store.addTest(qTankId, { ph: "7.0", ammonia: "0", nitrite: "0", nitrate: "5", temp: "26" }, ["whiteSpot"], undefined, clock, "qt");
  store.suggestCase(qTankId, s().tests.find((t) => t.tankId === qTankId)!.id, "qs");
  const qc = s().cases.find((c) => c.status === "suggested")!;
  assert.ok(qc.actions.some((a) => a.kind === "medicate"));
  store.executeCase(qc.id, qc.actions.filter((a) => a.kind !== "isolate"), undefined, "qe");
  clock += 10 * H;
  assert.match(errMessages(() => store.moveGroup(groupId, e.id)), /用药观察期/);
  // 72h 后且两缸都健康 -> 放行
  clock += 80 * H;
  store.moveGroup(groupId, e.id, "mv2");
  assert.equal(s().groups.find((g) => g.id === groupId)!.tankId, e.id);
});

// =====================================================================
// 6. 时间线 / 整批撤销
// =====================================================================

test("所有变更进入时间线并可按批次整批撤销（工单全流程回退）", () => {
  const store = makeStore();
  const { tankId } = setupTank(store);
  store.addTest(tankId, { ammonia: "0.1" }, [], undefined, clock, "t1");
  const testId = store.getState().tests[0].id;
  const sugBatch = store.suggestCase(tankId, testId, "s");
  const c0 = store.getState().cases[0];
  clock += H;
  const exeBatch = store.executeCase(c0.id, c0.actions, undefined, "e");
  clock += 24 * H;
  const rtBatch = store.retestCase(c0.id, { ammonia: "0.01" }, undefined, "r");
  clock += H;
  const clBatch = store.closeCase(c0.id, "恢复", "c");
  assert.equal(store.getState().cases[0].status, "closed");
  assert.ok(store.getEvents().length >= 8);

  // 倒序整批撤销
  store.undoBatch(clBatch, "撤销关闭");
  assert.equal(store.getState().cases[0].status, "retested");
  store.undoBatch(rtBatch, "撤销复测");
  assert.equal(store.getState().cases[0].status, "executed");
  store.undoBatch(exeBatch, "撤销执行");
  assert.equal(store.getState().cases[0].status, "suggested");
  store.undoBatch(sugBatch, "撤销建议");
  assert.equal(store.getState().cases.length, 0, "工单随建议批次整体消失");

  // 撤销事件本身也在时间线
  assert.ok(store.getEvents().some((e) => e.payload.type === "batchUndone"));
  // 已撤销批次不可重复撤销
  assert.match(errMessages(() => store.undoBatch(sugBatch, "再撤")), /已经被撤销/);
});

test("撤销有依赖的批次被拦截并说明原因", () => {
  const store = makeStore();
  const b1 = store.addTank("缸一", "planted", 100, "t");
  const tankId = store.getState().tanks[0].id;
  store.addGroup(tankId, "neon", 5, undefined, "g");
  // 直接撤缸批次：后续鱼群批次会悬空
  const msg = errMessages(() => store.undoBatch(b1, "x"));
  assert.match(msg, /撤销被拦截/);
  assert.match(msg, /鱼群所属缸已不存在/);
});

test("撤销隔离转移批次会把鱼带回原缸", () => {
  const store = makeStore();
  const { tankId, groupId } = setupTank(store);
  store.addTank("Q", "quarantine", 40, "q");
  const qId = store.getState().tanks[1].id;
  const batch = store.moveGroup(groupId, qId, "m");
  assert.equal(store.getState().groups[0].tankId, qId);
  store.undoBatch(batch, "撤回转移");
  assert.equal(store.getState().groups[0].tankId, tankId);
});

// =====================================================================
// 7. 持久化恢复
// =====================================================================

test("数据刷新后恢复：事件重放得到相同状态", () => {
  const storage = new FakeStorage();
  let store = makeStore({ storage });
  const { tankId } = setupTank(store);
  store.addTest(tankId, { ammonia: "0.1" }, [], undefined, clock, "t1");
  store.suggestCase(tankId, store.getState().tests[0].id, "s");
  const snapshot = JSON.stringify({
    tanks: store.getState().tanks.map((t) => [t.id, t.name]),
    cases: store.getState().cases.map((c) => [c.id, c.status]),
  });

  // 重新装载（同一 localStorage）
  const store2 = makeStore({ storage });
  const snapshot2 = JSON.stringify({
    tanks: store2.getState().tanks.map((t) => [t.id, t.name]),
    cases: store2.getState().cases.map((c) => [c.id, c.status]),
  });
  assert.equal(snapshot2, snapshot);
  assert.equal(store2.getState().cases[0].status, "suggested");
});

test("损坏数据被隔离：JSON 损坏时清空主数据并保留原文，可丢弃", () => {
  const storage = new FakeStorage();
  storage.setItem("aquarium-desk-state-v1", "{ 这不是合法JSON ");
  const store = makeStore({ storage });
  assert.deepEqual(store.getState().tanks, []);
  const q = store.quarantineInfo()!;
  assert.ok(q.raw.includes("不是合法JSON"));
  assert.match(q.reason, /JSON 解析失败/);
  // 丢弃隔离数据后不再出现
  store.discardQuarantine();
  assert.equal(store.quarantineInfo(), null);
  // 新写入正常落盘，再次装载无隔离
  store.addTank("新缸", "planted", 100, "n");
  const store2 = makeStore({ storage });
  assert.equal(store2.getState().tanks.length, 1);
  assert.equal(store2.quarantineInfo(), null);
});

test("结构性损坏（未知事件类型/重复id/版本错误）被隔离", () => {
  const storage = new FakeStorage();
  const key = "aquarium-desk-state-v1";
  const cases: string[] = [
    JSON.stringify({ version: 9, events: [] }),
    JSON.stringify({ version: 1, events: [{ id: "x", batchId: "b", at: 1, payload: { type: "nope" } }] }),
    JSON.stringify({
      version: 1,
      events: [
        { id: "dup", batchId: "b", at: 1, payload: { type: "tankCreated", tank: {} } },
        { id: "dup", batchId: "b", at: 1, payload: { type: "tankCreated", tank: {} } },
      ],
    }),
  ];
  for (const raw of cases) {
    storage.setItem(key, raw);
    const store = makeStore({ storage });
    assert.ok(store.quarantineInfo(), "应隔离：" + raw.slice(0, 40));
    assert.deepEqual(store.getState().tanks, []);
  }
});

test("悬空引用事件（检测指向不存在的缸）在装载期被识别为损坏并隔离", () => {
  const storage = new FakeStorage();
  const raw = JSON.stringify({
    version: 1,
    events: [
      { id: "e1", batchId: "b1", at: 1, payload: { type: "testAdded", test: { id: "r1", tankId: "ghost", at: 1, readings: {} } } },
    ],
  });
  storage.setItem("aquarium-desk-state-v1", raw);
  const store = makeStore({ storage });
  const q = store.quarantineInfo()!;
  assert.ok(q, "悬空数据应被隔离");
  assert.match(q.reason, /悬空引用/);
  assert.deepEqual(store.getState().tests, []);
});

// =====================================================================
// 8. 输入校验与杂项
// =====================================================================

test("检测输入：非数字、超物理范围、空值处理", () => {
  const r1 = validateReading({ ph: "abc" });
  assert.match(r1.errors.join(), /不是数字/);
  const r2 = validateReading({ ph: "15", temp: "-5", ammonia: "0.01" });
  assert.match(r2.errors.join(), /pH/);
  assert.match(r2.errors.join(), /水温/);
  assert.equal(r2.values.ammonia, 0.01);
  const r3 = validateReading({ ph: "", nitrate: "   " });
  assert.deepEqual(r3.values, {});
});

test("无存储环境（隐私模式）下仍可工作", () => {
  const store = makeStore({ storage: null });
  store.addTank("离线缸", "planted", 100, "t");
  assert.equal(store.getState().tanks.length, 1);
});

test("事件重放确定性：乱序事件按时间/批次回放结果一致", () => {
  const store = makeStore();
  const { tankId } = setupTank(store);
  store.addTest(tankId, { ammonia: "0.1" }, [], undefined, clock, "t1");
  const evs = store.getEvents();
  const reversed = [...evs].reverse();
  // 检测记录按时间排序读取，不受插入顺序影响
  const series = testsForTank(replay(evs).tests, tankId);
  const series2 = testsForTank(replay(reversed).tests, tankId);
  assert.deepEqual(series2.map((t) => t.id), series.map((t) => t.id));
});

test("删缸前必须清空鱼群", () => {
  const store = makeStore();
  const { tankId } = setupTank(store);
  assert.match(errMessages(() => store.deleteTank(tankId)), /仍有 1 个鱼群/);
  store.deleteGroup(store.getState().groups[0].id);
  store.deleteTank(tankId);
  assert.equal(store.getState().tanks.length, 0);
});

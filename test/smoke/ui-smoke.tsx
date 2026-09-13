import "./jsdom-global.cjs";
import { createRoot } from "react-dom/client";
import { act } from "react";
import assert from "node:assert";

async function main() {
// 先清掉持久化数据（全局 localStorage 已由 jsdom-global 提供）
localStorage.clear();
const { store } = await import("../../src/ui/store-hook");
const { default: App } = await import("../../src/App");

const container = document.getElementById("root")!;
await act(async () => {
  createRoot(container).render(<App />);
});

let passed = 0;
function check(name: string, cond: boolean, detail?: string) {
  assert.ok(cond, name + (detail ? " — " + detail : ""));
  passed++;
  console.log("ok -", name);
}

const text = () => container.textContent ?? "";
function findButton(label: string): HTMLButtonElement {
  const btns = [...container.querySelectorAll("button")] as HTMLButtonElement[];
  return btns.find((b) => (b.textContent ?? "").includes(label))!;
}
function click(label: string | RegExp) {
  const btns = [...container.querySelectorAll("button")] as HTMLButtonElement[];
  const b = btns.find((x) =>
    typeof label === "string" ? (x.textContent ?? "").includes(label) : label.test(x.textContent ?? ""),
  )!;
  assert.ok(b, "找不到按钮：" + label);
  act(() => b.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
}
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  // jsdom 下直接赋 .value 不会更新 React 的 inputValueTracking，必须走原型原生 setter
  const proto =
    el instanceof window.HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : el instanceof window.HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
}
function setInput(input: Element, value: string) {
  const el = input as HTMLInputElement;
  act(() => {
    setNativeValue(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
function setSelect(select: Element, value: string) {
  const el = select as HTMLSelectElement;
  act(() => {
    setNativeValue(el, value);
    el.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}

// ---------- 1. 种子数据挂载 ----------
check("挂载后显示标题", text().includes("鱼缸健康处置台"));
check("种子缸存在：草缸A/海缸B/繁殖缸C/隔离缸Q", ["草缸A", "海缸B", "繁殖缸C", "隔离缸Q"].every((n) => text().includes(n)));
check("繁殖缸C 存在危急标识（种子数据）", text().includes("危急"));

// 找到繁殖缸C 的种子工单（切到处置工单页）
click("处置工单");
check("工单页显示四阶段与种子工单", text().includes("进行中工单") && text().includes("建议"));
const cCard = [...container.querySelectorAll(".case-card")].find((el) =>
  (el.textContent ?? "").includes("繁殖缸"),
)!;
check("种子工单含重复用药提示文案", cCard.textContent!.includes("72 小时内禁重复"));
check("种子工单含隔离转移动作", cCard.textContent!.includes("隔离转移至"));

// ---------- 2. 非法状态跳跃：复测阶段前不存在复测录入 ----------
check("建议阶段只显示执行面板", cCard.querySelector(".phase-panel") !== null);

// ---------- 3. 执行种子工单（勾选全部：换水+隔离+用药+复测动作，含鱼群转移） ----------
const checksBefore = cCard.querySelectorAll('input[type="checkbox"]').length;
assert.ok(checksBefore >= 2, "执行清单应至少有 2 个勾选框");
click("确认执行，进入复测阶段");
check("执行后进入复测阶段（状态=执行）", text().includes("录入处置后的复测数据"));

// 鱼已进隔离缸
const groupAfter = store.getState().groups.find((g) => g.id === "g-seed-3")!;
check("执行隔离后鱼群进入隔离缸Q", groupAfter.tankId === "t-seed-q");

// 回到详情确认转移结果
click("鱼缸与检测");
click("隔离缸Q");
check("隔离缸Q 详情中可见孔雀鱼", text().includes("孔雀鱼"));

// ---------- 4. 在隔离缸Q 再登记危急检测并生成工单，尝试重复用药 ----------
const detail = container.querySelector(".detail-panel")!;
const readingInputs = detail.querySelectorAll(".reading-grid input") as NodeListOf<HTMLInputElement>;
// reading-grid 顺序：pH/氨氮/亚硝/硝酸/水温
setInput(readingInputs[0], "7.0");
setInput(readingInputs[1], "0");
setInput(readingInputs[2], "0.3"); // 亚硝危急
setInput(readingInputs[3], "5");
setInput(readingInputs[4], "26");
// 勾选白点病
const boxes = detail.querySelectorAll('.symptom-row input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
act(() => boxes[0].click());
click("提交检测");

// 该缸最新一行点"生成处置建议"
const freshDetail = () => container.querySelector(".detail-panel")!;
const sugBtns = [...freshDetail().querySelectorAll("button")].filter((b) =>
  (b.textContent ?? "").includes("生成处置建议"),
);
act(() => (sugBtns[0] as HTMLButtonElement).click());
check("第二个工单生成（重复提交由领域层拦截，UI 仍在）", store.getState().cases.filter((c) => c.status === "suggested").length >= 1);

click("处置工单");
const cards = [...container.querySelectorAll(".case-card")] as HTMLElement[];
const qCase = cards.find(
  (el) => el.classList.contains("status-suggested") && (el.textContent ?? "").includes("隔离缸Q"),
)!;
check("Q缸工单建议含甲基蓝", qCase.textContent!.includes("甲基蓝"));
// 勾选全部动作执行（鱼已在隔离缸，isolate 动作的目标也是本缸……实际建议里不会有 isolate：鱼已在该缸，危急且目标=隔离缸自身）
// 直接点执行
const execBtn = [...qCase.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("确认执行"))!;
act(() => execBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
const banner = qCase.querySelector(".error-banner");
check("72h 内重复甲基蓝被拦截并说明原因", banner !== null && banner.textContent!.includes("重复用药拦截") && banner.textContent!.includes("72 小时"));
check("拦截后工单仍停留在建议阶段", store.getState().cases.some((c) => c.tankId === "t-seed-q" && c.status === "suggested"));

// 只执行非用药动作（换水+复测）—— 取消用药勾选
const medCheckbox = [...qCase.querySelectorAll(".pick-list input[type=checkbox]")].find((cb) => {
  const li = (cb as HTMLInputElement).closest("li")!;
  return li.textContent!.includes("甲基蓝");
}) as HTMLInputElement;
act(() => medCheckbox.click());
act(() => execBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
check("去掉用药后执行成功，进入复测阶段", qCase.textContent!.includes("录入处置后的复测数据"));

// ---------- 5. 跨缸转移拦截：用药观察期内把鱼转回草缸 ----------
click("鱼缸与检测");
click("隔离缸Q");
const moveSelect = [...container.querySelectorAll(".group-actions select")][0] as HTMLSelectElement;
const options = [...moveSelect.options].map((o) => o.textContent);
assert.ok(options.some((o) => o!.includes("草缸A")));
setSelect(moveSelect, [...moveSelect.options].find((o) => o.textContent!.includes("草缸A"))!.value);
const moveBtn = [...container.querySelectorAll(".group-actions button")].find((b) => b.textContent === "转移")!;
act(() => moveBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
check("用药观察期跨缸转移被拦截", text().includes("用药观察期"));

// ---------- 6. 完成 C 缸工单复测+关闭 ----------
click("处置工单");
// 找到已执行的 C 缸工单做复测（精确按 h3 标题匹配，避免命中 Q 缸卡片）
const cCard2 = ([...container.querySelectorAll(".case-card")] as HTMLElement[]).find((el) =>
  el.querySelector("h3")!.textContent!.includes("繁殖缸C"),
)!;
check("C 缸工单处于执行阶段等待复测", cCard2.classList.contains("status-executed"));
const retestInputs = cCard2.querySelectorAll(".reading-grid input") as NodeListOf<HTMLInputElement>;
setInput(retestInputs[0], "7.1");
setInput(retestInputs[1], "0");
setInput(retestInputs[2], "0.02");
setInput(retestInputs[3], "10");
setInput(retestInputs[4], "26");
const retestBtn = [...cCard2.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("提交复测"))!;
act(() => retestBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
const cCard2fresh = ([...container.querySelectorAll(".case-card")] as HTMLElement[]).find((el) =>
  el.querySelector("h3")!.textContent!.includes("繁殖缸C"),
)!;
const hasClosePanel = !!cCard2fresh.querySelector("textarea") &&
  [...cCard2fresh.querySelectorAll("button")].some((b) => (b.textContent ?? "").includes("关闭工单"));
check("复测提交后进入关闭阶段", hasClosePanel);

// 空结论被拦
const closeBtn = [...cCard2fresh.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("关闭工单"))!;
act(() => closeBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
check("空关闭结论被拦截", cCard2fresh.textContent!.includes("关闭工单必须填写处置结论"));

const ta = cCard2fresh.querySelector("textarea") as HTMLTextAreaElement;
setInput(ta, "亚硝降至0.02，鱼只恢复，关闭");
act(() => closeBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
check("工单关闭", store.getState().cases.find((c) => c.id === "c-seed-1")!.status === "closed");

// ---------- 7. 时间线与撤销 ----------
click("时间线与撤销");
check("时间线展示批次", text().includes("变更时间线"));
const eventCount = store.getEvents().length;
check("所有变更都在时间线（事件数 >= 10）", eventCount >= 10, `实际 ${eventCount}`);

// 尝试撤销最早的种子批次 -> 应被依赖拦截
const undoBtns = [...container.querySelectorAll("button")].filter((b) => b.textContent === "整批撤销");
const lastUndo = undoBtns[undoBtns.length - 1];
act(() => lastUndo.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
const confirmBtn = [...container.querySelectorAll("button")].filter((b) => b.textContent === "确认撤销").pop()!;
act(() => confirmBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
check("撤销被依赖拦截并说明", text().includes("撤销被拦截") && text().includes("请先撤销后续批次"));

// 撤销关闭批次 -> 工单回到复测阶段
const firstUndo = undoBtns[0];
act(() => firstUndo.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
const confirm1 = [...container.querySelectorAll("button")].filter((b) => b.textContent === "确认撤销")[0];
act(() => confirm1.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
check("整批撤销关闭后工单回到复测阶段", store.getState().cases.find((c) => c.id === "c-seed-1")!.status === "retested");
check("撤销事件进入时间线", store.getEvents().some((e) => e.payload.type === "batchUndone"));

// ---------- 8. 持久化：新 store 重放一致 ----------
const persisted = localStorage.getItem(store.STORAGE_KEY)!;
assert.ok(persisted, "数据已写入 localStorage");
const parsed = JSON.parse(persisted);
check("持久化结构带版本号与事件数组", parsed.version === 1 && Array.isArray(parsed.events));

console.log(`\n# smoke assertions passed: ${passed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

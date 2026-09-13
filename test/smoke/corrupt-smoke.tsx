// 独立进程：写入损坏 localStorage 数据，挂载 App，验证隔离横幅
require("./jsdom-global.cjs");
const { act } = require("react");
const { createRoot } = require("react-dom/client");
const assert = require("node:assert");

localStorage.setItem(
  "aquarium-desk-state-v1",
  '{ "version": 1, "events": [ 损坏数据 ',
);

(async () => {
  const { store } = await import("../../src/ui/store-hook");
  const { default: App } = await import("../../src/App");
  const container = document.getElementById("root");
  await act(async () => {
    createRoot(container).render(<App />);
  });

  const text = container.textContent;
  assert.ok(text.includes("已自动隔离"), "应显示隔离横幅");
  assert.ok(text.includes("JSON 解析失败"), "应说明损坏原因");
  assert.deepEqual(store.getState().tanks, [], "主数据为空状态启动");
  assert.ok(store.quarantineInfo(), "隔离区保留原始损坏文本");
  console.log("ok - 损坏数据隔离横幅显示，主数据安全启动");

  // 丢弃后横幅消失
  const btns = [...container.querySelectorAll("button")];
  const discard = btns.find((b) => b.textContent.includes("丢弃损坏数据"));
  assert.ok(discard, "有丢弃按钮");
  await act(async () => discard.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
  assert.ok(!container.textContent.includes("已自动隔离"), "丢弃后横幅消失");
  assert.equal(store.quarantineInfo(), null);
  console.log("ok - 丢弃损坏数据后恢复正常界面");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

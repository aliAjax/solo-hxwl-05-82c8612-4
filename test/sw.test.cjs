// service worker 离线缓存行为测试。
// sw.js 是浏览器脚本（引用 self/caches/fetch），这里用 vm 构造最小 SW 全局，
// 验证：导航网络优先+离线回退、静态资源缓存优先、非同源/POST 放行。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ORIGIN = "http://localhost:5105";

function loadWorker() {
  const code = fs.readFileSync(path.join(__dirname, "..", "public", "sw.js"), "utf8");
  const handlers = new Map();

  function makeResponse(body, ok = true) {
    return {
      ok,
      body,
      clone() {
        return makeResponse(body, ok);
      },
    };
  }

  const store = new Map();
  const cache = {
    match: async (req) => {
      const key = typeof req === "string" ? req : req.url;
      return store.has(key) ? store.get(key) : undefined;
    },
    put: async (req, res) => {
      const key = typeof req === "string" ? req : req.url;
      store.set(key, res);
    },
    addAll: async () => {},
  };
  const cachesApi = {
    open: async () => cache,
    match: async (req) => cache.match(req),
    keys: async () => [],
    delete: async () => true,
  };

  // 可切换的网络行为：默认正常，可置为 reject 模拟断网
  const net = {
    fail: false,
    calls: 0,
  };
  const fetchMock = async (req) => {
    net.calls++;
    if (net.fail) throw new Error("network offline");
    return makeResponse("network:" + req.url);
  };

  let claimed = false;
  const selfApi = {
    location: { origin: ORIGIN },
    skipWaiting: () => {},
    clients: { claim: async () => { claimed = true; } },
  };

  const sandbox = {
    caches: cachesApi,
    fetch: fetchMock,
    URL,
    Promise,
    console,
  };
  sandbox.self = sandbox;
  Object.assign(sandbox, selfApi);
  sandbox.addEventListener = (type, fn) => {
    handlers.set(type, fn);
  };

  vm.runInNewContext(code, sandbox, { filename: "sw.js" });

  function fire(type, event) {
    const h = handlers.get(type);
    assert.ok(h, `应注册 ${type} 事件`);
    h(event);
  }

  return {
    fire,
    store,
    net,
    makeResponse,
    get claimed() {
      return claimed;
    },
  };
}

function respondEvent(url, init = {}) {
  let captured;
  const event = {
    request: { method: init.method || "GET", mode: init.mode || "navigate", url },
    waitUntil: () => {},
    respondWith: (p) => {
      captured = p;
    },
  };
  return {
    event,
    result: () => captured,
  };
}

test("SW: install/activate 正常完成并 claim", async () => {
  const w = loadWorker();
  w.fire("install", { waitUntil: async () => {} });
  let activated = false;
  w.fire("activate", { waitUntil: (p) => p.then(() => (activated = true)) });
  // 跨 vm 的 Promise 链需要排空多轮微任务
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(activated, true);
  assert.equal(w.claimed, true);
});

test("SW: 导航请求网络优先，并把页面写入缓存", async () => {
  const w = loadWorker();
  const { event, result } = respondEvent(ORIGIN + "/dashboard");
  w.fire("fetch", event);
  const res = await result();
  assert.equal(res.body, "network:" + ORIGIN + "/dashboard");
  assert.ok(w.store.has("/index.html"), "导航成功后应缓存 index.html");
});

test("SW: 断网时导航回退到缓存的 index.html（离线可打开页面）", async () => {
  const w = loadWorker();
  // 先在线访问一次，写入缓存
  const first = respondEvent(ORIGIN + "/");
  w.fire("fetch", first.event);
  await first.result();
  // 断网
  w.net.fail = true;
  const offline = respondEvent(ORIGIN + "/cases");
  w.fire("fetch", offline.event);
  const res = await offline.result();
  assert.ok(res, "断网时必须返回缓存而不是抛错");
  assert.equal(res.body, "network:" + ORIGIN + "/", "返回的是缓存的首页内容");
});

test("SW: 静态资源缓存优先，二次命中不再请求网络", async () => {
  const w = loadWorker();
  const url = ORIGIN + "/assets/index-abc.js";
  const e1 = respondEvent(url, { mode: "no-cors" });
  w.fire("fetch", e1.event);
  await e1.result();
  assert.equal(w.net.calls, 1);

  const e2 = respondEvent(url, { mode: "no-cors" });
  w.fire("fetch", e2.event);
  const res = await e2.result();
  assert.equal(w.net.calls, 1, "缓存命中不应再访问网络");
  assert.equal(res.body, "network:" + url);
});

test("SW: 非同源请求与 POST 不拦截（respondWith 不被调用）", async () => {
  const w = loadWorker();
  const cross = respondEvent("https://cdn.example.com/x.js", { mode: "cors" });
  w.fire("fetch", cross.event);
  assert.equal(cross.result(), undefined);

  const post = respondEvent(ORIGIN + "/api", { method: "POST", mode: "same-origin" });
  w.fire("fetch", post.event);
  assert.equal(post.result(), undefined);
});

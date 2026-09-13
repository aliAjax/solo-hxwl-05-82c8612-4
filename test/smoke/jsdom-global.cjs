// jsdom 全局环境安装器。
//
// 兼容两类 Node：
//   - Node 20：navigator/addEventListener 等尚不是全局，直接赋值即可；
//   - Node 21+：navigator 是 configurable 的只读 getter，EventTarget 方法作为继承属性
//     挂在 globalThis 上，直接赋值会抛 "Cannot set property ... which has only a getter"。
// 因此所有安装都经过 installGlobal：按描述符选择直接赋值 / defineProperty 重定义 /
// 失败时保留 Node 内建，绝不在挂载应用前抛错。从 window 取出的函数统一绑定回 window，
// 避免未绑定方法以 globalThis 为 this 调用时触发 Illegal invocation。

const { JSDOM } = require("jsdom");

const dom = new JSDOM(
  '<!doctype html><html><body><div id="root"></div></body></html>',
  { url: "http://localhost:5105/" },
);
const { window } = dom;

function isFunction(v) {
  return typeof v === "function";
}

/** 把 window 上的成员安全地暴露为全局 */
function installGlobal(name, value) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, name);
  // 可写自有数据属性：直接赋值
  if (desc && "value" in desc && desc.writable) {
    try {
      globalThis[name] = value;
      return;
    } catch {
      /* 落到 defineProperty */
    }
  }
  // getter-only / 继承属性 / 只读：用 defineProperty 重定义
  try {
    Object.defineProperty(globalThis, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    return;
  } catch {
    /* 连重定义都不允许（极少数实现）：保留 Node 内建全局 */
  }
}

/** 取 window 的成员；函数绑定回 window，构造器保持不绑定（供 new 使用） */
function fromWindow(name, bind = true) {
  const v = window[name];
  if (v === undefined) return undefined;
  if (isFunction(v) && bind && !/^[A-Z]/.test(name)) {
    try {
      return v.bind(window);
    } catch {
      return v;
    }
  }
  return v;
}

/** 让 localStorage 等对象上的任意方法即使直接解构调用也以其自身为 this */
function boundHost(host) {
  if (host === null || typeof host !== "object") return host;
  return new Proxy(host, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      return isFunction(v) ? v.bind(target) : v;
    },
  });
}

// 基础全局对象
installGlobal("window", window);
installGlobal("document", window.document);
installGlobal("navigator", window.navigator);
installGlobal("localStorage", boundHost(window.localStorage));
installGlobal("location", window.location);
installGlobal("history", window.history);
installGlobal("getComputedStyle", fromWindow("getComputedStyle"));
installGlobal("requestAnimationFrame", (cb) => setTimeout(cb, 0));
installGlobal("cancelAnimationFrame", (id) => clearTimeout(id));

// EventTarget 方法：优先使用 jsdom window 版本（与 DOM 节点同源）
installGlobal("addEventListener", fromWindow("addEventListener"));
installGlobal("removeEventListener", fromWindow("removeEventListener"));
installGlobal("dispatchEvent", fromWindow("dispatchEvent"));

// 构造器/类型（保持不绑定，供 instanceof 与 new 使用）
[
  "HTMLElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "HTMLButtonElement",
  "HTMLAnchorElement",
  "Element",
  "Node",
  "NodeList",
  "DocumentFragment",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "InputEvent",
  "KeyboardEvent",
  "Blob",
  "URL",
  "DOMParser",
].forEach((name) => {
  if (window[name]) installGlobal(name, window[name]);
});

// React act() 环境标志（仅测试环境使用）
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

module.exports = dom;

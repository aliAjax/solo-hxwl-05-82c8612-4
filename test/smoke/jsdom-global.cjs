// jsdom 全局预加载：在 require 业务包之前准备好 DOM/localStorage
const { JSDOM } = require("jsdom");

const dom = new JSDOM(
  '<!doctype html><html><body><div id="root"></div></body></html>',
  { url: "http://localhost:5105/" },
);
const { window } = dom;

const keys = [
  "window",
  "document",
  "navigator",
  "localStorage",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "InputEvent",
  "getComputedStyle",
  "addEventListener",
  "removeEventListener",
  "location",
  "history",
];
for (const key of keys) {
  global[key] = key === "window" ? window : window[key];
}
global.window = window;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

module.exports = dom;

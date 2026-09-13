// 构建并运行损坏数据恢复冒烟测试（独立进程，预置坏 localStorage）
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, ".test-build");
fs.mkdirSync(outDir, { recursive: true });

esbuild.buildSync({
  entryPoints: [path.join(root, "test/smoke/corrupt-smoke.tsx")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  jsx: "automatic",
  packages: "external",
  outfile: path.join(outDir, "corrupt-smoke.cjs"),
  logLevel: "silent",
  define: { "process.env.NODE_ENV": '"production"' },
});
console.log("corrupt smoke built");
require(path.join(outDir, "corrupt-smoke.cjs"));

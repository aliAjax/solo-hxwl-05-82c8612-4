// 构建并运行 UI jsdom 冒烟测试
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, ".test-build");
fs.mkdirSync(outDir, { recursive: true });

esbuild.buildSync({
  entryPoints: [path.join(root, "test/smoke/ui-smoke.tsx")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  jsx: "automatic",
  packages: "external",
  outfile: path.join(outDir, "ui-smoke.cjs"),
  logLevel: "silent",
  define: {
    "process.env.NODE_ENV": '"production"',
  },
});
console.log("smoke built");
require(path.join(outDir, "ui-smoke.cjs"));

// 测试构建：用 vite 依赖树里的 esbuild 把 domain TS 打成 CJS，供 node --test 运行。
// 离线、零额外依赖。
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, ".test-build");
fs.mkdirSync(outDir, { recursive: true });

esbuild.buildSync({
  entryPoints: [path.join(root, "test/suite.test.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: path.join(outDir, "suite.test.cjs"),
  logLevel: "silent",
});
console.log("tests built ->", path.join(outDir, "suite.test.cjs"));

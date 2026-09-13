import "./styles.css";
import { useEffect, useState } from "react";
import Dashboard from "./ui/Dashboard";
import Cases from "./ui/Cases";
import TimelineView from "./ui/Timeline";
import { store, useStore } from "./ui/store-hook";

type Tab = "dashboard" | "cases" | "timeline";

const TABS: { key: Tab; label: string }[] = [
  { key: "dashboard", label: "鱼缸与检测" },
  { key: "cases", label: "处置工单" },
  { key: "timeline", label: "时间线与撤销" },
];

function OfflinePill() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    addEventListener("online", on);
    addEventListener("offline", off);
    return () => {
      removeEventListener("online", on);
      removeEventListener("offline", off);
    };
  }, []);
  return (
    <span className={`offline-pill ${online ? "on" : "off"}`} title="全部数据保存在本机，断网可正常使用">
      <i />
      {online ? "在线（已离线就绪）" : "离线模式 · 数据本机保存"}
    </span>
  );
}

function QuarantineBanner() {
  const { revision } = useStore();
  void revision;
  const q = store.quarantineInfo();
  const [showRaw, setShowRaw] = useState(false);
  if (!q) return null;
  return (
    <div className="quarantine-banner" role="alert">
      <div>
        <strong>⚠ 检测到损坏的本地数据，已自动隔离</strong>
        <p>
          原因：{q.reason}（{new Date(q.at).toLocaleString("zh-CN")}）。
          为保护现有记录，系统未加载该数据，当前界面使用安全的空状态启动。你可以查看原始内容后丢弃，或从备份重新导入。
        </p>
        <div className="btn-row">
          <button onClick={() => setShowRaw((v) => !v)}>{showRaw ? "隐藏" : "查看"}原始数据</button>
          <button className="primary-action" onClick={() => store.discardQuarantine()}>
            丢弃损坏数据
          </button>
        </div>
        {showRaw && <pre className="raw-dump">{q.raw.slice(0, 4000)}</pre>}
      </div>
    </div>
  );
}

function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const { state } = useStore();
  const openCount = state.cases.filter((c) => c.status !== "closed").length;

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">离线可用 · 事件溯源 · 本机持久化</p>
          <h1>鱼缸健康处置台</h1>
          <p className="subtitle">
            维护鱼缸、鱼群与检测记录；按鱼种、缸型与连续检测变化计算风险；
            处置严格经过 <b>建议 → 执行 → 复测 → 关闭</b> 四阶段，重复用药与违规跨缸转移自动拦截。
          </p>
        </div>
        <div className="stack-card">
          <span>运行状态</span>
          <strong>
            {state.tanks.length} 个缸 · {state.groups.length} 个鱼群 · {state.tests.length} 条检测 · {openCount} 个进行中工单
          </strong>
          <OfflinePill />
        </div>
      </section>

      <QuarantineBanner />

      <nav className="tabbar">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>
            {t.label}
            {t.key === "cases" && openCount > 0 && <span className="tab-count">{openCount}</span>}
          </button>
        ))}
      </nav>

      {tab === "dashboard" && <Dashboard />}
      {tab === "cases" && <Cases />}
      {tab === "timeline" && <TimelineView />}

      <footer className="app-footer">
        阈值规则：淡水 pH 6.5–7.5 / 氨氮 &lt;0.02ppm / 亚硝 &lt;0.1ppm；海缸与鱼种（金鱼、慈鲷、灯鱼等）单独修正；
        单次换水 ≤50%，同药间隔 ≥72h。规则可在 <code>src/domain/thresholds.ts</code> 调整。
      </footer>
    </main>
  );
}

export default App;

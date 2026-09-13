// 视图二：处置工单 —— 建议 → 执行 → 复测 → 关闭 四阶段
import { useMemo, useState } from "react";
import type { Case, CaseAction } from "../domain/types";
import { ACTION_LABEL, TANK_TYPE_LABEL } from "../domain/types";
import {
  READING_FIELDS,
  caseTankName,
  dt,
  store,
  tankRiskView,
  useStore,
} from "./store-hook";
import { Empty, ErrorBanner, RiskBadge, StatusBadge, useGuardedAction } from "./primitives";
import type { Reading } from "../domain/types";

const STEPS = ["suggested", "executed", "retested", "closed"] as const;

function Stepper({ status }: { status: Case["status"] }) {
  const idx = STEPS.indexOf(status);
  return (
    <ol className="stepper">
      {STEPS.map((s, i) => (
        <li key={s} className={i <= idx ? "done" : ""}>
          <span className="step-dot">{i + 1}</span>
          {{ suggested: "建议", executed: "执行", retested: "复测", closed: "关闭" }[s]}
        </li>
      ))}
    </ol>
  );
}

function ActionDetail({ action, tankNameById }: { action: CaseAction; tankNameById: (id?: string) => string }) {
  switch (action.kind) {
    case "waterChange":
      return (
        <span>
          换水 <strong>{Math.round((action.waterChangePct ?? 0) * 100)}%</strong>
          <em className="muted">（单次安全上限 50%）</em>
        </span>
      );
    case "medicate":
      return (
        <span>
          用药 <strong>{action.medName}</strong>
          <em className="muted"> · {action.dose} · 同药 72 小时内禁重复</em>
        </span>
      );
    case "isolate":
      return (
        <span>
          隔离转移至 <strong>{tankNameById(action.targetTankId)}</strong>
        </span>
      );
    case "retest":
      return <span>处置后按时复测（危急 24h / 关注 48h）</span>;
  }
}

function ExecutePanel({ c }: { c: Case }) {
  const [picked, setPicked] = useState<boolean[]>(() => c.actions.map(() => true));
  const [seq, setSeq] = useState(0);
  const token = useMemo(() => `exec-${c.id}-${seq}-${Math.random().toString(36).slice(2, 8)}`, [c.id, seq]);
  const guard = useGuardedAction();
  const toggle = (i: number) => setPicked((p) => p.map((v, j) => (j === i ? !v : v)));

  return (
    <div className="phase-panel">
      <p className="muted">勾选本次实际完成的处置动作（重复用药、超量换水、违规跨缸转移会被拦截）：</p>
      <ul className="pick-list">
        {c.actions.map((a, i) => (
          <li key={i}>
            <label className="check-label">
              <input type="checkbox" checked={picked[i]} onChange={() => toggle(i)} />
              <ActionDetail action={a} tankNameById={(id) => (id ? nameById(id) : "—")} />
            </label>
          </li>
        ))}
      </ul>
      <button
        className="primary-action"
        disabled={guard.busy}
        onClick={() =>
          guard.run(() => {
            const actions = c.actions.filter((_, i) => picked[i]);
            store.executeCase(c.id, actions, undefined, token);
            setSeq((s) => s + 1);
          })
        }
      >
        {guard.busy ? "提交中…" : "确认执行，进入复测阶段"}
      </button>
      <ErrorBanner errors={guard.errors} onDismiss={guard.clear} />
    </div>
  );
}

function nameById(id: string): string {
  return store.getState().tanks.find((t) => t.id === id)?.name ?? id;
}

function RetestPanel({ c }: { c: Case }) {
  const [values, setValues] = useState<Partial<Record<keyof Reading, string>>>({});
  const [note, setNote] = useState("");
  const [seq, setSeq] = useState(0);
  const token = useMemo(() => `retest-${c.id}-${seq}-${Math.random().toString(36).slice(2, 8)}`, [c.id, seq]);
  const guard = useGuardedAction();

  return (
    <div className="phase-panel">
      <p className="muted">录入处置后的复测数据（时间必须晚于建单时间）：</p>
      <div className="reading-grid">
        {READING_FIELDS.map((f) => (
          <label key={f.key}>
            <span>
              {f.label}
              {f.unit ? ` (${f.unit})` : ""}
            </span>
            <input type="number" step={f.step} value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
          </label>
        ))}
      </div>
      <input placeholder="复测备注（可选）" value={note} onChange={(e) => setNote(e.target.value)} />
      <button
        className="primary-action"
        disabled={guard.busy}
        onClick={() =>
          guard.run(() => {
            store.retestCase(c.id, values, note, token);
            setValues({});
            setNote("");
            setSeq((s) => s + 1);
          })
        }
      >
        {guard.busy ? "提交中…" : "提交复测"}
      </button>
      <ErrorBanner errors={guard.errors} onDismiss={guard.clear} />
    </div>
  );
}

function ClosePanel({ c }: { c: Case }) {
  const [note, setNote] = useState("");
  const [seq, setSeq] = useState(0);
  const token = useMemo(() => `close-${c.id}-${seq}-${Math.random().toString(36).slice(2, 8)}`, [c.id, seq]);
  const guard = useGuardedAction();
  const { state } = useStore();
  const tank = state.tanks.find((t) => t.id === c.tankId);
  const risk = tank ? tankRiskView(tank, state) : null;

  return (
    <div className="phase-panel">
      {risk && risk.level !== "ok" && (
        <p className="warn-line">
          注意：复测后风险仍为{risk.level === "danger" ? "危急" : "关注"}（{risk.hits[0]}）。
          如关闭工单，建议立即依据最新检测再生成新的处置建议。
        </p>
      )}
      <textarea
        rows={3}
        placeholder="关闭结论（必填），如：氨氮降至 0.01ppm，鱼只状态恢复，观察 48h 无异常"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button
        className="primary-action"
        disabled={guard.busy}
        onClick={() =>
          guard.run(() => {
            store.closeCase(c.id, note, token);
            setSeq((s) => s + 1);
          })
        }
      >
        {guard.busy ? "提交中…" : "关闭工单"}
      </button>
      <ErrorBanner errors={guard.errors} onDismiss={guard.clear} />
    </div>
  );
}

function CaseCard({ c }: { c: Case }) {
  const { state } = useStore();
  const tank = state.tanks.find((t) => t.id === c.tankId);
  const sourceTest = state.tests.find((t) => t.id === c.testRecordId);

  return (
    <article className={`case-card status-${c.status}`}>
      <header className="case-head">
        <div>
          <h3>{c.title}</h3>
          <div className="muted small">
            {caseTankName(c, state)}
            {tank ? ` · ${TANK_TYPE_LABEL[tank.type]}` : ""} · 建单 {dt(c.createdAt)}
          </div>
        </div>
        <div className="badge-row">
          <RiskBadge level={c.risk} />
          <StatusBadge status={c.status} />
        </div>
      </header>

      <Stepper status={c.status} />

      {c.reasons.length > 0 && (
        <ul className="reason-list">
          {c.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}

      <div className="case-actions">
        <h4>建议处置</h4>
        <ol className="pick-list">
          {c.actions.map((a, i) => (
            <li key={i} className="readonly">
              <ActionDetail action={a} tankNameById={(id) => (id ? nameById(id) : "—")} />
            </li>
          ))}
        </ol>
      </div>

      {c.status === "suggested" && <ExecutePanel c={c} />}
      {c.status === "executed" && <RetestPanel c={c} />}
      {c.status === "retested" && <ClosePanel c={c} />}
      {c.status === "closed" && (
        <p className="close-note">
          <strong>关闭结论：</strong>
          {c.closeNote}
        </p>
      )}

      <details className="case-history">
        <summary>处置留痕（{c.history.length} 次流转 · {c.executions.length} 批执行）{sourceTest ? ` · 依据检测 ${dt(sourceTest.at)}` : ""}</summary>
        <ul>
          {c.executions.map((ex, i) => (
            <li key={"e" + i}>
              {dt(ex.at)} 执行：{ACTION_LABEL[ex.action.kind]}
              {ex.note ? `（${ex.note}）` : ""}
            </li>
          ))}
          {c.history.map((h, i) => (
            <li key={"h" + i}>
              {dt(h.at)} 流转：{h.from} → {h.to}
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}

export default function Cases() {
  const { state } = useStore();
  const open = state.cases.filter((c) => c.status !== "closed");
  const closed = state.cases.filter((c) => c.status === "closed");
  const [showClosed, setShowClosed] = useState(false);

  return (
    <div className="cases-view">
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">处置流程</p>
            <h2>进行中工单（{open.length}）</h2>
          </div>
        </div>
        {open.length === 0 && <Empty>没有进行中的处置工单。在「鱼缸与检测」页登记异常检测后，点击「生成处置建议」。</Empty>}
        <div className="case-grid">
          {open.map((c) => (
            <CaseCard key={c.id} c={c} />
          ))}
        </div>
      </section>

      {closed.length > 0 && (
        <section className="panel">
          <button className="link-btn" onClick={() => setShowClosed((v) => !v)}>
            {showClosed ? "隐藏" : "查看"}已关闭工单（{closed.length}）
          </button>
          {showClosed && (
            <div className="case-grid">
              {closed.map((c) => (
                <CaseCard key={c.id} c={c} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

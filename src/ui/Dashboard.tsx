// 视图一：鱼缸与鱼群维护、检测登记、按缸查看风险与趋势
import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { store, useStore } from "./store-hook";
import {
  READING_FIELDS,
  SPECIES_OPTIONS,
  SYMPTOM_OPTIONS,
  TANK_TYPE_OPTIONS,
  dt,
  latestTest,
  riskClass,
  tankRiskView,
} from "./store-hook";
import { Empty, ErrorBanner, RiskBadge, useGuardedAction } from "./primitives";
import { SPECIES_LABEL, TANK_TYPE_LABEL } from "../domain/types";
import type { Reading, TankType } from "../domain/types";

function useFormToken(prefix: string, resetSignal: unknown) {
  return useMemo(
    () => `${prefix}-${Math.random().toString(36).slice(2, 10)}`,
    // resetSignal 变化（提交成功）后换新令牌
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prefix, resetSignal],
  );
}

function AddTankForm() {
  const [name, setName] = useState("");
  const [type, setType] = useState<TankType>("planted");
  const [volume, setVolume] = useState("");
  const [seq, setSeq] = useState(0);
  const token = useFormToken("tank", seq);
  const { errors, busy, run, clear } = useGuardedAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(() => {
      store.addTank(name, type, Number(volume), token);
      setName("");
      setVolume("");
      setSeq((s) => s + 1);
    });
  };

  return (
    <form className="inline-form" onSubmit={submit}>
      <h3>新建鱼缸</h3>
      <div className="form-row">
        <input placeholder="缸名，如 草缸A" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={type} onChange={(e) => setType(e.target.value as TankType)}>
          {TANK_TYPE_OPTIONS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <input className="narrow-input" placeholder="水量 L" type="number" value={volume} onChange={(e) => setVolume(e.target.value)} />
        <button className="primary-action" disabled={busy}>
          {busy ? "提交中…" : "建缸"}
        </button>
      </div>
      <ErrorBanner errors={errors} onDismiss={clear} />
    </form>
  );
}

function ReadingInputs({ values, onChange }: { values: Partial<Record<keyof Reading, string>>; onChange: (v: Partial<Record<keyof Reading, string>>) => void }) {
  return (
    <div className="reading-grid">
      {READING_FIELDS.map((f) => (
        <label key={f.key}>
          <span>
            {f.label}
            {f.unit ? ` (${f.unit})` : ""}
          </span>
          <input
            type="number"
            step={f.step}
            placeholder="留空=未测"
            value={values[f.key] ?? ""}
            onChange={(e) => onChange({ ...values, [f.key]: e.target.value })}
          />
        </label>
      ))}
    </div>
  );
}

function TankDetail({ tankId }: { tankId: string }) {
  const { state } = useStore();
  const tank = state.tanks.find((t) => t.id === tankId);
  const [readings, setReadings] = useState<Partial<Record<keyof Reading, string>>>({});
  const [symptoms, setSymptoms] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [seq, setSeq] = useState(0);
  const token = useFormToken("test", seq);
  const testGuard = useGuardedAction();

  const [species, setSpecies] = useState(SPECIES_OPTIONS[0][0]);
  const [count, setCount] = useState("");
  const [gSeq, setGSeq] = useState(0);
  const gToken = useFormToken("group", gSeq);
  const groupGuard = useGuardedAction();

  const tankGuard = useGuardedAction();

  if (!tank) return <Empty>请选择左侧鱼缸</Empty>;
  const risk = tankRiskView(tank, state);
  const groups = state.groups.filter((g) => g.tankId === tankId);
  const tests = state.tests.filter((t) => t.tankId === tankId).sort((a, b) => b.at - a.at);
  const latest = tests[0];
  const otherTanks = state.tanks.filter((t) => t.id !== tankId);

  const submitTest = (e: FormEvent) => {
    e.preventDefault();
    testGuard.run(() => {
      store.addTest(tankId, readings, symptoms, note, undefined, token);
      setReadings({});
      setSymptoms([]);
      setNote("");
      setSeq((s) => s + 1);
    });
  };

  const submitGroup = (e: FormEvent) => {
    e.preventDefault();
    groupGuard.run(() => {
      store.addGroup(tankId, species, Number(count), undefined, gToken);
      setCount("");
      setGSeq((s) => s + 1);
    });
  };

  return (
    <div className="detail">
      <div className="detail-head">
        <div>
          <h2>
            {tank.name} <span className="muted">· {TANK_TYPE_LABEL[tank.type]} · {tank.volumeL}L</span>
          </h2>
          <div className="risk-line">
            <RiskBadge level={risk.level} />
            <span className={`trend ${risk.trend}`}>
              趋势：{risk.trend === "improving" ? "改善" : risk.trend === "worsening" ? "恶化 ↑" : "平稳 →"}
            </span>
          </div>
          <ul className="hit-list">
            {risk.hits.map((h, i) => (
              <li key={i} className={riskClass(risk.level)}>
                {h}
              </li>
            ))}
          </ul>
        </div>
        <button
          className="danger-btn"
          onClick={() =>
            tankGuard.run(() => {
              store.deleteTank(tankId);
            })
          }
        >
          删除该缸
        </button>
      </div>
      <ErrorBanner errors={tankGuard.errors} onDismiss={tankGuard.clear} />

      <section className="subpanel">
        <h3>鱼群（{groups.length}）</h3>
        {groups.length === 0 && <Empty>缸内暂无鱼群登记</Empty>}
        {groups.map((g) => (
          <GroupRow key={g.id} groupId={g.id} otherTanks={otherTanks} />
        ))}
        <form className="inline-form tight" onSubmit={submitGroup}>
          <div className="form-row">
            <select value={species} onChange={(e) => setSpecies(e.target.value as typeof species)}>
              {SPECIES_OPTIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <input className="narrow-input" type="number" min={1} placeholder="数量" value={count} onChange={(e) => setCount(e.target.value)} />
            <button disabled={groupGuard.busy}>登记鱼群</button>
          </div>
        </form>
        <ErrorBanner errors={groupGuard.errors} onDismiss={groupGuard.clear} />
      </section>

      <section className="subpanel">
        <h3>登记检测</h3>
        <form onSubmit={submitTest}>
          <ReadingInputs values={readings} onChange={setReadings} />
          <div className="symptom-row">
            {SYMPTOM_OPTIONS.map((s) => (
              <label key={s.key} className="check-label">
                <input
                  type="checkbox"
                  checked={symptoms.includes(s.key)}
                  onChange={(e) =>
                    setSymptoms(e.target.checked ? [...symptoms, s.key] : symptoms.filter((x) => x !== s.key))
                  }
                />
                {s.label}
              </label>
            ))}
          </div>
          <input placeholder="备注（可选）" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="form-actions">
            <button className="primary-action" disabled={testGuard.busy}>
              {testGuard.busy ? "提交中…" : "提交检测"}
            </button>
          </div>
        </form>
        <ErrorBanner errors={testGuard.errors} onDismiss={testGuard.clear} />
      </section>

      <section className="subpanel">
        <h3>检测历史（{tests.length}）</h3>
        {tests.length === 0 && <Empty>尚无检测记录</Empty>}
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>时间</th>
                {READING_FIELDS.map((f) => (
                  <th key={f.key}>{f.label}</th>
                ))}
                <th>症状</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tests.map((t) => (
                <tr key={t.id} className={latest?.id === t.id ? "latest-row" : ""}>
                  <td>{dt(t.at)}</td>
                  {READING_FIELDS.map((f) => (
                    <td key={f.key}>{t.readings[f.key] ?? "—"}</td>
                  ))}
                  <td>{t.symptoms?.map((s) => SYMPTOM_OPTIONS.find((x) => x.key === s)?.label ?? s).join("、") || "—"}</td>
                  <td>
                    <SuggestButton tankId={tankId} testId={t.id} isLatest={latest?.id === t.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function GroupRow({ groupId, otherTanks }: { groupId: string; otherTanks: { id: string; name: string }[] }) {
  const { state } = useStore();
  const g = state.groups.find((x) => x.id === groupId);
  const [target, setTarget] = useState("");
  const guard = useGuardedAction();
  if (!g) return null;
  const here = state.tanks.find((t) => t.id === g.tankId);

  return (
    <div className="group-row">
      <div>
        <strong>{SPECIES_LABEL[g.species]}</strong> ×{g.count}
        <span className="muted">（当前：{here?.name ?? g.tankId}）</span>
      </div>
      <div className="group-actions">
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">转移到…</option>
          {otherTanks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <button
          disabled={!target || guard.busy}
          onClick={() =>
            guard.run(() => {
              store.moveGroup(groupId, target);
              setTarget("");
            })
          }
        >
          转移
        </button>
        <button className="link-btn" onClick={() => guard.run(() => store.deleteGroup(groupId))}>
          移出
        </button>
      </div>
      <ErrorBanner errors={guard.errors} onDismiss={guard.clear} />
    </div>
  );
}

function SuggestButton({ tankId, testId, isLatest }: { tankId: string; testId: string; isLatest: boolean }) {
  const guard = useGuardedAction();
  const [seq, setSeq] = useState(0);
  const token = useFormToken("sug-" + testId, seq);
  return (
    <>
      <button
        className={isLatest ? "primary-action small" : "small"}
        onClick={() =>
          guard.run(() => {
            store.suggestCase(tankId, testId, token);
            setSeq((s) => s + 1); // 成功后轮换令牌，工单关闭后允许再次建议
          })
        }
      >
        生成处置建议
      </button>
      {guard.errors.length > 0 && <ErrorBanner errors={guard.errors} onDismiss={guard.clear} />}
    </>
  );
}

export default function Dashboard() {
  const { state } = useStore();
  const firstId = state.tanks[0]?.id;
  const [selected, setSelected] = useState<string | null>(null);
  const selectedId = selected ?? firstId ?? null;

  return (
    <div className="dashboard">
      <aside className="tank-list panel">
        <AddTankForm />
        <h3>店内鱼缸（{state.tanks.length}）</h3>
        {state.tanks.length === 0 && <Empty>先建一个缸开始登记</Empty>}
        {state.tanks.map((t) => {
          const risk = tankRiskView(t, state);
          const lt = latestTest(t.id, state);
          const openCases = state.cases.filter((c) => c.tankId === t.id && c.status !== "closed").length;
          return (
            <button
              key={t.id}
              className={`tank-card ${selectedId === t.id ? "selected" : ""}`}
              onClick={() => setSelected(t.id)}
            >
              <div className="tank-card-head">
                <strong>{t.name}</strong>
                <RiskBadge level={risk.level} />
              </div>
              <div className="muted small">
                {TANK_TYPE_LABEL[t.type]} · {t.volumeL}L · {state.groups.filter((g) => g.tankId === t.id).length} 个鱼群
              </div>
              <div className="tank-card-readings">
                {lt ? (
                  READING_FIELDS.filter((f) => lt.readings[f.key] !== undefined)
                    .slice(0, 3)
                    .map((f) => (
                      <span key={f.key}>
                        {f.label} {lt.readings[f.key]}
                      </span>
                    ))
                ) : (
                  <span>无检测</span>
                )}
              </div>
              {openCases > 0 && <div className="open-case-flag">进行中工单 ×{openCases}</div>}
            </button>
          );
        })}
      </aside>
      <section className="panel detail-panel">{selectedId && <TankDetail key={selectedId} tankId={selectedId} />}</section>
    </div>
  );
}

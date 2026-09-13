// 视图三：时间线（按批次分组、整批撤销）+ 数据备份/恢复
import { useState } from "react";
import { actionSummary, dt, eventTankId, store, useStore } from "./store-hook";
import { Empty, ErrorBanner, useGuardedAction } from "./primitives";
import { TANK_TYPE_LABEL } from "../domain/types";

function UndoButton({ batchId, undone }: { batchId: string; undone: boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const guard = useGuardedAction();

  if (undone) return <span className="undone-tag">已撤销</span>;

  if (!open)
    return (
      <button className="danger-btn small" onClick={() => setOpen(true)}>
        整批撤销
      </button>
    );

  return (
    <div className="undo-inline">
      <input
        autoFocus
        placeholder="撤销原因（可选）"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button
        className="danger-btn small"
        disabled={guard.busy}
        onClick={() =>
          guard.run(() => {
            store.undoBatch(batchId, reason);
            setOpen(false);
            setReason("");
          })
        }
      >
        确认撤销
      </button>
      <button className="small" onClick={() => setOpen(false)}>
        取消
      </button>
      <ErrorBanner errors={guard.errors} onDismiss={guard.clear} />
    </div>
  );
}

const KIND_TAG: Record<string, string> = {
  tankCreated: "缸",
  tankDeleted: "缸",
  groupCreated: "鱼群",
  groupMoved: "转移",
  groupDeleted: "鱼群",
  testAdded: "检测",
  caseSuggested: "建议",
  caseTransition: "流转",
  caseExecuted: "执行",
  caseClosed: "关闭",
  batchUndone: "撤销",
};

export default function Timeline() {
  const { state } = useStore();
  const batches = store.batches();
  const guard = useGuardedAction();
  const [importText, setImportText] = useState("");

  const tankName = (id: string | undefined) =>
    id ? state.tanks.find((t) => t.id === id)?.name ?? id.slice(0, 6) : "";

  const doExport = () => {
    const blob = new Blob([store.exportJson()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `aquarium-desk-${dt(Date.now()).replace(/[ :]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const doImport = () => {
    guard.run(() => {
      store.importJson(importText);
      setImportText("");
    });
  };

  const corruptDemo = () => {
    // 演示损坏隔离：写入非法 JSON 后刷新页面即触发
    localStorage.setItem(store.STORAGE_KEY, "{ 损坏的本地数据 " + Date.now());
    location.reload();
  };

  return (
    <div className="timeline-view">
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">事件溯源</p>
            <h2>变更时间线（{store.getEvents().length} 个事件 / {batches.length} 个批次）</h2>
          </div>
          <div className="btn-row">
            <button onClick={doExport}>导出备份</button>
            <button className="danger-btn" onClick={() => guard.run(() => store.resetAll())}>
              重置为演示数据
            </button>
          </div>
        </div>
        <ErrorBanner errors={guard.errors} onDismiss={guard.clear} />
        {batches.length === 0 && <Empty>暂无任何变更记录</Empty>}
        <div className="batch-list">
          {batches.map((b) => (
            <article key={b.batchId} className={`batch-card ${b.undone ? "is-undone" : ""}`}>
              <header>
                <div>
                  <strong>{dt(b.at)}</strong>
                  <span className="muted small"> 批次 {b.batchId.slice(0, 10)}… · {b.events.length} 个事件</span>
                </div>
                {b.events[0].payload.type !== "batchUndone" && <UndoButton batchId={b.batchId} undone={b.undone} />}
                {b.events[0].payload.type === "batchUndone" && <span className="undo-marker">撤销记录</span>}
              </header>
              <ul className="event-list">
                {b.events.map((e) => (
                  <li key={e.id}>
                    <span className={`kind-tag k-${e.payload.type}`}>{KIND_TAG[e.payload.type] ?? "事件"}</span>
                    <span className="event-text">{actionSummary(e.payload)}</span>
                    {(() => {
                      const tid = eventTankId(e, state);
                      return tid && state.tanks.some((t) => t.id === tid) ? (
                        <em className="muted small">@ {tankName(tid)}</em>
                      ) : null;
                    })()}
                    {e.payload.type === "batchUndone" && (
                      <em className="muted small">原因：{e.payload.reason}</em>
                    )}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>导入备份 / 演练损坏恢复</h2>
        <p className="muted">
          粘贴此前导出的 JSON 可整库恢复（同样经过结构与悬空引用校验，损坏数据会被隔离而非覆盖现有数据）。
        </p>
        <textarea
          rows={4}
          className="muted"
          placeholder='{"version":1,"events":[...]}'
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
        />
        <div className="btn-row">
          <button className="primary-action" onClick={doImport} disabled={!importText.trim()}>
            校验并导入
          </button>
          <button onClick={corruptDemo}>模拟本地数据损坏（写入坏数据并刷新）</button>
        </div>
        <p className="muted small">缸型说明：{Object.values(TANK_TYPE_LABEL).join("、")}。全部数据保存在本机浏览器 localStorage 中，断网可用。</p>
      </section>
    </div>
  );
}

// 轻量 UI 原语：错误条、风险徽章、提交锁 hook（防重复提交的前端第二道闸）
import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";
import { RISK_LABEL, STATUS_LABEL } from "../domain/types";
import type { CaseStatus, RiskLevel } from "../domain/types";

export function ErrorBanner({ errors, onDismiss }: { errors: string[]; onDismiss?: () => void }) {
  if (errors.length === 0) return null;
  return (
    <div className="error-banner" role="alert">
      <strong>操作被拦截</strong>
      <ul>
        {errors.map((e, i) => (
          <li key={i}>{e}</li>
        ))}
      </ul>
      {onDismiss && (
        <button className="link-btn" onClick={onDismiss}>
          知道了
        </button>
      )}
    </div>
  );
}

export function RiskBadge({ level }: { level: RiskLevel }) {
  return <span className={`badge ${level === "danger" ? "b-danger" : level === "watch" ? "b-watch" : "b-ok"}`}>{RISK_LABEL[level]}</span>;
}

export function StatusBadge({ status }: { status: CaseStatus }) {
  return <span className={`badge s-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty-hint">{children}</p>;
}

/**
 * 提交锁：异步/同步动作执行期间忽略重复点击；
 * 领域层的 clientToken 是防重复提交的第一道闸，这里只负责按钮反馈。
 */
export function useGuardedAction() {
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const run = useCallback((fn: () => void) => {
    if (busyRef.current) return; // 重复提交直接吞掉
    busyRef.current = true;
    setBusy(true);
    setErrors([]);
    try {
      fn();
    } catch (e) {
      const errs =
        e && typeof e === "object" && "errors" in e && Array.isArray((e as { errors: unknown }).errors)
          ? ((e as { errors: string[] }).errors)
          : [(e as Error).message || String(e)];
      setErrors(errs);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const clear = useCallback(() => setErrors([]), []);
  return { errors, busy, run, clear, setErrors };
}

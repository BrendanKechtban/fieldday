import type { ReactNode } from "react";
import { ApiError, type Status } from "./api";

export function Loading({ what }: { what: string }) { return <p role="status" className="muted">Loading {what}…</p>; }
export function ErrorBox({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <div role="alert" className="alert alert-error">
      <strong>{error.message}</strong>
      {error.requestId && <span className="muted"> (request {error.requestId})</span>}
      {onRetry && <> <button type="button" onClick={onRetry}>Try again</button></>}
    </div>
  );
}
export const StatusBadge = ({ status }: { status: Status }) => <span className={`badge badge-${status}`}>{status}</span>;
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small className="muted">{hint}</small>}</label>;
}

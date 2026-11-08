import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

export type AsyncState<T> = { status: "loading" } | { status: "error"; error: ApiError } | { status: "ok"; data: T };

/** Loads on mount / when deps change (showing loading), aborts stale requests, and reload() refreshes silently (live updates). */
export function useAsync<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[]): [AsyncState<T>, () => void] {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const silent = useRef(false);
  useEffect(() => {
    const ac = new AbortController();
    if (!silent.current) setState({ status: "loading" });
    silent.current = false;
    fn(ac.signal)
      .then((data) => setState({ status: "ok", data }))
      .catch((e: unknown) => {
        if ((e as Error).name === "AbortError") return;
        setState({ status: "error", error: e instanceof ApiError ? e : new ApiError(0, "unknown", "Something went wrong.") });
      });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => { silent.current = true; setTick((t) => t + 1); }, []);
  return [state, reload];
}

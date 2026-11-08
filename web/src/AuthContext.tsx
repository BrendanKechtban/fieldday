import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { completeLogin, startLogin, uiClaims } from "./auth";
import { setTokenGetter } from "./api";

interface Ctx { signedIn: boolean; isCoordinator: boolean; name: string; error: string | null; busy: boolean; login(): void; logout(): void }
const AuthCtx = createContext<Ctx>({ signedIn: false, isCoordinator: false, name: "", error: null, busy: false, login() {}, logout() {} });
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(() => /[?&](code|error)=/.test(window.location.search));
  const ref = useRef<string | null>(null);
  ref.current = token;
  setTokenGetter(() => ref.current);

  useEffect(() => {
    if (!busy) return;
    let live = true;
    completeLogin(window.location.href)
      .then((s) => { if (live && s) setToken(s.accessToken); })
      .catch((e: Error) => { if (live) setError(e.message); })
      .finally(() => { if (live) setBusy(false); window.history.replaceState({}, "", window.location.pathname + window.location.hash); });
    return () => { live = false; };
  }, [busy]);

  const value = useMemo<Ctx>(() => {
    const c = uiClaims(token);
    return { signedIn: !!token, isCoordinator: c.roles.includes("coordinator"), name: c.name || c.sub, error, busy, login: () => { void startLogin(); }, logout: () => setToken(null) };
  }, [token, error, busy]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

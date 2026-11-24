import { OIDC } from "./config";

/* Authorization Code + PKCE, implemented by hand with Web Crypto so state, nonce and verifier handling is explicit.
   The access token lives in memory only (never localStorage); sessionStorage holds only the short-lived
   per-login secrets (verifier, state, nonce), which are removed as soon as the callback is processed. */

const K = { verifier: "fd.pkce.verifier", state: "fd.pkce.state", nonce: "fd.pkce.nonce" } as const;

export const b64url = (bytes: Uint8Array): string => {
  let s = "";
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const randomString = (bytes = 32): string => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
export const challengeFor = async (verifier: string): Promise<string> =>
  b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("Malformed token");
  const json = decodeURIComponent(Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join(""));
  return JSON.parse(json) as Record<string, unknown>;
}

export async function buildAuthorizeUrl(): Promise<string> {
  const verifier = randomString(48), state = randomString(16), nonce = randomString(16);
  sessionStorage.setItem(K.verifier, verifier);
  sessionStorage.setItem(K.state, state);
  sessionStorage.setItem(K.nonce, nonce);
  const p = new URLSearchParams({
    client_id: OIDC.clientId, response_type: "code", redirect_uri: OIDC.redirectUri(), scope: OIDC.scopes,
    state, nonce, code_challenge: await challengeFor(verifier), code_challenge_method: "S256", response_mode: "query",
  });
  if (OIDC.audience) p.set("audience", OIDC.audience);
  return `${OIDC.authorizeUrl}?${p.toString()}`;
}

export async function startLogin(): Promise<void> { window.location.assign(await buildAuthorizeUrl()); }

export interface Session { accessToken: string; expiresAt: number }

/** Returns null when the URL is not an OIDC callback. Throws on any validation failure. */
export async function completeLogin(href: string, fetchFn: typeof fetch = fetch): Promise<Session | null> {
  const url = new URL(href);
  const code = url.searchParams.get("code"), state = url.searchParams.get("state"), err = url.searchParams.get("error");
  if (!code && !err) return null;
  const expectState = sessionStorage.getItem(K.state), verifier = sessionStorage.getItem(K.verifier), nonce = sessionStorage.getItem(K.nonce);
  Object.values(K).forEach((k) => sessionStorage.removeItem(k)); // single use, whatever happens next
  if (err) throw new Error(`Sign-in failed: ${url.searchParams.get("error_description") ?? err}`);
  if (!expectState || !state || state !== expectState) throw new Error("Sign-in failed: state mismatch (possible CSRF). Please try again.");
  if (!verifier || !nonce) throw new Error("Sign-in failed: no login in progress.");
  const res = await fetchFn(OIDC.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: OIDC.clientId, code: code!, redirect_uri: OIDC.redirectUri(), code_verifier: verifier }),
  });
  if (!res.ok) throw new Error(`Sign-in failed: token endpoint returned ${res.status}`);
  const tok = (await res.json()) as { access_token?: string; id_token?: string; expires_in?: number };
  if (!tok.access_token || !tok.id_token) throw new Error("Sign-in failed: incomplete token response");
  // The id_token is only checked for nonce replay protection here. It is not used for authorization, so client-side
  // signature validation adds nothing: the API independently verifies the ACCESS token (JWKS signature, issuer,
  // audience, expiry, scopes) on every request and is the only authority.
  if (decodeJwtPayload(tok.id_token).nonce !== nonce) throw new Error("Sign-in failed: nonce mismatch.");
  return { accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 };
}

/** UI hints only. Hiding a button is not authorization: the server enforces scopes and roles on every call. */
export function uiClaims(token: string | null): { sub: string; roles: string[]; name: string } {
  if (!token) return { sub: "", roles: [], name: "" };
  try {
    const c = decodeJwtPayload(token);
    const roles = c[OIDC.rolesClaim];
    return { sub: String(c.sub ?? ""), roles: Array.isArray(roles) ? roles.filter((r): r is string => typeof r === "string") : [], name: String(c.name ?? "") };
  } catch { return { sub: "", roles: [], name: "" }; }
}

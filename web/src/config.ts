const env = import.meta.env as Record<string, string | undefined>;

export const API_BASE = (env.VITE_API_BASE ?? "").replace(/\/$/, "");
const authority = (env.VITE_OIDC_AUTHORITY ?? "https://login.microsoftonline.com/common/v2.0").replace(/\/$/, "");
// Entra v2 shape: https://login.microsoftonline.com/<tenant>/v2.0 -> /oauth2/v2.0/{authorize,token}
const base = authority.replace(/\/v2\.0$/, "");

export const OIDC = {
  clientId: env.VITE_OIDC_CLIENT_ID ?? "",
  authorizeUrl: env.VITE_OIDC_AUTHORIZE_URL ?? `${base}/oauth2/v2.0/authorize`,
  tokenUrl: env.VITE_OIDC_TOKEN_URL ?? `${base}/oauth2/v2.0/token`,
  scopes: env.VITE_OIDC_SCOPES ?? "openid api://fieldday/events.read api://fieldday/events.write",
  redirectUri: () => `${window.location.origin}/`,
};

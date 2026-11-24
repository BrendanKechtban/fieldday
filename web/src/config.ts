const env = import.meta.env as Record<string, string | undefined>;

export const API_BASE = (env.VITE_API_BASE ?? "").replace(/\/$/, "");
const authority = (env.VITE_OIDC_AUTHORITY ?? "https://login.microsoftonline.com/common/v2.0").replace(/\/$/, "");
// Entra v2 shape: https://login.microsoftonline.com/<tenant>/v2.0 -> /oauth2/v2.0/{authorize,token}
// Anything else is treated as Auth0 shape: https://<tenant>.auth0.com -> /authorize and /oauth/token
const entraShape = /\/v2\.0$/.test(authority);
const base = authority.replace(/\/v2\.0$/, "");

export const OIDC = {
  clientId: env.VITE_OIDC_CLIENT_ID ?? "",
  authorizeUrl: env.VITE_OIDC_AUTHORIZE_URL ?? (entraShape ? `${base}/oauth2/v2.0/authorize` : `${authority}/authorize`),
  tokenUrl: env.VITE_OIDC_TOKEN_URL ?? (entraShape ? `${base}/oauth2/v2.0/token` : `${authority}/oauth/token`),
  scopes: env.VITE_OIDC_SCOPES ?? "openid api://fieldday/events.read api://fieldday/events.write",
  // Auth0 only issues a JWT access token for the API when the authorize request names the API (its "audience").
  audience: env.VITE_OIDC_AUDIENCE ?? "",
  // Which access-token claim holds the roles (UI hint only; the server enforces roles).
  rolesClaim: env.VITE_OIDC_ROLES_CLAIM || "roles",
  redirectUri: () => `${window.location.origin}/`,
};

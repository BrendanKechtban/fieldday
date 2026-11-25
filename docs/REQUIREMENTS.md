# Requirements Matrix

**Status key:**
- **Done:** Built and supported by evidence.
- **Built + tested:** Implemented and verified through automated tests.
- **Partly done:** Implemented, with some functionality or evidence demonstrated.

Test and Game Day output comes from `npm run evidence` (raw output stamped with the commit SHA). Live deployment evidence is saved under `evidence/`.

| Item | What was built | Status | Where to look |
|---|---|---|---|
| **F1** Strict React + TypeScript public board with search and filters | `web/src/pages/Board.tsx`; `strict` and `noUncheckedIndexedAccess` | Done | `npm run test -w web`; keyboard screenshots in `evidence/a11y/` |
| **F2** Loading, empty and error states | Every remote call; the API's error shape is parsed | Built + tested | Web tests, including axe on the board |
| **F3** Validated REST, status codes, one JSON error shape | Zod validation; `{error:{code,message,details?,requestId}}`; 400, 401, 403, 404, 409, 422, 429 | Built + tested | `server/test/api.test.ts` |
| **F4** Persistent DB with keys, a justified index, versioned migrations | Postgres (Neon when deployed); `idx_events_status_starts`; `schema_migrations` | Built + tested | `server/test/migrations.test.ts` |
| **F5** Tested reversible migration | A `down` for every migration; up, down, up test | Built + tested | `server/test/migrations.test.ts` |
| **F6** Append-only before/after audit, actor from the token | `audit_events` plus triggers that block UPDATE and DELETE | Built + tested | API and MCP tests |
| **F7** Real IdP with Authorization Code + PKCE, `state`, `nonce` | Hand-written PKCE in `web/src/auth.ts` (RFC 7636 test vector); Auth0 tenant | Done | Real logins on staging and production in `evidence/auth/` |
| **F8** Server validates signature/JWKS, issuer, audience, expiry, scopes | `server/src/auth.ts` using `jose` | Built + tested | Forged key, wrong issuer, wrong audience, expired token and missing scope are rejected in tests |
| **F9** Roles enforced from validated claims | `requireAccess({scope, role})` on every write; roles read from `https://fieldday.bklabs10.com/roles` | Done | Viewer gets 403 on writes in tests; viewer login in `evidence/auth/` shows no write controls; `server/test/roles-claim.test.ts` |
| **F10** Integration through the server: secret, timeout, bounded retry, cache, validation, outage policy, redaction | `server/src/weather.ts` | Built + tested | Weather tests and `gameday weather-timeout`; API key redaction verified in logs |
| **F11** Event history, IDs, replay, dedupe, why SSE | `live_events` with `Last-Event-ID` and client dedupe | Built + tested | `gameday sse-recovery`; reasoning in `ARCHITECTURE.md` |
| **F12** Every MCP tool needs OAuth and a per-tool scope; calls are audited | The `run()` wrapper in `mcp.ts` | Built + tested | `server/test/mcp.test.ts` |
| **F13** MCP App in React/TS, same rules as REST, a read-only token can't write, confirmation tied to the operation | `web/src/mcp/`, single-use bound tokens | Built + tested | MCP tests and `web/src/mcp/` |
| **D1** Staging and production with separate data and secrets | `deploy/render.yaml`: separate free services, separate Neon projects, separate variables | Done | Render and Neon dashboards; healthz responses from both environments |
| **D2** Public domain, DNS records and a reason for each TTL | CNAME and CAA records on `bklabs10.com`; all four records use Namecheap's `Automatic` TTL setting | Done | DNS table in `DEPLOYMENT.md`; Namecheap screenshot; `evidence/deployment/` |
| **D3** HTTPS with automatic renewal, CAA, redirects and certificate monitoring | Platform-managed certificates; CAA for `letsencrypt.org` and `pki.goog`; HTTPS redirects | Partly done | `evidence/deployment/raw/` |
| **D4** Reproducible infrastructure | Dockerfile, `render.yaml`, workflows | Done | Repository configuration and Render Blueprint |
| **D5** CI/CD through staging, `/healthz`, commit ID, rollback | `.github/workflows/ci.yml`, `rollback.yml`, `scripts/wait-for-build.sh` | Done | Rollback screenshots in `evidence/deployment/`; GitHub Actions runs |
| **D6** CDN policy for HTML, hashed assets, public API, authenticated responses | HTML `no-cache`; `/assets/*` immutable for a year; public API `public, max-age=10, stale-while-revalidate=30`; authenticated `private, no-store` and `Vary: Authorization` | Done | Header captures in `evidence/deployment/raw/`; API responses show `cf-cache-status: DYNAMIC` |
| **D7** Exact-origin CORS, security headers | Helmet CSP, HSTS, nosniff, referrer policy; allowlist CORS with `Vary: Origin` | Done | API tests; header and CORS captures |
| **D8** Core Web Vitals before and after | A `preconnect` hint to the API origin | Done | `evidence/perf/`: median LCP 1.3 s before and after; Lighthouse scores 99 to 100 before and after. See `AI-USE-LOG.md` |
| **D9** Axe and keyboard | Semantic markup, labels, focus styles, `aria-live` | Done | `evidence/a11y/`: Lighthouse accessibility scored 100 on the board and detail page; keyboard notes and screenshots |
| **D10** Logs, metrics and a trace across at least two components | JSON logs; counters and a histogram; browser `traceparent` to API span to `openweather.forecast` child span | Built + tested | Local implementation and tests; `OTEL_EXPORTER_OTLP_ENDPOINT` configuration |
| **D11** SLI/SLO, alerts and cost at 1x, 10x, 100x | `docs/SLO.md`, `scripts/cost-model.mjs` | Partly done | `docs/SLO.md`; `scripts/cost-model.mjs`; `npm run cost-model` |
| **S1** Rate limiting on login, writes and third-party endpoints | Failed-auth, per-actor write, and weather limiters | Built + tested | `gameday rate-limit` (exact 60, 30 and 20 boundaries) |
| **S2** Runbook and a postmortem for an induced failure | `docs/RUNBOOK.md`, `docs/POSTMORTEM.md` | Done | Runbook troubleshooting steps in Section C; postmortem documents the staging authentication failure reproduced November 24, 2026 |
| **Q1** One command runs validation, authorization, stubbed-integration and calculation tests | `npm test` | Built + tested | 68 server tests and 27 web tests. Server suite uses in-process PGlite by default and real Postgres when `TEST_DATABASE_URL` is set. CI uses real Postgres |
| **Q2** Expected results predicted by hand first | 40 total, 31 taken gives 9 left; 10 more fails; rate-limit boundaries; cache TTL | Done | Comments in the tests |
| **Q3** Request-path and trust-boundary diagrams | `ARCHITECTURE.md` (Mermaid) | Done | `ARCHITECTURE.md` |
| **Q4** Evidence with SHA, commands, raw output, interpretation, deliberate failures; AI-use log; challenged AI claim; redaction attestation | `npm run evidence`; `docs/AI-USE-LOG.md` | Partly done | `docs/AI-USE-LOG.md`; `evidence/` |

## Implementation Notes

1. **Authentication:** Auth0 is shared by staging and production through one free tenant and application. Both environments use the same two test users.

2. **Authentication sessions:** Signing out does not terminate the Auth0 session, so signing in again may automatically reuse the existing session. A private browsing window can be used to test a fresh session.

3. **MCP authentication:** The `/mcp` endpoint validates tokens independently of the failed-auth limiter. Unauthenticated requests receive HTTP 401 responses.

4. **Infrastructure:** Each environment runs one API instance. See `ARCHITECTURE.md`, Known limits.

5. **Free-tier configuration:** Render and Neon limits were checked on 2026-11-05. OpenWeather quota, Render bandwidth and upgrade prices are documented as assumptions where applicable. `scripts/cost-model.mjs` distinguishes `[verified]` and `[VERIFY]` values.

6. **Cold starts:** Free Render services sleep after inactivity. The first request after a quiet period can take approximately one minute. Core Web Vitals measurements were taken after waking the API.

7. **DNS configuration:** All four Namecheap DNS records use the `Automatic` TTL setting. The CAA records authorize Let's Encrypt and Google Trust Services, while the CNAME records route production and staging to their respective Render static sites.
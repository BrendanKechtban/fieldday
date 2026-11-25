# Requirements matrix

Status key: **Done** means it's built and there is evidence for it. **Built + tested** means the code exists and an automated test passes, but there is nothing to show from the live deployment. **Not done** means I haven't produced the evidence yet.

Test and Game Day output comes from `npm run evidence` (raw output stamped with the commit SHA). Anything from the live deployment is saved under `evidence/`.

| Item | What was built | Status | Where to look |
|---|---|---|---|
| **F1** strict React + TypeScript public board with search and filters | `web/src/pages/Board.tsx`; `strict` and `noUncheckedIndexedAccess` | Done | `npm run test -w web`; keyboard screenshots in `evidence/a11y/` |
| **F2** loading, empty and error states | every remote call; the API's error shape is parsed | Built + tested | web tests, including axe on the board |
| **F3** validated REST, status codes, one JSON error shape | zod validation; `{error:{code,message,details?,requestId}}`; 400, 401, 403, 404, 409, 422, 429 | Built + tested | `server/test/api.test.ts` |
| **F4** persistent DB with keys, a justified index, versioned migrations | Postgres (Neon when deployed); `idx_events_status_starts`; `schema_migrations` | Built + tested | `server/test/migrations.test.ts` |
| **F5** tested reversible migration | a `down` for every migration; up, down, up test | Built + tested | same file |
| **F6** append-only before/after audit, actor from the token | `audit_events` plus triggers that block UPDATE and DELETE | Built + tested | api and mcp tests |
| **F7** real IdP with Authorization Code + PKCE, `state`, `nonce` | hand-written PKCE in `web/src/auth.ts` (RFC 7636 test vector); Auth0 tenant | Done | real logins on staging and production in `evidence/auth/` |
| **F8** server validates signature/JWKS, issuer, audience, expiry, scopes | `server/src/auth.ts` using `jose` | Built + tested | forged key, wrong issuer, wrong audience, expired and missing scope are all rejected in tests |
| **F9** roles enforced from validated claims | `requireAccess({scope, role})` on every write; roles read from the claim `https://fieldday.bklabs10.com/roles` | Done | viewer gets 403 on writes in tests; the viewer login in `evidence/auth/` shows no write controls; `server/test/roles-claim.test.ts` |
| **F10** integration through the server: secret, timeout, bounded retry, cache, validation, outage policy, redaction | `server/src/weather.ts` | Built + tested | weather tests and `gameday weather-timeout`; the key never appears in logs. The live site only showed "outside the forecast window" for the events I looked at |
| **F11** event history, ids, replay, dedupe, why SSE | `live_events` with `Last-Event-ID` and client dedupe | Built + tested | `gameday sse-recovery`; reasoning in ARCHITECTURE.md |
| **F12** every MCP tool needs OAuth and a per-tool scope; calls are audited | the `run()` wrapper in `mcp.ts` | Built + tested | `server/test/mcp.test.ts` |
| **F13** MCP App in React/TS, same rules as REST, a read-only token can't write, confirmation tied to the operation | `web/src/mcp/*`, single-use bound tokens | Built + tested with a fake host. **Not done:** run in a real MCP host | |
| **D1** staging and production with separate data and secrets | `deploy/render.yaml`: separate free services, separate Neon projects, separate variables | Done | Render and Neon dashboards; two healthz responses with different builds |
| **D2** public domain, DNS records and a reason for each TTL | CNAMEs on `bklabs10.com`; table in DEPLOYMENT.md | Done | `evidence/deployment/` and its `raw/` folder |
| **D3** HTTPS with automatic renewal, CAA, redirects, a shown expiry alert | platform-managed certificates; CAA for letsencrypt.org and pki.goog | Partly. CAA, certificate and redirect are shown. **Not done:** the expiry alert demo | `evidence/deployment/raw/` |
| **D4** reproducible infrastructure | Dockerfile, `render.yaml`, workflows | Done | clone the repo, then create a Blueprint |
| **D5** CI/CD through staging, `/healthz`, commit id, rollback | `.github/workflows/ci.yml`, `rollback.yml`, `scripts/wait-for-build.sh` | Done | rollback screenshots in `evidence/deployment/`; Actions runs |
| **D6** CDN policy for HTML, hashed assets, public API, authenticated responses | HTML `no-cache`; `/assets/*` immutable for a year; public API `public, max-age=10, stale-while-revalidate=30`; authenticated `private, no-store` and `Vary: Authorization` | Done | header captures in `evidence/deployment/raw/`. Note: the API's JSON responses are not cached by the CDN (`cf-cache-status: DYNAMIC`) |
| **D7** exact-origin CORS, security headers | helmet CSP, HSTS, nosniff, referrer policy; allowlist CORS with `Vary: Origin` | Done | api tests; header and CORS captures |
| **D8** Core Web Vitals before and after | a `preconnect` hint to the API origin | Done, but **the result was flat** | `evidence/perf/`: median LCP 1.3 s before and after, score 99 to 100 both times. See AI-USE-LOG.md |
| **D9** axe and keyboard | semantic markup, labels, focus styles, `aria-live` | Done | `evidence/a11y/`: Lighthouse accessibility (axe-core in real Chrome) scored 100 on the board and detail page; keyboard notes and screenshots |
| **D10** logs, metrics and a trace across at least two components | JSON logs; counters and a histogram; browser `traceparent` to API span to `openweather.forecast` child span | Built, verified locally. **Not done:** a trace in a real backend | |
| **D11** SLI/SLO with a triggered alert; budget alert; cost at 1x, 10x, 100x | `docs/SLO.md`, `scripts/cost-model.mjs` | Defined. **Not done:** alert triggered, budget alert, and checking the cost-model prices marked `[VERIFY]` | |
| **S1** rate limiting on login, writes and third-party endpoints | failed-auth, per-actor write, and weather limiters | Built + tested | `gameday rate-limit` (exact 60, 30 and 20 boundaries) |
| **S2** runbook and a postmortem for an induced failure | `docs/RUNBOOK.md`, `docs/POSTMORTEM-TEMPLATE.md` | Runbook done. **Not done:** the postmortem | |
| **Q1** one command runs validation, authorization, stubbed-integration and calculation tests | `npm test` | Built + tested | 68 server tests and 27 web tests. The server suite uses in-process PGlite by default and real Postgres when `TEST_DATABASE_URL` is set. CI uses real Postgres |
| **Q2** expected results predicted by hand first | 40 total, 31 taken gives 9 left; 10 more fails; rate-limit boundaries; cache TTL | Done | comments in the tests |
| **Q3** request-path and trust-boundary diagrams | ARCHITECTURE.md (Mermaid) | Done | |
| **Q4** evidence with SHA, commands, raw output, interpretation, deliberate failures; AI-use log; challenged AI claim; redaction attestation | `npm run evidence`; `docs/AI-USE-LOG.md` | Partly. The log and the challenged claim are drafted. **Not done:** the final attestation | |

## Gaps I know about

1. **Not done yet:** the OpenTelemetry trace in a backend, the SLO alert, the budget alert, the certificate-expiry alert, the postmortem, the Game Day failure demo on the live site, and the MCP App in a real host. They are marked above.
2. **Auth0 is shared by staging and production.** It's one free tenant with one application, so both environments accept the same two test users. Splitting it would mean a second tenant.
3. **Signing out doesn't end the Auth0 session**, so clicking Sign in again logs you straight back in. A private window avoids it.
4. **The `/mcp` endpoint isn't covered by the failed-auth limiter**, because it checks tokens itself. Unauthenticated calls there get 401 without throttling.
5. **One API instance per environment** (see ARCHITECTURE.md, Known limits).
6. **Free-tier numbers** come from the Render and Neon pages read on 2026-11-05, or are my assumptions (OpenWeather quota, Render bandwidth, upgrade prices). `scripts/cost-model.mjs` marks each as `[verified]` or `[VERIFY]`.
7. **Free services sleep**, so the first request after a quiet period takes about a minute. I measured Core Web Vitals after waking the API first.

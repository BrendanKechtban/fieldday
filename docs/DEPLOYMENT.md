# How FieldDay is deployed

Everything here runs on free plans. The only money spent is the domain `bklabs10.com`, which I already owned. `npm run cost-model` shows what breaks first at 10 and 100 times the traffic.

## Free-tier rules

These come from the providers' own pages, read on 2026-11-05 ([Render](https://render.com/docs/free), [Neon](https://neon.com/faqs/free-plan-limits-and-quotas)). Providers change them, so check again before relying on them.

1. **Render free web services sleep after 15 idle minutes and take about a minute to wake up.** Their local disk is wiped when they sleep, which is why the data lives in Neon. Wake the API a couple of minutes before a demo (open the app or `curl .../healthz`).
2. **There are 750 free instance hours a month per workspace, shared by every free service.** When they run out, all free web services are suspended until next month. One service awake all month is about 744 hours, so a monitor pinging the production API every few minutes would keep it awake and starve staging. Monitors go on the static web hostnames, which use no instance hours. The API is only monitored briefly for the SLO alert demo.
3. **`/healthz` is shallow on purpose** (build id only, no database query), so probes don't wake Neon. `/healthz?deep=1` also checks the database, and CI and the smoke script use that.
4. **Neon free gives 100 compute hours per project per month, suspends compute after 5 idle minutes, and allows 1 GB of storage and 5 GB of transfer.** Staging and production are separate Neon projects with separate allowances and separate data. If a limit is hit, compute is suspended until next month and no data is deleted.
5. **Sleeping resets in-memory state** (rate-limit counters and the weather cache). Live-update clients reconnect and replay from the saved log, so nothing is lost.
6. **`weather_snapshots` rows are never deleted.** That's about 0.1 GB a year at the default settings, which is fine for a course.
7. **`DATABASE_URL` is never committed.** It's a `sync: false` secret in `deploy/render.yaml` and is set per environment in the Render dashboard.

## 1. Identity provider: Auth0

I first tried Microsoft Entra ID, but my university tenant wouldn't let me create app registrations. The project requirement allows any real OIDC provider, so I used a free Auth0 tenant. (The code still supports the Entra URL shape; it picks the Auth0 shape when the authority doesn't end in `/v2.0`.)

**What I set up in Auth0**

- **API** with the identifier `https://fieldday-api`. Permissions (scopes): `events.read` and `events.write`.
- **Application** "FieldDay Web", type Single Page Application. Allowed Callback URLs: `https://fieldday.bklabs10.com/` and `https://staging.bklabs10.com/`. Allowed Logout URLs and Allowed Web Origins list the same two hosts without the slash.
- The application is authorized for the API with both scopes.
- **Two users**, created by hand with sign-ups switched off: `coordinator@bklabs10.com` with `app_metadata` `{"roles":["coordinator"]}`, and a viewer with `{"roles":["viewer"]}`. These are made-up addresses on my own domain.
- **A Login Action called `add-roles`**, deployed and attached to the Login flow. It copies `app_metadata.roles` into the access token as the custom claim `https://fieldday.bklabs10.com/roles`. Auth0 only allows custom claims that are namespaced with a URL, which is why the claim name is long. I used `app_metadata` plus an Action because Auth0's built-in roles feature may need a paid plan.

**Settings in the platform**

| Variable | Where | Value |
|---|---|---|
| `OIDC_ISSUER` | API services | `https://dev-w8cs0spu2cm1cvzu.us.auth0.com/` (the trailing slash matters) |
| `OIDC_AUDIENCE` | API services | `https://fieldday-api` |
| `OIDC_JWKS_URI` | API services | `https://dev-w8cs0spu2cm1cvzu.us.auth0.com/.well-known/jwks.json` |
| `OIDC_ROLES_CLAIM` | API services | `https://fieldday.bklabs10.com/roles` |
| `VITE_OIDC_AUTHORITY` | web services (build time) | `https://dev-w8cs0spu2cm1cvzu.us.auth0.com` |
| `VITE_OIDC_CLIENT_ID` | web services (build time) | the Auth0 application's Client ID (public, not a secret) |
| `VITE_OIDC_SCOPES` | web services (build time) | `openid profile events.read events.write` |
| `VITE_OIDC_AUDIENCE` | web services (build time) | `https://fieldday-api` |
| `VITE_OIDC_ROLES_CLAIM` | web services (build time) | `https://fieldday.bklabs10.com/roles` |

The `VITE_*` values are baked into the page when it is built, so changing one means rebuilding the static site (Save and deploy in Render). The Auth0 application shows a Client Secret field even for single-page apps. FieldDay never uses it, because PKCE replaces it.

**Evidence:** real sign-ins as coordinator and viewer on both environments are in `evidence/auth/`. The coordinator changed an event's status, and the viewer got no write controls. The server's own refusal of a viewer's write is covered by the 403 tests.

**If a token is rejected:** decode it and compare `iss`, `aud`, `scope` and the roles claim with the table. Those four mismatches cause nearly every failure.

## 2. OpenWeather

The key is stored only as `OPENWEATHER_API_KEY` in each environment's secret store. The cost model assumes at most 144 provider calls a day because of caching.

## 2b. Databases: Neon free

1. Two Neon projects, one for staging and one for production, so data, credentials and quotas are separate.
2. Each connection string (ending `?sslmode=require`) is set as `DATABASE_URL` on that environment's API service in the Render dashboard.
3. The API runs migrations at startup (an advisory lock stops two instances from racing). With `SEED=1` it inserts synthetic demo data only when the database is empty.

## 3. Hosting, domain, DNS, HTTPS

1. The code is on GitHub. In Render I created a Blueprint from `deploy/render.yaml`. All services are on the free plan, and every `sync: false` variable is filled in per environment.
2. Custom domains: `fieldday.bklabs10.com` (production web) and `staging.bklabs10.com` (staging web). The two APIs keep their `onrender.com` addresses, `fieldday-api-prod` and `fieldday-api-staging`, and the CSP `connect-src` in `render.yaml` names them and the Auth0 domain.
3. DNS is at Namecheap (BasicDNS). I only added records for the two subdomains and left the root domain and the existing TXT records alone.

**DNS records in Namecheap**

| Type | Host | Value | TTL | Purpose |
|---|---|---|---|---|
| `CAA` | `@` | `0 issue "letsencrypt.org"` | Automatic | Allows Let's Encrypt to issue certificates for the domain |
| `CAA` | `@` | `0 issue "pki.goog"` | Automatic | Allows Google Trust Services to issue certificates |
| `CNAME` | `fieldday` | `fieldday-web-prod.onrender.com.` | Automatic | Routes the production web subdomain to its Render static site |
| `CNAME` | `staging` | `fieldday-web-staging.onrender.com.` | Automatic | Routes the staging web subdomain to its Render static site |

The Namecheap DNS screenshot confirms these four records and their `Automatic` TTL settings. The CAA records use host `@` (the root domain); the CNAME records point the `fieldday` and `staging` subdomains to their respective Render static-site hostnames.

4. **HTTPS:** Render issues and renews the certificates and redirects HTTP to HTTPS. Evidence in `evidence/deployment/raw/`: certificate details, the HTTP to HTTPS redirect, and the CAA lookups.
5. **Expiry alert:** not done yet. The plan is a free uptime/certificate monitor on the static hostname that alerts at 14 days, shown firing by raising its threshold above the days remaining.
6. **CDN:** Render's static sites sit behind Cloudflare. HTML (`/` and `/index.html`) is `no-cache`, hashed files under `/assets/` are immutable for a year, public API responses are `public, max-age=10, stale-while-revalidate=30`, and authenticated responses are `private, no-store` with `Vary: Authorization`. The API's JSON responses are not cached at the CDN (`cf-cache-status: DYNAMIC`). Headers for each class are captured in `evidence/deployment/raw/`.

## 4. CI/CD

GitHub environments `staging` and `production`; production has a required reviewer, which is the manual approval gate.

| Where | Name |
|---|---|
| secrets | `RENDER_STAGING_API_HOOK`, `RENDER_STAGING_WEB_HOOK`, `RENDER_PROD_API_HOOK`, `RENDER_PROD_WEB_HOOK` (each service's Deploy Hook URL, which already contains a `?key=`) |
| variables | `STAGING_API_URL`, `STAGING_WEB_URL`, `PROD_API_URL`, `PROD_WEB_URL`, and `DEPLOY_ENABLED=true` (until it exists the deploy jobs are skipped) |

The pipeline: test, deploy staging pinned to the commit, wait for `/healthz` to report that exact SHA, smoke checks, approval, then production with the same checks.

**Rollback:** I ran the `rollback` workflow twice on staging, first back to an earlier commit and then forward again. After each run `/healthz` reported the expected build. The screenshots are in `evidence/deployment/`.

## 5. Observability and alerts

`OTEL_EXPORTER_OTLP_ENDPOINT` points the API at an OTLP/HTTP backend. The planned screenshot is one trace that starts at the browser request (`traceparent`), passes through the API span and ends in the `openweather.forecast` child span. **Not done yet:** the backend, the trace screenshot, the triggered SLO alert and the budget alert.

## 6. MCP App

The MCP endpoint is `POST /mcp` with a bearer access token, and discovery metadata is at `/.well-known/oauth-protected-resource`. **Not done yet:** running it in a real MCP host. If a real host's handshake differs from what `web/src/mcp/protocol.ts` expects, that file is the only place to adjust.

## 7. Performance and accessibility

- **Core Web Vitals:** I ran Lighthouse three times on staging before and three times after one change. The change was a `<link rel="preconnect">` to the API origin, added in `web/vite.config.ts` from the same `VITE_API_BASE` the app uses. "Before" ran on commit `5d4deff` and "after" on `ebf911a`. The medians didn't move (LCP 1.3 s both times, scores 99 to 100 before and 100 after, CLS near 0, TBT near 0). The page already sits well inside the "good" limits, and the LCP element is the page heading rather than the API data, so the hint wasn't on the critical path. Reports are in `evidence/perf/`.
- **axe:** Lighthouse's accessibility audit uses axe-core in real Chrome (colour contrast included). It scored 100 with no failing audits on the board and the event detail page. The jsdom axe tests cover the signed-in coordinator forms.
- **Keyboard:** I completed search, opening an event and changing its status using only the keyboard. Notes and screenshots are in `evidence/a11y/`.

## 8. Postmortem

The staging authentication failure caused by an incorrect `OIDC_JWKS_URI` was reproduced on November 24, 2026. The incident and its timeline, root cause, impact, recovery, and follow-up actions are documented in `docs/POSTMORTEM.md`. The related troubleshooting steps are documented in Section C of `docs/RUNBOOK.md`.
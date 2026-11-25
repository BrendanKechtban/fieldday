# FieldDay runbook

Written so someone who has never seen the system can operate it. Assume you have: the Render dashboard, the GitHub repo, and the observability backend.

## What is running

| Piece | Where | Health signal |
|---|---|---|
| API (Node) | Render **free** web service `fieldday-api-<env>` (sleeps when idle) | `GET /healthz` -> `{"status":"ok","build":"<commit sha>","db":null}`; `GET /healthz?deep=1` also checks the database (`db:true`) |
| Database | Neon Postgres, one project per environment (suspends when idle, wakes on the first query) | `/healthz?deep=1` returns `db:true` |
| Web (static) | Render static site `fieldday-web-<env>` | `GET /` returns 200 |
| Identity | Entra ID | sign-in works; API logs `invalid_token` if JWKS/issuer/audience are wrong |
| Weather | OpenWeather | `GET /api/events/:id/weather` reports `fresh`, `stale`, `unavailable` or `out_of_range` |

Logs are JSON lines on stdout: `{t, rid, method, path, status, ms, build}`. Quote the `rid` (request id) from a user's error message to find the exact request; the same id is in the API error body (`requestId`).

## First five minutes of any incident

1. `curl -s https://api.<domain>/healthz?deep=1`. **No answer may simply mean the free service is asleep: wait about a minute and retry.** Still no answer or `db:false` -> section A. Build id not what you expect -> a deploy is half-done or rolled back; check the Actions run.
2. Open the web app. Board empty with an error banner -> API down or CORS broken (section B).
3. Check the last deploy (GitHub Actions, Render events). **If the problem started with a deploy, roll back first, diagnose second** (section F).
4. Say what you see and the time in the incident log (this becomes the postmortem timeline).

## A. API down or `db:false`

- Render logs: look for a crash at startup. `OIDC_ISSUER, OIDC_AUDIENCE and OIDC_JWKS_URI are required` -> an env var was removed; restore it.
- `DATABASE_URL is required` -> the secret is missing; set it in the Render dashboard for that environment.
- `password authentication failed`, `ENOTFOUND`, `ECONNREFUSED` or SSL errors -> `DATABASE_URL` is wrong or the Neon password was rotated; copy the current string from the Neon console (it must end in `?sslmode=require`). Do **not** create a new Neon project: the data lives in the old one.
- Timeouts right after a quiet period -> Neon compute was suspended and is waking; retry after a few seconds. If it never wakes, check the Neon console for a quota suspension (100 CU-hours per month on the free plan).
- Migrations run automatically at startup; a failing migration rolls its own transaction back and the process exits. Roll back the deploy.

## B. Board shows an error banner / browser console CORS errors

- `CORS_ORIGINS` must contain the **exact** web origin (scheme + host, no trailing slash). Staging and production differ. Fix the variable and redeploy the API.

## C. Everyone gets 401 `invalid_token` (but the site loads)

- A successful `/healthz` response does **not** mean authentication is working. It does not validate tokens or check whether the API can retrieve signing keys. The board loading and sign-in working do not rule out an API authentication problem either.
- The web app displays "Your session has expired" for any 401 response. This message can be misleading when the actual problem is on the API side.
- Find the failed request in Render. Open `fieldday-api-staging` (or the production service), select **Logs** from the left sidebar, and use the service-wide log view rather than an individual deployment's logs. Search for `401` and look for entries such as `"method":"POST","path":"/api/events/4/status","status":401`.
- Decode a failing token using jwt.io. Compare its `iss` claim with `OIDC_ISSUER` and its `aud` claim with `OIDC_AUDIENCE`. Auth0 issuer URLs include a trailing slash.
- If the issuer and audience are correct, check `OIDC_JWKS_URI`. It should point to `https://<tenant>.us.auth0.com/.well-known/jwks.json`. Open the URL in a browser to confirm that it returns the signing keys rather than a not-found response.
- If the JWKS URL is incorrect, update it in the Render environment settings, select **Save and deploy**, and wait until the new build is Live.
- After deployment, sign in again using a private browser window and retry an authenticated action, such as changing an event's status. Confirm that the request succeeds.
- Remember that `/healthz` returning 200 only confirms basic service availability. It does not confirm that authenticated requests work. A synthetic check that signs in and performs an authenticated write would detect this type of issue more reliably.
- This was reproduced during the November 24 staging test. See `docs/POSTMORTEM.md` for the incident details.

## D. 403 for a coordinator

- The token needs scope `events.write` (check `scp`) **and** role `coordinator` (check `roles`). Missing role: assign it in Enterprise applications -> Users and groups, then sign out and in again (roles are baked into the token).

## E. Weather banner says stale / unavailable

- This is the designed degradation, not an outage: the board, status changes and registrations keep working. Check OpenWeather status and the key/quota. Expect `stale` (with the last-good timestamp) once the 30-minute cache expires. Nothing to do unless it persists for hours; then verify the key was not revoked. The key never appears in logs; if you ever see `appid=` with a value, treat the key as leaked and rotate it.

## F. Roll back

1. GitHub -> Actions -> **rollback** -> Run workflow -> environment + the last known-good full SHA (from `git log` or the previous deploy).
2. The workflow redeploys that commit and waits until `/healthz?deep=1` reports it. Confirm manually: `curl -s "https://api.<domain>/healthz?deep=1"`.
3. Data is not rolled back. Migrations are forward-only in production; if a bad migration shipped, use Neon's point-in-time restore or a branch from before the deploy (the free plan keeps only a short history window; check the console for yours) and tell the team. `npm run migrate:down -w server` reverts one migration when it is safe to do so.

## G. Data questions

- Who changed what: `audit_events` (append-only, actor = token `sub`, before/after JSON, channel `rest`/`mcp`). Query read-only from the Neon SQL editor or `psql "$DATABASE_URL" -c "select at,actor,action,entity_id from audit_events order by id desc limit 20"`.
- All data is synthetic; there is no personal data to protect beyond the opaque `sub` ids in the audit log.

## H. Live updates not arriving

- The stream is `GET /api/stream` (SSE). Proxies that buffer responses break it; the API sends `X-Accel-Buffering: no`. Clients reconnect automatically and replay missed events from `Last-Event-ID`; if a client is too far behind it refetches a snapshot (`resync`). A single instance serves all streams; restarting the API drops connections and clients recover on their own within ~3 s.

## I. Free-tier behaviour that looks like an outage but is not

- **First request after idle is slow (about a minute):** Render free services sleep after 15 idle minutes. Wait and retry; nothing to fix. Wake the API before demos.
- **Rate-limit counters and the weather cache reset after a sleep:** expected; the weather banner may briefly show a fresh fetch.
- **Everything is down at the end of the month:** the shared 750 Render instance hours may be used up (free services are suspended until next month). Check the Render dashboard; avoid pinging the production API from monitors (see `docs/DEPLOYMENT.md` Free-tier rules).

## Alerts and what they mean

See `docs/SLO.md`. Page-worthy: availability SLO burn, `/healthz` failing. Ticket-worthy: weather degradation, certificate < 14 days.

- Authentication failures: `/healthz` may remain healthy even when token validation is broken. A separate authenticated-write check is needed to detect this.
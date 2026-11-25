# Postmortem: Staging Sign-In Worked but Every Write Returned 401 (Bad JWKS URL)

I intentionally caused this issue in the staging environment to test how FieldDay behaves when token validation breaks while the rest of the application appears healthy. The goal was to see what fails, how the issue appears to users, and how it can be diagnosed and resolved.

## 1. Incident Details

- **Environment:** Staging (`fieldday-api-staging`, serving staging.bklabs10.com)
- **Date:** November 24, 2026
- **Start:** 21:13:15 UTC
- **Detected:** 21:15:51 UTC
- **Mitigated:** 21:41:55 UTC
- **Resolved:** Approximately 21:43 UTC
- **Build:** `dfabc9b3b2acef181a4c1650a32c9b30cbbc4ebb`
- **Author:** Brendan Kechtban
- **Severity:** SEV-3 (staging only, intentionally induced, no real users affected)

All times are UTC. My local time was CST (UTC-6). Render displays local times, while the JSON log entries use UTC.

## 2. Summary

I changed the API's `OIDC_JWKS_URI` to an incorrect URL that did not exist on the Auth0 tenant. The website continued loading and `/healthz` kept returning 200, but requests requiring token validation failed with 401 responses. I could sign in as a coordinator but could not change an event's status. The incorrect configuration remained active for approximately 28 minutes.

The website displayed "Your session has expired. Please sign in again," even though the session itself was valid.

## 3. What I Did to Induce It

I opened `fieldday-api-staging` in Render and went to its Environment settings.

I changed `OIDC_JWKS_URI` from:

`https://dev-w8cs0spu2cm1cvzu.us.auth0.com/.well-known/jwks.json`

to an incorrect path ending in:

`/.well-known/jwks-broken.json`

I then clicked **Save and deploy**.

My first attempt at approximately 3:06 PM CST did not successfully change the environment variable. When I checked it afterward, the original URL was still there, and a status change worked at 3:08 PM. I did not count that attempt as a failure.

The second attempt at approximately 3:13 PM CST successfully deployed the incorrect URL and caused the issue.

## 4. Impact

The failure affected authenticated actions, while other parts of the application continued working.

- **Public board:** Continued working. I opened it in a private window around 3:14 PM CST, and all six events appeared. Reading events does not require authentication.
- **Sign-in:** Continued working. Auth0 issued tokens normally because Auth0 itself was not affected.
- **Status changes:** Failed. `POST /api/events/4/status` returned HTTP 401 at 21:15:51 UTC. The request took 198 ms.
- **Frontend:** Displayed "Your session has expired. Please sign in again," even though signing in had worked.
- **Health check:** `/healthz` returned 200 throughout the incident.

I only made one failing write attempt, so I cannot provide a meaningful total failure count. No real users were affected because this was a staging test.

## 5. Timeline

- **21:06:46 UTC:** First configuration attempt deployed, but the URL remained correct. A status change still worked at 21:08.
- **21:13:02 UTC:** Incorrect JWKS URL successfully deployed. Render deployment: `dep-dc2vrnjl550s73ccptpg`.
- **21:13:15 UTC:** New build became live.
- **21:13:14–21:13:24 UTC:** `/healthz` continued returning 200.
- **Around 21:14 UTC:** Opened the public board in a private window and confirmed all six events loaded.
- **Around 21:15 UTC:** Signed in as a coordinator and attempted to change an event's status. The application displayed the expired-session message.
- **21:15:51 UTC:** `POST /api/events/4/status` returned 401.
- **21:41:37 UTC:** Restored the correct JWKS URL and deployed the change. Render deployment: `dep-dc3094d9fdbs73fh339g`.
- **21:41:55 UTC:** Restored build became live.
- **Around 21:43 UTC:** Successfully changed the event from delayed to canceled, using the reason "test."
- **Around 21:44 UTC:** Changed the event back to scheduled using the reason "test success."

## 6. Detection

No automated alert fired. I noticed the issue because I had intentionally changed the configuration and then tested an authenticated action.

The SLO alert described in `docs/SLO.md` had not been implemented yet. Even if a basic health check had been monitoring `/healthz`, it would not have detected the problem because that endpoint continued returning 200.

A synthetic check that signs in and performs an authenticated write would have detected the issue. I do not currently have one configured.

Without manually testing the status change, the problem could have remained unnoticed until a coordinator tried to perform an authenticated action.

## 7. Root Cause

The issue was caused by an incorrect URL in the API's `OIDC_JWKS_URI` environment variable.

The API creates its key resolver using the configured URL at startup, but only fetches the signing keys when it needs to verify a token. This allowed the service to start normally and pass its health check even though token validation was broken.

When the key retrieval failed, `verifyToken` threw an error. The authentication middleware treated every verification failure the same way and returned a generic `401 invalid_token` response with the message "Token validation failed."

This caused three problems:

- The API returned 401 even though the actual issue was the server failing to retrieve the signing keys. This should be treated differently from a genuinely invalid token.
- The server did not log the underlying verification error, so the logs showed a 401 without explaining why it happened.
- The frontend interpreted every 401 as an expired session and told the user to sign in again, which could not fix the issue.

The main missing safeguards were a health check that verifies JWKS availability, better logging for token verification failures, and monitoring for authentication errors.

## 8. What Went Well, What Went Badly, and Where I Got Lucky

**What went well:**
- The public board and sign-in continued working.
- The issue was limited to authenticated actions.
- Restoring the correct environment variable resolved the problem without requiring a code change.
- The request log made the 401 easy to find once I opened the service-wide Logs tab in Render.

**What went badly:**
- `/healthz` continued reporting that everything was healthy.
- The error message shown to the user was misleading.
- The server did not explain why token verification failed.
- I initially searched the individual deployment logs and found nothing, which delayed finding the relevant request.

**Where I got lucky:**

The issue was limited to staging, and only one person was testing it. No real users were affected.

## 9. Action Items

**Logging and error handling**
- Log the reason token verification fails, including the error name and message, without logging the actual token.
- Return 503 when the signing keys cannot be retrieved, while keeping 401 for genuinely invalid tokens.

**Health checks and monitoring**
- Extend `/healthz?deep=1` to also check JWKS availability.
- Add a synthetic sign-in and authenticated-write check.
- Add an alert for unusual increases in 401 responses.

**Frontend**
- Change the frontend error message so it does not automatically tell users their session expired whenever an authenticated request returns 401.

**Runbook**
- Direct developers to the service-wide Logs tab in Render when searching for failed requests.
- Explain that `/healthz` returning 200 does not rule out an authentication problem.

None of these changes have been implemented as of this commit. They are listed as follow-up tasks.

## 10. Runbook Check

The relevant instructions are in section C of `docs/RUNBOOK.md`, which covers situations where users receive `401 invalid_token` errors while the website continues loading.

The incident showed a few areas where the instructions could be improved:

- The troubleshooting steps should make checking `OIDC_JWKS_URI` an explicit part of diagnosing authentication failures.
- The instructions should direct developers to the service-wide Logs tab instead of the individual deployment logs.
- The runbook should explain that `/healthz` returning 200 does not guarantee that authentication is working.

These updates should be made directly in `docs/RUNBOOK.md` in the same commit as this postmortem.
# Submission sheet

## 1. What the reviewer gets

| Item | Value |
|---|---|
| Repository (public) | `https://github.com/BrendanKechtban/fieldday` |
| Production web / API | `https://fieldday.bklabs10.com` / `https://fieldday-api-prod.onrender.com` |
| Staging web / API | `https://staging.bklabs10.com` / `https://fieldday-api-staging.onrender.com` |
| Sign-in for reviewers | Auth0 login page. Two accounts: `coordinator@bklabs10.com` (can change events) and a viewer account (read only). The passwords are in the secrets file uploaded to D2L, not in the repo. |
| Note for the reviewer | The API runs on a free host and sleeps when idle, so the first request takes about a minute. Open the site, wait, and refresh. |

The accounts use made-up addresses on my own domain. After clicking Sign out you may be logged straight back in, because Auth0 keeps its own session. Use a private window to switch between the two accounts.

To check the code without any accounts: `npm install && npm test`, then `npm run gameday`.

## 2. Where the evidence is

| Checklist area | Where |
|---|---|
| Tests, Game Day, audit, cost model (generated) | `evidence/raw/<timestamp>/` (each run names the commit it ran on) |
| Deploy pipeline, rollback, `/healthz` build id | `evidence/deployment/` (rollback screenshots) and the GitHub Actions runs |
| HTTPS, DNS, CAA, headers, CORS | `evidence/deployment/raw/<timestamp>/` (raw command output) and screenshots in `evidence/deployment/` |
| Real sign-in, roles (F7 to F9) | `evidence/auth/` (coordinator, viewer, staging and production) |
| Core Web Vitals before and after | `evidence/perf/` (3 Lighthouse runs before, 3 after, JSON and HTML). The result was flat; see `docs/AI-USE-LOG.md` |
| axe and keyboard | `evidence/a11y/` (Lighthouse accessibility reports, keyboard notes and screenshots) |
| OpenTelemetry trace, SLO alert | **Not done.** The SLI and SLO definitions are in `docs/SLO.md`; no trace backend or live alert was set up. |
| Rate limiting | `evidence/raw/<timestamp>/06-rate-limiting.txt` |
| Runbook, postmortem | `docs/RUNBOOK.md`, `docs/POSTMORTEM.md` (staging failure induced on 2026-11-24) |
| AI-use log, challenged claim, attestation | `docs/AI-USE-LOG.md` |

Anything marked not done in `docs/REQUIREMENTS.md` is a real gap, not a hidden one.

## 3. Keeping it free

The only thing that costs money is the domain, which I already paid for. The repository doesn't need any paid plan. `deploy/render.yaml` puts both API services on `plan: free`, the static sites have no paid plan, and nothing uses a disk.

1. I never added a payment method or clicked Upgrade on Render, Neon, OpenWeather, Auth0, GitHub or any monitor.
2. Everything runs on free plans: Render free web services and static sites, Neon free, an OpenWeather free key, an Auth0 free tenant, and GitHub free.
3. According to the Render and Neon pages, the free plans suspend service when the allowance runs out instead of billing. Render stops all free web services when the 750 shared hours are gone, and Neon suspends compute when its monthly hours are gone.
4. Any uptime monitor points at the static web hostnames, not the production API, so it doesn't burn the shared Render hours.

## 4. How it was handed in through GitHub

1. The repository is public on a free GitHub account. Actions has a free monthly allowance, and CI takes a few minutes per run.
2. No secrets are in the repo. `.env` files are ignored. The Neon connection strings, Render deploy hook URLs and the OpenWeather key live only in the Render dashboard and GitHub secrets, and in the secrets file uploaded to D2L. (The Auth0 domain, API identifier and client ID are public by design and do appear in config.)
3. The final evidence is generated on the commit above with `npm run evidence`. 
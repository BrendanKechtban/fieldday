# FieldDay

FieldDay is an operations board for a made-up outdoor events group: runs, yoga in the park, trail workshops, that kind of thing. Anyone can look at the upcoming events. Coordinators can sign in and change an event's status (scheduled, delayed, canceled), add seats, and see who changed what. Weather is shown for each event, but it only advises. If the weather service is down, everything else keeps working. All the data is made up.

This is my CSC436 final project ( FieldDay).

**Live**
- Production: https://fieldday.bklabs10.com
- Staging: https://staging.bklabs10.com

The server is on a free host and goes to sleep when nobody uses it. If the board looks stuck the first time, give it about a minute and refresh.

To sign in as a coordinator you need the account details I put in the D2L submission. Reading the board needs no account.

## What it's made of

- **Front end:** React with strict TypeScript, built with Vite.
- **API:** Express, with zod checking every request.
- **Database:** Postgres (Neon in the deployed version) with migrations that can be reversed.
- **Sign-in:** Auth0 using OpenID Connect. The API checks the token's signature, issuer, audience and expiry itself with `jose`. Coordinator rights come from a role claim in the token.
- **Live updates:** server-sent events, with replay so a viewer who drops off catches up when it reconnects.
- **Also in there:** an MCP server and app, rate limiting, an audit log of status changes, and OpenTelemetry hooks.
- **Hosting:** Render free plan for the API and the static sites, deployed by GitHub Actions (staging first, then production after approval). Domain `bklabs10.com` is the only thing I paid for.

`docs/ARCHITECTURE.md` has the diagrams and the reasoning behind the choices.

## Running it on your own machine

You need Node 22 or newer.

```bash
npm install
npm test        # typechecks and runs the server and web tests, no database setup needed
npm run build
```

To run the whole thing, use three terminals:

```bash
# 1. A small fake sign-in server for local use (it is not a real login service)
node scripts/dev-idp.mjs          # prints the OIDC_* settings to export in terminal 2

# 2. The API (export the OIDC_* values from step 1 first)
export DATABASE_URL=pglite://./.pgdata SEED=1
npm run dev:server                # http://localhost:8080

# 3. The web app
cp web/.env.example web/.env
npm run dev:web                   # http://localhost:5173
```

The board works without signing in. Changing anything needs a token with the `events.write` scope and the `coordinator` role. `OPENWEATHER_API_KEY` is optional locally; without it the weather box just says it's unavailable.

If you'd rather use a real Postgres server: `docker compose up -d db` and set `DATABASE_URL=postgres://fd:fd@localhost:5432/fieldday`.

## Checking my work

```bash
npm run gameday      # capacity race, rate limits, weather timeout, viewer reconnect
npm run evidence     # saves the raw output, stamped with the commit, under evidence/raw/
npm run cost-model   # monthly cost arithmetic at 1x, 10x and 100x traffic
```

Commit your changes before `npm run evidence`, otherwise the files say `NO-GIT-REPO` instead of a commit id. Without `GAMEDAY_DATABASE_URL` the game day uses the in-memory database, which is fine for correctness but proves less about real concurrency. The output says which one ran.

The `evidence/` folder also has things I captured by hand: the deploy and rollback screenshots, the sign-in screenshots, the Lighthouse runs and the accessibility checks. `docs/SUBMISSION.md` lists where each item lives.

## The docs

| File | What's in it |
|---|---|
| `docs/SUBMISSION.md` | The links, the commit under review, and where the evidence is |
| `docs/REQUIREMENTS.md` | The checklist, what's done |
| `docs/ARCHITECTURE.md` | How a request flows, where the trust boundaries are, known limits |
| `docs/DEPLOYMENT.md` | How I actually deployed it: Auth0, Render, DNS, CI |
| `docs/RUNBOOK.md` | What to do when something breaks, written for someone who has never seen it |
| `docs/SLO.md` | What I measure and what the targets are |
| `docs/POSTMORTEM.md` | The failure I caused on staging on purpose, and what I learned |
| `docs/AI-USE-LOG.md` | How I used AI |

# AI Use Log

I used Claude through Claude Code for much of this project. The configured model was `claude-sonnet-5-5`, although the actual model serving the requests may have differed. This document explains how I used AI, what I handled myself, and one suggestion that I tested but did not find to be effective.

## 1. How I Used AI


**Backend (`server/src`)**

Claude helped write the API, database migrations, token validation, weather integration, SSE, rate limiting, and MCP server.

I reviewed the implementation, did changes and ran the tests.

**Frontend (`web/src`)**

Claude helped build the main board, detail page, PKCE sign-in, live updates, and MCP App.

I reviewed the pages, did changes and tested the application.

**Tests and Scripts**

Claude helped create the tests, Game Day scripts, evidence collector, and cost model.

I ran the scripts and checked the expected results, including the hand-calculated values.


**Hosting and DNS**

I used Claude for guidance when setting up Render, Namecheap, Auth0, and GitHub.
I completed the configuration and setup myself through each service.

**Auth0 Integration**

Claude helped with Auth0, including the custom roles claim, audience parameter, Auth0 URLs, and a test for the roles claim.

I created the Auth0 tenant, API, application, users, and Action. I also configured the Render environment variables and tested the login process.

**Evidence Collection**

Claude helped create scripts for capturing command output and organizing evidence.

I ran the scripts, captured the screenshots, and committed the evidence files.

**Performance Testing**

Claude suggested adding a `preconnect` hint to the API origin.

I tested the suggestion by running Lighthouse before and after the change to see whether it actually improved performance.

## 2. An AI Suggestion I Tested

One suggestion I wanted to verify was adding a `preconnect` link to the API origin.

Claude suggested that this could improve Largest Contentful Paint (LCP) because the event list waits for the first API response. The suggestion appeared in the Claude Code session on November 24, 2026, and in the commit message for `ebf911a`.

To check whether it helped, I ran Lighthouse three times using the default mobile performance settings before the change (commit `5d4deff`) and three more times after deploying `ebf911a`.

The reports are saved in `evidence/perf/` as JSON and HTML files.

**Results:**

Before the change:
- Performance scores: 99, 100, 100
- LCP: 2.0, 1.3, 1.3 seconds
- FCP: 1.4, 1.2, 1.2 seconds

After the change:
- Performance scores: 100, 100, 100
- LCP: 1.4, 1.3, 1.3 seconds
- FCP: 1.4, 1.3, 1.2 seconds

The median LCP was 1.3 seconds both before and after the change. The other metrics, including CLS and TBT, were also about zero in both sets of tests.

Based on these results I also checked the LCP element and found that it was the page heading, not the API data. This meant the API connection was not on the critical path for LCP.

I kept the `preconnect` change because it does not cause any issues, but I did not claim a performance improvement. I updated section 7 of `docs/DEPLOYMENT.md` and D8 in `docs/REQUIREMENTS.md` to reflect the results.


## 3. Final Checks Before Submission

Before submitting, I reviewed the repository, evidence folder, and screenshots for credentials and personal information that should not be publicly available.

The following are the checks I performed:

- [ ] Ran `grep -rIn "appid=" .` to check for real OpenWeather API keys.
- [ ] Ran `grep -rIn "Bearer " evidence docs` to check for authentication tokens.
- [ ] Ran `grep -rIn "postgres\://" .` to check for exposed Neon connection strings.
- [ ] Ran `grep -rIn "api/deploy" .` to check for Render deployment hooks.
- [ ] Reviewed the repository, evidence files, and screenshots for personal email addresses and passwords.
- [ ] Confirmed that the only Auth0 identifiers in the configuration are the domain, API identifier, and Client ID, which are public by design.

**Attestation**

I reviewed the project files and evidence before submission to check for exposed credentials and personal information. I also checked that the Auth0 configuration only contains identifiers intended to be public.

Name: Brendan Kechtban

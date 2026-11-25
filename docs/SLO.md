# SLI and SLO

## What I measure (SLIs)

| SLI | Definition | Where it comes from |
|---|---|---|
| Availability | share of API requests that are not 5xx. 429s (deliberate throttling) and 4xx client errors don't count against it | `fieldday_http_requests_total{status_class}` |
| Read latency | share of public read requests finishing in under 300 ms | `fieldday_http_request_duration_ms{route="read"}` histogram |
| Weather freshness (for information only) | share of `/weather` responses that are `fresh` instead of `stale` or `unavailable` | `fieldday_weather_provider_calls_total{outcome}` |

## Targets over 30 days

- Availability of at least 99.5%. That leaves an error budget of 0.5%, about 3 h 36 min of total failure in 30 days, or 0.5% of requests.
- 95% of public reads under 300 ms.
- Weather is not part of the availability target on purpose. The design keeps weather problems away from the core functions, and `gameday weather-timeout` checks that.

## Alerts

| Alert | Condition | Severity |
|---|---|---|
| Fast burn | 5xx ratio above 5% over 5 minutes (about 10 times the budget burn rate) and above 1% over 1 hour | page |
| Slow burn | 5xx ratio above 1% over 6 hours | ticket |
| Health | `/healthz` fails from the external monitor on 2 checks in a row | page |
| Certificate | fewer than 14 days to expiry | ticket |

On free hosting I only point a monitor at the API for the alert demo, because a monitor pinging it all month would use up the shared free hours. Normal monitoring points at the static web hostnames.

## Triggering it for the demo

Stop the staging API (or deploy a build that exits at startup), send traffic for a few minutes, then screenshot the alert firing and clearing. The timestamps go into the postmortem.

Metrics leave the API through OpenTelemetry (`OTEL_EXPORTER_OTLP_ENDPOINT`). The queries are written against the instrument names in `server/src/telemetry.ts`.

## Status

The SLOs and alert rules are defined above. **Not done yet at the time of writing:** creating the alert in a monitoring backend and triggering it on staging. Update this section when it is done and link the screenshot.

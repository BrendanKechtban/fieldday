import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { ConsoleSpanExporter, SimpleSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { trace, metrics, context, propagation, SpanKind, SpanStatusCode, type Span } from "@opentelemetry/api";
import type { Request, Response, NextFunction } from "express";

/**
 * OpenTelemetry bootstrap. Called first in index.ts so the SDK (and its context manager) is live before any request.
 *
 *  OTEL_EXPORTER_OTLP_ENDPOINT  -> traces + metrics go to that OTLP/HTTP collector
 *  OTEL_CONSOLE=1               -> spans are printed to stdout (handy for the trace evidence)
 *  neither set                  -> SDK still runs (context propagation works), nothing is exported
 *
 * Server spans are created by the explicit middleware below (not by monkey-patching http), so it works the
 * same under ESM, tsx and the compiled build. The W3C `traceparent` header sent by the browser is extracted,
 * which makes the browser request and the API span ONE distributed trace. Only the path (never the query
 * string) is recorded, so API keys that ride in provider URLs (appid=...) can never land in a span.
 */

export function startTelemetry(serviceName = "fieldday-api", buildSha = process.env.BUILD_SHA ?? "dev") {
  const spanProcessors: SpanProcessor[] = [];
  if (process.env.OTEL_CONSOLE === "1") spanProcessors.push(new SimpleSpanProcessor({ exporter: new ConsoleSpanExporter() }));
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ "service.name": serviceName, "service.version": buildSha, "deployment.environment": process.env.DEPLOY_ENV ?? "dev" }),
    spanProcessors,
    ...(endpoint ? {
      traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` }),
      metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/metrics` }), exportIntervalMillis: 15_000 }),
    } : {}),
  });
  sdk.start();
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => { void sdk.shutdown(); });
  return sdk;
}

const tracer = trace.getTracer("fieldday");
const meter = metrics.getMeter("fieldday");
export const weatherCalls = meter.createCounter("fieldday_weather_provider_calls_total", { description: "Calls to the weather provider by outcome" });
export const requestDuration = meter.createHistogram("fieldday_http_request_duration_ms", { description: "HTTP request latency", unit: "ms" });
export const requestsTotal = meter.createCounter("fieldday_http_requests_total", { description: "HTTP requests by route class and status class" });

/** Run fn inside a named child span of the current trace; records errors, always ends the span. */
export async function withSpan<T>(name: string, attrs: Record<string, string | number | boolean>, fn: (span: Span) => Promise<T> | T): Promise<T> {
  return tracer.startActiveSpan(name, { attributes: attrs }, async (span) => {
    try {
      return await fn(span);
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message.replace(/([?&](?:appid|api_key|apikey|key|token)=)[^&\s"']+/gi, "$1[REDACTED]") });
      throw e;
    } finally {
      span.end();
    }
  });
}

/** Express middleware: continues the caller's trace (W3C traceparent) and records one SERVER span per request. */
export function traceRequests(req: Request, res: Response, next: NextFunction) {
  if (req.path === "/healthz" || req.path === "/api/stream") return next();
  const parent = propagation.extract(context.active(), req.headers);
  const span = tracer.startSpan(`${req.method} ${req.path.replace(/\/\d+/g, "/:id")}`, {
    kind: SpanKind.SERVER,
    attributes: { "http.request.method": req.method, "url.path": req.path, "client.origin": String(req.headers.origin ?? "") },
  }, parent);
  const start = Date.now();
  res.on("finish", () => {
    const cls = `${Math.floor(res.statusCode / 100)}xx`;
    span.setAttribute("http.response.status_code", res.statusCode);
    if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    const route = req.path.startsWith("/mcp") ? "mcp" : req.path.includes("/weather") ? "weather" : req.method === "GET" ? "read" : "write";
    requestsTotal.add(1, { route, status_class: cls });
    requestDuration.record(Date.now() - start, { route, status_class: cls });
    span.end();
  });
  context.with(trace.setSpan(parent, span), next);
}

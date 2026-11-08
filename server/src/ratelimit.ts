import type { Request, Response, NextFunction, RequestHandler } from "express";
import { HttpError } from "./auth.js";

/** Fixed-window in-memory limiter. Single-instance only; see docs/scaling.md for the shared-store upgrade path. */
export function rateLimit(opts: { name: string; max: number; windowMs: number; now?: () => number; key?: (req: Request) => string }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const now = opts.now ?? (() => Date.now());
  return (req: Request, res: Response, next: NextFunction) => {
    const k = `${opts.name}:${opts.key ? opts.key(req) : req.ip ?? "unknown"}`;
    const t = now();
    let h = hits.get(k);
    if (!h || h.resetAt <= t) { h = { count: 0, resetAt: t + opts.windowMs }; hits.set(k, h); }
    h.count++;
    res.setHeader("RateLimit-Limit", String(opts.max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, opts.max - h.count)));
    if (h.count > opts.max) {
      const retry = Math.ceil((h.resetAt - t) / 1000);
      res.setHeader("Retry-After", String(retry));
      return next(new HttpError(429, "rate_limited", `Too many requests. Retry in ${retry}s.`));
    }
    if (hits.size > 10_000) for (const [kk, v] of hits) if (v.resetAt <= t) hits.delete(kk);
    next();
  };
}

/**
 * Brute-force protection for the auth layer. Wraps the authenticator and counts only FAILED authentications per client IP.
 * A request with a valid token is never throttled here (so junk traffic from a shared IP cannot lock real users out of
 * their writes); once an IP has produced more than `max` failures in the window, further failures get 429 + Retry-After
 * instead of 401, which removes the incentive to keep guessing.
 */
export function authFailureGuard(opts: { max: number; windowMs: number; now?: () => number }, authenticator: RequestHandler): RequestHandler {
  const fails = new Map<string, { count: number; resetAt: number }>();
  const now = opts.now ?? (() => Date.now());
  return (req: Request, res: Response, next: NextFunction) => {
    authenticator(req, res, (err?: unknown) => {
      if (!err) return next();
      const k = req.ip ?? "unknown";
      const t = now();
      let h = fails.get(k);
      if (!h || h.resetAt <= t) { h = { count: 0, resetAt: t + opts.windowMs }; fails.set(k, h); }
      h.count++;
      if (fails.size > 10_000) for (const [kk, v] of fails) if (v.resetAt <= t) fails.delete(kk);
      if (h.count > opts.max) {
        const retry = Math.ceil((h.resetAt - t) / 1000);
        res.setHeader("Retry-After", String(retry));
        return next(new HttpError(429, "rate_limited", `Too many failed authentication attempts. Retry in ${retry}s.`));
      }
      next(err);
    });
  };
}

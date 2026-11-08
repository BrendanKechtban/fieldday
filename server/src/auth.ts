import type { Request, Response, NextFunction } from "express";
import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey, type KeyLike } from "jose";
import type { Config } from "./config.js";

export interface Actor {
  sub: string;
  roles: string[];
  scopes: string[];
}

declare module "express-serve-static-core" {
  interface Request { actor?: Actor }
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

export type KeyResolver = JWTVerifyGetKey | KeyLike | Uint8Array;

export function makeKeyResolver(cfg: Pick<Config, "jwksUri">): KeyResolver {
  return createRemoteJWKSet(new URL(cfg.jwksUri));
}

/** Validates signature (JWKS), issuer, audience and expiry. Roles come from the `roles` claim, scopes from `scp` (Entra) or `scope`. */
export async function verifyToken(token: string, cfg: Pick<Config, "issuer" | "audience">, keys: KeyResolver): Promise<Actor> {
  const { payload } = await jwtVerify(token, keys as JWTVerifyGetKey, {
    issuer: cfg.issuer,
    audience: cfg.audience,
    algorithms: ["RS256", "ES256"],
    clockTolerance: 5,
  });
  if (!payload.sub) throw new HttpError(401, "invalid_token", "Token has no subject");
  const scopeStr = typeof payload.scp === "string" ? payload.scp : typeof payload.scope === "string" ? payload.scope : "";
  const roles = Array.isArray(payload.roles) ? payload.roles.filter((r): r is string => typeof r === "string") : [];
  return { sub: payload.sub, roles, scopes: scopeStr.split(" ").filter(Boolean) };
}

export function bearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer (.+)$/i.exec(h);
  return m?.[1] ?? null;
}

export function authenticate(cfg: Pick<Config, "issuer" | "audience">, keys: KeyResolver) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const t = bearer(req);
    if (!t) return next(new HttpError(401, "unauthenticated", "Missing bearer token"));
    try {
      req.actor = await verifyToken(t, cfg, keys);
      next();
    } catch (e) {
      if (e instanceof HttpError) return next(e);
      next(new HttpError(401, "invalid_token", "Token validation failed"));
    }
  };
}

/** Require a validated scope AND (when given) a role. */
export function requireAccess(opts: { scope?: string; role?: string }) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const a = req.actor;
    if (!a) return next(new HttpError(401, "unauthenticated", "Authentication required"));
    if (opts.scope && !a.scopes.includes(opts.scope)) return next(new HttpError(403, "insufficient_scope", `Missing scope ${opts.scope}`));
    if (opts.role && !a.roles.includes(opts.role)) return next(new HttpError(403, "forbidden", `Requires role ${opts.role}`));
    next();
  };
}

export const SCOPES = { read: "events.read", write: "events.write" } as const;
export const ROLES = { coordinator: "coordinator", viewer: "viewer" } as const;

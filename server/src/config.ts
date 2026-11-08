export interface Config {
  port: number;
  databaseUrl: string;
  corsOrigins: string[];
  issuer: string;
  audience: string;
  jwksUri: string;
  weatherApiKey: string;
  weatherBaseUrl: string;
  weatherTimeoutMs: number;
  weatherMaxRetries: number;
  weatherCacheTtlMs: number;
  writeRateLimit: number;
  buildSha: string;
  mcpConfirmTtlMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 8080),
    // postgres://... (Neon, local, CI) or pglite://memory | pglite://./dir for zero-setup local dev.
    databaseUrl: env.DATABASE_URL ?? "",
    // Exact-origin allowlist. No wildcards, no regex.
    corsOrigins: (env.CORS_ORIGINS ?? "http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean),
    issuer: env.OIDC_ISSUER ?? "",
    audience: env.OIDC_AUDIENCE ?? "",
    jwksUri: env.OIDC_JWKS_URI ?? "",
    weatherApiKey: env.OPENWEATHER_API_KEY ?? "",
    weatherBaseUrl: env.OPENWEATHER_BASE_URL ?? "https://api.openweathermap.org/data/2.5/forecast",
    weatherTimeoutMs: Number(env.WEATHER_TIMEOUT_MS ?? 3000),
    weatherMaxRetries: Number(env.WEATHER_MAX_RETRIES ?? 2),
    weatherCacheTtlMs: Number(env.WEATHER_CACHE_TTL_MS ?? 30 * 60 * 1000),
    writeRateLimit: Number(env.WRITE_RATE_LIMIT ?? 30), // writes per actor per minute
    buildSha: env.BUILD_SHA ?? env.RENDER_GIT_COMMIT ?? "dev",
    mcpConfirmTtlMs: Number(env.MCP_CONFIRM_TTL_MS ?? 5 * 60 * 1000),
  };
}

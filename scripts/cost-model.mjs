#!/usr/bin/env node
// Monthly cost model at 1x / 10x / 100x traffic for the FREE-TIER deployment (Render free web services + Neon free Postgres).
// Every assumption is an explicit, editable INPUT. Inputs marked [verified] were read from the provider's own docs on 2026-11-05;
// inputs marked [VERIFY] are my assumptions or recalled prices: check them on the provider's page the day you submit.
//   node scripts/cost-model.mjs                    (defaults)
//   PRICE_API_INSTANCE=9 node scripts/cost-model.mjs   (override any input named in env())
const env = (k, d) => Number(process.env[k] ?? d);

// ---- Workload assumptions (all [VERIFY]: they are guesses about a class demo, not measurements) ----
const W = {
  pageViews1x: env("VIEWS_1X", 3000),     // views/month: a small class demo + graders + light public use
  apiCallsPerView: 3,                     // list + detail + weather, counted at origin (worst case: nothing served from a cache)
  sseMinutesPerView: 2,                   // how long a viewer keeps the live stream open
  htmlKB: 3, staticKB: 85, apiJsonKB: 12, // gzipped page weight (re-measure after changes) and average API body
  viewsPerBurst: 20,                      // traffic is clustered: this many views arrive in one burst (a class session, a grading hour)
  burstMinutes: 30,                       // how long one burst keeps the API busy
  maxBurstsPerDay: 96,                    // cap: one burst every 15 minutes means it never sleeps
  peakToAverage: 10, secondsPerMonth: 30 * 86400, daysPerMonth: 30,
  venues: 3, weatherRefreshMinutes: 30,   // weather cache TTL (WEATHER_CACHE_TTL_MS)
  weatherSnapshotKB: 2,                   // rows written to weather_snapshots per fresh fetch (never pruned)
  writesShareOfViews: 0.01,               // 1% of views are coordinator writes (each writes ~3 small rows)
  stagingAwakeHours: env("STAGING_HOURS", 20), // staging is mostly asleep; hours you keep it awake for demos/CI
};
// ---- Free-tier limits ----
const L = {
  renderInstanceHours: 750,   // [verified] free instance hours per WORKSPACE per month, shared by all free web services; at 0 all free services are suspended
  renderIdleSpinDownMin: 15,  // [verified] idle minutes before a free web service sleeps (waking takes about a minute)
  renderBandwidthGB: env("RENDER_BW_GB", 100), // [VERIFY] Render only says "included monthly amount"; look up your workspace's number
  neonComputeCuHours: 100,    // [verified] per project per month
  neonCuWhenActive: env("NEON_CU", 0.25), // [VERIFY] smallest autoscaling size; Neon bills/limits CU-hours = CU x hours active
  neonSuspendMin: 5,          // [verified] compute suspends after 5 idle minutes (cannot be disabled)
  neonStorageGB: 1,           // [verified] per project
  neonTransferGB: 5,          // [verified] public network transfer per project per month
  openWeatherCallsPerDay: 1000, // [VERIFY] against your OpenWeather plan
};
// ---- Prices if you must upgrade what breaks (all [VERIFY]; used only for the arithmetic) ----
const P = {
  renderPaidInstance: env("PRICE_API_INSTANCE", 7),
  neonPaidPerMonth: env("PRICE_NEON_PAID", 19),
  bandwidthPerGB: env("PRICE_BW_GB", 0.15),
  telemetryAt100x: env("PRICE_OTEL_100X", 19), // assume a free OTLP backend tier is outgrown at 100x
  domainIncremental: env("PRICE_DOMAIN_INCREMENTAL", 0), // you already own the domain: sunk cost, $0 extra
};

const f = (n, d = 2) => n.toLocaleString("en-US", { maximumFractionDigits: d });
console.log("WORKLOAD ASSUMPTIONS:", JSON.stringify(W));
console.log("FREE-TIER LIMITS:", JSON.stringify(L));
console.log("UPGRADE PRICES (verify!):", JSON.stringify(P), "\n");

for (const mult of [1, 10, 100]) {
  const views = W.pageViews1x * mult;
  const apiReqs = views * W.apiCallsPerView;
  const peakReqPerSec = (apiReqs / W.secondsPerMonth) * W.peakToAverage;
  const peakSse = ((views * W.sseMinutesPerView * 60) / W.secondsPerMonth) * W.peakToAverage;
  const egressGB = (views * (W.htmlKB + W.staticKB + W.apiCallsPerView * W.apiJsonKB)) / 1024 / 1024;
  const dbTransferGB = (apiReqs * W.apiJsonKB) / 1024 / 1024;

  const burstsPerDay = Math.min(W.maxBurstsPerDay, Math.ceil(views / W.daysPerMonth / W.viewsPerBurst));
  const apiAwake = Math.min(744, (burstsPerDay * W.daysPerMonth * (W.burstMinutes + L.renderIdleSpinDownMin)) / 60);
  const renderHours = apiAwake + W.stagingAwakeHours;
  const dbAwake = Math.min(744, (burstsPerDay * W.daysPerMonth * (W.burstMinutes + L.neonSuspendMin)) / 60);
  const cuHours = dbAwake * L.neonCuWhenActive;
  const weatherCallsPerDay = (W.venues * 24 * 60) / W.weatherRefreshMinutes;
  const storageMBPerMonth = (weatherCallsPerDay * W.daysPerMonth * W.weatherSnapshotKB) / 1024 + (views * W.writesShareOfViews * 3 * 1) / 1024;

  const checks = [
    ["Render instance hours (staging + prod, shared 750)", renderHours, L.renderInstanceHours, "h"],
    ["Neon compute CU-hours (prod project)", cuHours, L.neonComputeCuHours, "CU-h"],
    ["Neon DB->API transfer", dbTransferGB, L.neonTransferGB, "GB"],
    ["Render bandwidth (static + API)", egressGB, L.renderBandwidthGB, "GB"],
    ["Neon storage after 12 months of snapshots", (storageMBPerMonth * 12) / 1024, L.neonStorageGB, "GB"],
    ["OpenWeather calls/day", weatherCallsPerDay, L.openWeatherCallsPerDay, "calls"],
  ];
  const broken = checks.filter(([, used, lim]) => used > lim).map(([n]) => n);

  console.log(`--- ${mult}x ---`);
  console.log(`page views/month        = ${f(W.pageViews1x)} x ${mult} = ${f(views)}`);
  console.log(`API requests/month      = ${f(views)} x ${W.apiCallsPerView} = ${f(apiReqs)}; peak ${f(peakReqPerSec, 3)} req/s, ~${f(peakSse, 1)} open SSE streams (one small Node instance handles hundreds: OK)`);
  console.log(`bursts/day              = min(${W.maxBurstsPerDay}, ceil(${f(views)} / ${W.daysPerMonth} days / ${W.viewsPerBurst} views per burst)) = ${burstsPerDay}`);
  console.log(`prod API awake hours    = min(744, ${burstsPerDay} x ${W.daysPerMonth} x (${W.burstMinutes}+${L.renderIdleSpinDownMin}) min / 60) = ${f(apiAwake, 0)}; + staging ${W.stagingAwakeHours} = ${f(renderHours, 0)} h`);
  console.log(`Neon prod awake hours   = min(744, ${burstsPerDay} x ${W.daysPerMonth} x (${W.burstMinutes}+${L.neonSuspendMin}) / 60) = ${f(dbAwake, 0)} h x ${L.neonCuWhenActive} CU = ${f(cuHours, 1)} CU-h`);
  for (const [name, used, lim, unit] of checks) console.log(`  ${used > lim ? "EXCEEDED" : "ok      "}  ${name}: ${f(used, 2)} / ${f(lim)} ${unit}`);

  const needApi = renderHours > L.renderInstanceHours;
  const needNeon = cuHours > L.neonComputeCuHours || dbTransferGB > L.neonTransferGB;
  const bwOver = Math.max(0, egressGB - L.renderBandwidthGB);
  const total = (needApi ? P.renderPaidInstance : 0) + (needNeon ? P.neonPaidPerMonth : 0) + bwOver * P.bandwidthPerGB + (mult >= 100 ? P.telemetryAt100x : 0) + P.domainIncremental;
  console.log(`TOTAL                   = ${needApi ? `$${f(P.renderPaidInstance)} paid API instance` : "$0 API (free)"} + ${needNeon ? `$${f(P.neonPaidPerMonth)} paid Neon` : "$0 Neon (free)"} + $${f(bwOver * P.bandwidthPerGB)} bandwidth + $${f(mult >= 100 ? P.telemetryAt100x : 0)} telemetry + $${f(P.domainIncremental)} domain (already owned) = $${f(total)}/month`);
  console.log(broken.length ? `FIRST THINGS TO BREAK ON FREE TIERS: ${broken.join("; ")}\n` : "Everything stays inside the free tiers.\n");
}
console.log("SCALING LIMIT: still ONE API instance per environment (in-process rate limits, weather cache and SSE bus).");
console.log("Past what one small instance serves you need a shared limiter/cache and pub/sub (LISTEN/NOTIFY or Redis); see docs/ARCHITECTURE.md.");

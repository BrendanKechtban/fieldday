// LOCAL DEV / TEST ONLY identity provider: serves a JWKS and mints RS256 access tokens that the API validates
// exactly like real ones (signature via JWKS, issuer, audience, expiry, scopes, roles). It is NOT a login service
// and has no browser flow: real sign-in (Authorization Code + PKCE) needs a real IdP such as Entra ID.
import http from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

export async function startDevIdp({ port = 0, audience = "api://fieldday-dev" } = {}) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "dev-1", alg: "RS256", use: "sig" };
  const server = http.createServer((req, res) => {
    if (req.url === "/jwks") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const actualPort = server.address().port;
  const issuer = `http://127.0.0.1:${actualPort}`;
  const mint = (o = {}) => new SignJWT({ roles: o.roles ?? [], scp: o.scp ?? "events.read" })
    .setProtectedHeader({ alg: "RS256", kid: "dev-1" }).setSubject(o.sub ?? "dev-user").setIssuer(issuer).setAudience(audience)
    .setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + (o.expSec ?? 3600)).sign(privateKey);
  return {
    issuer, audience, jwksUri: `${issuer}/jwks`, port: actualPort,
    coordinatorToken: (sub = "coordinator-demo") => mint({ sub, roles: ["coordinator"], scp: "events.read events.write" }),
    viewerToken: (sub = "viewer-demo") => mint({ sub, roles: ["viewer"], scp: "events.read" }),
    mint, close: () => new Promise((r) => server.close(r)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const idp = await startDevIdp({ port: Number(process.env.IDP_PORT ?? 9099) });
  console.log(`dev IdP on ${idp.issuer}\nexport OIDC_ISSUER=${idp.issuer} OIDC_AUDIENCE=${idp.audience} OIDC_JWKS_URI=${idp.jwksUri}`);
  console.log(`\nCOORDINATOR_TOKEN=${await idp.coordinatorToken()}\n\nVIEWER_TOKEN=${await idp.viewerToken()}\n(tokens expire in 1h; restart to rotate the signing key)`);
}

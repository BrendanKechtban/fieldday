import { describe, it, expect } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { verifyToken } from "../src/auth.js";

// Hand-predicted: the roles come ONLY from the configured claim. A plain "roles" claim must not grant anything when the
// deployment reads a namespaced claim, otherwise an attacker-influenced claim name could escalate privileges.
const issuer = "https://tenant.example/", audience = "https://api.example";
const ns = "https://fieldday.example/roles";

async function token(claims: Record<string, unknown>) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwt = await new SignJWT(claims).setProtectedHeader({ alg: "RS256" }).setSubject("auth0|u1")
    .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("1h").sign(privateKey);
  return { jwt, publicKey };
}

describe("configurable roles claim", () => {
  it("defaults to the `roles` claim (Entra)", async () => {
    const { jwt, publicKey } = await token({ roles: ["coordinator"], scp: "events.read" });
    expect((await verifyToken(jwt, { issuer, audience }, publicKey)).roles).toEqual(["coordinator"]);
  });
  it("reads a namespaced claim (Auth0) and ignores a plain `roles` claim", async () => {
    const { jwt, publicKey } = await token({ [ns]: ["viewer"], roles: ["coordinator"], scope: "openid events.read" });
    const actor = await verifyToken(jwt, { issuer, audience, rolesClaim: ns }, publicKey);
    expect(actor.roles).toEqual(["viewer"]);
    expect(actor.scopes).toEqual(["openid", "events.read"]);
  });
  it("yields no roles when the configured claim is missing or not an array", async () => {
    const a = await token({ scope: "events.read" });
    expect((await verifyToken(a.jwt, { issuer, audience, rolesClaim: ns }, a.publicKey)).roles).toEqual([]);
    const b = await token({ [ns]: "coordinator" });
    expect((await verifyToken(b.jwt, { issuer, audience, rolesClaim: ns }, b.publicKey)).roles).toEqual([]);
  });
});

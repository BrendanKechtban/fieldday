import { describe, it, expect, beforeEach, vi } from "vitest";
import { challengeFor, completeLogin, buildAuthorizeUrl, uiClaims, b64url } from "../src/auth";

const jwt = (payload: object) => `h.${btoa(JSON.stringify(payload)).replace(/=+$/, "")}.s`;
const tokenFetch = (idPayload: object, ok = true) => vi.fn(async () => ({ ok, status: ok ? 200 : 400, json: async () => ({ access_token: jwt({ sub: "u1", roles: ["coordinator"] }), id_token: jwt(idPayload), expires_in: 3600 }) })) as unknown as typeof fetch;

beforeEach(() => sessionStorage.clear());

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B S256 test vector", async () => {
    expect(await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("authorize URL carries S256 challenge, state and nonce, and stores secrets for the callback", async () => {
    const u = new URL(await buildAuthorizeUrl());
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("state")).toBe(sessionStorage.getItem("fd.pkce.state"));
    expect(u.searchParams.get("nonce")).toBe(sessionStorage.getItem("fd.pkce.nonce"));
    expect(u.searchParams.get("code_challenge")).toBe(await challengeFor(sessionStorage.getItem("fd.pkce.verifier")!));
    expect(u.searchParams.get("code_verifier")).toBeNull(); // verifier never leaves the browser until the token call
  });
  it("completes login: sends verifier, accepts matching state and nonce, clears secrets", async () => {
    const u = new URL(await buildAuthorizeUrl());
    const state = u.searchParams.get("state")!, nonce = u.searchParams.get("nonce")!, verifier = sessionStorage.getItem("fd.pkce.verifier")!;
    const f = tokenFetch({ nonce });
    const s = await completeLogin(`http://localhost/?code=abc&state=${state}`, f);
    expect(s?.accessToken).toBeTruthy();
    expect((f as any).mock.calls[0][1].body.get("code_verifier")).toBe(verifier);
    expect(sessionStorage.length).toBe(0);
  });
  it("rejects a state mismatch without calling the token endpoint", async () => {
    await buildAuthorizeUrl();
    const f = tokenFetch({ nonce: "x" });
    await expect(completeLogin("http://localhost/?code=abc&state=forged", f)).rejects.toThrow(/state mismatch/);
    expect(f).not.toHaveBeenCalled();
  });
  it("rejects a nonce mismatch", async () => {
    const u = new URL(await buildAuthorizeUrl());
    await expect(completeLogin(`http://localhost/?code=abc&state=${u.searchParams.get("state")}`, tokenFetch({ nonce: "replayed" }))).rejects.toThrow(/nonce mismatch/);
  });
  it("returns null when the URL is not a callback", async () => { expect(await completeLogin("http://localhost/#/events/1")).toBeNull(); });
  it("b64url is URL-safe", () => { expect(b64url(new Uint8Array([251, 255, 254]))).toBe("-__-"); });
});

describe("uiClaims (UI hints only)", () => {
  it("reads roles; tolerates garbage", () => {
    expect(uiClaims(jwt({ sub: "a", roles: ["coordinator", 5] })).roles).toEqual(["coordinator"]);
    expect(uiClaims("not-a-jwt").roles).toEqual([]);
    expect(uiClaims(null).roles).toEqual([]);
  });
});

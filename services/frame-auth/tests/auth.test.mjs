import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../dist/app.js";
import { SessionSigner } from "../dist/session.js";

test("protected requests redirect to login and one session unlocks multiple panels", async () => {
  const signer = new SessionSigner("01234567890123456789012345678901", 604800);
  const app = createApp({
    portal: { username: "frame", password: "secret" },
    streams: { username: "streams", password: "streams-secret" },
    overlays: { username: "", password: "" },
    sessionSigner: signer,
    sessionDays: 7,
  });
  const server = app.listen(0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const denied = await fetch(`${base}/auth/check`, {
      redirect: "manual",
      headers: {
        "x-forwarded-host": "frame.example.test",
        "x-forwarded-proto": "https",
        "x-forwarded-uri": "/today/remote",
      },
    });
    assert.equal(denied.status, 302);
    assert.equal(denied.headers.get("location"), "https://frame.example.test/auth/login?return_to=%2Ftoday%2Fremote");

    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-proto": "https" },
      body: "username=frame&password=secret&return_to=%2Ftoday%2Fremote",
    });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get("location"), "/today/remote");
    const cookie = login.headers.get("set-cookie");
    assert.ok(cookie?.includes("Max-Age=604800"));
    assert.ok(cookie?.includes("HttpOnly"));
    assert.ok(cookie?.includes("Secure"));

    const portal = await fetch(`${base}/auth/check`, {
      headers: { cookie: cookie || "", "x-forwarded-uri": "/today/remote" },
    });
    assert.equal(portal.status, 200);
    assert.equal(portal.headers.get("authorization"), `Basic ${Buffer.from("frame:secret").toString("base64")}`);

    const streams = await fetch(`${base}/auth/check`, {
      headers: { cookie: cookie || "", "x-forwarded-uri": "/slsui" },
    });
    assert.equal(streams.status, 200);
    assert.equal(streams.headers.get("authorization"), `Basic ${Buffer.from("streams:streams-secret").toString("base64")}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("unconfigured installs pass through without a login wall", async () => {
  const app = createApp({
    portal: { username: "", password: "" },
    streams: { username: "", password: "" },
    overlays: { username: "", password: "" },
    sessionSigner: new SessionSigner("01234567890123456789012345678901", 604800),
    sessionDays: 7,
  });
  const server = app.listen(0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/auth/check`)).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

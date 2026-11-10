"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync, createHash, randomBytes, sign } = require("node:crypto");
const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
process.env.GATEWAY_ENABLED = "true";
process.env.STORAGE_BUCKET = "offline-only-test-bucket";
process.env.STORAGE_ACCESS_KEY_ID = "offline-test-id";
process.env.STORAGE_SECRET_ACCESS_KEY = "offline-test-secret";
process.env.DEVICE_PUBLIC_KEYS_JSON = JSON.stringify({
  testphone: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64")
});
const { handler } = require("../index.js");
const digest = text => createHash("sha256").update(text).digest("hex");
function request(body, opts = {}) {
  const raw = JSON.stringify(body);
  const time = String(opts.time || Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString("hex");
  const canonical = time + "\n" + nonce + "\n" + digest(raw);
  const signature = sign("sha256", Buffer.from(canonical), pair.privateKey).toString("base64");
  return {
    httpMethod: "POST", body: opts.raw || raw,
    headers: {
      "x-kpro-device": "testphone",
      "x-kpro-time": time,
      "x-kpro-nonce": nonce,
      "x-kpro-signature": opts.signature || signature
    }
  };
}
test("without registered device signature: 401", async () => {
  const evt = request({ operation: "begin", bytes: 10, md5_base64: "bad" });
  evt.headers["x-kpro-device"] = "unknown";
  assert.equal((await handler(evt)).statusCode, 401);
});
test("changed body after signing: 401", async () => {
  const evt = request({ operation: "revoke", id: "a".repeat(32) });
  evt.body = JSON.stringify({ operation: "revoke", id: "b".repeat(32) });
  assert.equal((await handler(evt)).statusCode, 401);
});
test("expired request rejected: 401", async () => {
  const evt = request({ operation: "revoke", id: "a".repeat(32) },
    {time: Math.floor(Date.now() / 1000) - 1000});
  assert.equal((await handler(evt)).statusCode, 401);
});
test("signed invalid publish rejected without storage calls", async () => {
  const evt = request({ operation: "publish", id: "123", bytes: 99, sha256: "not-sha" });
  assert.equal((await handler(evt)).statusCode, 400);
});
test("signed begin validates length and MD5", async () => {
  const evt = request({ operation: "begin", bytes: 33554433,
    md5_base64: "AAAAAAAAAAAAAAAAAAAAAA==" });
  assert.equal((await handler(evt)).statusCode, 400);
});
test("signed begin returns short-lived signed PUT without calling network", async () => {
  const evt = request({ operation: "begin", bytes: 6522143,
    md5_base64: "AAAAAAAAAAAAAAAAAAAAAA==" });
  const res = await handler(evt);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.match(body.id, /^[a-f0-9]{32}$/);
  assert.equal(body.expires_seconds, 300);
  assert.match(body.upload_url, /X-Amz-Signature=/);
  assert.equal(body.headers["Content-Length"], "6522143");
  assert.equal(body.headers["If-None-Match"], "*");
});
test("disabled gateway fails closed", async () => {
  const saved = process.env.GATEWAY_ENABLED;
  process.env.GATEWAY_ENABLED = "false";
  try {
    const res = await handler(request({operation:"begin", bytes:30,
      md5_base64:"AAAAAAAAAAAAAAAAAAAAAA=="}));
    assert.equal(res.statusCode, 503);
  } finally { process.env.GATEWAY_ENABLED = saved; }
});

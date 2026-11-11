"use strict";
// Execute the EXACT auth() from the checked-out PR, without S3 clients/dependencies/network.
// Only synthetic, ephemeral JVM test key material arrives on stdin. Never print it.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const {createHash, createPublicKey, verify} = require("node:crypto");
try {
  const fixture = JSON.parse(fs.readFileSync(0, "utf8"));
  const source = fs.readFileSync(path.resolve(__dirname, "../../simple-gateway/index.js"), "utf8");
  const start = source.indexOf("function auth(event,raw,keys){");
  const end = source.indexOf("\nfunction adapter(s3){", start);
  assert(start >= 0 && end > start);
  const sandbox = {
    Buffer, createPublicKey, verify,
    sha: b => createHash("sha256").update(b).digest("hex"),
    Date: {now: () => fixture.time * 1000}
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end) + "\nthis.authenticate=auth;", sandbox, {timeout: 1000});
  const event = {headers: fixture.headers};
  const device = fixture.headers["x-kpro-device"];
  const keys = {[device]: fixture.publicKey};
  assert(sandbox.authenticate(event, fixture.body, keys));
  assert.equal(sandbox.authenticate(event, fixture.body + " ", keys), null);
  assert.equal(sandbox.authenticate({...event, headers: {...event.headers, "x-kpro-nonce": "f".repeat(32)}}, fixture.body, keys), null);
  sandbox.Date.now = () => (fixture.time + 91) * 1000;
  assert.equal(sandbox.authenticate(event, fixture.body, keys), null);
} catch (_) {
  // Error objects can embed assertion operands. Print no material, even on failure.
  process.stderr.write("Protocol interoperability check failed\n");
  process.exitCode = 1;
}

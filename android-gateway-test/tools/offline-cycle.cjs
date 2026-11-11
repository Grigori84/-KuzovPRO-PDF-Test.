"use strict";
// Local stdin/stdout test bridge. No sockets, fetch, S3 SDK, credentials or cloud access.
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const {createHash, createPublicKey, verify} = require("node:crypto");
const {PDFDocument} = require(path.resolve(__dirname, "../../simple-gateway/node_modules/pdf-lib"));
const {makeWorkflow, FlowError} = require(path.resolve(__dirname, "../../simple-gateway/workflow.js"));
const hash = b => createHash("sha256").update(b).digest("hex");
const source = fs.readFileSync(path.resolve(__dirname, "../../simple-gateway/index.js"), "utf8");
const start = source.indexOf("function auth(event,raw,keys){"), end = source.indexOf("\nfunction adapter(s3){", start);
if (start < 0 || end < start) process.exit(2);
const sandbox = {Buffer, Date, createPublicKey, verify, sha: hash};
vm.createContext(sandbox);
vm.runInContext(source.slice(start, end) + "\nthis.authenticate=auth;", sandbox, {timeout: 1000});
let keys = {}, revision = 0, lostPublish = false;
const records = new Map(), staging = new Map(), published = new Map(), nonces = new Set();
const operations = [];
const store = {
  async putState(id, value, cond) {
    const old = records.get(id);
    if ((cond.ifNoneMatch && old) || (cond.ifMatch && old?.etag !== cond.ifMatch)) throw new FlowError(409, "PRECONDITION_FAILED");
    const record = {value: structuredClone(value), etag: String(++revision)};
    records.set(id, record); return structuredClone(record);
  },
  async getState(id) { return records.has(id) ? structuredClone(records.get(id)) : null; },
  async signUpload(id, bytes, md5) {
    return {upload_url: "https://storage.yandexcloud.net/offline-private/staging/" + id + ".pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=" + "a".repeat(64) + "&X-Amz-Expires=300&X-Amz-SignedHeaders=content-length%3Bcontent-md5%3Bcontent-type%3Bhost%3Bif-none-match",
      headers: {"Content-Type":"application/pdf", "Content-Length":String(bytes), "Content-MD5":md5, "If-None-Match":"*"}, expires_seconds:300};
  },
  async readStaging(id) { return staging.has(id) ? {bytes:staging.get(id),contentType:"application/pdf"} : null; },
  async sha256(bytes) { return hash(bytes); },
  async parsePdf(bytes) { try { return (await PDFDocument.load(bytes)).getPageCount() === 1; } catch (_) { return false; } },
  async putPublishedOnce(id, bytes) { if (published.has(id)) throw new FlowError(409,"PRECONDITION_FAILED"); published.set(id, Buffer.from(bytes)); },
  async headPublished(id) { const bytes = published.get(id); return bytes ? {bytes:bytes.length,sha256:hash(bytes)} : null; },
  async removePublished(id) { published.delete(id); },
  async removeStaging(id) { staging.delete(id); }
};
const flow = makeWorkflow(store, {viewerUrl:"https://grigori84.github.io/-KuzovPRO-PDF-Test./client.html", newId:() => "a".repeat(32)});
async function command(input) {
  if (input.type === "init") { keys = {[input.device]:input.publicKey}; return {ok:true}; }
  if (input.type === "drop-publish") { lostPublish = true; return {ok:true}; }
  if (input.type === "stats") return {operations};
  if (input.type === "post") {
    const auth = sandbox.authenticate({headers:input.headers}, input.body, keys);
    if (!auth) return {status:401,error:"UNAUTHORIZED"};
    if (nonces.has(auth.nonce)) return {status:409,error:"REPLAYED_REQUEST"};
    nonces.add(auth.nonce);
    const body = JSON.parse(input.body);
    operations.push(body.operation);
    try {
      const result = await flow[body.operation](body, auth.device);
      if (body.operation === "publish" && lostPublish) { lostPublish = false; return {lost:true}; }
      return {status:200,...result};
    } catch (e) { return {status:e instanceof FlowError?e.status:503, error:e instanceof FlowError?e.code:"OFFLINE_FAILURE"}; }
  }
  if (input.type === "put") {
    operations.push("PUT");
    if (staging.has(input.id)) return {status:412,md5:false};
    const bytes = Buffer.from(input.bytes,"base64"), record = records.get(input.id)?.value;
    if (!record || bytes.length !== record.bytes || createHash("md5").update(bytes).digest("base64") !== record.md5_base64) return {status:400,md5:false};
    staging.set(input.id,bytes); return {status:200,md5:true};
  }
  if (input.type === "check") {
    const bytes = published.get(input.id);
    return bytes ? {status:200,sha256:hash(bytes),bytes:bytes.length} : {status:404};
  }
  return {error:"OFFLINE_UNKNOWN_COMMAND"};
}
let queue = Promise.resolve();
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  queue = queue.then(async () => {
    try { process.stdout.write(JSON.stringify(await command(JSON.parse(line))) + "\n"); }
    catch (_) { process.stdout.write('{"error":"OFFLINE_BRIDGE_FAILURE"}\n'); }
  });
});

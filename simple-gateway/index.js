"use strict";
// KuzovPRO: TWO EXISTING buckets / ONE Cloud Function. DRAFT: not deployable for real data.
// Staging bucket MUST remain entirely private; published bucket is already public-read.
// STOP: publication/revocation concurrency is NOT yet safe; see README before deployment.
const { createHash, createPublicKey, randomBytes, verify } = require("node:crypto");
const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand,
        CopyObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const MAX = 10 * 1024 * 1024;
const STAGING_BUCKET = process.env.STAGING_BUCKET;
const PUBLIC_BUCKET = process.env.PUBLIC_BUCKET;
const VIEWER = process.env.VIEWER_URL ||
  "https://grigori84.github.io/-KuzovPRO-PDF-Test./client.html";
const ID_RE = /^[a-f0-9]{32}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const MD5_RE = /^[A-Za-z0-9+/]{22}==$/;
const response = (statusCode, obj) => ({
  statusCode, isBase64Encoded: false,
  headers: { "Content-Type": "application/json; charset=utf-8",
             "Cache-Control": "no-store" },
  body: JSON.stringify(obj)
});
const digest = s => createHash("sha256").update(s).digest("hex");
const publicUrl = id => VIEWER + "#id=" + id;
const isMissing = e => e?.name === "NotFound" ||
  e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;

function config() {
  if (process.env.GATEWAY_ENABLED !== "true") throw Error("GATEWAY_DISABLED");
  if (!STAGING_BUCKET || !PUBLIC_BUCKET || STAGING_BUCKET === PUBLIC_BUCKET ||
      !process.env.STORAGE_ACCESS_KEY_ID ||
      !process.env.STORAGE_SECRET_ACCESS_KEY ||
      !process.env.DEVICE_PUBLIC_KEYS_JSON) {
    throw Error("SERVER_NOT_CONFIGURED");
  }
  const devices = JSON.parse(process.env.DEVICE_PUBLIC_KEYS_JSON);
  if (!devices || typeof devices !== "object" || Array.isArray(devices) ||
      !Object.keys(devices).length) throw Error("DEVICE_KEYS_NOT_CONFIGURED");
  return devices;
}
function s3Client() {
  return new S3Client({
    region: "ru-central1", endpoint: "https://storage.yandexcloud.net",
    forcePathStyle: true,
    credentials: { accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
                   secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY }
  });
}
function validAuth(event, raw, devices) {
  const h = Object.fromEntries(Object.entries(event.headers || {})
    .map(([k, v]) => [k.toLowerCase(), String(v)]));
  const device = h["x-kpro-device"];
  const time = h["x-kpro-time"];
  const nonce = h["x-kpro-nonce"];
  const signature = h["x-kpro-signature"];
  if (!device || !Object.hasOwn(devices, device) ||
      !/^\d{10}$/.test(time || "") ||
      !/^[a-f0-9]{32}$/.test(nonce || "") ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(signature || "") ||
      Math.abs(Date.now() / 1000 - Number(time)) > 90) return false;
  try {
    const der = Buffer.from(devices[device], "base64");
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec" ||
        key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return false;
    const message = time + "\n" + nonce + "\n" + digest(raw);
    return verify("sha256", Buffer.from(message), key,
      Buffer.from(signature, "base64"));
  } catch (_) { return false; }
}
async function head(s3, bucket, key) {
  try { return await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); }
  catch (e) { if (isMissing(e)) return null; throw e; }
}
async function begin(s3, body) {
  const length = body.bytes, md5 = body.md5_base64;
  if (!Number.isSafeInteger(length) || length < 10 || length > MAX ||
      typeof md5 !== "string" || !MD5_RE.test(md5) ||
      Buffer.from(md5, "base64").length !== 16) {
    return response(400, { error: "INVALID_FILE_INFO" });
  }
  const id = randomBytes(16).toString("hex");
  const key = "staging/" + id + ".pdf";
  const headers = { "Content-Type": "application/pdf", "Content-MD5": md5,
                    "Content-Length": String(length), "If-None-Match": "*" };
  const put = new PutObjectCommand({
    Bucket: STAGING_BUCKET, Key: key, ContentType: "application/pdf",
    ContentMD5: md5, ContentLength: length, IfNoneMatch: "*"
  });
  // The mobile client must send all four exact headers; verify the actual
  // SignedHeaders with Yandex in integration tests before enabling uploads.
  const url = await getSignedUrl(s3, put, {
    expiresIn: 300,
    signableHeaders: new Set(["content-type", "content-md5",
                             "content-length", "if-none-match"])
  });
  return response(200, { id, upload_url: url, headers, expires_seconds: 300 });
}
async function readAndCheck(s3, key, headInfo, length, sha) {
  if (headInfo.ContentLength !== length ||
      headInfo.ContentType !== "application/pdf" || !headInfo.ETag) {
    return false;
  }
  const got = await s3.send(new GetObjectCommand({
    Bucket: STAGING_BUCKET, Key: key, IfMatch: headInfo.ETag
  }));
  const hash = createHash("sha256");
  let count = 0, prefix = Buffer.alloc(0), tail = Buffer.alloc(0);
  for await (const block of got.Body) {
    count += block.length;
    if (count > MAX || count > length) {
      got.Body.destroy?.();
      return false;
    }
    hash.update(block);
    if (prefix.length < 5) prefix = Buffer.concat([prefix, block]).subarray(0, 5);
    tail = Buffer.concat([tail, block]).subarray(-1024);
  }
  return count === length && prefix.toString("ascii") === "%PDF-" &&
    /%%EOF\s*$/.test(tail.toString("latin1")) && hash.digest("hex") === sha;
}
async function publish(s3, body) {
  const id = body.id, sha = body.sha256, length = body.bytes;
  if (typeof id !== "string" || !ID_RE.test(id) ||
      typeof sha !== "string" || !SHA_RE.test(sha) ||
      !Number.isSafeInteger(length) || length < 10 || length > MAX) {
    return response(400, { error: "INVALID_PUBLISH_REQUEST" });
  }
  const from = "staging/" + id + ".pdf", to = "estimates/" + id + ".pdf";
  const existing = await head(s3, PUBLIC_BUCKET, to);
  if (existing) {
    // A retry after a successful publication returns the same immutable URL.
    return existing.ContentLength === length && existing.Metadata?.sha256 === sha
      ? response(200, { id, url: publicUrl(id), already_published: true })
      : response(409, { error: "PUBLICATION_CONFLICT" });
  }
  const info = await head(s3, STAGING_BUCKET, from);
  if (!info) return response(404, { error: "UPLOAD_NOT_FOUND" });
  if (!(await readAndCheck(s3, from, info, length, sha))) {
    return response(422, { error: "PDF_VERIFICATION_FAILED" });
  }
  // Copy only the source version that was validated; ETag isn't used as SHA-256.
  await s3.send(new CopyObjectCommand({
    Bucket: PUBLIC_BUCKET, Key: to,
    CopySource: STAGING_BUCKET + "/" + from,
    CopySourceIfMatch: info.ETag,
    ContentType: "application/pdf", CacheControl: "no-store, max-age=0",
    MetadataDirective: "REPLACE",
    Metadata: { sha256: sha }
  }));
  const final = await head(s3, PUBLIC_BUCKET, to);
  if (!final || final.ContentLength !== length || final.Metadata?.sha256 !== sha) {
    return response(503, { error: "PUBLICATION_UNCONFIRMED" });
  }
  await s3.send(new DeleteObjectCommand({ Bucket: STAGING_BUCKET, Key: from }));
  return response(200, { id, url: publicUrl(id), already_published: false });
}
async function revoke(s3, body) {
  const id = body.id;
  if (typeof id !== "string" || !ID_RE.test(id))
    return response(400, { error: "INVALID_ID" });
  await s3.send(new DeleteObjectCommand({
    Bucket: PUBLIC_BUCKET, Key: "estimates/" + id + ".pdf"
  }));
  await s3.send(new DeleteObjectCommand({
    Bucket: STAGING_BUCKET, Key: "staging/" + id + ".pdf"
  }));
  if (await head(s3, PUBLIC_BUCKET, "estimates/" + id + ".pdf")) {
    return response(503, { error: "REVOCATION_UNCONFIRMED" });
  }
  return response(200, { id, revoked: true });
}
module.exports.handler = async event => {
  const method = (event?.httpMethod || event?.requestContext?.http?.method || "")
    .toUpperCase();
  if (method !== "POST") return response(405, { error: "METHOD_NOT_ALLOWED" });
  const raw = event?.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (typeof event?.body === "string" ? event.body : "");
  if (Buffer.byteLength(raw, "utf8") > 4096)
    return response(413, { error: "REQUEST_TOO_LARGE" });
  try {
    const devices = config();
    if (!validAuth(event, raw, devices))
      return response(401, { error: "UNAUTHORIZED" });
    let body;
    try { body = JSON.parse(raw); }
    catch (_) { return response(400, { error: "INVALID_JSON" }); }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return response(400, { error: "INVALID_JSON" });
    const s3 = s3Client();
    if (body.operation === "begin") return await begin(s3, body);
    // Work audit: no publish/revoke until replay, revoke and destination
    // immutability protections are demonstrated in integration tests.
    if (body.operation === "publish" || body.operation === "revoke")
      return response(501, { error: "PUBLICATION_NOT_ENABLED" });
    return response(400, { error: "UNKNOWN_OPERATION" });
  } catch (e) {
    // Never log signed upload URLs, request bodies, credentials, or client data.
    console.error("pdf_gateway_failure", e?.name || "Error");
    return response(503, { error: "GATEWAY_UNAVAILABLE" });
  }
};

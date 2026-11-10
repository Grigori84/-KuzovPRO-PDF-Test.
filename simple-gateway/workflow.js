"use strict";

// Pure state machine for publication/revocation. Storage operations are injected.
// No PDF is exposed until SHA-256 and PDF parsing have succeeded.
// A permanently retained control/<id>.json CAS record prevents a revoked ID
// from being published again. The publishing phase blocks concurrent revoke.
// If a process dies while publishing, fail closed and require recovery, never
// assume publication or revocation succeeded.
const ID = /^[0-9a-f]{32}$/;
const SHA = /^[0-9a-f]{64}$/;
const MD5 = /^[A-Za-z0-9+/]{22}==$/;
const MAX = 10 * 1024 * 1024;

class FlowError extends Error {
  constructor(status, code) {
    super(code); this.status = status; this.code = code;
  }
}
const fail = (status, code) => { throw new FlowError(status, code); };
const conflict = e => e && (e.code === "PRECONDITION_FAILED" ||
  e.name === "PreconditionFailed" || e.$metadata?.httpStatusCode === 412 ||
  e.$metadata?.httpStatusCode === 409);

function makeWorkflow(store, {viewerUrl, newId, now = () => Date.now()} = {}) {
  if (typeof viewerUrl !== "string" || !viewerUrl.startsWith("https://") ||
      typeof newId !== "function") throw Error("INVALID_WORKFLOW_CONFIG");
  const view = id => viewerUrl + "#id=" + id;
  const same = (actual, bytes, sha) =>
    actual && actual.bytes === bytes && actual.sha256 === sha;

  async function transition(id, previous, record) {
    try {
      return await store.putState(id, record, {ifMatch: previous.etag});
    } catch (e) {
      if (conflict(e)) fail(409, "STATE_CHANGED_RETRY");
      throw e;
    }
  }
  async function begin({bytes, md5_base64}, device) {
    if (!Number.isSafeInteger(bytes) || bytes < 20 || bytes > MAX ||
        typeof md5_base64 !== "string" || !MD5.test(md5_base64))
      fail(400, "INVALID_FILE_INFO");
    if (typeof device !== "string" || !device) fail(401, "INVALID_DEVICE");
    const id = newId();
    if (!ID.test(id)) throw Error("INVALID_RANDOM_ID");
    const control = {v:1,device,phase:"issued",bytes,md5_base64,
                     created_at:now()};
    try {
      await store.putState(id, control, {ifNoneMatch:"*"});
    } catch (e) {
      if (conflict(e)) fail(503, "ID_COLLISION_RETRY");
      throw e;
    }
    const signed = await store.signUpload(id, bytes, md5_base64);
    return {id, ...signed};
  }
  async function checkedState(id, device) {
    if (typeof id !== "string" || !ID.test(id)) fail(400, "INVALID_ID");
    const state = await store.getState(id);
    if (!state) fail(404, "UNKNOWN_PUBLICATION_ID");
    if (state.value?.v !== 1 || state.value.device !== device)
      fail(403, "PUBLICATION_ACCESS_DENIED");
    return state;
  }
  async function publish({id, bytes, sha256}, device) {
    if (typeof id !== "string" || !ID.test(id) ||
        !Number.isSafeInteger(bytes) || bytes < 20 || bytes > MAX ||
        typeof sha256 !== "string" || !SHA.test(sha256))
      fail(400, "INVALID_PUBLISH_REQUEST");
    const state = await checkedState(id,device);
    const record = state.value;
    if (record.bytes !== bytes) fail(409, "SIZE_DOES_NOT_MATCH_TICKET");
    if (record.phase === "revoking" || record.phase === "revoked")
      fail(410, "PUBLICATION_REVOKED");
    if (record.phase === "published") {
      if (record.sha256 !== sha256) fail(409, "CONTENT_ALREADY_PUBLISHED");
      const obj = await store.headPublished(id);
      if (!same(obj, bytes, sha256)) fail(410, "PUBLISHED_OBJECT_UNAVAILABLE");
      return {id,url:view(id),already_published:true};
    }
    if (record.phase === "publishing") {
      // A timed-out writer may still be in flight. Do not finalize or revoke
      // based on HEAD alone: an SDK retry after deletion could resurrect it.
      fail(409, "PUBLICATION_IN_PROGRESS");
    }
    if (record.phase !== "issued") fail(409, "UNEXPECTED_STATE");
    const file = await store.readStaging(id, MAX);
    if (!file) fail(404, "UPLOADED_PDF_MISSING");
    if (file.bytes.length !== bytes || file.contentType !== "application/pdf")
      fail(422, "UPLOADED_FILE_MISMATCH");
    const digest = await store.sha256(file.bytes);
    if (digest !== sha256) fail(422, "HASH_MISMATCH");
    if (!(await store.parsePdf(file.bytes))) fail(422, "INVALID_PDF");

    // The only writer must win an atomic CAS before any public write.
    const writing = {...record,phase:"publishing",sha256,started_at:now()};
    const acquired = await transition(id,state,writing);
    try {
      await store.putPublishedOnce(id,file.bytes,sha256);
    } catch (e) {
      if (!conflict(e)) throw e; // In-flight timeout: state stays publishing.
      const obj = await store.headPublished(id);
      if (!same(obj,bytes,sha256)) fail(409, "PUBLISHED_OBJECT_CONFLICT");
    }
    const obj = await store.headPublished(id);
    if (!same(obj,bytes,sha256)) fail(503, "PUBLICATION_UNCONFIRMED");
    await transition(id,acquired,{...writing,phase:"published",published_at:now()});
    // Cleanup is best effort: staging Lifecycle already runs independently.
    try { await store.removeStaging(id); } catch (_) {}
    return {id,url:view(id),already_published:false};
  }

  async function revoke({id}, device) {
    const state = await checkedState(id,device);
    const record = state.value;
    if (record.phase === "publishing")
      fail(409, "PUBLISHING_IN_PROGRESS_RETRY");
    if (record.phase !== "issued" && record.phase !== "published" &&
        record.phase !== "revoking" && record.phase !== "revoked")
      fail(409, "UNEXPECTED_STATE");
    if (record.phase !== "revoked" && record.phase !== "revoking") {
      await transition(id,state,{...record,phase:"revoking",revoked_requested_at:now()});
    }
    // Never remove the control record: it is a persistent tombstone.
    await store.removePublished(id);
    await store.removeStaging(id);
    if (await store.headPublished(id)) fail(503, "REVOCATION_UNCONFIRMED");
    if (record.phase !== "revoked") {
      const latest = await store.getState(id);
      if (latest?.value?.phase === "revoking")
        await transition(id, latest, {...latest.value,phase:"revoked",revoked_at:now()});
      else if (latest?.value?.phase !== "revoked")
        fail(503,"REVOCATION_STATE_UNCONFIRMED");
    }
    return {id,revoked:true};
  }
  return {begin,publish,revoke};
}

module.exports = { makeWorkflow, FlowError, MAX };


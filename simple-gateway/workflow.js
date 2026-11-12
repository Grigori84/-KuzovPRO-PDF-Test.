"use strict";

// One function / two existing buckets. Public writes use a single-use multipart
// upload ID: abort consumes the writer's authority, including delayed requests.
// No timeout/age-based lock stealing, and no deletion of control/request records.
const ID = /^[0-9a-f]{32}$/;
const SHA = /^[0-9a-f]{64}$/;
const MD5 = /^[A-Za-z0-9+/]{22}==$/;
const MAX = 10 * 1024 * 1024;
const isId = value => typeof value === "string" && ID.test(value);
const isSha = value => typeof value === "string" && SHA.test(value);
const PHASES = new Set(["issued", "publishing", "published", "revoking", "revoked"]);

class FlowError extends Error {
  constructor(status, code, details = {}) { super(code); this.status = status; this.code = code; this.details = details; }
}
const fail = (status, code, details) => { throw new FlowError(status, code, details); };
const conflict = e => e && (e.code === "PRECONDITION_FAILED" ||
  e.name === "PreconditionFailed" || e.$metadata?.httpStatusCode === 412 ||
  e.$metadata?.httpStatusCode === 409);
const noUpload = e => e?.name === "NoSuchUpload" || e?.code === "NoSuchUpload";

function makeWorkflow(store, {viewerUrl, newId, now = Date.now,
  legacyWritesDrained = false} = {}) {
  if (typeof viewerUrl !== "string" || !viewerUrl.startsWith("https://") ||
      typeof newId !== "function") throw Error("INVALID_WORKFLOW_CONFIG");
  const view = id => viewerUrl + "#id=" + id;
  const same = (obj, record) => obj && obj.bytes === record.bytes && obj.sha256 === record.sha256;
  const owned = (obj, record) => record.writer
    ? obj?.token === record.writer.token
    : record.legacy_drained === true && same(obj, record);
  const randomId = () => {
    const id = newId();
    if (!isId(id)) throw Error("INVALID_RANDOM_ID");
    return id;
  };
  async function transition(id, previous, value) {
    if (!previous?.etag) fail(503, "CONTROL_ETAG_MISSING");
    try { return await store.putState(id, value, {ifMatch: previous.etag}); }
    catch (e) { if (conflict(e)) fail(409, "STATE_CHANGED_RETRY"); throw e; }
  }
  async function checkedState(id, device) {
    if (typeof id !== "string" || !isId(id)) fail(400, "INVALID_ID");
    const state = await store.getState(id);
    if (!state) fail(404, "UNKNOWN_PUBLICATION_ID");
    const r = state.value;
    if (![1, 2].includes(r?.v) || r.device !== device) fail(403, "PUBLICATION_ACCESS_DENIED");
    if (!state.etag || !PHASES.has(r.phase) || !Number.isSafeInteger(r.bytes) ||
        r.bytes < 20 || r.bytes > MAX || !MD5.test(r.md5_base64 || "") ||
        !Number.isSafeInteger(r.created_at) || r.created_at < 0 ||
        (r.sha256 !== undefined && !isSha(r.sha256)) ||
        (r.expected_sha256 !== undefined && !isSha(r.expected_sha256)) ||
        (r.writer && (!isId(r.writer.token) ||
          typeof r.writer.upload_id !== "string" || !r.writer.upload_id || r.writer.upload_id.length > 1024)))
      fail(503, "CONTROL_RECORD_INVALID");
    if (r.v === 2 && r.phase === "publishing" && (!r.writer || !r.sha256))
      fail(503, "CONTROL_RECORD_INVALID");
    return state;
  }

  async function begin(body, device) {
    const {bytes, md5_base64, request_id, sha256} = body;
    if (!Number.isSafeInteger(bytes) || bytes < 20 || bytes > MAX ||
        typeof md5_base64 !== "string" || !MD5.test(md5_base64)) fail(400, "INVALID_FILE_INFO");
    if (typeof device !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(device)) fail(401, "INVALID_DEVICE");
    const keyed = request_id !== undefined || sha256 !== undefined || body.operation === "begin_v2";
    if (keyed && (!isId(request_id) || !isSha(sha256)))
      fail(400, "INVALID_BEGIN_REQUEST");
    let id, createdAt = now();
    if (keyed) {
      let entry = await store.getBegin(device, request_id);
      if (!entry) {
        const value = {v:1, device, request_id, id:randomId(), bytes, md5_base64, sha256, created_at:createdAt};
        try { entry = await store.putBegin(device, request_id, value); }
        catch (e) {
          // A lost CAS response may already have committed the mapping. Never
          // create control state for the losing candidate ID.
          entry = await store.getBegin(device, request_id);
          if (!entry) throw e;
        }
      }
      const r = entry.value;
      if (r?.v !== 1 || r.device !== device || r.request_id !== request_id ||
          r.bytes !== bytes || r.md5_base64 !== md5_base64 || r.sha256 !== sha256)
        fail(409, "BEGIN_REQUEST_CONFLICT");
      if (!isId(r.id) || !Number.isSafeInteger(r.created_at)) fail(503, "BEGIN_RECORD_INVALID");
      id = r.id; createdAt = r.created_at;
    } else id = randomId(); // Installed 1.1.1 wire format remains supported.
    const value = {v:2, device, phase:"issued", bytes, md5_base64, created_at:createdAt,
      ...(keyed ? {request_id, expected_sha256:sha256} : {})};
    let state;
    try { state = await store.putState(id, value, {ifNoneMatch:"*"}); }
    catch (e) {
      if (!keyed) { if (conflict(e)) fail(503, "ID_COLLISION_RETRY"); throw e; }
      state = await checkedState(id, device);
      const r = state.value;
      if (r.request_id !== request_id || r.bytes !== bytes || r.md5_base64 !== md5_base64 ||
          r.expected_sha256 !== sha256) fail(409, "BEGIN_REQUEST_CONFLICT");
    }
    if (state.value.phase === "revoked") fail(410, "PUBLICATION_REVOKED", {id, ...(keyed ? {request_id} : {}), revoked:true});
    if (state.value.phase === "revoking") fail(409, "REVOCATION_IN_PROGRESS");
    return {id, ...(await store.signUpload(id, bytes, md5_base64)), ...(keyed ? {request_id} : {})};
  }

  async function migrateLegacy(id, state) {
    if (state.value.v === 2) return state;
    // A v1 raw PUT cannot be fenced retrospectively. This is a trusted deployment
    // assertion, never a client parameter or an elapsed-time heuristic.
    if (!legacyWritesDrained) fail(409, "LEGACY_WRITERS_NOT_DRAINED");
    const record = state.value;
    const obj = await store.headPublished(id);
    if (obj && !same(obj, record)) fail(409, "PUBLISHED_OBJECT_CONFLICT");
    const phase = record.phase === "publishing" ? (obj ? "published" : "issued") : record.phase;
    return transition(id, state, {...record, v:2, phase, legacy_drained:true,
      ...(record.sha256 ? {expected_sha256:record.sha256} : {})});
  }
  async function validatedStaging(id, record) {
    const file = await store.readStaging(id, MAX);
    if (!file) fail(404, "UPLOADED_PDF_MISSING");
    if (file.bytes.length !== record.bytes || file.contentType !== "application/pdf")
      fail(422, "UPLOADED_FILE_MISMATCH");
    if (await store.sha256(file.bytes) !== record.sha256) fail(422, "HASH_MISMATCH");
    if (!(await store.parsePdf(file.bytes))) fail(422, "INVALID_PDF");
    return file;
  }
  async function finish(id, state, alreadyPublished) {
    const obj = await store.headPublished(id);
    if (!same(obj, state.value) || !owned(obj, state.value)) fail(503, "PUBLICATION_UNCONFIRMED");
    await transition(id, state, {...state.value, phase:"published", published_at:now()});
    try { await store.removeStaging(id); } catch (_) {} // Private staging Lifecycle is independent.
    return {id, url:view(id), already_published:alreadyPublished};
  }
  async function fence(id, writer) {
    if (writer && !(await store.abortPublication(id, writer.upload_id))) fail(503, "UPLOAD_ABORT_UNCONFIRMED");
  }
  async function resume(id, state, device, file) {
    let obj = await store.headPublished(id);
    if (obj) {
      if (!same(obj, state.value) || !owned(obj, state.value)) fail(409, "PUBLISHED_OBJECT_CONFLICT");
      return finish(id, state, true);
    }
    file ||= await validatedStaging(id, state.value);
    const current = await checkedState(id, device);
    if (["revoking", "revoked"].includes(current.value.phase)) fail(410, "PUBLICATION_REVOKED");
    if (current.etag !== state.etag) fail(409, "STATE_CHANGED_RETRY");
    const writer = state.value.writer;
    try {
      const part = await store.writePublicationPart(id, writer.upload_id, file.bytes);
      await store.completePublication(id, writer.upload_id, part);
    } catch (e) {
      if (!conflict(e) && !noUpload(e)) throw e; // Retry the same upload/ID after lost responses.
      obj = await store.headPublished(id);
      if (obj) {
        if (!same(obj, state.value) || !owned(obj, state.value)) fail(409, "PUBLISHED_OBJECT_CONFLICT");
        return finish(id, state, true);
      }
      if (!noUpload(e)) throw e;
      // A consumed/aborted upload can be replaced only after the abort fence is
      // confirmed. Keep the publication ID and immutable content binding.
      await fence(id, writer);
      const {writer:retired, ...record} = state.value;
      await transition(id, state, {...record, phase:"issued"});
      fail(409, "PUBLICATION_RETRY_SAME_ID");
    }
    return finish(id, state, false);
  }

  async function publish({id, bytes, sha256}, device) {
    if (!isId(id) || !Number.isSafeInteger(bytes) || bytes < 20 || bytes > MAX ||
        !isSha(sha256)) fail(400, "INVALID_PUBLISH_REQUEST");
    let state = await checkedState(id, device);
    const initial = state.value;
    if (initial.bytes !== bytes) fail(409, "SIZE_DOES_NOT_MATCH_TICKET");
    if ((initial.sha256 && initial.sha256 !== sha256) ||
        (initial.expected_sha256 && initial.expected_sha256 !== sha256)) fail(409, "CONTENT_ALREADY_PUBLISHED");
    if (["revoking", "revoked"].includes(initial.phase)) fail(410, "PUBLICATION_REVOKED");
    // Reading an existing v1 publication needs no migration or public write.
    if (initial.phase === "published") {
      const obj = await store.headPublished(id);
      if (!same(obj, initial) || (initial.v === 2 && !owned(obj, initial))) fail(410, "PUBLISHED_OBJECT_UNAVAILABLE");
      return {id, url:view(id), already_published:true};
    }
    state = await migrateLegacy(id, state);
    if (state.value.phase === "published") return {id, url:view(id), already_published:true};
    if (state.value.phase === "publishing") return resume(id, state, device);
    if (state.value.phase !== "issued") fail(409, "UNEXPECTED_STATE");
    const writing = {...state.value, phase:"publishing", sha256, started_at:now()};
    const file = await validatedStaging(id, writing);
    if (await store.headPublished(id)) fail(409, "PUBLISHED_OBJECT_CONFLICT");
    const token = randomId();
    const uploadId = await store.startPublication(id, sha256, token);
    if (typeof uploadId !== "string" || !uploadId || uploadId.length > 1024) throw Error("INVALID_UPLOAD_ID");
    writing.writer = {upload_id:uploadId, token};
    try { state = await transition(id, state, writing); }
    catch (e) {
      // Only the control owner can upload parts/complete. Uncommitted attempts
      // can be aborted, but never race a helper of a committed control record.
      const actual = await checkedState(id, device);
      if (actual.value.writer?.upload_id === uploadId && actual.value.writer?.token === token) {
        if (actual.value.phase !== "publishing") fail(409, "STATE_CHANGED_RETRY");
        state = actual;
      } else {
        try { await fence(id, writing.writer); } catch (_) {} // Empty orphan, never completed.
        throw e;
      }
    }
    return resume(id, state, device, file);
  }

  async function revoke({id}, device) {
    let state = await migrateLegacy(id, await checkedState(id, device));
    if (!["revoking", "revoked"].includes(state.value.phase))
      state = await transition(id, state, {...state.value, phase:"revoking", revoked_requested_at:now()});
    await fence(id, state.value.writer); // Includes an in-flight CompleteMultipartUpload.
    const obj = await store.headPublished(id);
    if (obj && !owned(obj, state.value)) fail(409, "PUBLISHED_OBJECT_CONFLICT");
    if (obj) await store.removePublished(id);
    await store.removeStaging(id);
    if (await store.headPublished(id)) fail(503, "REVOCATION_UNCONFIRMED");
    if (state.value.phase !== "revoked") {
      try { await transition(id, state, {...state.value, phase:"revoked", revoked_at:now()}); }
      catch (e) {
        if (!(e instanceof FlowError) || e.code !== "STATE_CHANGED_RETRY" ||
            (await checkedState(id, device)).value.phase !== "revoked") throw e;
      }
    }
    return {id, revoked:true};
  }
  return {begin, publish, revoke};
}
module.exports = {makeWorkflow, FlowError, MAX};

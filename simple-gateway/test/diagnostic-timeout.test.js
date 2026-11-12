"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {fixture,deferred}=require("../test-support/memory-store");
const {runRecoveryChecks}=require("../recovery-selftest");
function setup(){
  const f=fixture(),options={viewerUrl:"https://example.invalid/client.html",runId:"a".repeat(32),
    async uploadStaging(t,b){f.store.stage.set(t.id,b);}};
  return {...f,options,call:action=>runRecoveryChecks(f.store,action==="prepare"?f.bytes:null,{...options,action})};
}
// A blocked invocation is left alive while an independent invocation recovers:
// this models hard timeout with absent finally/stdout, including late requests.
async function pauseRun(f,target,hook="after"){
  const entered=deferred(),release=deferred();let once=true;
  f.store[hook][target]=async()=>{if(once){once=false;entered.resolve();await release.promise;}};
  const active=f.call("run");await entered.promise;return {active,release:()=>release.resolve()};
}
test("prepare reply lost: known run ID recovers all IDs, with no other objects created",async()=>{
  const f=setup();let once=true;
  f.store.after.putDiagnosticRun=async()=>{if(once){once=false;throw Error("reply lost");}};
  await assert.rejects(f.call("prepare"),/reply lost/);
  assert.equal(f.store.states.size,0);assert.equal(f.store.uploads.size,0);
  const status=await f.call("status");assert.equal(status.test_ids.length,5);
  assert.deepEqual((await f.call("prepare")).test_ids,status.test_ids);assert.equal(f.store.runs.size,1);
});
test("no writes without explicit run ID and durable preparation; status is read-only",async()=>{
  const f=setup();await assert.rejects(f.call("run"),e=>e.code==="SELFTEST_RUN_NOT_PREPARED");
  await assert.rejects(runRecoveryChecks(f.store,f.bytes,{...f.options,runId:undefined,action:"prepare"}),e=>e.code==="SELFTEST_RUN_ID_REQUIRED");
  await f.call("prepare");await f.call("status");assert.equal(f.store.states.size,0);assert.equal(f.store.uploads.size,0);
});
test("timeout after control commit before ID reply: registry and tombstone fence the delayed begin",async()=>{
  const f=setup();await f.call("prepare");const p=await pauseRun(f,"putState");
  assert.ok((await f.call("status")).test_ids.includes([...f.store.states.keys()][0]));
  assert.equal((await f.call("cleanup")).result,"CLEANED");
  p.release();await assert.rejects(p.active);
  assert.equal(f.store.objects.size,0);assert.equal(f.store.stage.size,0);
  assert.ok([...f.store.states.values()].every(r=>r.value.phase==="revoked"));
});
test("timeout after Create commit before recording upload ID: exact-key list recovers it",async()=>{
  const f=setup();await f.call("prepare");const p=await pauseRun(f,"startPublication");
  const status=await f.call("status");assert.equal(status.pending_creates.length,1);
  assert.equal(status.objects[0].upload_ids.length,1);
  assert.equal((await f.call("cleanup")).result,"CLEANED");
  p.release();await assert.rejects(p.active);
  assert.equal(f.store.calls.writePublicationPart||0,0);assert.equal(f.store.objects.size,0);
  assert.ok([...f.store.uploads.values()].every(u=>!u.active));
});
test("delayed Create cannot produce CLEANED; its late empty upload is recovered on retry",async()=>{
  const f=setup();await f.call("prepare");const p=await pauseRun(f,"startPublication","before");
  await assert.rejects(f.call("cleanup"),e=>e.code==="SELFTEST_PENDING_IO_RECHECK");
  assert.equal((await f.call("status")).phase,"cleaning");
  p.release();await assert.rejects(p.active);
  assert.equal((await f.call("cleanup")).result,"CLEANED");
  assert.equal(f.store.calls.writePublicationPart||0,0);assert.equal(f.store.objects.size,0);
});
for(const beforeCommit of [false,true])test("timeout during staging PUT, beforeCommit="+beforeCommit,async()=>{
  const f=setup();await f.call("prepare");const entered=deferred(),release=deferred();
  f.options.uploadStaging=async(t,b)=>{if(!beforeCommit)f.store.stage.set(t.id,b);entered.resolve();
    await release.promise;if(beforeCommit)f.store.stage.set(t.id,b);};
  const active=f.call("run");await entered.promise;
  if(beforeCommit)await assert.rejects(f.call("cleanup"),e=>e.code==="SELFTEST_PENDING_IO_RECHECK");
  else assert.equal((await f.call("cleanup")).result,"CLEANED");
  release.resolve();await assert.rejects(active);
  assert.equal((await f.call("cleanup")).result,"CLEANED");
  assert.equal(f.store.calls.startPublication||0,0);assert.equal(f.store.stage.size,0);
});
test("single-use run and repeated cleanup survive final CAS reply loss",async()=>{
  const f=setup();await f.call("prepare");await f.call("run");
  await assert.rejects(f.call("run"),e=>e.code==="SELFTEST_RUN_ALREADY_STARTED");let once=true;
  f.store.after.putDiagnosticRun=async(id,value)=>{if(value.phase==="cleaned"&&once){once=false;throw Error("final reply lost");}};
  await assert.rejects(f.call("cleanup"),/final reply lost/);assert.equal((await f.call("cleanup")).result,"CLEANED");
});
test("foreign control/modified plan are rejected without deleting foreign data",async()=>{
  const f=setup(),p=await f.call("prepare");
  f.store.states.set(p.test_ids[0],{value:{v:2,device:"real-customer"},etag:'"foreign"'});
  await assert.rejects(f.call("cleanup"),e=>e.code==="SELFTEST_FOREIGN_CONTROL");
  assert.equal(f.store.states.get(p.test_ids[0]).value.device,"real-customer");
  f.store.runs.get(f.options.runId).value.rows[0].id="f".repeat(32);
  await assert.rejects(f.call("cleanup"),e=>e.code==="SELFTEST_RUN_INVALID");
});
test("timeout after Complete commits: another invocation fences and cleans; late reply never republishes",async()=>{
  const f=setup();await f.call("prepare");const p=await pauseRun(f,"completePublication");
  assert.equal(f.store.objects.size,1);
  assert.equal((await f.call("cleanup")).result,"CLEANED");
  p.release();await assert.rejects(p.active);
  assert.equal(f.store.objects.size,0);assert.equal((await f.call("status")).phase,"cleaned");
});
test("concurrent run calls cannot allocate two diagnostic attempts",async()=>{
  const f=setup();await f.call("prepare");const p=await pauseRun(f,"putState");
  await assert.rejects(f.call("run"),e=>e.code==="SELFTEST_RUN_ALREADY_STARTED");
  await f.call("cleanup");p.release();await assert.rejects(p.active);
  assert.equal(f.store.objects.size,0);
});
test("missing list permission blocks status before any synthetic control or multipart creation",async()=>{
  const f=setup();await f.call("prepare");
  f.store.before.listPublicationUploads=async()=>{throw Error("AccessDenied");};
  await assert.rejects(f.call("status"),/AccessDenied/);
  assert.equal(f.store.states.size,0);assert.equal(f.store.uploads.size,0);
});
test("a conflicting begin mapping cannot create an unplanned control ID",async()=>{
  const f=setup();await f.call("prepare");const r=f.store.runs.get(f.options.runId).value,row=r.rows[0];
  f.store.begins.set("cloud-selftest/"+row.request_id,{value:{v:1,device:"cloud-selftest",request_id:row.request_id,
    id:"f".repeat(32),bytes:r.bytes,md5_base64:r.md5_base64,sha256:r.sha256,created_at:0},etag:'"foreign"'});
  await assert.rejects(f.call("run"),e=>e.code==="SELFTEST_FOREIGN_BEGIN_MAPPING");
  assert.equal(f.store.states.has("f".repeat(32)),false);assert.equal(f.store.uploads.size,0);
});
test("unexplained uploads are not aborted or reported as cleaned",async()=>{
  const f=setup(),p=await f.call("prepare");
  f.store.uploads.set("unrelated",{id:p.test_ids[0],active:true,token:"foreign"});
  await assert.rejects(f.call("cleanup"),e=>e.code==="SELFTEST_UNEXPECTED_UPLOAD");
  assert.equal(f.store.uploads.get("unrelated").active,true);
});

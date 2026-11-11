"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {fixture}=require("../test-support/memory-store");
const {runRecoveryChecks}=require("../recovery-selftest");
const {handler}=require("../selftest");
function setup(){
  const f=fixture();let n=0;
  return {...f,options:{viewerUrl:"https://example.invalid/client.html",newId:()=> (++n).toString(16).padStart(32,"0"),
    async uploadStaging(ticket,bytes){f.store.stage.set(ticket.id,bytes);}}};
}
test("private recovery check verifies the real storage contract model and retains only its tombstones",async()=>{
  const f=setup(),result=await runRecoveryChecks(f.store,f.bytes,f.options);
  assert.equal(result.result,"PASS");assert.ok(result.checks.includes("abort_complete_race_x3"));
  assert.equal(f.store.objects.size,0);assert.equal(f.store.stage.size,0);
  assert.ok([...f.store.states.values()].every(r=>r.value.phase==="revoked"));
  assert.ok([...f.store.uploads.values()].every(u=>!u.active));
});
test("private check fails if provider ignores conditional completion, without touching foreign IDs",async()=>{
  const f=setup(),normal=f.store.completePublication;
  f.store.objects.set("e".repeat(32),{body:Buffer.from("unrelated"),token:"unrelated",etag:'"foreign"'});
  f.store.completePublication=async(id,upload,part)=>{
    if(f.store.objects.has(id))f.store.objects.delete(id); // Deliberately broken storage provider.
    return normal(id,upload,part);
  };
  await assert.rejects(runRecoveryChecks(f.store,f.bytes,f.options),e=>e.code==="SELFTEST_CONDITIONAL_COMPLETE_UNSUPPORTED");
  assert.equal(f.store.objects.size,1);assert.equal(f.store.objects.get("e".repeat(32)).body.toString(),"unrelated");
});
test("an unconfirmed abort cannot produce a passing private check",async()=>{
  const f=setup();f.store.abortUnconfirmed=true;
  await assert.rejects(runRecoveryChecks(f.store,f.bytes,f.options),e=>e.code==="UPLOAD_ABORT_UNCONFIRMED");
});
test("selftest cannot be invoked through an HTTP Gateway envelope, even if its flag is true",async()=>{
  process.env.SELFTEST_ENABLED="true";
  try {
    const response=await handler({httpMethod:"POST",operation:"recovery"});
    assert.equal(response.statusCode,403);assert.equal(JSON.parse(response.body).error,"PRIVATE_SELFTEST_ONLY");
  }finally{delete process.env.SELFTEST_ENABLED;}
});

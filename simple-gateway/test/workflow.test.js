"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {MAX}=require("../workflow");
const {fixture,hash,deferred}=require("../test-support/memory-store");
const rejects=(promise,status,code)=>assert.rejects(promise,e=>e.status===status&&e.code===code);
const lost=()=>{throw Error("synthetic lost network response");};

for(const legacy of [false,true])test(`publish/retry/revoke with ${legacy?'installed 1.1.1':'idempotent'} begin`,async()=>{
  const f=fixture(),id=await f.begin(legacy);
  const p=await f.flow().publish(f.args(id),f.device);
  assert.match(p.url,/#id=[a-f0-9]{32}$/);
  assert.equal((await f.flow().publish(f.args(id),f.device)).already_published,true);
  assert.equal((await f.flow().revoke({id},f.device)).revoked,true);
  assert.equal(f.store.objects.size,0);
  assert.equal(f.store.states.get(id).value.phase,"revoked");
  f.store.stage.set(id,f.bytes); // A still-valid old presigned PUT is harmless.
  await rejects(f.flow().publish(f.args(id),f.device),410,"PUBLICATION_REVOKED");
  assert.equal(f.store.objects.size,0);
});

test("lost begin response and restart return the original ID and original creation time",async()=>{
  const f=fixture(),first=await f.begin(); f.setTime(5000000);
  const retry=await f.flow().begin(f.body,f.device);
  assert.equal(retry.id,first);assert.equal(retry.request_id,f.body.request_id);
  assert.equal(f.store.begins.size,1);assert.equal(f.store.states.size,1);
  assert.equal(f.store.states.get(first).value.created_at,1000);
});
for(const point of ["putBegin","putState","signUpload"])test(`begin recovers after lost ${point} response`,async()=>{
  const f=fixture();f.store.after[point]=()=>{delete f.store.after[point];lost();};
  try{await f.flow().begin(f.body,f.device);}catch(e){assert.equal(e.message,"synthetic lost network response");}
  const ticket=await f.flow().begin(f.body,f.device);
  assert.equal(f.store.begins.size,1);assert.equal(f.store.states.size,1);
  assert.equal(f.store.states.has(ticket.id),true);
});
test("concurrent begin callers never create a losing control ID",async()=>{
  const f=fixture();const results=await Promise.all(Array.from({length:8},()=>f.flow().begin(f.body,f.device)));
  assert.equal(new Set(results.map(r=>r.id)).size,1);
  assert.equal(f.store.begins.size,1);assert.equal(f.store.states.size,1);
});
test("idempotency key binds size, MD5 and SHA-256, scoped to one device",async()=>{
  const f=fixture(),id=await f.begin();
  for(const patch of [{bytes:f.bytes.length+1},{md5_base64:"AQEBAQEBAQEBAQEBAQEBAQ=="},{sha256:"b".repeat(64)}])
    await rejects(f.flow().begin({...f.body,...patch},f.device),409,"BEGIN_REQUEST_CONFLICT");
  const other=await f.flow().begin(f.body,"phone2");assert.notEqual(id,other.id);
  await rejects(f.flow().revoke({id},"phone2"),403,"PUBLICATION_ACCESS_DENIED");
});
test("revoked begin mapping is retained and never allocates another ID",async()=>{
  const f=fixture(),id=await f.begin();await f.flow().revoke({id},f.device);
  await rejects(f.flow().begin(f.body,f.device),410,"PUBLICATION_REVOKED");
  assert.equal(f.store.states.size,1);assert.equal(f.store.begins.size,1);
});
test("begin_v2 rejects missing/invalid keys and content information before storage writes",async()=>{
  const f=fixture();
  for(const patch of [{request_id:undefined},{request_id:[f.body.request_id]},{sha256:undefined},{bytes:MAX+1}])
    await assert.rejects(f.flow().begin({...f.body,...patch},f.device),e=>e.status===400);
  assert.equal(f.store.states.size,0);assert.equal(f.store.begins.size,0);
});
test("a lost multipart initialization leaves only an uncompleted orphan, not another PDF",async()=>{
  const f=fixture(),id=await f.begin();
  f.store.after.startPublication=()=>{delete f.store.after.startPublication;lost();};
  await assert.rejects(f.flow().publish(f.args(id),f.device));
  assert.equal(f.store.states.get(id).value.phase,"issued");assert.equal(f.store.objects.size,0);
  await f.flow().publish(f.args(id),f.device);
  assert.equal(f.store.objects.size,1);assert.equal(f.store.states.size,1);
  assert.equal([...f.store.uploads.values()].filter(u=>u.active&&!u.part).length,1);
});
test("lost publishing CAS acknowledgement is read back before part upload",async()=>{
  const f=fixture(),id=await f.begin();
  f.store.after.putState=(_,value)=>{if(value.phase==="publishing"){delete f.store.after.putState;lost();}};
  await f.flow().publish(f.args(id),f.device);
  assert.equal(f.store.calls.startPublication,1);assert.equal(f.store.objects.size,1);
});
for(const method of ["writePublicationPart","completePublication"])test(`restart recovers lost ${method} acknowledgement`,async()=>{
  const f=fixture(),id=await f.begin();
  f.store.after[method]=()=>{delete f.store.after[method];lost();};
  await assert.rejects(f.flow().publish(f.args(id),f.device));
  assert.equal(f.store.states.get(id).value.phase,"publishing");
  await f.flow().publish(f.args(id),f.device);
  assert.equal(f.store.states.get(id).value.phase,"published");
  assert.equal(f.store.calls.startPublication,1);assert.equal(f.store.objects.size,1);
});
test("crash before the public write resumes the same upload ID without an age heuristic",async()=>{
  const f=fixture(),id=await f.begin();
  f.store.before.writePublicationPart=()=>{delete f.store.before.writePublicationPart;lost();};
  await assert.rejects(f.flow().publish(f.args(id),f.device));
  const upload=f.store.states.get(id).value.writer.upload_id;
  f.setTime(1000000000000);
  await f.flow().publish(f.args(id),f.device);
  assert.equal(f.store.states.get(id).value.writer.upload_id,upload);
  assert.equal(f.store.calls.startPublication,1);
});
test("a lost published-state response is idempotent",async()=>{
  const f=fixture(),id=await f.begin();
  f.store.after.putState=(_,value)=>{if(value.phase==="published"){delete f.store.after.putState;lost();}};
  await assert.rejects(f.flow().publish(f.args(id),f.device));
  assert.equal((await f.flow().publish(f.args(id),f.device)).already_published,true);
  assert.equal(f.store.calls.completePublication,1);
});
for(const method of ["writePublicationPart","completePublication"])test(`revoke fences a delayed ${method} before it can commit`,async()=>{
  const f=fixture(),id=await f.begin(),started=deferred(),release=deferred();
  f.store.before[method]=async()=>{delete f.store.before[method];started.resolve();await release.promise;};
  const running=f.flow().publish(f.args(id),f.device);const result=assert.rejects(running);
  await started.promise;
  const writer=f.store.states.get(id).value.writer;
  assert.equal((await f.flow().revoke({id},f.device)).revoked,true);
  release.resolve();await result;
  assert.equal(f.store.objects.size,0);assert.equal(f.store.states.get(id).value.phase,"revoked");
  await assert.rejects(f.store.completePublication(id,writer.upload_id,'"late"'),e=>e.name==="NoSuchUpload");
  assert.equal(f.store.objects.size,0);
});
test("revoke also wins after public commit but before the original completion response",async()=>{
  const f=fixture(),id=await f.begin(),committed=deferred(),release=deferred();
  f.store.after.completePublication=async()=>{delete f.store.after.completePublication;committed.resolve();await release.promise;};
  const running=f.flow().publish(f.args(id),f.device);const result=assert.rejects(running);
  await committed.promise;assert.equal(f.store.objects.size,1);
  await f.flow().revoke({id},f.device);release.resolve();await result;
  assert.equal(f.store.objects.size,0);assert.equal(f.store.states.get(id).value.phase,"revoked");
});
test("parallel publish attempts expose only one object and losing uploads never complete",async()=>{
  const f=fixture(),id=await f.begin();
  const results=await Promise.allSettled(Array.from({length:6},()=>f.flow().publish(f.args(id),f.device)));
  assert.ok(results.some(r=>r.status==="fulfilled"));
  assert.equal(f.store.objects.size,1);assert.equal(f.store.calls.completePublication,1);
  assert.equal((await f.flow().publish(f.args(id),f.device)).already_published,true);
});
test("parallel revokes and a repeated request retain the tombstone",async()=>{
  const f=fixture(),id=await f.begin();await f.flow().publish(f.args(id),f.device);
  const results=await Promise.allSettled(Array.from({length:4},()=>f.flow().revoke({id},f.device)));
  assert.ok(results.some(r=>r.status==="fulfilled"));
  assert.equal((await f.flow().revoke({id},f.device)).revoked,true);
  assert.equal(f.store.states.get(id).value.phase,"revoked");assert.equal(f.store.objects.size,0);
});
test("an unconfirmed abort never permits deletion or a successful revoke",async()=>{
  const f=fixture(),id=await f.begin();await f.flow().publish(f.args(id),f.device);
  f.store.abortUnconfirmed=true;
  await rejects(f.flow().revoke({id},f.device),503,"UPLOAD_ABORT_UNCONFIRMED");
  assert.equal(f.store.objects.size,1);assert.equal(f.store.calls.removePublished,undefined);
  f.store.abortUnconfirmed=false;await f.flow().revoke({id},f.device);assert.equal(f.store.objects.size,0);
});
for(const method of ["removePublished","removeStaging"])test(`lost ${method} response is recovered in revoking`,async()=>{
  const f=fixture(),id=await f.begin();await f.flow().publish(f.args(id),f.device);
  f.store.after[method]=()=>{delete f.store.after[method];lost();};
  await assert.rejects(f.flow().revoke({id},f.device));
  assert.equal(f.store.states.get(id).value.phase,"revoking");
  await f.flow().revoke({id},f.device);
  assert.equal(f.store.states.get(id).value.phase,"revoked");assert.equal(f.store.objects.size,0);
});
test("a lost revoked-state acknowledgement never reopens publication",async()=>{
  const f=fixture(),id=await f.begin();
  f.store.after.putState=(_,r)=>{if(r.phase==="revoked"){delete f.store.after.putState;lost();}};
  await assert.rejects(f.flow().revoke({id},f.device));
  assert.equal((await f.flow().revoke({id},f.device)).revoked,true);
  await rejects(f.flow().publish(f.args(id),f.device),410,"PUBLICATION_REVOKED");
});
test("missing staging can still be safely revoked from publishing",async()=>{
  const f=fixture(),id=await f.begin();f.store.before.writePublicationPart=()=>{delete f.store.before.writePublicationPart;lost();};
  await assert.rejects(f.flow().publish(f.args(id),f.device));f.store.stage.delete(id);
  await rejects(f.flow().publish(f.args(id),f.device),404,"UPLOADED_PDF_MISSING");
  await f.flow().revoke({id},f.device);assert.equal(f.store.objects.size,0);
});
test("an externally aborted upload rotates only after fencing, and keeps the publication ID",async()=>{
  const f=fixture(),id=await f.begin();f.store.before.writePublicationPart=()=>{delete f.store.before.writePublicationPart;lost();};
  await assert.rejects(f.flow().publish(f.args(id),f.device));
  const writer=f.store.states.get(id).value.writer;
  await f.store.abortPublication(id,writer.upload_id);
  await rejects(f.flow().publish(f.args(id),f.device),409,"PUBLICATION_RETRY_SAME_ID");
  await f.flow().publish(f.args(id),f.device);
  assert.equal(f.store.states.size,1);assert.equal(f.store.objects.size,1);
  await assert.rejects(f.store.completePublication(id,writer.upload_id,'"late"'),e=>e.name==="NoSuchUpload");
});
test("foreign object tokens block publication and deletion; hashes come from actual bytes",async()=>{
  const f=fixture(),id=await f.begin();f.store.before.writePublicationPart=()=>{delete f.store.before.writePublicationPart;lost();};
  await assert.rejects(f.flow().publish(f.args(id),f.device));
  const body=Buffer.from("foreign data");f.store.objects.set(id,{body,token:"e".repeat(32),etag:'"foreign"'});
  await rejects(f.flow().publish(f.args(id),f.device),409,"PUBLISHED_OBJECT_CONFLICT");
  await rejects(f.flow().revoke({id},f.device),409,"PUBLISHED_OBJECT_CONFLICT");
  assert.deepEqual(f.store.objects.get(id).body,body);assert.equal(f.store.calls.removePublished,undefined);
});
test("wrong SHA, wrong size, invalid PDF and missing ETag fail before public writes",async()=>{
  const f=fixture(),id=await f.begin();
  await rejects(f.flow().publish({...f.args(id),sha256:"b".repeat(64)},f.device),409,"CONTENT_ALREADY_PUBLISHED");
  f.store.stage.set(id,Buffer.alloc(f.bytes.length,1));
  await rejects(f.flow().publish(f.args(id),f.device),422,"HASH_MISMATCH");
  f.store.stage.set(id,f.bytes);f.store.parsePdf=async()=>false;
  await rejects(f.flow().publish(f.args(id),f.device),422,"INVALID_PDF");
  delete f.store.states.get(id).etag;
  await rejects(f.flow().revoke({id},f.device),503,"CONTROL_RECORD_INVALID");
  assert.equal(f.store.calls.startPublication,undefined);
});

async function legacyFixture(withObject,options={}) {
  const f=fixture(options),id=await f.begin(true);
  const row=f.store.states.get(id);row.value={...row.value,v:1,phase:"publishing",sha256:hash(f.bytes)};
  if(withObject)f.store.objects.set(id,{body:Buffer.from(f.bytes),etag:'"legacy"'});
  return {...f,id};
}
test("old raw-PUT publishing never unlocks just because it is old or a matching object exists",async()=>{
  for(const exists of [true,false]) {
    const f=await legacyFixture(exists);f.setTime(1000000000000);
    await rejects(f.flow().publish(f.args(f.id),f.device),409,"LEGACY_WRITERS_NOT_DRAINED");
    await rejects(f.flow().revoke({id:f.id},f.device),409,"LEGACY_WRITERS_NOT_DRAINED");
    assert.equal(f.store.states.get(f.id).value.v,1);
  }
});
for(const exists of [true,false])test(`drained legacy publishing recovers ${exists?'the actual object':'the missing write'} with the original ID`,async()=>{
  const f=await legacyFixture(exists,{legacyWritesDrained:true});
  await f.flow().publish(f.args(f.id),f.device);
  assert.equal(f.store.states.get(f.id).value.v,2);assert.equal(f.store.states.size,1);
  assert.equal(f.store.calls.startPublication||0,exists?0:1);
  await f.flow().revoke({id:f.id},f.device);assert.equal(f.store.objects.size,0);
});
test("drained legacy publishing with expired staging can be revoked without creating a PDF",async()=>{
  const f=await legacyFixture(false,{legacyWritesDrained:true});f.store.stage.delete(f.id);
  await f.flow().revoke({id:f.id},f.device);
  assert.equal(f.store.states.get(f.id).value.phase,"revoked");assert.equal(f.store.calls.startPublication,undefined);
});
test("legacy object mismatch cannot be automatically adopted or deleted",async()=>{
  const f=await legacyFixture(true,{legacyWritesDrained:true});f.store.objects.get(f.id).body=Buffer.from("wrong file");
  await rejects(f.flow().publish(f.args(f.id),f.device),409,"PUBLISHED_OBJECT_CONFLICT");
  await rejects(f.flow().revoke({id:f.id},f.device),409,"PUBLISHED_OBJECT_CONFLICT");
  assert.equal(f.store.calls.removePublished,undefined);assert.equal(f.store.states.get(f.id).value.v,1);
});
test("installed client can still read an already-published v1 object without migration",async()=>{
  const f=await legacyFixture(true);f.store.states.get(f.id).value.phase="published";
  assert.equal((await f.flow().publish(f.args(f.id),f.device)).already_published,true);
  assert.equal(f.store.states.get(f.id).value.v,1);
});

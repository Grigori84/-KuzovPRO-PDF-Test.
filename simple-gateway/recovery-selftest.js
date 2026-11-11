"use strict";
// Called only by the existing, explicitly enabled PRIVATE selftest entrypoint.
// Creates its own synthetic IDs; it never accepts a customer's ID or device.
const {createHash}=require("node:crypto");
const {makeWorkflow,FlowError}=require("./workflow");
const DEVICE="cloud-selftest";
const digest=(name,bytes,encoding)=>createHash(name).update(bytes).digest(encoding);
const noUpload=e=>e?.name==="NoSuchUpload"||e?.code==="NoSuchUpload";
const precondition=e=>e?.name==="PreconditionFailed"||[409,412].includes(e?.$metadata?.httpStatusCode);
const check=(value,code)=>{if(!value)throw new FlowError(503,code);};

async function runRecoveryChecks(store,bytes,{viewerUrl,newId,uploadStaging}={}) {
  const flow=()=>makeWorkflow(store,{viewerUrl,newId});
  const rows=[],checks=[];
  const sha256=digest("sha256",bytes,"hex"),md5_base64=digest("md5",bytes,"base64");
  async function fresh() {
    const ticket=await flow().begin({bytes:bytes.length,md5_base64},DEVICE);
    const row={id:ticket.id,tokens:new Set(),uploads:new Set()};rows.push(row);return row;
  }
  async function writer(row) {
    const token=newId(),upload=await store.startPublication(row.id,sha256,token);
    row.tokens.add(token);row.uploads.add(upload);
    const part=await store.writePublicationPart(row.id,upload,bytes);
    return {upload,part,token};
  }
  async function absent(id) { check(!(await store.headPublished(id)),"SELFTEST_PUBLIC_OBJECT_REAPPEARED"); }
  async function removeOwned(row) {
    const obj=await store.headPublished(row.id);
    if(obj){check(row.tokens.has(obj.token),"SELFTEST_FOREIGN_OBJECT");await store.removePublished(row.id);}
    await absent(row.id);
  }
  let failure;
  try {
    // Discard the complete begin reply, then recover using a new invocation.
    const body={operation:"begin_v2",request_id:newId(),bytes:bytes.length,md5_base64,sha256};
    const first=await flow().begin(body,DEVICE);
    const row={id:first.id,tokens:new Set(),uploads:new Set()};rows.push(row);
    const retry=await flow().begin(body,DEVICE);
    check(first.id===retry.id&&retry.request_id===body.request_id,"SELFTEST_BEGIN_DUPLICATED");
    checks.push("lost_begin_same_id");
    await uploadStaging(retry,bytes);
    const interrupted={...store,async completePublication(...args){
      await store.completePublication(...args);throw Error("SELFTEST_COMPLETION_RESPONSE_LOST");
    }};
    let lost=false;
    try{await makeWorkflow(interrupted,{viewerUrl,newId}).publish({id:row.id,bytes:bytes.length,sha256},DEVICE);}
    catch(e){if(e.message==="SELFTEST_COMPLETION_RESPONSE_LOST")lost=true;else throw e;}
    check(lost,"SELFTEST_FAULT_NOT_REACHED");
    const pending=await store.getState(row.id);
    check(pending.value.phase==="publishing","SELFTEST_PENDING_STATE_MISSING");
    row.tokens.add(pending.value.writer.token);row.uploads.add(pending.value.writer.upload_id);
    const recovered=await flow().publish({id:row.id,bytes:bytes.length,sha256},DEVICE);
    check(recovered.already_published===true,"SELFTEST_PUBLISH_RECOVERY_FAILED");
    await flow().revoke({id:row.id},DEVICE);await absent(row.id);
    let denied=false;
    try{await flow().publish({id:row.id,bytes:bytes.length,sha256},DEVICE);}
    catch(e){if(e.code==="PUBLICATION_REVOKED")denied=true;else throw e;}
    check(denied,"SELFTEST_REVOKED_ID_REUSED");
    checks.push("lost_complete_response_recovered","revoke_tombstone");

    // Verify that the provider actually enforces the serialized If-None-Match.
    const conditional=await fresh(),a=await writer(conditional),b=await writer(conditional);
    await store.completePublication(conditional.id,a.upload,a.part);
    let rejected=false;
    try{await store.completePublication(conditional.id,b.upload,b.part);}
    catch(e){if(precondition(e))rejected=true;else throw e;}
    const object=await store.headPublished(conditional.id);
    check(rejected&&object?.token===a.token&&object.sha256===sha256,"SELFTEST_CONDITIONAL_COMPLETE_UNSUPPORTED");
    checks.push("conditional_complete_no_overwrite");

    // Delete immediately after the abort fence, before awaiting an overlapping
    // Complete response. A late completion must not recreate the public PDF.
    for(let i=0;i<3;i++) {
      const race=await fresh(),w=await writer(race);
      const completing=store.completePublication(race.id,w.upload,w.part).then(()=>null,e=>e);
      check(await store.abortPublication(race.id,w.upload),"SELFTEST_ABORT_NOT_CONFIRMED");
      await removeOwned(race);
      const completionError=await completing;
      if(completionError&&!noUpload(completionError)&&!precondition(completionError))throw completionError;
      await absent(race.id);
      let terminal=false;
      try{await store.completePublication(race.id,w.upload,w.part);}
      catch(e){if(noUpload(e))terminal=true;else throw e;}
      check(terminal,"SELFTEST_ABORT_NOT_TERMINAL");await absent(race.id);
    }
    checks.push("abort_complete_race_x3","late_complete_cannot_recreate");
  } catch(e) { failure=e; }
  // Cleanup is constrained to IDs/tokens created in THIS invocation. A failure
  // here is reported, never disguised as a successful contract check.
  for(const row of rows) {
    try {
      const current=await store.getState(row.id);
      if(current?.value.writer){row.uploads.add(current.value.writer.upload_id);row.tokens.add(current.value.writer.token);}
      for(const upload of row.uploads)check(await store.abortPublication(row.id,upload),"SELFTEST_CLEANUP_ABORT_UNCONFIRMED");
      await removeOwned(row);await flow().revoke({id:row.id},DEVICE);await absent(row.id);
    } catch(e) { failure ||= e; }
  }
  if(failure){failure.testIds=rows.map(r=>r.id);throw failure;}
  return {result:"PASS",operation:"recovery",checks,test_ids:rows.map(r=>r.id),
    known_uploads_fenced:true,public_absence_verified:true,tombstones_retained:true};
}
module.exports={runRecoveryChecks};

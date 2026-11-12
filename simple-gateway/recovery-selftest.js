"use strict";
// Called only by the existing, explicitly enabled PRIVATE selftest entrypoint.
// Creates its own synthetic IDs; it never accepts a customer's ID or device.
const {createHash}=require("node:crypto");
const {makeWorkflow,FlowError}=require("./workflow");
const {journal,DEVICE}=require("./recovery-journal");
const digest=(name,bytes,encoding)=>createHash(name).update(bytes).digest(encoding);
const noUpload=e=>e?.name==="NoSuchUpload"||e?.code==="NoSuchUpload";
const precondition=e=>e?.name==="PreconditionFailed"||[409,412].includes(e?.$metadata?.httpStatusCode);
const check=(value,code)=>{if(!value)throw new FlowError(503,code);};

async function executeChecks(store,bytes,{viewerUrl,uploadStaging,session}) {
  const flow=row=>makeWorkflow(store,{viewerUrl,newId:()=>row.tokens[0]});
  const rows=session.rows,checks=[];
  const sha256=digest("sha256",bytes,"hex"),md5_base64=digest("md5",bytes,"base64");
  const body=row=>({operation:"begin_v2",request_id:row.request_id,bytes:bytes.length,md5_base64,sha256});
  const begin=row=>makeWorkflow(store,{viewerUrl,newId:()=>row.id}).begin(body(row),DEVICE);
  let nextRow=1;
  async function fresh(){const row=rows[nextRow++];await begin(row);return row;}
  const slots=new Map();
  async function writer(row) {
    const slot=slots.get(row.id)||0;slots.set(row.id,slot+1);
    const token=row.tokens[slot],upload=await store.startPublication(row.id,sha256,token);
    const part=await store.writePublicationPart(row.id,upload,bytes);
    return {upload,part,token};
  }
  async function absent(id) { check(!(await store.headPublished(id)),"SELFTEST_PUBLIC_OBJECT_REAPPEARED"); }
  async function removeOwned(row) {
    const obj=await store.headPublished(row.id);
    if(obj){check(row.tokens.includes(obj.token),"SELFTEST_FOREIGN_OBJECT");await store.removePublished(row.id);}
    await absent(row.id);
  }
  // All IDs are already in the durable plan, including a lost begin reply.
  const row=rows[0],first=await begin(row),retry=await begin(row);
  check(first.id===retry.id&&retry.request_id===row.request_id,"SELFTEST_BEGIN_DUPLICATED");
  checks.push("lost_begin_same_id");
  await session.update(r=>{check(r.phase==="running","SELFTEST_RUN_STOPPED");r.staging="writing";});
  await uploadStaging(retry,bytes);
  await session.update(r=>{check(r.phase==="running","SELFTEST_RUN_STOPPED");r.staging="done";});
  const interrupted={...store,async completePublication(...args){
    await store.completePublication(...args);throw Error("SELFTEST_COMPLETION_RESPONSE_LOST");
  }};
  let lost=false;
  try{await makeWorkflow(interrupted,{viewerUrl,newId:()=>row.tokens[0]}).publish({id:row.id,bytes:bytes.length,sha256},DEVICE);}
  catch(e){if(e.message==="SELFTEST_COMPLETION_RESPONSE_LOST")lost=true;else throw e;}
  check(lost,"SELFTEST_FAULT_NOT_REACHED");
  const pending=await store.getState(row.id);
  check(pending.value.phase==="publishing","SELFTEST_PENDING_STATE_MISSING");

  const recovered=await flow(row).publish({id:row.id,bytes:bytes.length,sha256},DEVICE);
  check(recovered.already_published===true,"SELFTEST_PUBLISH_RECOVERY_FAILED");
  await flow(row).revoke({id:row.id},DEVICE);await absent(row.id);
  let denied=false;
  try{await flow(row).publish({id:row.id,bytes:bytes.length,sha256},DEVICE);}
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
  return checks;
}

async function runRecoveryChecks(store,bytes,{viewerUrl,runId,action,uploadStaging}={}){
  const session=journal(store,runId,{viewerUrl});
  if(action==="prepare")return session.prepare(bytes);
  if(action==="status")return session.status();
  if(action==="cleanup")return session.cleanup();
  check(action==="run","SELFTEST_ACTION_REQUIRED");
  await session.update(r=>{check(r.phase==="prepared","SELFTEST_RUN_ALREADY_STARTED");r.phase="running";});
  const payload=Buffer.from((await session.read()).value.pdf_base64,"base64");
  let checks,failure;
  try{checks=await executeChecks(session.tracked,payload,{viewerUrl,uploadStaging,session});}
  catch(e){failure=e;}
  try{
    const result=await session.cleanup();
    if(!failure)return {...result,result:"PASS",operation:"recovery",checks};
  }catch(e){failure ||= e;}
  failure.testIds=session.rows.map(r=>r.id);throw failure;
}
module.exports={runRecoveryChecks};

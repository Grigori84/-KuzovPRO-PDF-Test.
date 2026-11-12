"use strict";
// Private diagnostic only. No customer IDs, leases, or production protocol changes.
const {createHash}=require("node:crypto");
const {makeWorkflow,FlowError}=require("./workflow");
const DEVICE="cloud-selftest",ID=/^[0-9a-f]{32}$/;
const hash=(value,encoding="hex",algorithm="sha256")=>createHash(algorithm).update(value).digest(encoding);
const check=(ok,code)=>{if(!ok)throw new FlowError(409,code);};
const collision=e=>[409,412].includes(e?.status||e?.$metadata?.httpStatusCode);
function plan(runId){
  const id=label=>hash("kpro-private-recovery-v1/"+runId+"/"+label).slice(0,32);
  return Array.from({length:5},(_,i)=>({id:id("pdf/"+i),request_id:id("begin/"+i),
    tokens:Array.from({length:i===1?2:1},(_,j)=>id("writer/"+i+"/"+j))}));
}
function journal(store,runId,{viewerUrl}={}){
  check(typeof runId==="string"&&ID.test(runId),"SELFTEST_RUN_ID_REQUIRED");
  const rows=plan(runId);
  async function read(){
    const entry=await store.getDiagnosticRun(runId);
    check(entry?.etag,"SELFTEST_RUN_NOT_PREPARED");
    const r=entry.value;
    check(r?.v===1&&r.run_id===runId&&JSON.stringify(r.rows)===JSON.stringify(rows)&&
      ["prepared","running","cleaning","cleaned"].includes(r.phase)&&Array.isArray(r.uploads)&&
      r.uploads.length===6&&["idle","writing","done"].includes(r.staging),"SELFTEST_RUN_INVALID");
    const expected=rows.flatMap(row=>row.tokens.map(token=>({id:row.id,token})));
    check(r.uploads.every((u,i)=>u.id===expected[i].id&&u.token===expected[i].token&&
      ["idle","creating","ready"].includes(u.state)&&
      (u.state!=="ready"||(typeof u.upload_id==="string"&&u.upload_id.length>0&&u.upload_id.length<=1024))),"SELFTEST_RUN_INVALID");
    const bytes=Buffer.from(r.pdf_base64||"","base64");
    check(bytes.length>=20&&bytes.length<=16384&&hash(bytes)===r.sha256&&bytes.length===r.bytes&&
      hash(bytes,"base64","md5")===r.md5_base64,"SELFTEST_RUN_INVALID");
    return entry;
  }
  async function update(fn){
    const entry=await read(),value=structuredClone(entry.value);fn(value);
    return store.putDiagnosticRun(runId,value,{ifMatch:entry.etag});
  }
  const running=()=>read().then(e=>check(e.value.phase==="running","SELFTEST_RUN_STOPPED"));
  async function prepare(bytes){
    const existing=await store.getDiagnosticRun(runId);
    if(!existing){
      check(Buffer.isBuffer(bytes)&&bytes.length>=20&&bytes.length<=16384,"SELFTEST_INVALID_ARTIFICIAL_PDF");
      const value={v:1,run_id:runId,phase:"prepared",rows,bytes:bytes.length,sha256:hash(bytes),
        md5_base64:hash(bytes,"base64","md5"),pdf_base64:bytes.toString("base64"),staging:"idle",
        uploads:rows.flatMap(row=>row.tokens.map(token=>({id:row.id,token,state:"idle"})))};
      // The entire ID/token plan is durable BEFORE any begin/control/MPU/PUT.
      try{await store.putDiagnosticRun(runId,value,{ifNoneMatch:"*"});}
      catch(e){if(!collision(e))throw e;}
    }
    const r=(await read()).value;
    return {result:"PREPARED",run_id:runId,phase:r.phase,test_ids:rows.map(r=>r.id)};
  }
  function ownControl(record,row,r){
    check(record?.v===2&&record.device===DEVICE&&record.request_id===row.request_id&&
      record.expected_sha256===r.sha256&&record.bytes===r.bytes&&record.md5_base64===r.md5_base64&&
      (!record.writer||(row.tokens.includes(record.writer.token)&&r.uploads.some(u=>
        u.id===row.id&&u.token===record.writer.token&&u.upload_id===record.writer.upload_id))),"SELFTEST_FOREIGN_CONTROL");
  }
  const tracked={...store,
    async getBegin(device,key){
      const row=rows.find(row=>row.request_id===key);
      check(device===DEVICE&&row,"SELFTEST_UNPLANNED_ID");
      const entry=await store.getBegin(device,key);
      if(entry)check(entry.value.id===row.id,"SELFTEST_FOREIGN_BEGIN_MAPPING");
      return entry;
    },
    async putBegin(device,key,value){
      await running();
      check(device===DEVICE&&rows.some(row=>row.request_id===key&&row.id===value.id),"SELFTEST_UNPLANNED_ID");
      return store.putBegin(device,key,value);
    },
    async putState(id,value,condition){
      const r=(await read()).value;check(r.phase==="running","SELFTEST_RUN_STOPPED");
      const row=rows.find(row=>row.id===id);check(row,"SELFTEST_UNPLANNED_ID");
      ownControl(value,row,r);return store.putState(id,value,condition);
    },
    async startPublication(id,sha256,token){
      await update(r=>{check(r.phase==="running"&&r.sha256===sha256,"SELFTEST_RUN_STOPPED");
        const u=r.uploads.find(u=>u.id===id&&u.token===token);check(u?.state==="idle","SELFTEST_WRITER_ALREADY_STARTED");u.state="creating";});
      const uploadId=await store.startPublication(id,sha256,token);
      // Lost response leaves a durable creating intent. List by planned exact key
      // can find the empty orphan; no part/Complete is allowed before this CAS.
      await update(r=>{check(r.phase==="running","SELFTEST_RUN_STOPPED");const u=r.uploads.find(u=>u.id===id&&u.token===token);
        u.state="ready";u.upload_id=uploadId;});
      return uploadId;
    },
    async writePublicationPart(...args){await running();return store.writePublicationPart(...args);},
    async completePublication(...args){await running();return store.completePublication(...args);}
  };
  async function status(){
    const r=(await read()).value,objects=[];
    for(const row of rows){
      const state=await store.getState(row.id);if(state)ownControl(state.value,row,r);
      const staging=await store.readStaging(row.id,16384),object=await store.headPublished(row.id);
      const uploads=await store.listPublicationUploads(row.id);
      objects.push({id:row.id,control:state?.value.phase||"absent",staging_present:!!staging,
        public_present:!!object,upload_ids:uploads});
    }
    return {result:"STATUS",run_id:runId,phase:r.phase,test_ids:rows.map(r=>r.id),objects,
      pending_creates:r.uploads.filter(u=>u.state==="creating").map(u=>u.id),staging_state:r.staging};
  }
  async function cleanup(){
    await update(r=>{r.phase="cleaning";}); // Permanent stop; the run can never be run again.
    let r=(await read()).value;
    for(const row of rows){
      let state=await store.getState(row.id);
      if(!state){
        // Fence a begin/control PUT whose response/request is still in flight.
        const value={v:2,device:DEVICE,phase:"issued",bytes:r.bytes,md5_base64:r.md5_base64,
          created_at:0,request_id:row.request_id,expected_sha256:r.sha256};
        try{await store.putState(row.id,value,{ifNoneMatch:"*"});}
        catch(e){if(!collision(e))throw e;}
        state=await store.getState(row.id);
      }
      ownControl(state?.value,row,r);
      const listed=await store.listPublicationUploads(row.id);
      const known=r.uploads.filter(u=>u.id===row.id&&u.state==="ready").map(u=>u.upload_id);
      const unknown=listed.filter(id=>!known.includes(id));
      const creating=r.uploads.filter(u=>u.id===row.id&&u.state==="creating");
      check(!unknown.length||(creating.length===1&&unknown.length===1),"SELFTEST_UNEXPECTED_UPLOAD");
      const object=await store.headPublished(row.id);
      if(object)check(row.tokens.includes(object.token)&&object.sha256===r.sha256&&object.bytes===r.bytes,"SELFTEST_FOREIGN_OBJECT");
      // Only one Create can be outstanding: checks run sequentially and the run
      // CAS is single-use. Bind its lost reply only when the match is unambiguous.
      if(creating.length===1&&unknown.length===1){
        await update(value=>{const u=value.uploads.find(u=>u.token===creating[0].token);
          u.state="ready";u.upload_id=unknown[0];});r=(await read()).value;
      }
      for(const uploadId of new Set([...known,...listed]))
        check(await store.abortPublication(row.id,uploadId),"SELFTEST_CLEANUP_ABORT_UNCONFIRMED");
      if(object)await store.removePublished(row.id);
      if(row.id===rows[0].id&&r.staging==="writing"){
        const file=await store.readStaging(row.id,16384);
        if(file){check(file.bytes.length===r.bytes&&hash(file.bytes)===r.sha256,"SELFTEST_STAGING_CONFLICT");
          await update(value=>{value.staging="done";});r=(await read()).value;}
      }
      await makeWorkflow(store,{viewerUrl,newId:()=>row.tokens[0]}).revoke({id:row.id},DEVICE);
      check(!(await store.headPublished(row.id)),"SELFTEST_PUBLIC_OBJECT_REAPPEARED");
      check(!(await store.readStaging(row.id,16384)),"SELFTEST_STAGING_REAPPEARED");
      check((await store.listPublicationUploads(row.id)).length===0,"SELFTEST_UPLOADS_REMAIN");
    }
    r=(await read()).value;
    check(!r.uploads.some(u=>u.state==="creating")&&r.staging!=="writing","SELFTEST_PENDING_IO_RECHECK");
    await update(value=>{value.phase="cleaned";});
    return {result:"CLEANED",run_id:runId,test_ids:rows.map(r=>r.id),known_uploads_fenced:true,
      public_absence_verified:true,tombstones_retained:true};
  }
  return {rows,read,update,tracked,prepare,status,cleanup,running};
}
module.exports={journal,DEVICE};

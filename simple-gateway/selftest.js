"use strict";

/**
 * Temporary PRIVATE Cloud Functions test entrypoint, never production.
 * Entrypoint: selftest.handler. Guarded by SELFTEST_ENABLED === "true".
 *
 * One invocation owns begin -> signed PUT -> staging SHA-256 validation;
 * optionally publish -> anonymous GET, returning only synthetic viewer URL.
 * A separate private invocation revokes. No third-party invocation credentials,
 * real customer files, exported S3 tokens, or printed presigned URLs.
 *
 * IMPORTANT: This verifies internal workflow / S3, NOT Android authentication
 * or an actual outside-client call to the private function.
 */
const {randomBytes,createHash}=require("node:crypto");
const {S3Client}=require("@aws-sdk/client-s3");
const {PDFDocument}=require("pdf-lib");
const {credentialProvider}=require("./ephemeral");
const {makeWorkflow,FlowError,MAX}=require("./workflow");
const {__testing}=require("./index");

const DEVICE="cloud-selftest";
const STAGING=process.env.STAGING_BUCKET;
const PUBLIC=process.env.PUBLIC_BUCKET;
const VIEWER=process.env.VIEWER_URL ||
  "https://grigori84.github.io/-KuzovPRO-PDF-Test./client.html";
const ID=/^[0-9a-f]{32}$/;
const sha256=bytes=>createHash("sha256").update(bytes).digest("hex");
const md5=bytes=>createHash("md5").update(bytes).digest("base64");
const reply=(statusCode,body)=>({
  statusCode,isBase64Encoded:false,
  headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"},
  body:JSON.stringify(body)
});
function configuration(){
  if(process.env.SELFTEST_ENABLED!=="true")throw new FlowError(503,"SELFTEST_DISABLED");
  if(!STAGING||!PUBLIC||STAGING===PUBLIC)throw new FlowError(503,"INVALID_BUCKET_CONFIG");
  if(!VIEWER.startsWith("https://"))throw new FlowError(503,"INVALID_VIEWER_URL");
}
function storage(){
  const client=new S3Client({
    endpoint:"https://storage.yandexcloud.net",region:"ru-central1",
    forcePathStyle:true,requestChecksumCalculation:"WHEN_REQUIRED",
    credentials:credentialProvider()
  });
  return __testing.adapter(client);
}
function workflow(store){
  return makeWorkflow(store,{viewerUrl:VIEWER,newId:()=>randomBytes(16).toString("hex")});
}
async function artificialPdf(){
  const doc=await PDFDocument.create();
  doc.setTitle("KuzovPRO artificial PDF test only");
  doc.setAuthor("KuzovPRO test harness");
  doc.addPage([420,300]);
  return Buffer.from(await doc.save());
}
function parseInput(event){
  if(event && typeof event==="object" && typeof event.operation==="string")return event;
  if(typeof event?.body==="string"){
    const parsed=JSON.parse(event.body);
    if(parsed && !Array.isArray(parsed) && typeof parsed==="object")return parsed;
  }
  throw new FlowError(400,"INVALID_TEST_REQUEST");
}
function publicObjectUrl(id){
  return "https://storage.yandexcloud.net/" + encodeURIComponent(PUBLIC) +
    "/estimates/" + id + ".pdf";
}
async function upload(mode){
  const bytes=await artificialPdf();
  const store=storage(),flow=workflow(store);
  let id=null,stage="begin";
  try{
    const ticket=await flow.begin({bytes:bytes.length,md5_base64:md5(bytes)},DEVICE);
    id=ticket.id;
    stage="put";
    const signedUrl=new URL(ticket.upload_url);
    if(signedUrl.protocol!=="https:"||signedUrl.hostname!=="storage.yandexcloud.net")
      throw new FlowError(503,"UNEXPECTED_PUT_HOST");
    const put=await fetch(ticket.upload_url,{
      method:"PUT",redirect:"error",
      headers:ticket.headers,body:bytes,signal:AbortSignal.timeout(30000)
    });
    if(!put.ok)throw new FlowError(502,"PUT_HTTP_"+put.status);
    stage="staging-check";
    const staged=await store.readStaging(id,MAX);
    const matched=staged?.bytes?.length===bytes.length &&
      sha256(staged.bytes)===sha256(bytes);
    if(!matched)throw new FlowError(502,"STAGING_SHA256_MISMATCH");

    if(mode==="upload"){
      stage="cleanup";
      const revoked=await flow.revoke({id},DEVICE);
      const gone=await store.readStaging(id,MAX);
      if(gone)throw new FlowError(503,"STAGING_DELETE_UNCONFIRMED");
      return {
        result:"PASS",operation:"upload-only",
        put_status:put.status,bytes:bytes.length,sha256_match:true,
        revoked:revoked.revoked,staging_deleted:true
      };
    }

    stage="publish";
    const pub=await flow.publish({
      id,bytes:bytes.length,sha256:sha256(bytes)
    },DEVICE);
    stage="anonymous-get";
    const open=await fetch(publicObjectUrl(id)+"?test="+randomBytes(6).toString("hex"),{
      method:"GET",redirect:"error",signal:AbortSignal.timeout(15000)
    });
    if(!open.ok)throw new FlowError(502,"PUBLIC_GET_HTTP_"+open.status);
    const content=Buffer.from(await open.arrayBuffer());
    if(content.length!==bytes.length||sha256(content)!==sha256(bytes))
      throw new FlowError(502,"PUBLIC_SHA256_MISMATCH");
    return {
      result:"PASS",operation:"publish",
      id,put_status:put.status,publish_status:200,
      public_get_status:open.status,bytes:bytes.length,
      sha256_match:true,viewer_url:pub.url,
      note:"Synthetic PDF is public until a later revoke selftest call"
    };
  }catch(err){
    // Never attempt unsafe concurrent revoke when publication may be in flight.
    // Return test ID for deliberate, separate recovery if one was created.
    err.testStage=stage;
    err.testId=id;
    throw err;
  }
}
async function revokeTest(id){
  if(typeof id!=="string"||!ID.test(id))throw new FlowError(400,"INVALID_TEST_ID");
  const store=storage(),flow=workflow(store);
  const before=await store.getState(id);
  if(!before||before.value?.device!==DEVICE)
    throw new FlowError(403,"NOT_A_SELFTEST_OBJECT");
  const bytes=before.value.bytes,hash=before.value.sha256;
  const done=await flow.revoke({id},DEVICE);
  const response=await fetch(publicObjectUrl(id)+"?test="+randomBytes(6).toString("hex"),{
    method:"GET",redirect:"error",signal:AbortSignal.timeout(15000)
  });
  const publicUnavailable=response.status===403||response.status===404;
  if(!publicUnavailable)throw new FlowError(503,"PUBLIC_LINK_STILL_ACCESSIBLE");
  let afterRevocationStatus="not-checked";
  if(typeof hash==="string"){
    try{await flow.publish({id,bytes,sha256:hash},DEVICE);}
    catch(err){afterRevocationStatus=err instanceof FlowError ? err.status : "error";}
  }
  if(afterRevocationStatus!==410)
    throw new FlowError(503,"REVOCATION_GUARD_UNCONFIRMED");
  const again=await flow.revoke({id},DEVICE);
  return {result:"PASS",operation:"revoke",revoked:done.revoked,
    public_get_status:response.status,republication_status:afterRevocationStatus,
    repeat_revoke:again.revoked};
}

module.exports.handler=async event=>{
  let phase="start",testId=null;
  try{
    configuration();
    const body=parseInput(event);
    if(body.operation==="upload"||body.operation==="publish"){
      const result=await upload(body.operation);
      return reply(200,result);
    }
    if(body.operation==="revoke"){
      return reply(200,await revokeTest(body.id));
    }
    return reply(400,{error:"UNKNOWN_SELFTEST_OPERATION"});
  }catch(err){
    phase=err.testStage||phase;
    testId=err.testId||null;
    // Do not log tokens, presigned links, secret headers or PDF bytes.
    console.error("pdf_selftest_failure",err?.name||"Error");
    return reply(err instanceof FlowError?err.status:503,{
      error:err instanceof FlowError?err.code:"SELFTEST_FAILED",phase,
      ...(testId?{test_id:testId}:{}),
      note:"No automatic revoke if publication could still be in flight"
    });
  }
};

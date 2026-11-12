"use strict";
// PRIVATE diagnostics only; never route this entrypoint through API Gateway.
// Run ID and immutable plan must be durable before any synthetic control/PUT/MPU.
const {S3Client}=require("@aws-sdk/client-s3");
const {PDFDocument}=require("pdf-lib");
const {credentialProvider}=require("./ephemeral");
const {FlowError}=require("./workflow");
const {__testing}=require("./index");
const {runRecoveryChecks}=require("./recovery-selftest");
const STAGING=process.env.STAGING_BUCKET,PUBLIC=process.env.PUBLIC_BUCKET;
const VIEWER=process.env.VIEWER_URL||"https://grigori84.github.io/-KuzovPRO-PDF-Test./client.html";
const ID=/^[0-9a-f]{32}$/;
const reply=(statusCode,body)=>({statusCode,isBase64Encoded:false,
  headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"},body:JSON.stringify(body)});
function configuration(){
  if(process.env.SELFTEST_ENABLED!=="true")throw new FlowError(503,"SELFTEST_DISABLED");
  if(!STAGING||!PUBLIC||STAGING===PUBLIC)throw new FlowError(503,"INVALID_BUCKET_CONFIG");
  if(!VIEWER.startsWith("https://"))throw new FlowError(503,"INVALID_VIEWER_URL");
}
function storage(){return __testing.adapter(new S3Client({
  endpoint:"https://storage.yandexcloud.net",region:"ru-central1",forcePathStyle:true,
  requestChecksumCalculation:"WHEN_REQUIRED",maxAttempts:1,credentials:credentialProvider()
}));}
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
module.exports.handler=async event=>{
  try{
    if(event?.httpMethod||event?.requestContext)throw new FlowError(403,"PRIVATE_SELFTEST_ONLY");
    configuration();
    const body=parseInput(event);
    if(body.operation==="recovery"){
      if(process.env.GATEWAY_ENABLED==="true")throw new FlowError(503,"RECOVERY_SELFTEST_REQUIRES_DISABLED_GATEWAY");
      const result=await runRecoveryChecks(storage(),body.action==="prepare"?await artificialPdf():null,{
        viewerUrl:VIEWER,runId:body.run_id,action:body.action,
        async uploadStaging(ticket,bytes){
          const url=new URL(ticket.upload_url);
          if(url.protocol!=="https:"||url.hostname!=="storage.yandexcloud.net")throw new FlowError(503,"UNEXPECTED_PUT_HOST");
          const response=await fetch(url,{method:"PUT",redirect:"error",headers:ticket.headers,body:bytes,signal:AbortSignal.timeout(30000)});
          if(!response.ok)throw new FlowError(502,"SELFTEST_PUT_FAILED");
        }
      });
      return reply(200,{...result,runtime:process.version,
        sdk_version:require("@aws-sdk/client-s3/package.json").version,pdf_lib_version:require("pdf-lib/package.json").version});
    }
    return reply(400,{error:"UNKNOWN_SELFTEST_OPERATION"});
  }catch(err){
    // Do not log tokens, presigned links, secret headers or PDF bytes.
    console.error("pdf_selftest_failure",err?.name||"Error");
    return reply(err instanceof FlowError?err.status:503,{
      error:err instanceof FlowError?err.code:"SELFTEST_FAILED",
      ...(typeof event?.run_id==="string"&&ID.test(event.run_id)?{run_id:event.run_id}:{}),
      ...(Array.isArray(err.testIds)?{test_ids:err.testIds.filter(id=>typeof id==="string"&&ID.test(id))}:{}),
      note:"Read the durable selftest-runs/<run_id>.json registry; use private status/cleanup, never restart run"
    });
  }
};

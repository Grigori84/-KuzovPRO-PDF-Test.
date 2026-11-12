"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Readable}=require("node:stream");
const {createHash}=require("node:crypto");
const sdk=require("@aws-sdk/client-s3");
process.env.STAGING_BUCKET="offline-storage-private";
process.env.PUBLIC_BUCKET="offline-storage-public";
const {adapter}=require("../index").__testing;
const noUpload=()=>Object.assign(Error("NoSuchUpload"),{name:"NoSuchUpload",$metadata:{httpStatusCode:404}});

test("multipart writer has immutable token/hash, MD5, one part and a conditional completion",async()=>{
  const id="a".repeat(32),token="b".repeat(32),hash="c".repeat(64),bytes=Buffer.from("offline bytes"),seen=[];
  const store=adapter({async send(command){seen.push(command);
    if(command instanceof sdk.CreateMultipartUploadCommand)return {UploadId:"opaque-upload"};
    if(command instanceof sdk.UploadPartCommand)return {ETag:'"part"'};
    if(command instanceof sdk.CompleteMultipartUploadCommand)return {};
    throw Error("unexpected command");
  }});
  const upload=await store.startPublication(id,hash,token);
  const etag=await store.writePublicationPart(id,upload,bytes);await store.completePublication(id,upload,etag);
  assert.equal(seen[0].input.Bucket,"offline-storage-public");assert.equal(seen[0].input.Key,"estimates/"+id+".pdf");
  assert.deepEqual(seen[0].input.Metadata,{sha256:hash,"publication-token":token});
  assert.equal(seen[1].input.ContentMD5,createHash("md5").update(bytes).digest("base64"));
  assert.equal(seen[1].input.ContentLength,bytes.length);assert.equal(seen[1].input.PartNumber,1);
  assert.equal(seen[2].input.IfNoneMatch,"*");assert.equal(seen[2].input.UploadId,upload);
  assert.deepEqual(seen[2].input.MultipartUpload.Parts,[{PartNumber:1,ETag:etag}]);
  assert.equal(seen.some(c=>c instanceof sdk.PutObjectCommand),false);
});
test("abort is confirmed only when ListParts says NoSuchUpload",async()=>{
  for(const active of [true,false]) {
    const seen=[],store=adapter({async send(c){seen.push(c);
      if(c instanceof sdk.AbortMultipartUploadCommand)return {};
      if(c instanceof sdk.ListPartsCommand){if(active)return {Parts:[]};throw noUpload();}
      throw Error("unexpected command");
    }});
    assert.equal(await store.abortPublication("a".repeat(32),"upload"),!active);
    assert.equal(seen.length,2);assert.equal(seen[0].input.UploadId,"upload");assert.equal(seen[1].input.UploadId,"upload");
  }
});
test("already consumed upload is idempotently aborted but access errors never prove a fence",async()=>{
  const ended=adapter({async send(){throw noUpload();}});
  assert.equal(await ended.abortPublication("a".repeat(32),"upload"),true);
  const denied=adapter({async send(){throw Object.assign(Error("denied"),{name:"AccessDenied",$metadata:{httpStatusCode:403}});}});
  await assert.rejects(denied.abortPublication("a".repeat(32),"upload"),e=>e.name==="AccessDenied");
});
test("missing bucket, read failures and missing control ETag fail closed",async()=>{
  const badBucket=adapter({async send(){throw Object.assign(Error("missing bucket"),{name:"NoSuchBucket",$metadata:{httpStatusCode:404}});}});
  await assert.rejects(badBucket.headPublished("a".repeat(32)),e=>e.name==="NoSuchBucket");
  const missingEtag=adapter({async send(){return {Body:Readable.from([Buffer.from('{"v":2}')])};}});
  await assert.rejects(missingEtag.getState("a".repeat(32)),e=>e.code==="CONTROL_ETAG_MISSING");
  const missing=adapter({async send(){throw Object.assign(Error("missing key"),{name:"NoSuchKey",$metadata:{httpStatusCode:404}});}});
  assert.equal(await missing.headPublished("a".repeat(32)),null);
});
test("public ownership metadata and hash are taken from the ETag-bound GET",async()=>{
  const token="d".repeat(32),bytes=Buffer.from("actual PDF bytes"),store=adapter({async send(c){
    if(c instanceof sdk.HeadObjectCommand)return {ETag:'"e"',ContentLength:bytes.length,Metadata:{"publication-token":"untrusted-head"}};
    if(c instanceof sdk.GetObjectCommand){assert.equal(c.input.IfMatch,'"e"');return {ETag:'"e"',Body:Readable.from([bytes]),Metadata:{"publication-token":token,sha256:"f".repeat(64)}};}
    throw Error("unexpected command");
  }});
  const result=await store.headPublished("a".repeat(32));assert.equal(result.token,token);
  assert.equal(result.sha256,createHash("sha256").update(bytes).digest("hex"));
});
test("begin mappings are conditional private writes and cannot overwrite a previous operation",async()=>{
  const calls=[],store=adapter({async send(c){calls.push(c);return {ETag:'"map"'};}});
  await store.putBegin("phone1","e".repeat(32),{id:"a".repeat(32)});
  const command=calls[0];assert.ok(command instanceof sdk.PutObjectCommand);
  assert.equal(command.input.Bucket,"offline-storage-private");assert.equal(command.input.IfNoneMatch,"*");
  assert.equal(command.input.Key,"begin-requests/phone1/"+"e".repeat(32)+".json");
});
test("AWS SDK really serializes If-None-Match for multipart complete without a network call",async()=>{
  let captured;
  const client=new sdk.S3Client({region:"ru-central1",endpoint:"https://storage.invalid",forcePathStyle:true,maxAttempts:1,
    requestChecksumCalculation:"WHEN_REQUIRED",credentials:{accessKeyId:"offline",secretAccessKey:"offline"},
    requestHandler:{async handle(request){captured=request;return {response:{statusCode:200,headers:{"content-type":"application/xml"},
      body:Readable.from([Buffer.from('<CompleteMultipartUploadResult><ETag>"etag"</ETag></CompleteMultipartUploadResult>')])}};}}});
  try {
    await adapter(client).completePublication("a".repeat(32),"opaque-upload",'"part"');
    assert.equal(captured.headers["if-none-match"],"*");assert.equal(captured.query.uploadId,"opaque-upload");
    assert.equal(captured.method,"POST");assert.equal(captured.hostname,"storage.invalid");
  }finally{client.destroy();}
});
test("diagnostic registry uses private CAS and exact-key multipart discovery paginates without foreign uploads",async()=>{
  const calls=[],id="a".repeat(32),run="b".repeat(32);
  const store=adapter({async send(c){calls.push(c);
    if(c instanceof sdk.PutObjectCommand)return {ETag:'"registry"'};
    if(c instanceof sdk.ListMultipartUploadsCommand){
      if(!c.input.KeyMarker)return {Uploads:[{Key:"estimates/"+id+".pdf",UploadId:"one"},
        {Key:"estimates/"+id+".pdf-other",UploadId:"foreign"}],IsTruncated:true,
        NextKeyMarker:"marker",NextUploadIdMarker:"one"};
      return {Uploads:[{Key:"estimates/"+id+".pdf",UploadId:"two"}],IsTruncated:false};
    }
    throw Error("unexpected command");
  }});
  await store.putDiagnosticRun(run,{v:1},{ifNoneMatch:"*"});
  assert.equal(calls[0].input.Key,"selftest-runs/"+run+".json");
  assert.equal(calls[0].input.Bucket,"offline-storage-private");assert.equal(calls[0].input.IfNoneMatch,"*");
  await assert.rejects(store.putDiagnosticRun(run,{},{}),/INVALID_DIAGNOSTIC_CAS/);
  assert.deepEqual(await store.listPublicationUploads(id),["one","two"]);
  assert.equal(calls[1].input.Prefix,"estimates/"+id+".pdf");assert.equal(calls[2].input.UploadIdMarker,"one");
});

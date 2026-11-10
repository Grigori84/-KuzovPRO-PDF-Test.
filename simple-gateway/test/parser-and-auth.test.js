"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {PDFDocument}=require("pdf-lib");
const {generateKeyPairSync,createHash,sign}=require("node:crypto");
const {__testing}=require("../index.js");
const parse=__testing.adapter({send:async()=>{throw Error("unexpected network")}}).parsePdf;

test("generated PDF with a valid page passes structural parsing",async()=>{
  const doc=await PDFDocument.create();
  doc.addPage([595,842]);
  const bytes=Buffer.from(await doc.save());
  assert.equal(await parse(bytes),true);
});
test("PDF marker and EOF alone are not enough",async()=>{
  const fake=Buffer.from("%PDF-1.7\nnot really an xref\n%%EOF\n");
  assert.equal(await parse(fake),false);
});
test("random binary data is rejected",async()=>{
  assert.equal(await parse(Buffer.alloc(100,7)),false);
});
test("device signature uses DER/SPKI P-256 and signed raw body",()=>{
  const pair=generateKeyPairSync("ec",{namedCurve:"prime256v1"});
  const publicKey=pair.publicKey.export({format:"der",type:"spki"}).toString("base64");
  const time=String(Math.floor(Date.now()/1000)),nonce="f".repeat(32);
  const raw='{"operation":"revoke","id":"'+ "0".repeat(32) +'"}';
  const data=time+"\n"+nonce+"\n"+createHash("sha256").update(raw).digest("hex");
  const signature=sign("sha256",Buffer.from(data),pair.privateKey).toString("base64");
  const evt={headers:{
    "x-kpro-device":"phone_1","x-kpro-time":time,
    "x-kpro-nonce":nonce,"x-kpro-signature":signature
  }};
  const keys={phone_1:publicKey};
  assert.deepEqual(__testing.auth(evt,raw,keys),{device:"phone_1",nonce});
  assert.equal(__testing.auth(evt,raw+" ",keys),null);
  evt.headers["x-kpro-device"]="phone/unsafe";
  assert.equal(__testing.auth(evt,raw,keys),null);
});


test('published checksum is calculated from stored bytes, not metadata', async () => {
  const {Readable}=require('node:stream');
  const {HeadObjectCommand,GetObjectCommand}=require('@aws-sdk/client-s3');
  const fake={async send(command){
    if(command instanceof HeadObjectCommand)return {ContentLength:3,ETag:'"e"',Metadata:{sha256:'a'.repeat(64)}};
    if(command instanceof GetObjectCommand){assert.equal(command.input.IfMatch,'"e"');return {Body:Readable.from([Buffer.from('bad')])};}
    throw Error('unexpected command');
  }};
  const result=await __testing.adapter(fake).headPublished('f'.repeat(32));
  assert.equal(result.sha256,require('node:crypto').createHash('sha256').update('bad').digest('hex'));
  assert.notEqual(result.sha256,'a'.repeat(64));
});

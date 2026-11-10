"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {generateKeyPairSync,createHash,randomBytes,sign}=require("node:crypto");
const keys=generateKeyPairSync("ec",{namedCurve:"prime256v1"});
process.env.GATEWAY_ENABLED="true";
process.env.STAGING_BUCKET="offline-private-bucket";
process.env.PUBLIC_BUCKET="offline-public-bucket";
process.env.STORAGE_ACCESS_KEY_ID="offline-key";
process.env.STORAGE_SECRET_ACCESS_KEY="offline-secret";
process.env.DEVICE_PUBLIC_KEYS_JSON=JSON.stringify({
  testphone:keys.publicKey.export({format:"der",type:"spki"}).toString("base64")
});
const {handler}=require("../index.js");
function request(body){
  const raw=JSON.stringify(body);
  const now=String(Math.floor(Date.now()/1000));
  const nonce=randomBytes(16).toString("hex");
  const hash=createHash("sha256").update(raw).digest("hex");
  const sig=sign("sha256",Buffer.from(now+"\n"+nonce+"\n"+hash),keys.privateKey)
    .toString("base64");
  return {httpMethod:"POST",body:raw,headers:{
    "x-kpro-device":"testphone","x-kpro-time":now,
    "x-kpro-nonce":nonce,"x-kpro-signature":sig
  }};
}
test("function disabled by default",async()=>{
  process.env.GATEWAY_ENABLED="false";
  try{
    const result=await handler(request({operation:"begin"}));
    assert.equal(result.statusCode,503);
    assert.equal(JSON.parse(result.body).error,"GATEWAY_DISABLED");
  }finally{process.env.GATEWAY_ENABLED="true";}
});
test("wrong HTTP method rejected before any storage call",async()=>{
  const evt=request({operation:"begin"});evt.httpMethod="GET";
  assert.equal((await handler(evt)).statusCode,405);
});
test("unknown device rejected before any storage call",async()=>{
  const evt=request({operation:"begin"});
  evt.headers["x-kpro-device"]="stranger";
  assert.equal((await handler(evt)).statusCode,401);
});
test("tampered body signature rejected",async()=>{
  const evt=request({operation:"begin",bytes:100});
  evt.body=JSON.stringify({operation:"revoke",id:"a".repeat(32)});
  assert.equal((await handler(evt)).statusCode,401);
});
test("expired signature rejected",async()=>{
  const evt=request({operation:"begin"});
  evt.headers["x-kpro-time"]=String(Math.floor(Date.now()/1000)-1000);
  assert.equal((await handler(evt)).statusCode,401);
});
test("oversized body rejected before any storage call",async()=>{
  const evt=request({operation:"begin"});
  evt.body="x".repeat(4097);
  assert.equal((await handler(evt)).statusCode,413);
});

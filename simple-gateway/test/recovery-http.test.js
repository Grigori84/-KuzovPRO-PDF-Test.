"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {generateKeyPairSync,createHash,sign,randomBytes}=require("node:crypto");
process.env.STAGING_BUCKET="offline-recovery-private";
process.env.PUBLIC_BUCKET="offline-recovery-public";
process.env.GATEWAY_ENABLED="true";
const keys={phone1:generateKeyPairSync("ec",{namedCurve:"prime256v1"}),phone2:generateKeyPairSync("ec",{namedCurve:"prime256v1"})};
process.env.DEVICE_PUBLIC_KEYS_JSON=JSON.stringify(Object.fromEntries(Object.entries(keys).map(([id,pair])=>
  [id,pair.publicKey.export({format:"der",type:"spki"}).toString("base64")])));
const {__testing}=require("../index");
const {fixture}=require("../test-support/memory-store");
function request(body,device="phone1",{nonce=randomBytes(16).toString("hex"),time=String(Math.floor(Date.now()/1000))}={}) {
  const raw=JSON.stringify(body),canonical=time+"\n"+nonce+"\n"+createHash("sha256").update(raw).digest("hex");
  return {httpMethod:"POST",body:raw,headers:{"x-kpro-device":device,"x-kpro-time":time,"x-kpro-nonce":nonce,
    "x-kpro-signature":sign("sha256",Buffer.from(canonical),keys[device].privateKey).toString("base64")}};
}
function setup() {
  const f=fixture();let sequence=0;
  const handler=__testing.makeHandler({storageFactory:()=>f.store,workflowOptions:{
    viewerUrl:"https://example.invalid/client.html",newId:()=> (++sequence).toString(16).padStart(32,"0")}});
  return {...f,handler};
}
const json=r=>JSON.parse(r.body);
test("disabled gateway performs no nonce or control operation",async()=>{
  const f=setup();delete process.env.GATEWAY_ENABLED;
  try {const r=await f.handler(request(f.body));assert.equal(r.statusCode,503);assert.equal(json(r).error,"GATEWAY_DISABLED");assert.equal(f.store.nonces.size,0);}
  finally {process.env.GATEWAY_ENABLED="true";}
});
test("a fresh signature recovers a lost begin response; exact replay remains 409",async()=>{
  const f=setup(),original=request(f.body),first=await f.handler(original);
  assert.equal(first.statusCode,200);assert.equal(json(first).request_id,f.body.request_id);
  const replay=await f.handler(original);assert.equal(replay.statusCode,409);assert.equal(json(replay).error,"REPLAYED_REQUEST");
  const recovered=await f.handler(request(f.body));assert.equal(recovered.statusCode,200);assert.equal(json(recovered).id,json(first).id);
  assert.equal(f.store.begins.size,1);assert.equal(f.store.states.size,1);
});
test("eight independent authenticated retries commit one begin mapping",async()=>{
  const f=setup(),results=await Promise.all(Array.from({length:8},()=>f.handler(request(f.body))));
  assert.ok(results.every(r=>r.statusCode===200));assert.equal(new Set(results.map(r=>json(r).id)).size,1);
  assert.equal(f.store.nonces.size,8);assert.equal(f.store.states.size,1);
});
test("nonce scope and request mapping scope are separate for the two masters",async()=>{
  const f=setup(),nonce="e".repeat(32);
  const a=await f.handler(request(f.body,"phone1",{nonce}));
  const b=await f.handler(request(f.body,"phone2",{nonce}));
  assert.equal(a.statusCode,200);assert.equal(b.statusCode,200);assert.notEqual(json(a).id,json(b).id);
  const foreign=await f.handler(request({operation:"revoke",id:json(a).id},"phone2"));
  assert.equal(foreign.statusCode,403);assert.equal(f.store.states.get(json(a).id).value.phase,"issued");
});
test("altered body, time, nonce, device or signature is rejected before storage",async()=>{
  for(const change of [evt=>{evt.body+=" ";},evt=>{evt.headers["x-kpro-time"]="1000000000";},
    evt=>{evt.headers["x-kpro-nonce"]="bad";},evt=>{evt.headers["x-kpro-device"]="unknown";},
    evt=>{evt.headers["x-kpro-signature"]="AAAA";}]) {
    const f=setup(),event=request(f.body);change(event);
    assert.equal((await f.handler(event)).statusCode,401);assert.equal(f.store.nonces.size,0);assert.equal(f.store.states.size,0);
  }
});
test("a reused operation key with altered PDF information cannot allocate an ID",async()=>{
  const f=setup();assert.equal((await f.handler(request(f.body))).statusCode,200);
  const r=await f.handler(request({...f.body,sha256:"b".repeat(64)}));
  assert.equal(r.statusCode,409);assert.equal(json(r).error,"BEGIN_REQUEST_CONFLICT");assert.equal(f.store.states.size,1);
});
test("a lost ticket response recovers under the same key after HTTP 503",async()=>{
  const f=setup();f.store.after.signUpload=()=>{delete f.store.after.signUpload;throw Error("offline ticket failure");};
  const result=await f.handler(request(f.body));assert.equal(result.statusCode,503);
  assert.deepEqual(json(result),{error:"GATEWAY_UNAVAILABLE"});
  const id=[...f.store.states.keys()][0],retry=await f.handler(request(f.body));
  assert.equal(retry.statusCode,200);assert.equal(json(retry).id,id);assert.equal(f.store.states.size,1);
});
test("installed Android 1.1.1 legacy JSON succeeds on the new fenced workflow",async()=>{
  const f=setup(),ticket=await f.handler(request({operation:"begin",bytes:f.body.bytes,md5_base64:f.body.md5_base64}));
  assert.equal(ticket.statusCode,200);const id=json(ticket).id;f.store.stage.set(id,f.bytes);
  const published=await f.handler(request({operation:"publish",...f.args(id)}));
  assert.equal(published.statusCode,200);assert.equal(json(published).url,"https://example.invalid/client.html#id="+id);
  const revoked=await f.handler(request({operation:"revoke",id}));assert.equal(revoked.statusCode,200);assert.equal(json(revoked).revoked,true);
  assert.equal(f.store.objects.size,0);
  const late=await f.handler(request({operation:"publish",...f.args(id)}));assert.equal(late.statusCode,410);
});

test("terminal begin recovery returns the original ID and key without issuing another ticket",async()=>{
  const f=setup(),first=await f.handler(request(f.body)),id=json(first).id;
  assert.equal((await f.handler(request({operation:"revoke",id}))).statusCode,200);
  const result=await f.handler(request(f.body));
  assert.equal(result.statusCode,410);
  assert.deepEqual(json(result),{error:"PUBLICATION_REVOKED",id,request_id:f.body.request_id,revoked:true});
  assert.equal(f.store.states.size,1);assert.equal(f.store.calls.signUpload,1);
});
test("the public handler never exposes private recovery selftests",async()=>{
  const f=setup(),result=await f.handler(request({operation:"recovery"}));
  assert.equal(result.statusCode,400);assert.equal(json(result).error,"UNKNOWN_OPERATION");assert.equal(f.store.states.size,0);
});

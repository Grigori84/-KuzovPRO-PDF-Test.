"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {makeWorkflow,MAX} = require("../workflow");

const HASH = "a".repeat(64);
const MD5 = "AAAAAAAAAAAAAAAAAAAAAA==";
function fixture() {
  const state = new Map(), stage = new Map(), published = new Map();
  const bytes = new Uint8Array([37,80,68,70,45,49,46,55,10,
    49,50,51,52,53,54,55,56,57,48,10,37,37,69,79,70,10]);
  let revision = 0, nextId=1;
  const precondition = () => {const e=new Error("PRECONDITION_FAILED");
    e.code="PRECONDITION_FAILED";throw e;};
  const store = {
    state,stage,published,bytes,
    beforeWrite: null,
    async putState(id,value,c={}) {
      const prev=state.get(id);
      if(c.ifNoneMatch==="*"&&prev)precondition();
      if(c.ifMatch&&(!prev||prev.etag!==c.ifMatch))precondition();
      const result={value:{...value},etag:"etag-"+(++revision)};
      state.set(id,result);return result;
    },
    async getState(id) {
      const v=state.get(id);
      return v?{value:{...v.value},etag:v.etag}:null;
    },
    async signUpload(id,size,md5){return {
      upload_url:"https://storage.example/"+id,headers:{"Content-MD5":md5},
      expires_seconds:300
    };},
    async readStaging(id) {
      const data=stage.get(id);
      return data?{bytes:data,contentType:"application/pdf"}:null;
    },
    async sha256(){return HASH;},
    async parsePdf(data){return data[0]===37;},
    async putPublishedOnce(id,data,sha) {
      if(store.beforeWrite)await store.beforeWrite();
      if(published.has(id))precondition();
      published.set(id,{bytes:data.length,sha256:sha});
    },
    async headPublished(id){return published.get(id)||null;},
    async removePublished(id){published.delete(id);},
    async removeStaging(id){stage.delete(id);}
  };
  const flow=makeWorkflow(store,{viewerUrl:"https://example.com/client.html",
    newId:()=>String(nextId++).padStart(32,"0")});
  async function begin(){
    const ticket=await flow.begin({bytes:bytes.length,md5_base64:MD5},"phone1");
    stage.set(ticket.id,bytes);return ticket.id;
  }
  return {store,flow,begin,bytes};
}
async function mustReject(p,status,code) {
  await assert.rejects(p,e=>e.status===status&&e.code===code);
}
test("begin, publish, retry, revoke; revoked URL never revives",async()=>{
  const {store,flow,begin,bytes}=fixture();const id=await begin();
  const a=await flow.publish({id,bytes:bytes.length,sha256:HASH},"phone1");
  assert.match(a.url,/#id=[a-f0-9]{32}$/);
  assert.equal(store.published.size,1);
  const b=await flow.publish({id,bytes:bytes.length,sha256:HASH},"phone1");
  assert.equal(b.already_published,true);
  assert.equal((await flow.revoke({id},"phone1")).revoked,true);
  assert.equal(store.published.size,0);
  assert.equal(store.state.get(id).value.phase,"revoked");
  await mustReject(flow.publish({id,bytes:bytes.length,sha256:HASH},"phone1"),
    410,"PUBLICATION_REVOKED");
});
test("revoke before publish denies even a late signed upload",async()=>{
  const {store,flow,begin,bytes}=fixture();const id=await begin();
  await flow.revoke({id},"phone1");
  store.stage.set(id,bytes); // an old signed URL is reused after delete
  await mustReject(flow.publish({id,bytes:bytes.length,sha256:HASH},"phone1"),
    410,"PUBLICATION_REVOKED");
});
test("concurrent publication permits only one state transition",async()=>{
  const {store,flow,begin,bytes}=fixture();const id=await begin();
  const arg={id,bytes:bytes.length,sha256:HASH};
  const outcomes=await Promise.allSettled([
    flow.publish(arg,"phone1"),flow.publish(arg,"phone1")
  ]);
  assert.equal(outcomes.filter(x=>x.status==="fulfilled").length,1);
  assert.equal(store.published.size,1);
});
test("revoke cannot overtake an in-flight publication",async()=>{
  const {store,flow,begin,bytes}=fixture();const id=await begin();
  let notify,unblock;
  const started=new Promise(resolve=>notify=resolve);
  store.beforeWrite=async()=>{notify();await new Promise(resolve=>unblock=resolve);};
  const running=flow.publish({id,bytes:bytes.length,sha256:HASH},"phone1");
  await started;
  await mustReject(flow.revoke({id},"phone1"),409,"PUBLISHING_IN_PROGRESS_RETRY");
  unblock();await running;
  assert.equal((await flow.revoke({id},"phone1")).revoked,true);
  assert.equal(store.published.size,0);
});
test("lost response with public object remains blocked until safe recovery",async()=>{
  const {store,flow,begin,bytes}=fixture();const id=await begin();
  const original=store.putPublishedOnce;
  store.putPublishedOnce=async(...args)=>{await original(...args);throw new Error("lost response");};
  const arg={id,bytes:bytes.length,sha256:HASH};
  await assert.rejects(flow.publish(arg,"phone1"));
  await mustReject(flow.publish(arg,"phone1"),409,"PUBLICATION_IN_PROGRESS");
  await mustReject(flow.revoke({id},"phone1"),409,"PUBLISHING_IN_PROGRESS_RETRY");
  assert.equal(store.state.get(id).value.phase,"publishing");
});
test("failed publication without public object stays blocked safely",async()=>{
  const {store,flow,begin,bytes}=fixture();const id=await begin();
  store.putPublishedOnce=async()=>{throw new Error("network timeout");};
  const arg={id,bytes:bytes.length,sha256:HASH};
  await assert.rejects(flow.publish(arg,"phone1"));
  await mustReject(flow.revoke({id},"phone1"),409,"PUBLISHING_IN_PROGRESS_RETRY");
  await mustReject(flow.publish(arg,"phone1"),409,"PUBLICATION_IN_PROGRESS");
});
test("retry revocation after interrupted delete",async()=>{
  const {store,flow,begin,bytes}=fixture();const id=await begin();
  await flow.publish({id,bytes:bytes.length,sha256:HASH},"phone1");
  const original=store.removePublished;let first=true;
  store.removePublished=async(id)=>{
    if(first){first=false;throw new Error("temporary failure");}
    return original(id);
  };
  await assert.rejects(flow.revoke({id},"phone1"));
  assert.equal(store.state.get(id).value.phase,"revoking");
  assert.equal((await flow.revoke({id},"phone1")).revoked,true);
  assert.equal(store.state.get(id).value.phase,"revoked");
});
test("reject wrong hash, foreign device and oversized uploads",async()=>{
  const {store,flow,begin,bytes}=fixture();const id=await begin();
  await mustReject(flow.publish({id,bytes:bytes.length,sha256:"b".repeat(64)},
    "phone1"),422,"HASH_MISMATCH");
  await mustReject(flow.revoke({id},"other-phone"),403,"PUBLICATION_ACCESS_DENIED");
  await mustReject(flow.begin({bytes:MAX+1,md5_base64:MD5},"phone1"),
    400,"INVALID_FILE_INFO");
  store.stage.set(id,new Uint8Array(22));
  await mustReject(flow.publish({id,bytes:bytes.length,sha256:HASH},"phone1"),
    422,"UPLOADED_FILE_MISMATCH");
});


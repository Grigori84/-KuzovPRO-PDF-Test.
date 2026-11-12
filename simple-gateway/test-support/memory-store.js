"use strict";
const {createHash} = require("node:crypto");
const {makeWorkflow} = require("../workflow");
const hash = b => createHash("sha256").update(b).digest("hex");
const md5 = b => createHash("md5").update(b).digest("base64");
const clone = value => JSON.parse(JSON.stringify(value));
function storageError(name, status) { return Object.assign(Error(name), {name, code:name, $metadata:{httpStatusCode:status}}); }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; }

// A linearizable S3 contract model, with faults either side of every commit.
// An upload ID is consumed once by complete/abort; it cannot create another object.
function memoryStore() {
  const states = new Map(), begins = new Map(), runs = new Map(), stage = new Map(), objects = new Map(), uploads = new Map(), nonces = new Set();
  const calls = {}, before = {}, after = {};
  let sequence = 0;
  const etag = () => '"version-' + (++sequence) + '"';
  const missingUpload = () => { throw storageError("NoSuchUpload", 404); };
  const precondition = () => { throw storageError("PreconditionFailed", 412); };
  const methods = {
    getDiagnosticRun(id){const r=runs.get(id);return r?clone(r):null;},
    putDiagnosticRun(id,value,condition){
      const old=runs.get(id);
      if(condition.ifNoneMatch==="*"&&old)precondition();
      if(condition.ifMatch&&old?.etag!==condition.ifMatch)precondition();
      const row={value:clone(value),etag:etag()};runs.set(id,row);return clone(row);
    },
    listPublicationUploads(id){return [...uploads].filter(([,u])=>u.id===id&&u.active).map(([key])=>key);},
    reserveNonce(device, nonce) { const key=device+'/'+nonce; if(nonces.has(key))return false; nonces.add(key); return true; },
    getBegin(device, key) { const row=begins.get(device+'/'+key); return row ? clone(row) : null; },
    putBegin(device, key, value) {
      const name=device+'/'+key; if(begins.has(name))precondition();
      const row={value:clone(value),etag:etag()}; begins.set(name,row); return clone(row);
    },
    getState(id) { const row=states.get(id); return row ? clone(row) : null; },
    putState(id, value, condition) {
      const old=states.get(id);
      if(!condition || (!condition.ifMatch && condition.ifNoneMatch!=="*")) throw Error("UNCONDITIONAL_CONTROL_WRITE");
      if(condition.ifNoneMatch==="*" && old)precondition();
      if(condition.ifMatch && old?.etag!==condition.ifMatch)precondition();
      const row={value:clone(value),etag:etag()}; states.set(id,row); return clone(row);
    },
    signUpload(id, bytes, digest) { return {upload_url:"https://storage.invalid/staging/"+id,
      headers:{"Content-Type":"application/pdf","Content-Length":String(bytes),"Content-MD5":digest,"If-None-Match":"*"},expires_seconds:300}; },
    readStaging(id) { const bytes=stage.get(id); return bytes ? {bytes:Buffer.from(bytes),contentType:"application/pdf"} : null; },
    sha256(bytes) { return hash(bytes); },
    parsePdf() { return true; }, // Production parser is tested separately against pdf-lib.
    startPublication(id, sha256, token) {
      const key="upload-"+(++sequence); uploads.set(key,{id,sha256,token,active:true,part:null}); return key;
    },
    writePublicationPart(id, key, bytes) {
      const upload=uploads.get(key); if(!upload?.active || upload.id!==id)missingUpload();
      upload.part=Buffer.from(bytes); return '"'+md5(bytes)+'"';
    },
    completePublication(id, key, part) {
      const upload=uploads.get(key); if(!upload?.active || upload.id!==id)missingUpload();
      if(!upload.part || part!=='"'+md5(upload.part)+'"')throw Error("InvalidPart");
      if(objects.has(id))precondition();
      objects.set(id,{body:Buffer.from(upload.part),token:upload.token,etag:etag()});
      upload.active=false;
    },
    abortPublication(id, key) {
      if(store.abortUnconfirmed)return false;
      const upload=uploads.get(key); if(upload && upload.id!==id)throw Error("WRONG_KEY");
      if(upload)upload.active=false; return true;
    },
    headPublished(id) {
      const obj=objects.get(id); return obj ? {bytes:obj.body.length,sha256:hash(obj.body),token:obj.token,etag:obj.etag} : null;
    },
    removePublished(id) { objects.delete(id); },
    removeStaging(id) { stage.delete(id); }
  };
  const store={states,begins,runs,stage,objects,uploads,nonces,calls,before,after,abortUnconfirmed:false};
  for(const [name,fn] of Object.entries(methods))store[name]=async (...args)=>{
    calls[name]=(calls[name]||0)+1;
    if(before[name])await before[name](...args);
    const result=fn(...args);
    if(after[name])await after[name](...args);
    return result;
  };
  return store;
}
function fixture(options={}) {
  const store=memoryStore(); let sequence=0, time=1000;
  const bytes=Buffer.from("%PDF-1.4\nartificial offline estimate only\n%%EOF\n");
  const requestId="f".repeat(32), device="phone1";
  const body={operation:"begin_v2",request_id:requestId,bytes:bytes.length,md5_base64:md5(bytes),sha256:hash(bytes)};
  const flow=()=>makeWorkflow(store,{viewerUrl:"https://example.invalid/client.html",newId:()=> (++sequence).toString(16).padStart(32,"0"),now:()=>time,...options});
  async function begin(legacy=false) {
    const arg=legacy ? {bytes:body.bytes,md5_base64:body.md5_base64} : body;
    const ticket=await flow().begin(arg,device); store.stage.set(ticket.id,bytes); return ticket.id;
  }
  const args=id=>({id,bytes:body.bytes,sha256:body.sha256});
  return {store,flow,begin,bytes,body,device,args,setTime:value=>{time=value;}};
}
module.exports={fixture,memoryStore,hash,md5,storageError,deferred};

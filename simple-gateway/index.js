"use strict";
// DRAFT: one function, two existing buckets. Keep GATEWAY_ENABLED=false
// until integration checks against Yandex Object Storage have passed.
const {randomBytes,createHash,createPublicKey,verify}=require("node:crypto");
const {S3Client,PutObjectCommand,GetObjectCommand,HeadObjectCommand,DeleteObjectCommand}=require("@aws-sdk/client-s3");
const {getSignedUrl}=require("@aws-sdk/s3-request-presigner");
const {PDFDocument,ParseSpeeds}=require("pdf-lib");
const {makeWorkflow,FlowError}=require("./workflow");

const STAGING=process.env.STAGING_BUCKET, PUBLIC=process.env.PUBLIC_BUCKET;
const VIEWER=process.env.VIEWER_URL||
  "https://grigori84.github.io/-KuzovPRO-PDF-Test./client.html";
const respond=(statusCode,data)=>({
  statusCode,isBase64Encoded:false,
  headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"},
  body:JSON.stringify(data)
});
const sha=b=>createHash("sha256").update(b).digest("hex");
const notFound=e=>e?.name==="NoSuchKey"||e?.name==="NotFound"||e?.$metadata?.httpStatusCode===404;
const collision=e=>e?.code==="PRECONDITION_FAILED"||
  e?.$metadata?.httpStatusCode===412||e?.$metadata?.httpStatusCode===409;
function devices(){
  if(!STAGING||!PUBLIC||STAGING===PUBLIC||
     !process.env.STORAGE_ACCESS_KEY_ID||!process.env.STORAGE_SECRET_ACCESS_KEY||
     !process.env.DEVICE_PUBLIC_KEYS_JSON)throw Error("CONFIG_MISSING");
  const x=JSON.parse(process.env.DEVICE_PUBLIC_KEYS_JSON);
  if(!x||typeof x!=="object"||Array.isArray(x)||!Object.keys(x).length)
    throw Error("DEVICE_LIST_EMPTY");
  return x;
}
function auth(event,raw,keys){
  const h=Object.fromEntries(Object.entries(event?.headers||{})
    .map(([k,v])=>[k.toLowerCase(),String(v)]));
  const device=h["x-kpro-device"],time=h["x-kpro-time"];
  const nonce=h["x-kpro-nonce"],sig=h["x-kpro-signature"];
  if(!/^[A-Za-z0-9_-]{1,40}$/.test(device||"")||!Object.hasOwn(keys,device)||!/^\d{10}$/.test(time||"")||
     !/^[a-f0-9]{32}$/.test(nonce||"")||
     !/^[A-Za-z0-9+/]+={0,2}$/.test(sig||"")||
     Math.abs(Date.now()/1000-Number(time))>90)return null;
  try{
    const key=createPublicKey({key:Buffer.from(keys[device],"base64"),
       format:"der",type:"spki"});
    if(key.asymmetricKeyType!=="ec"||key.asymmetricKeyDetails?.namedCurve!=="prime256v1")
      return null;
    const msg=time+"\n"+nonce+"\n"+sha(Buffer.from(raw,"utf8"));
    return verify("sha256",Buffer.from(msg,"utf8"),key,Buffer.from(sig,"base64"))
      ?{device,nonce}:null;
  }catch(_){return null;}
}
function adapter(s3){
  async function put(bucket,key,body,other={}){
    return s3.send(new PutObjectCommand({
      Bucket:bucket,Key:key,Body:body,
      ContentLength:body.length,...other
    }));
  }
  async function head(bucket,key){
    try{return await s3.send(new HeadObjectCommand({Bucket:bucket,Key:key}));}
    catch(e){if(notFound(e))return null;throw e;}
  }
  async function read(bucket,key,limit,etag){
    const req={Bucket:bucket,Key:key};if(etag)req.IfMatch=etag;
    let v;
    try{v=await s3.send(new GetObjectCommand(req));}
    catch(e){if(notFound(e))return null;throw e;}
    const parts=[];let size=0;
    for await(const chunk of v.Body){
      size+=chunk.length;
      if(size>limit){v.Body.destroy?.();throw new FlowError(413,"TOO_LARGE");}
      parts.push(chunk);
    }
    return {body:Buffer.concat(parts),etag:v.ETag,contentType:v.ContentType};
  }
  async function remove(bucket,key){
    return s3.send(new DeleteObjectCommand({Bucket:bucket,Key:key}));
  }
  return {
    async reserveNonce(device,nonce){
      try{
        await put(STAGING,"auth-nonces/"+device+"/"+nonce,Buffer.from("1"),
          {IfNoneMatch:"*",ContentType:"text/plain"});
        return true;
      }catch(e){if(collision(e))return false;throw e;}
    },
    async putState(id,value,cond={}){
      try{
        const raw=Buffer.from(JSON.stringify(value));
        const v=await put(STAGING,"control/"+id+".json",raw,{
          ContentType:"application/json",CacheControl:"no-store",
          ...(cond.ifMatch?{IfMatch:cond.ifMatch}:{}),
          ...(cond.ifNoneMatch?{IfNoneMatch:"*"}:{})
        });
        if(!v.ETag)throw Error("MISSING_ETAG");
        return {value,etag:v.ETag};
      }catch(e){
        if(collision(e))throw new FlowError(409,"PRECONDITION_FAILED");
        throw e;
      }
    },
    async getState(id){
      const d=await read(STAGING,"control/"+id+".json",4096);
      return d?{value:JSON.parse(d.body.toString("utf8")),etag:d.etag}:null;
    },
    async signUpload(id,bytes,md5){
      const headers={"Content-Type":"application/pdf",
        "Content-Length":String(bytes),"Content-MD5":md5,"If-None-Match":"*"};
      const cmd=new PutObjectCommand({Bucket:STAGING,Key:"staging/"+id+".pdf",
        ContentType:"application/pdf",ContentLength:bytes,ContentMD5:md5,IfNoneMatch:"*"});
      const url=await getSignedUrl(s3,cmd,{expiresIn:300,
        signableHeaders:new Set(["content-type","content-length","content-md5","if-none-match"])});
      const signed=(new URL(url).searchParams.get("X-Amz-SignedHeaders")||"")
        .toLowerCase().split(";");
      if(!["content-type","content-length","content-md5","if-none-match"]
        .every(k=>signed.includes(k)))throw Error("UNSIGNED_PUT_HEADER");
      return {upload_url:url,headers,expires_seconds:300};
    },
    async readStaging(id,limit){
      const key="staging/"+id+".pdf",h=await head(STAGING,key);
      if(!h)return null;
      if(h.ContentLength>limit)throw new FlowError(413,"TOO_LARGE");
      const d=await read(STAGING,key,limit,h.ETag);
      return d?{bytes:d.body,contentType:d.contentType}:null;
    },
    sha256:async bytes=>sha(bytes),
    async parsePdf(bytes){
      if(bytes.length<20||bytes.subarray(0,5).toString("ascii")!=="%PDF-"||
         !/%%EOF\s*$/.test(bytes.subarray(-1024).toString("latin1")))return false;
      try{
        const doc=await PDFDocument.load(bytes,{ignoreEncryption:false,
          throwOnInvalidObject:true,parseSpeed:ParseSpeeds.Fastest,updateMetadata:false});
        const pages=doc.getPageCount();
        return pages>=1&&pages<=100;
      }catch(_){return false;}
    },
    async putPublishedOnce(id,bytes,hash){
      await put(PUBLIC,"estimates/"+id+".pdf",bytes,{
        ContentType:"application/pdf",ContentDisposition:"inline",
        CacheControl:"no-store, max-age=0",Metadata:{sha256:hash},
        IfNoneMatch:"*"
      });
    },
    async headPublished(id){
      const v=await head(PUBLIC,"estimates/"+id+".pdf");
      return v?{bytes:v.ContentLength,sha256:v.Metadata?.sha256||""}:null;
    },
    async removePublished(id){await remove(PUBLIC,"estimates/"+id+".pdf");},
    async removeStaging(id){await remove(STAGING,"staging/"+id+".pdf");}
  };
}
module.exports.handler=async event=>{
  const method=(event?.httpMethod||event?.requestContext?.http?.method||"").toUpperCase();
  if(method!=="POST")return respond(405,{error:"METHOD_NOT_ALLOWED"});
  if(process.env.GATEWAY_ENABLED!=="true")
    return respond(503,{error:"GATEWAY_DISABLED"});
  try{
    const raw=event?.isBase64Encoded
      ?Buffer.from(event.body||"","base64").toString("utf8")
      :(typeof event?.body==="string"?event.body:"");
    if(Buffer.byteLength(raw,"utf8")>4096)return respond(413,{error:"REQUEST_TOO_LARGE"});
    const user=auth(event,raw,devices());
    if(!user)return respond(401,{error:"UNAUTHORIZED"});
    const s3=new S3Client({
      endpoint:"https://storage.yandexcloud.net",region:"ru-central1",
      forcePathStyle:true,requestChecksumCalculation:"WHEN_REQUIRED",
      credentials:{accessKeyId:process.env.STORAGE_ACCESS_KEY_ID,
        secretAccessKey:process.env.STORAGE_SECRET_ACCESS_KEY}
    });
    const storage=adapter(s3);
    if(!(await storage.reserveNonce(user.device,user.nonce)))
      return respond(409,{error:"REPLAYED_REQUEST"});
    let body;
    try{body=JSON.parse(raw);}catch(_){return respond(400,{error:"INVALID_JSON"});}
    if(!body||Array.isArray(body)||typeof body!=="object")
      return respond(400,{error:"INVALID_JSON"});
    const workflow=makeWorkflow(storage,{
      viewerUrl:VIEWER,newId:()=>randomBytes(16).toString("hex")
    });
    if(body.operation==="begin")return respond(200,await workflow.begin(body,user.device));
    if(body.operation==="publish")return respond(200,await workflow.publish(body,user.device));
    if(body.operation==="revoke")return respond(200,await workflow.revoke(body,user.device));
    return respond(400,{error:"UNKNOWN_OPERATION"});
  }catch(e){
    if(e instanceof FlowError)return respond(e.status,{error:e.code});
    console.error("pdf_gateway_failure",e?.name||"Error");
    return respond(503,{error:"GATEWAY_UNAVAILABLE"});
  }
};

// Internal unit-test seam only; not an HTTP route.
module.exports.__testing = {auth,adapter};

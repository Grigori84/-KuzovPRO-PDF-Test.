"use strict";

// KUZOVPRO — prototype of protected upload-ticket issuer.
// Cloud Function MUST remain private (Cloud IAM authentication required).
// Never publish this function with 'All users' invocation permission.
// No upload happens inside this function; it only signs a short POST to a random staging key.
// A separate, authenticated finalize step is mandatory before a file is published.

const { randomBytes } = require("node:crypto");
const { S3Client } = require("@aws-sdk/client-s3");
const { createPresignedPost } = require("@aws-sdk/s3-presigned-post");

const SIZE_LIMIT = 32 * 1024 * 1024; // Existing KuzovPRO PDF limit.
const TTL_SECONDS = 300;
const ROOT = "staging/";
const BUCKET = process.env.STORAGE_BUCKET;
const ACCESS_KEY = process.env.STORAGE_ACCESS_KEY_ID;
const SECRET_KEY = process.env.STORAGE_SECRET_ACCESS_KEY;

const response = (statusCode, obj) => ({
  statusCode,
  headers: {"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"},
  body: JSON.stringify(obj)
});

function requireConfig(){
  if (!BUCKET || !ACCESS_KEY || !SECRET_KEY) {
    throw new Error("Object Storage signing credentials are not configured in Lockbox");
  }
}

let client;
function s3(){
  if(!client){
    client=new S3Client({
      endpoint:"https://storage.yandexcloud.net",
      region:"ru-central1",
      forcePathStyle:true,
      credentials:{accessKeyId:ACCESS_KEY,secretAccessKey:SECRET_KEY}
    });
  }
  return client;
}

module.exports.handler = async (event) => {
  // Authentication is ENFORCED by a private Yandex Cloud Function, not by this handler.
  // If the function is accidentally public, DO NOT USE IT.
  const method=(event?.httpMethod || event?.requestContext?.http?.method || "").toUpperCase();
  if(method !== "POST") return response(405,{error:"METHOD_NOT_ALLOWED"});
  if((event?.body || "").length>4096) return response(413,{error:"REQUEST_TOO_LARGE"});

  try {
    requireConfig();
    let body={};
    if(event?.body){
      const raw=event.isBase64Encoded
        ? Buffer.from(event.body,"base64").toString("utf8")
        : event.body;
      body=typeof raw==="string"?JSON.parse(raw):raw;
    }
    if(body?.operation !== "begin-upload") return response(400,{error:"INVALID_OPERATION"});

    // Server, not APK, chooses the unguessable object name.
    const id=randomBytes(16).toString("hex");
    const key=ROOT+id+".pdf";
    const post=await createPresignedPost(s3(),{
      Bucket:BUCKET,
      Key:key,
      Expires:TTL_SECONDS,
      Fields:{"Content-Type":"application/pdf"},
      Conditions:[
        ["content-length-range",1,SIZE_LIMIT],
        ["eq","$Content-Type","application/pdf"]
      ]
    });

    return response(200,{
      ticket_id:id,
      staging_key:key,
      upload_url:post.url,
      upload_fields:post.fields,
      expires_in_seconds:TTL_SECONDS,
      max_pdf_bytes:SIZE_LIMIT,
      next_step:"finalize-not-yet-implemented"
    });
  } catch (err) {
    // Keep secret values and signed forms out of logs.
    console.error("Upload ticket issue failed",err?.name||"Error");
    return response(500,{error:"TICKET_ISSUE_FAILED"});
  }
};

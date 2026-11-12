"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
process.env.STAGING_BUCKET="offline-selftest-staging";
process.env.PUBLIC_BUCKET="offline-selftest-public";
const {handler}=require("../selftest");

test("selftest refuses invocation unless explicitly enabled",async()=>{
  const old=process.env.SELFTEST_ENABLED;
  process.env.SELFTEST_ENABLED="false";
  try{
    const result=await handler({operation:"upload"});
    assert.equal(result.statusCode,503);
    assert.equal(JSON.parse(result.body).error,"SELFTEST_DISABLED");
  } finally {
    if(old===undefined)delete process.env.SELFTEST_ENABLED;
    else process.env.SELFTEST_ENABLED=old;
  }
});
test("unexpected test operation is rejected without network",async()=>{
  const values={
    SELFTEST_ENABLED:process.env.SELFTEST_ENABLED,
    STAGING_BUCKET:process.env.STAGING_BUCKET,
    PUBLIC_BUCKET:process.env.PUBLIC_BUCKET
  };
  try{
    process.env.SELFTEST_ENABLED="true";
    process.env.STAGING_BUCKET="private-test";
    process.env.PUBLIC_BUCKET="public-test";
    const result=await handler({operation:"unsupported"});
    assert.equal(result.statusCode,400);
    assert.equal(JSON.parse(result.body).error,"UNKNOWN_SELFTEST_OPERATION");
  }finally{
    for(const [k,v]of Object.entries(values)){
      if(v===undefined)delete process.env[k]; else process.env[k]=v;
    }
  }
});
test("legacy unjournaled diagnostic allocators are no longer accepted",async()=>{
  process.env.SELFTEST_ENABLED="true";
  try{for(const operation of ["upload","publish","revoke"]){
    const result=await handler({operation});assert.equal(result.statusCode,400);
  }}finally{delete process.env.SELFTEST_ENABLED;}
});

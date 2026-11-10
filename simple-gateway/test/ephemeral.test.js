'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {credentialProvider}=require('../ephemeral');
test('uses metadata IAM and ephemeral key, caches and includes session token',async()=>{
  let calls=0;const now=1700000000000;
  const fetcher=async(url,opt)=>{calls++;if(calls===1){assert.match(url,/169\.254/);assert.equal(opt.headers['Metadata-Flavor'],'Google');return {ok:true,json:async()=>({access_token:'fake-iam'})};}
    assert.match(url,/iam\.api\.cloud/);assert.equal(opt.headers.Authorization,'Bearer fake-iam');assert.equal(JSON.parse(opt.body).duration,'900s');return {ok:true,json:async()=>({accessKeyId:'fake-id',secret:'fake-secret',sessionToken:'fake-session',expiresAt:new Date(now+900000).toISOString()})};};
  const provider=credentialProvider(fetcher,()=>now);const [a,b]=await Promise.all([provider(),provider()]);assert.equal(a.sessionToken,'fake-session');assert.equal(b.accessKeyId,'fake-id');assert.equal(calls,2);
});
test('failure is sanitized and fails closed',async()=>{const p=credentialProvider(async()=>{throw Error('sensitive simulated failure');});await assert.rejects(p(),e=>e.message==='CREDENTIAL_PROVIDER_FAILED');});
test('rejects missing session token',async()=>{let n=0;const p=credentialProvider(async()=>({ok:true,json:async()=>++n===1?{access_token:'fake'}:{accessKeyId:'fake',secret:'fake',expiresAt:new Date(Date.now()+900000).toISOString()}}));await assert.rejects(p(),/CREDENTIAL_PROVIDER_FAILED/);});

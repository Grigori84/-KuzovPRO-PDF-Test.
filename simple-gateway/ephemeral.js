'use strict';
// Cloud Functions service-account identity only. No credentials are logged or persisted.
const METADATA='http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token';
const IAM='https://iam.api.cloud.yandex.net/iam/aws-compatibility/v1/ephemeralAccessKeys';
function credentialProvider(fetcher=globalThis.fetch,clock=Date.now){
  let cached=null, pending=null;
  return async()=>{
    if(cached && cached.expiration.getTime()-clock()>360000)return cached;
    if(pending)return pending;
    pending=(async()=>{
      let m,k;
      try{
        m=await fetcher(METADATA,{headers:{'Metadata-Flavor':'Google'},signal:AbortSignal.timeout(5000)});
        if(!m.ok)throw Error('METADATA_FAILED');
        const token=(await m.json()).access_token;
        if(typeof token!=='string'||!token)throw Error('METADATA_FAILED');
        k=await fetcher(IAM,{method:'POST',headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({sessionName:'kuzovpro-pdf-gateway',duration:'900s'}),signal:AbortSignal.timeout(5000)});
        if(!k.ok)throw Error('EPHEMERAL_KEY_FAILED');
        const v=await k.json(),expiry=new Date(v.expiresAt);
        if(!v.accessKeyId||!v.secret||!v.sessionToken||!Number.isFinite(expiry.getTime())||expiry.getTime()-clock()<360000)throw Error('EPHEMERAL_KEY_INVALID');
        cached={accessKeyId:v.accessKeyId,secretAccessKey:v.secret,sessionToken:v.sessionToken,expiration:expiry};
        return cached;
      }catch(_){throw Error('CREDENTIAL_PROVIDER_FAILED');}
    })();
    try{return await pending;}finally{pending=null;}
  };
}
module.exports={credentialProvider};

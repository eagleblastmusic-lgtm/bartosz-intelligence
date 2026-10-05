import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
process.loadEnvFile('.env');
const evidencePath='docs/verification/gate-0/cpu-retest-run.json';
const previous=existsSync(evidencePath)?JSON.parse(readFileSync(evidencePath,'utf8')):null;
if(previous && (previous.live_attempts!==0 || previous.observations.length!==0)) throw new Error('RETEST_ALREADY_RESERVED');
const env={...process.env,WRANGLER_WRITE_LOGS:'false',WRANGLER_LOG_SANITIZE:'true',WRANGLER_SEND_METRICS:'false'};
const name=previous?.name??'gate0-cpu-recovery-'+Date.now();
const token=randomBytes(32).toString('base64url');
const config='tools/gates/adapters/wrangler.cpu-profile.jsonc';
const wrangler=(args)=>execFileSync(process.execPath,['node_modules/wrangler/bin/wrangler.js',...args],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
const record={started_at:new Date().toISOString(),name,config,live_request_limit:1,live_attempts:0,synthetic_requests:15,observations:[],cleanup_status:'PENDING_CPU_CAPTURE'};
writeFileSync(evidencePath,JSON.stringify(record,null,2));
try {
 const output=JSON.parse(wrangler(['preview','--config',config,'--name',name,'--var','GATE0_BENCH_TOKEN:'+token,'--json']));
 const preview=output.preview;
 if(preview.name!==name || !preview.id || !preview.urls?.length) throw new Error('PREVIEW_SHAPE_INVALID');
 Object.assign(record,{preview_id:preview.id,preview_slug:preview.slug,deployment_id:output.deployment.id,preview_url:preview.urls[0]});
 writeFileSync(evidencePath,JSON.stringify(record,null,2));
 for(const mode of ['control','hash','decode','extract','body','live']) {
  for(let i=0;i<(mode==='live'?1:3);i++) {
   const id=`cpu-${mode}-${i}`;
   if(mode==='live') {record.live_attempts++;writeFileSync(evidencePath,JSON.stringify(record,null,2));}
   const start=Date.now();
   const response=await fetch(new URL('/probe',preview.urls[0]),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,mode,request_id:id,video_id:'uEztHu4NHrs'}),signal:AbortSignal.timeout(60000)});
   const raw=await response.text();
   if(!response.ok) {record.last_http_status=response.status;throw new Error('HTTP_NON_OK');}
   const result=JSON.parse(raw);
   record.observations.push({mode,request_id:id,http_status:response.status,wall_ms:Date.now()-start,response_sha256:createHash('sha256').update(raw).digest('hex'),result});
   writeFileSync(evidencePath,JSON.stringify(record,null,2));
  }
 }
 record.completed_at=new Date().toISOString();
} catch(error) {
 record.failure='CPU_EXPERIMENT_FAILED_NO_RETRY';
 record.error_type=error?.name??'Unknown';
 record.error_code=/^[A-Z0-9_]+$/.test(error?.cause?.code??'')?error.cause.code:null;
 // Metadata retains the name for cleanup; never print raw CLI output/errors.
}
writeFileSync(evidencePath,JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify({name,preview_id:record.preview_id,preview_slug:record.preview_slug,requests:record.observations.length,live_attempts:record.live_attempts,failure:record.failure??null,cleanup_status:record.cleanup_status}));

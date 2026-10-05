import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const path='docs/verification/gate-0/local-ytdlp-canary.json';
if(existsSync(path)) throw new Error('CANARY_ALREADY_RESERVED');
const manifest=JSON.parse(readFileSync('docs/verification/gate-0/MANIFEST.json','utf8'));
const entry=manifest.entries.find(e=>e.video_id==='Q6BclIP5QBQ');
if(!entry) throw new Error('PREREGISTERED_CASE_REQUIRED');
const evidence={started_at:new Date().toISOString(),status:'RESERVED',provider:'yt-dlp captions-only',runtime:'local Python',
  measurement_ref:'cpu-retest-platform.json',manifest_sha256:manifest.sha256,video_id:entry.video_id,
  provider_revision:createHash('sha256').update(readFileSync('tools/gates/adapters/gate0_python_adapters.py')).digest('hex'),
  paid_services_enabled:false,billing_route:'disabled',control_plane:'Cloudflare Free unchanged',
  request_policy:'One caption-only extraction; internal retries 0, no retry or same-IP fallback after refusal; uses prior successful corpus canary',
  production_enabled:false};
writeFileSync(path,JSON.stringify(evidence,null,2));
try {
 const raw=execFileSync('python',['tools/gates/adapters/gate0_python_adapters.py','--provider','yt-dlp','--operation','fetch','--video-id',entry.video_id,'--request-id','local-ytdlp-cpu-canary-1','--language-code','es','--kind','manual','--duration-seconds',String(entry.duration_seconds)],{
  env:{...process.env,PYTHONPATH:resolve('.tools/gate0-python'),PYTHONIOENCODING:'utf-8',PYTHONNOUSERSITE:'1'},windowsHide:true,encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe'],
 });
 const result=JSON.parse(raw);
 Object.assign(evidence,{status:'MEASURED',completed_at:new Date().toISOString(),result,
  cpu_budget_note:'Local compute has no Cloudflare invocation limit; unchanged edge thresholds apply to control plane; full source/corpus/fidelity qualification still pending'});
} catch {Object.assign(evidence,{status:'INCONCLUSIVE',reason:'HARNESS_FAILURE_NO_RETRY'});}
writeFileSync(path,JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({status:evidence.status,source_status:evidence.result?.status,reason:evidence.result?.reason_code,cpu_us:evidence.result?.process_cpu_us,wall_ms:evidence.result?.elapsed_wall_ms,cues:evidence.result?.cue_count}));

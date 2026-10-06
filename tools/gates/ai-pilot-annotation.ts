import { sha256 } from '../../packages/core/src/auth/crypto.js';
import type { normalizeTranscript } from '../../packages/core/src/transcript/normalize.js';
type Manifest = Awaited<ReturnType<typeof normalizeTranscript>>['manifest'];

// Local human-review material only. It has no provider/API transport and cannot
// publish quality approval. Source strings are inert data, never HTML or code.
export async function renderAnnotationSheet(input: {
  video_id: string;
  source_text: string;
  manifest: Manifest;
  manifest_hash: string;
}) {
  const sourceHash = await sha256(input.source_text);
  if (
    !/^[A-Za-z0-9_-]{11}$/.test(input.video_id) ||
    !input.manifest.complete ||
    input.manifest.normalizer_version !== 'source-normalizer:1' ||
    input.manifest.source_text_hash !== sourceHash ||
    input.manifest.source_revision !== sourceHash ||
    (await sha256(JSON.stringify(input.manifest))) !== input.manifest_hash ||
    !input.manifest.anchors.length ||
    input.manifest.anchors.some(
      (anchor, index) =>
        anchor.alias !== `s${index + 1}` ||
        !Number.isSafeInteger(anchor.source_start) ||
        !Number.isSafeInteger(anchor.source_end) ||
        anchor.source_start < 0 ||
        anchor.source_end <= anchor.source_start ||
        anchor.source_end > input.source_text.length,
    )
  )
    throw new Error('INVALID_ANNOTATION_SOURCE');
  const dataset = JSON.stringify({ ...input, source_hash: sourceHash })
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  return `<!doctype html><html lang="pl"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>Anotacje pilota Bartosz Intelligence</title>
<style>body{font:16px/1.5 system-ui;margin:24px auto;max-width:1100px;padding:0 16px;color:#172033;background:#f6f8fb}label{display:block;margin:10px 0}input,textarea,button{font:inherit}button{padding:8px 14px;margin:4px 8px 4px 0}textarea{width:100%;box-sizing:border-box}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:14px;border:1px solid #cbd5e1}li{margin:10px 0}section{margin:24px 0}small{overflow-wrap:anywhere}input[type=number]{width:90px}</style>
<h1>Anotacje ważnych twierdzeń</h1>
<p>Oceń źródło samodzielnie, zanim zobaczysz odpowiedź modelu. Zapisz istotne twierdzenia wraz z negacjami, liczbami, warunkami i autorem wypowiedzi. Ten formularz nie wykonuje analizy AI.</p>
<p id="identity"></p><small id="hashes"></small>
<section aria-label="Autor anotacji"><label>Identyfikator osoby anotującej (pseudonim)<input id="reviewer" autocomplete="off" maxlength="64" required></label></section>
<section aria-label="Fragmenty źródła"><h2>Fragmenty źródła</h2><p>Numery odpowiadają aliasom s1, s2… Cytat obejmie dokładne bajty źródła pomiędzy wybranymi fragmentami. Nieznany czas pozostaje nieznany.</p><button id="previous" type="button">Poprzednie fragmenty</button><button id="next" type="button">Następne fragmenty</button><p id="page" role="status"></p><ol id="segments"></ol></section>
<section aria-label="Nowe twierdzenie"><h2>Dodaj ważne twierdzenie</h2>
<label>Pierwszy fragment<input id="first" type="number" min="1" value="1"></label><label>Ostatni fragment<input id="last" type="number" min="1" value="1"></label>
<pre id="quote" aria-label="Dokładny cytat"></pre><button id="range" type="button">Dodaj zakres do twierdzenia</button><p id="ranges" role="status"></p>
<label>Twierdzenie zapisane własnymi słowami<textarea id="statement" rows="4" required></textarea></label><button id="claim" type="button">Zapisz twierdzenie</button>
<ol id="claims"></ol></section>
<section aria-label="Zapis anotacji"><button id="freeze" type="button">Zamroź i pobierz anotacje JSON</button><p id="status" role="status" aria-live="polite"></p><p>Po zamrożeniu nie zmieniaj tego pliku. Jego hash i czas muszą poprzedzać pierwsze wywołanie modelu w zadeklarowanym pilocie. Niezależny przegląd trudnych przypadków i ocena odpowiedzi modelu następują osobno.</p></section>
<script type="application/json" id="dataset">${dataset}</script>
<script>
'use strict';
const data=JSON.parse(document.getElementById('dataset').textContent);
const anchors=data.manifest.anchors, groups=[], claims=[];
const el=id=>document.getElementById(id);
const status=text=>{el('status').textContent=text;};
el('identity').textContent='Film: '+data.video_id+' · fragmentów: '+anchors.length;
el('hashes').textContent='Source SHA-256: '+data.source_hash+' · Manifest SHA-256: '+data.manifest_hash;
let pageStart=0;const pageSize=50;
const showPage=()=>{el('segments').replaceChildren();el('segments').start=pageStart+1;for(const anchor of anchors.slice(pageStart,pageStart+pageSize)){const row=document.createElement('li');row.textContent=anchor.alias+' · '+(anchor.start_ms===null?'czas nieznany':Math.floor(anchor.start_ms/1000)+' s')+' · '+data.source_text.slice(anchor.source_start,anchor.source_end);el('segments').append(row);}el('page').textContent='Fragmenty '+(pageStart+1)+'–'+Math.min(pageStart+pageSize,anchors.length)+' z '+anchors.length;el('previous').disabled=pageStart===0;el('next').disabled=pageStart+pageSize>=anchors.length;};
el('previous').addEventListener('click',()=>{pageStart=Math.max(0,pageStart-pageSize);showPage();});el('next').addEventListener('click',()=>{pageStart+=pageSize;showPage();});showPage();
for(const name of ['first','last'])el(name).max=String(anchors.length);
const selected=()=>{const a=Number(el('first').value)-1,b=Number(el('last').value)-1;if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<0||b<a||b>=anchors.length)throw new Error('Wybierz poprawny zakres fragmentów.');return {segment_ids:anchors.slice(a,b+1).map(x=>x.segment_id),quote:data.source_text.slice(anchors[a].source_start,anchors[b].source_end)};};
const preview=()=>{try{el('quote').textContent=selected().quote;}catch(error){el('quote').textContent=error.message;}};
el('first').addEventListener('input',preview);el('last').addEventListener('input',preview);preview();
el('range').addEventListener('click',async()=>{try{const part=selected();const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(part.quote));groups.push({segment_ids:part.segment_ids,quote_hash:Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')});el('ranges').textContent='Dodanych zakresów: '+groups.length;}catch(error){status(error.message);}});
el('claim').addEventListener('click',()=>{const statement=el('statement').value.trim();if(!statement||!groups.length){status('Wpisz twierdzenie i dodaj co najmniej jeden zakres.');return;}const claim={claim_id:'c'+(claims.length+1),statement,anchors:groups.splice(0)};claims.push(claim);const row=document.createElement('li');row.textContent=claim.claim_id+': '+statement;el('claims').append(row);el('statement').value='';el('ranges').textContent='';status('Zapisanych twierdzeń: '+claims.length);});
el('freeze').addEventListener('click',()=>{const reviewer=el('reviewer').value.trim();if(!/^[A-Za-z0-9_-]{1,64}$/.test(reviewer)||!claims.length||groups.length||el('statement').value.trim()){status('Podaj pseudonim (litery/cyfry/_/-), zapisz twierdzenia i zakończ rozpoczęte twierdzenie.');return;}const frozen={source_hash:data.source_hash,manifest_hash:data.manifest_hash,frozen_at:new Date().toISOString(),annotator_id:reviewer,important_claims:claims};const url=URL.createObjectURL(new Blob([JSON.stringify(frozen,null,2)+'\\n'],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=data.video_id+'-annotations.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);el('freeze').disabled=true;el('claim').disabled=true;el('range').disabled=true;status('Pobrano zamrożone anotacje. Zachowaj plik w prywatnym katalogu pilota.');});
</script></html>`;
}

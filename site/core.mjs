export const PROTOCOL = 'browser-llm-bench-v1';
export const METRICS = {pp: 'Обробка, ток/с', tg: 'Генерація, ток/с', ttft: 'Перший токен, с'};
export const validNumber = n => typeof n === 'number' && Number.isFinite(n);
export function stats(values) {
  const v = values.filter(validNumber).sort((a,b)=>a-b);
  if (!v.length) return null;
  const mean = v.reduce((a,b)=>a+b,0)/v.length;
  return {n:v.length, median:(v[Math.floor((v.length-1)/2)]+v[Math.floor(v.length/2)])/2,
    mean, min:v[0], max:v.at(-1), stdev:v.length>1?Math.sqrt(v.reduce((a,b)=>a+(b-mean)**2,0)/(v.length-1)):0};
}
export function summarize(rows, phase) {
  const all=rows.filter(r=>r.phase===phase), good=all.filter(r=>r.valid);
  return {runs:good.length,invalid:all.length-good.length,
    ...Object.fromEntries(Object.keys(METRICS).map(m=>[m,stats(good.map(r=>r[m]))]))};
}
export function makePrompt(profile) {
  const lines = profile==='long' ? 150 : 10;
  return 'Read the following measurements. Continue with a concise explanation of the pattern.\n'+
    Array.from({length:lines},(_,i)=>`Record ${i}: group ${i%7}, input ${i*13%997}, output ${i*31%991}. Compare the values and explain possible errors.`).join('\n')+
    '\nExplanation:';
}
export async function hash(text) {
  const data=typeof text==='string'?text:JSON.stringify(text);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data)))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export function fingerprint(r) {
  return JSON.stringify([r.protocol,r.implementation,r.model.repository,r.model.revision,r.model.dtype,r.model.model_lib,
    r.model.engine,r.model.version,r.backend,r.settings.profile,r.promptHash,r.promptTokens,
    r.settings.context,r.settings.generate,r.settings.repeats,r.settings.heatSeconds,
    r.settings.batch,r.settings.concurrency,r.metricMethod,r.kvPolicy]);
}
export function compareReports(a,b,phase) {
  const sa=summarize(a.samples,phase),sb=summarize(b.samples,phase);
  const same=fingerprint(a)===fingerprint(b);
  const visible=!(a.visibilityIncidents||b.visibilityIncidents);
  const valid=a.status==='completed'&&b.status==='completed'&&same&&visible&&
    sa.runs===a.settings.repeats&&sb.runs===b.settings.repeats&&sa.invalid===0&&sb.invalid===0;
  return {comparable:valid,reason:!same?'Різні моделі, режими або параметри':!visible?'Вкладка переходила у фон під час тесту':!valid?'Немає повних коректних серій':'Однакове завдання; налаштування потоків і браузери дивіться нижче',
    a:sa,b:sb,ratios:Object.fromEntries(Object.keys(METRICS).map(k=>[k,valid&&sa[k]?.median>0?sb[k].median/sa[k].median:null]))};
}
export function validateReport(r) {
  if (!r||r.protocol!==PROTOCOL||typeof r.label!=='string'||r.label.length>200||
      !r.model||typeof r.model.repository!=='string'||typeof r.model.revision!=='string'||
      !r.settings||!Array.isArray(r.samples)||r.samples.length>50000||
      !['wasm','webgpu'].includes(r.backend)||!Number.isInteger(r.settings.repeats)) {
    throw Error('Це не звіт Browser LLM Bench. Нативні Python-звіти мають інший протокол.');
  }
  for(const row of r.samples) {
    if(!row||typeof row.phase!=='string'||typeof row.valid!=='boolean')throw Error('Пошкоджений запис вимірювання.');
    if(row.valid&&['pp','tg','ttft'].some(k=>!validNumber(row[k])||row[k]<=0))throw Error('Некоректні числові вимірювання.');
  }
  return r;
}
export function cpuMetrics({start,first,last,end,count,promptTokens,forwardMs,expected}) {
  const pp=promptTokens/(forwardMs/1000),tg=(count-1)/((last-first)/1000),ttft=(first-start)/1000;
  return {pp,tg,ttft,wall:(end-start)/1000,promptTokens,generated:count,
    firstForwardSeconds:forwardMs/1000,valid:count===expected&&count>1&&[pp,tg,ttft].every(x=>validNumber(x)&&x>0)};
}
export function csv(reports) {
  const fields=['device','model','engine','backend','quantization','profile','phase','status','valid','pp_tokens_s','tg_tokens_s','ttft_s','prompt_tokens','generated_tokens','utc'];
  const rows=reports.flatMap(r=>r.samples.map(x=>[r.label,r.model.repository,r.model.engine,r.backend,r.model.dtype,r.settings.profile,x.phase,r.status,x.valid,x.pp,x.tg,x.ttft,x.promptTokens,x.generated,x.utc]));
  const cell=x=>'"'+String(x??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';
  return '\uFEFF'+[fields,...rows].map(r=>r.map(cell).join(',')).join('\r\n');
}

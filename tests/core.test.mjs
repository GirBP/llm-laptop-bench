import test from 'node:test';
import assert from 'node:assert/strict';
import {stats,makePrompt,cpuMetrics,compareReports,validateReport,csv} from '../site/core.mjs';
const fixture=()=>({id:'a',label:'Test fixture',protocol:'browser-llm-bench-v1',implementation:'test',
  model:{repository:'fixture/model',revision:'fixed',dtype:'q4',engine:'test',version:'1'},backend:'wasm',
  settings:{profile:'short',context:2048,generate:64,repeats:3,heatSeconds:0,batch:1,concurrency:1},
  promptHash:'fixed',promptTokens:400,metricMethod:'test',kvPolicy:'fixed',status:'completed',visibilityIncidents:0,
  samples:Array.from({length:3},(_,i)=>({phase:'early',valid:true,pp:90+i*10,tg:10+i,ttft:4,generated:64,promptTokens:400}))});
test('statistics: median and sample deviation; missing data stay null',()=>{
  assert.equal(stats([1,2,3]).median,2);assert.equal(stats([1,2,3]).stdev,1);
  assert.equal(stats([NaN,undefined,null,Infinity]),null);assert.equal(stats([1,2,3,4]).median,2.5);
});
test('CPU metrics exclude prompt from decode and count decode intervals correctly',()=>{
  const m=cpuMetrics({start:0,first:1000,last:2000,end:2100,count:11,promptTokens:100,forwardMs:500,expected:11});
  assert.equal(m.pp,200);assert.equal(m.tg,10);assert.equal(m.ttft,1);assert.equal(m.valid,true);
  assert.equal(cpuMetrics({start:0,first:1,last:1,end:2,count:1,promptTokens:1,forwardMs:1,expected:2}).valid,false);
});
test('same workload can be compared',()=>{const a=fixture(),b=fixture();assert.equal(compareReports(a,b,'early').comparable,true);});
for(const key of ['revision','dtype','engine','version'])test(`reject incompatible model ${key}`,()=>{
  const a=fixture(),b=fixture();b.model[key]='different';assert.equal(compareReports(a,b,'early').comparable,false);
});
for(const key of ['context','generate','repeats','heatSeconds','profile'])test(`reject incompatible setting ${key}`,()=>{
  const a=fixture(),b=fixture();b.settings[key]='different';assert.equal(compareReports(a,b,'early').comparable,false);
});
test('missing hot data is not silently replaced with early data',()=>{assert.equal(compareReports(fixture(),fixture(),'hot').comparable,false);});
test('reject background, interrupted, invalid and code changes',()=>{
  for(const change of [r=>r.visibilityIncidents=1,r=>r.status='interrupted',r=>r.samples[0].valid=false,r=>r.implementation='changed']){
    const a=fixture(),b=fixture();change(b);const c=compareReports(a,b,'early');assert.equal(c.comparable,false);assert.equal(c.ratios.tg,null);
  }
});
test('import validates protocol and numeric values',()=>{
  assert.equal(validateReport(fixture()).label,'Test fixture');
  assert.throws(()=>validateReport({protocol:'llm-laptop-comparison-v1'}));
  const r=fixture();r.samples[0].tg=null;assert.throws(()=>validateReport(r));
});
test('CSV escapes quotes and spreadsheet formulas',()=>{
  const r=fixture();r.label='=HYPERLINK("bad")';const content=csv([r]);assert.ok(content.includes('"\'=HYPERLINK(""bad"")"'));
});
test('fixed prompt profiles are deterministic and distinct',()=>{
  assert.equal(makePrompt('short'),makePrompt('short'));assert.ok(makePrompt('long').length>makePrompt('short').length*5);
});

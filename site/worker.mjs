import {cpuMetrics,makePrompt,hash,validNumber} from './core.mjs';
let engine=null,model=null,tokenizer=null,aborted=false;
const send=(type,data={})=>postMessage({type,...data});
const tick=()=>new Promise(r=>setTimeout(r,0));
const stamp=()=>new Date().toISOString();

async function gpuLoad(m,s){
  const {CreateMLCEngine}=await import('@mlc-ai/web-llm');
  engine=await CreateMLCEngine(m.model_id,{
    appConfig:{useIndexedDBCache:true,model_list:[{model_id:m.model_id,model:m.model_url,model_lib:m.model_lib}]},
    initProgressCallback:p=>send('progress',{text:p.text,progress:p.progress}),
  },{context_window_size:s.context,prefill_chunk_size:512});
  send('runtime',{details:{engineGPUVendor:await engine.getGPUVendor(),maxStorageBufferBindingSize:await engine.getMaxStorageBufferBindingSize(),wasmThreads:null,executionProvider:'webgpu'}});
}
async function gpuRequest(prompt,s){
  await engine.resetChat(false);
  const start=performance.now();
  const result=await engine.completions.create({prompt,max_tokens:s.generate,temperature:0,
    seed:42,ignore_eos:true,stream:false});
  const end=performance.now(),u=result.usage,e=u?.extra;
  if(!e)throw Error('Рушій не повернув дані швидкості.');
  const row={pp:e.prefill_tokens_per_s,tg:e.decode_tokens_per_s,ttft:e.time_to_first_token_s,
    wall:(end-start)/1000,promptTokens:u.prompt_tokens,generated:u.completion_tokens,rawUsage:u};
  row.valid=u.completion_tokens===s.generate&&['pp','tg','ttft'].every(k=>validNumber(row[k])&&row[k]>0)&&u.prompt_tokens+s.generate<s.context;
  return row;
}
async function cpuLoad(m,s){
  const {env,AutoModelForCausalLM,AutoTokenizer}=await import('@huggingface/transformers');
  env.allowLocalModels=false;
  env.backends.onnx.wasm.numThreads=self.crossOriginIsolated?s.threads:1;
  env.backends.onnx.wasm.proxy=false;
  const opts={revision:m.revision,progress_callback:p=>{
    if(p.status==='progress')send('progress',{text:`${p.file}: ${(p.progress??0).toFixed(0)}%`,progress:(p.progress??0)/100});
    else if(p.status==='initiate')send('progress',{text:`Завантаження ${p.file}`,progress:null});
  }};
  tokenizer=await AutoTokenizer.from_pretrained(m.repository,opts);
  model=await AutoModelForCausalLM.from_pretrained(m.repository,{...opts,device:'wasm',dtype:m.dtype});
  send('runtime',{details:{wasmThreads:env.backends.onnx.wasm.numThreads,onnxVersion:env.backends.onnx.versions,executionProvider:'wasm'}});
}
async function cpuRequest(prompt,s){
  const inputs=tokenizer(prompt,{add_special_tokens:false});
  const promptTokens=inputs.input_ids.dims.at(-1);
  if(promptTokens+s.generate>=s.context)throw Error('Текст перевищив контекст. Оберіть короткий профіль.');
  let count=0,first=null,last=null,isPrompt=true,forwardMs=null;
  const original=model.forward;
  model.forward=async function(...args){const t=performance.now();const out=await original.apply(this,args);if(forwardMs===null)forwardMs=performance.now()-t;return out;};
  const streamer={put(value){if(isPrompt){isPrompt=false;return;}const t=performance.now();count+=value[0].length;first??=t;last=t;},end(){}};
  const start=performance.now();let output;
  try{
    output=await model.generate({...inputs,max_new_tokens:s.generate,min_new_tokens:s.generate,
      do_sample:false,streamer,return_dict_in_generate:false});
    const measured=cpuMetrics({start,first,last,end:performance.now(),count,promptTokens,forwardMs,expected:s.generate});
    const actual=output.dims.at(-1)-promptTokens;
    measured.valid=measured.valid&&actual===count;
    return measured;
  }finally{model.forward=original;output?.dispose?.();for(const x of Object.values(inputs))x.dispose?.();}
}
async function run({model:m,settings:s}){
  aborted=false;
  let terminal=null;
  const prompt=makePrompt(s.profile),loadStart=performance.now();
  send('stage',{stage:'loading',text:'Завантаження моделі та підготовка рушія'});
  try{
    if(m.backend==='webgpu')await gpuLoad(m,s);else await cpuLoad(m,s);
    const loadSeconds=(performance.now()-loadStart)/1000;
    const request=m.backend==='webgpu'?gpuRequest:cpuRequest;
    send('loaded',{loadSeconds,promptHash:await hash(prompt)});
    send('stage',{stage:'priming',text:'Перший службовий запуск: компіляція та ініціалізація'});
    const priming=await request(prompt,{...s,generate:8});
    if(!priming.valid)throw Error('Службовий запуск повернув некоректну кількість токенів або часові дані.');
    const promptTokens=priming.promptTokens;
    send('prompt',{promptTokens});
    async function sample(phase,iteration){
      if(aborted)throw Error('Зупинено користувачем');
      send('stage',{stage:phase,text:`${phase==='early'?'Початкова серія':phase==='hot'?'Після прогріву':'Прогрів'} · запит ${iteration+1}`});
      const row=await request(prompt,s);
      row.valid=row.valid&&row.promptTokens===promptTokens;
      send('sample',{sample:{...row,phase,iteration,utc:stamp()}});
      if(!row.valid)throw Error('Некоректне вимірювання: довжина відповіді, контекст або час не відповідають протоколу.');
      await tick();
    }
    for(let i=0;i<s.repeats;i++)await sample('early',i);
    if(s.heatSeconds>0){
      const began=performance.now();let i=0;
      while((performance.now()-began)/1000<s.heatSeconds){
        await sample('warmup',i++);
        send('heat',{seconds:(performance.now()-began)/1000,target:s.heatSeconds});
      }
      send('heated',{seconds:(performance.now()-began)/1000});
      for(let i=0;i<s.repeats;i++)await sample('hot',i);
    }
    terminal={type:'done'};
  }catch(e){terminal={type:'error',error:String(e?.message??e),stack:String(e?.stack??'').slice(0,4000)};}
  finally{
    try{await engine?.unload();await model?.dispose();}catch{}
    engine=model=tokenizer=null;
    if(terminal)postMessage(terminal);
  }
}
self.onmessage=e=>{if(e.data.type==='start')run(e.data);else if(e.data.type==='stop'){aborted=true;engine?.interruptGenerate();}};

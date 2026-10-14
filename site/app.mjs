import {PROTOCOL,METRICS,stats,summarize,compareReports,validateReport,csv} from './core.mjs';
const $=id=>document.getElementById(id);
const STORE='llm-browser-bench-v1';
const fmt=(n,d=1)=>typeof n==='number'&&Number.isFinite(n)?n.toLocaleString('uk-UA',{maximumFractionDigits:d}):'—';
const size=n=>n>1e9?`${(n/1e9).toFixed(2)} ГБ`:`${Math.round(n/1e6)} МБ`;
let models=[],build={},hardware={},backend='webgpu',reports=[],worker=null,current=null,timer=null,started=0,wake=null;
let gpuAvailable=false,contaminated=false,sampleActive=false,toastTimer=null;
let isRunning=false;
const statusNames={completed:'Завершено',failed:'Помилка',interrupted:'Зупинено',running:'Виконується'};

function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,7000);}
function log(message){const p=$('log');p.textContent=(p.textContent+'\n'+new Date().toLocaleTimeString('uk-UA')+' · '+message).slice(-16000);p.scrollTop=p.scrollHeight;}
function saveReports(){try{localStorage.setItem(STORE,JSON.stringify(reports));}catch{toast('Бракує місця для збереження звіту. Завантаж JSON перед закриттям сторінки.');}}
function download(data,name,type='application/json'){
  const url=URL.createObjectURL(new Blob([typeof data==='string'?data:JSON.stringify(data,null,2)],{type}));
  const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
const filename=r=>`${r.label.replace(/[^\p{L}\p{N}_-]/gu,'_').slice(0,60)}-${r.model.key}-${r.id.slice(0,8)}.json`;
function switchTab(id){
  document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!==id);
  document.querySelectorAll('.nav').forEach(el=>el.classList.toggle('active',el.dataset.tab===id));
  if(id==='compare')renderReports();
}
document.querySelectorAll('[data-tab]').forEach(el=>el.addEventListener('click',()=>switchTab(el.dataset.tab)));

async function isolation(){
  if(!('serviceWorker' in navigator)||!window.isSecureContext)return;
  try{
    await navigator.serviceWorker.register('./isolate.js');
    await navigator.serviceWorker.ready;
    if(!navigator.serviceWorker.controller)await Promise.race([new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true})),new Promise(r=>setTimeout(r,2500))]);
    const key=STORE+'-isolated-reload';
    if(!crossOriginIsolated&&navigator.serviceWorker.controller&&!sessionStorage.getItem(key)){
      sessionStorage.setItem(key,'1');location.reload();
    }
  }catch(e){console.warn('Isolation unavailable:',e);}
}
async function capabilities(){
  hardware={userAgent:navigator.userAgent,platform:navigator.userAgentData?.platform??navigator.platform,
    hardwareConcurrency:navigator.hardwareConcurrency??null,approximateDeviceMemoryGiB:navigator.deviceMemory??null,
    crossOriginIsolated:window.crossOriginIsolated,screen:{width:screen.width,height:screen.height,dpr:devicePixelRatio},
    memoryUsed:null,vramUsed:null,swap:null,temperature:null,powerWatts:null,gpu:null};
  try{
    if(navigator.gpu){
      const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
      if(adapter){
        const i=adapter.info??(adapter.requestAdapterInfo?await adapter.requestAdapterInfo():{});
        hardware.gpu={vendor:i.vendor??'',architecture:i.architecture??'',device:i.device??'',description:i.description??'',
          fallback:adapter.isFallbackAdapter??i.isFallbackAdapter??null,
          features:[...adapter.features],limits:Object.fromEntries(['maxBufferSize','maxStorageBufferBindingSize','maxComputeWorkgroupStorageSize'].map(k=>[k,adapter.limits[k]]))};
        gpuAvailable=hardware.gpu.fallback!==true;
      }
    }
  }catch(e){hardware.gpuError=String(e);}
  const gpu=hardware.gpu;
  $('device-name').textContent=gpu?.description||[gpu?.vendor,gpu?.architecture].filter(Boolean).join(' / ')||'Назва GPU недоступна браузеру';
  $('device-detail').textContent=`${hardware.platform} · ${hardware.hardwareConcurrency??'?'} логічних потоків · ${crossOriginIsolated?'багатопотоковий WASM доступний':'WASM: 1 потік'}`;
  $('gpu-pill').textContent=gpuAvailable?'● WebGPU доступний':gpu?.fallback?'Програмний GPU':'WebGPU недоступний';
  $('gpu-pill').classList.add(gpuAvailable?'good':'bad');
  $('cpu-pill').textContent=crossOriginIsolated?'● WASM + потоки':'● WASM · 1 потік';
  $('cpu-pill').classList.add('good');
  $('threads').value=Math.min(4,navigator.hardwareConcurrency||1);
  if(!gpuAvailable)setMode('wasm');
  const platform=String(hardware.platform).toLowerCase();
  $('device-label').value=platform.includes('mac')?'Мій Mac':platform.includes('win')?'Мій Windows ПК':'Мій комп’ютер';
  updateModelInfo();
}
function setMode(next){
  if(isRunning)return;
  backend=next;
  for(const [id,key] of [['gpu-mode','webgpu'],['cpu-mode','wasm']]){
    $(id).classList.toggle('selected',backend===key);$(id).setAttribute('aria-pressed',String(backend===key));
  }
  $('mode-help').textContent=backend==='webgpu'?'WebLLM · WebGPU. Обчислення FP32, ваги 4 біти.':'Transformers.js · WASM. CPU-тест малих моделей; не межа нативної продуктивності CPU.';
  const select=$('model-select');select.replaceChildren();
  models.filter(m=>m.backend===backend).forEach(m=>select.add(new Option(m.label,m.key)));
  updateModelInfo();
}
function updateModelInfo(){
  const m=models.find(m=>m.key===$('model-select').value);
  if(!m)return;
  $('model-info').textContent=`${size(m.bytes)} ваг + службові файли. ${m.key==='gpu7'?'7B може перевищити доступну пам’ять браузера або GPU.':'Модель кешується в браузері.'}`;
  $('start').disabled=isRunning||(backend==='webgpu'&&!gpuAvailable);
  $('threads').disabled=backend!=='wasm'||!crossOriginIsolated||isRunning;
  $('mode-help').textContent=backend==='webgpu'?
    gpuAvailable?'WebLLM · WebGPU. Обчислення FP32, ваги 4 біти.':'Браузер не надав фізичний WebGPU-адаптер. Обери CPU або перевір інший браузер / драйвер.':
    'Transformers.js · WASM. CPU-тест малих моделей; не межа нативної продуктивності CPU.';
}
$('gpu-mode').onclick=()=>setMode('webgpu');$('cpu-mode').onclick=()=>setMode('wasm');
$('model-select').onchange=updateModelInfo;
$('run-style').onchange=()=>{$('duration-info').textContent=$('run-style').value==='full'?'128 нових токенів · 5 + прогрів 20 хв + 5 повторів. Разом понад 20 хвилин.':'64 нові токени · 3 повтори · один запит одночасно.';};

function setBusy(value){
  isRunning=value;
  $('test-form').querySelectorAll('input,select,textarea,button').forEach(e=>e.disabled=value);
  $('stop').disabled=!value;
  if(!value)updateModelInfo();
}
function renderMetrics(){
  const samples=current?.samples??[];
  const phase=samples.some(r=>r.phase==='hot')?'hot':samples.at(-1)?.phase??'early';
  const s=summarize(samples,phase);
  $('tg-value').textContent=fmt(s.tg?.median);
  $('pp-value').textContent=fmt(s.pp?.median);
  $('ttft-value').textContent=fmt(s.ttft?.median,2);
  $('metric-caption').textContent=`Медіани · ${phase==='hot'?'після прогріву':phase==='warmup'?'під час прогріву':'початкова серія'} · ${s.runs} коректних повторів${s.invalid?`, ${s.invalid} виключено`:''}.`;
}
function finish(status,error){
  if(!current||!isRunning)return;
  current.status=status;current.finished=new Date().toISOString();if(error)current.error=error;
  worker?.terminate();worker=null;clearInterval(timer);wake?.release().catch(()=>{});wake=null;
  $('run-state').textContent=(statusNames[status]??status).toUpperCase();$('run-state').classList.remove('running');
  $('stage-text').textContent=error??(status==='completed'?'Тест завершено. Звіт збережений у браузері.':'Тест зупинено. Часткові дані збережено.');
  $('progress').value=status==='completed'?1:0;
  $('download-current').disabled=false;setBusy(false);saveReports();renderReports();renderMetrics();
  if(error){log(error);$('log-details').open=true;}
}
$('test-form').addEventListener('submit',async e=>{
  e.preventDefault();if(isRunning)return;
  if(document.hidden){toast('Відкрий вкладку перед початком тесту.');return;}
  const m=models.find(m=>m.key===$('model-select').value);if(!m)return;
  if(m.backend==='webgpu'&&!gpuAvailable){toast('WebGPU недоступний. Обери CPU.');return;}
  const full=$('run-style').value==='full',profile=$('profile').value;
  const threads=Number($('threads').value);
  if(!Number.isInteger(threads)||threads<1||threads>16){toast('Кількість потоків: від 1 до 16.');return;}
  current={id:crypto.randomUUID(),protocol:PROTOCOL,implementation:build.implementation,build,
    label:$('device-label').value.trim()||'Без назви',notes:$('notes').value,model:m,backend:m.backend,
    hardware:structuredClone(hardware),settings:{profile,context:profile==='long'?8192:2048,
      generate:full?128:64,repeats:full?5:3,heatSeconds:full?1200:0,threads,concurrency:1,batch:1},
    metricMethod:m.backend==='webgpu'?'webllm-usage-extra-v1':'wasm-first-forward-and-stream-v1',
    kvPolicy:'engine-default-pinned-model; fresh-per-request',samples:[],status:'running',
    visibilityIncidents:0,started:new Date().toISOString(),limitations:['Browser benchmark only; not native CUDA/Metal/CPU.',
      'No reliable system RAM/VRAM, swap, temperature or power sensors.',
      'CPU and GPU engines use different model files. Do not compare across backends.',
      'Model revisions are pinned; manifest hashes are publisher metadata, not an independent browser rehash.']};
  reports.push(current);saveReports();setBusy(true);sampleActive=false;contaminated=false;
  $('run-intro').hidden=true;$('run-progress').hidden=false;$('download-current').disabled=false;
  $('run-state').textContent='ВИКОНУЄТЬСЯ';$('run-state').classList.add('running');
  $('stage-text').textContent='Підготовка…';$('progress-detail').textContent='';$('progress').removeAttribute('value');
  $('log').textContent='';log(`${m.label} · ${m.engine} ${m.version} · ${m.dtype}`);renderMetrics();renderReports();
  started=Date.now();timer=setInterval(()=>{const s=Math.floor((Date.now()-started)/1000);$('elapsed').textContent=`${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;},1000);
  try{if(navigator.wakeLock)wake=await navigator.wakeLock.request('screen');}catch{}
  if(!isRunning)return;
  try{
    worker=new Worker(new URL('./worker.mjs',import.meta.url),{type:'module'});
    worker.onerror=e=>finish('failed',e.message||'Worker завершився з помилкою.');
    worker.onmessage=e=>{
      if(!isRunning)return;const d=e.data;
      if(d.type==='progress'){
        $('progress-detail').textContent=d.text??'';
        if(typeof d.progress==='number')$('progress').value=Math.max(0,Math.min(1,d.progress));else $('progress').removeAttribute('value');
      }else if(d.type==='stage'){
        $('stage-text').textContent=d.text;$('progress-detail').textContent='';$('progress').removeAttribute('value');
        sampleActive=['early','warmup','hot'].includes(d.stage);contaminated=document.hidden;log(d.text);
      }else if(d.type==='runtime'){current.runtime=d.details;log(`Фактичний runtime: ${JSON.stringify(d.details)}`);
      }else if(d.type==='loaded'){current.loadSeconds=d.loadSeconds;current.promptHash=d.promptHash;log(`Завантаження й ініціалізація: ${fmt(d.loadSeconds)} с`);
      }else if(d.type==='prompt'){current.promptTokens=d.promptTokens;log(`Фактичний запит: ${d.promptTokens} токенів`);
      }else if(d.type==='sample'){
        const row=d.sample;if(contaminated||document.hidden){row.valid=false;row.exclusion='background-tab';}
        sampleActive=false;current.samples.push(row);renderMetrics();saveReports();
        log(`PP ${fmt(row.pp)} · TG ${fmt(row.tg)} · TTFT ${fmt(row.ttft,2)} с${row.valid?'':' · виключено'}`);
      }else if(d.type==='heat'){$('progress').value=Math.min(1,d.seconds/d.target);$('progress-detail').textContent=`Прогрів: ${Math.floor(d.seconds/60)} / ${Math.round(d.target/60)} хв`;
      }else if(d.type==='heated'){current.heatSecondsActual=d.seconds;
      }else if(d.type==='done')finish('completed');
      else if(d.type==='error'){current.errorStack=d.stack;finish('failed',d.error);}
    };
    worker.postMessage({type:'start',model:m,settings:current.settings});
  }catch(e){finish('failed',String(e.message??e));}
});
$('stop').onclick=()=>finish('interrupted');
$('download-current').onclick=()=>{if(current)download(current,filename(current));};
document.addEventListener('visibilitychange',()=>{
  if(isRunning&&document.hidden){contaminated=true;current.visibilityIncidents++;saveReports();log('Вкладка перейшла у фон: порівняння цього запуску буде позначено некоректним.');}
});
window.addEventListener('beforeunload',e=>{if(isRunning){saveReports();e.preventDefault();e.returnValue='';}});

function node(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;}
function renderReports(){
  $('saved-count').textContent=reports.length;
  const left=$('left-report'),right=$('right-report');const lv=left.value,rv=right.value;
  left.replaceChildren();right.replaceChildren();
  reports.forEach(r=>{const label=`${r.label} · ${r.model.label??r.model.repository} · ${r.settings.profile} · ${new Date(r.started).toLocaleString('uk-UA')}`;left.add(new Option(label,r.id));right.add(new Option(label,r.id));});
  if(reports.some(r=>r.id===lv))left.value=lv;
  if(reports.some(r=>r.id===rv))right.value=rv;else if(reports.length>1)right.value=reports.at(-1).id;
  if(reports.length>1&&right.value===left.value)right.value=[...reports].reverse().find(r=>r.id!==left.value).id;
  $('report-rows').replaceChildren();
  for(const r of [...reports].reverse()){
    const tr=node('tr');const phase=r.samples.some(s=>s.phase==='hot')?'hot':'early';const s=summarize(r.samples,phase);
    const a=node('td',r.label);a.append(node('small',new Date(r.started).toLocaleString('uk-UA')));tr.append(a);
    const b=node('td',r.model.label??r.model.repository);b.append(node('small',`${r.model.engine} · ${r.backend} · ${r.model.dtype}`));tr.append(b);
    tr.append(node('td',`${r.settings.profile==='long'?'Довгий':'Короткий'} · ${r.settings.heatSeconds?'20 хв':'швидкий'}`),node('td',statusNames[r.status]??r.status),node('td',`${fmt(s.tg?.median)} ток/с`));
    const actions=node('td'),btn=node('button','JSON ↓','text-button');btn.onclick=()=>download(r,filename(r));actions.append(btn);tr.append(actions);$('report-rows').append(tr);
  }
  renderComparison();
}
function renderComparison(){
  const body=$('comparison-body');body.replaceChildren();
  const a=reports.find(r=>r.id===$('left-report').value),b=reports.find(r=>r.id===$('right-report').value);
  if(!a||!b||a.id===b.id){body.className='comparison-empty';body.textContent='Обери два різні звіти. Імпортуй JSON із другого комп’ютера.';return;}
  body.className='';const phase=$('phase').value,c=compareReports(a,b,phase);
  body.append(node('p',c.comparable?'Параметри збігаються. Можна зіставляти ці вимірювання.':`${c.reason}. Коефіцієнти переваги не розраховуються.`,c.comparable?'compare-alert':'compare-alert warning'));
  for(const [key,title] of Object.entries(METRICS)){
    const block=node('div',undefined,'bar-metric');block.append(node('h3',`${title} · ${key==='ttft'?'менше краще':'більше краще'}`));
    const max=Math.max(c.a[key]?.median??0,c.b[key]?.median??0,0.0001);
    for(const [r,s,cls] of [[a,c.a,''],[b,c.b,'b']]){
      const row=node('div',undefined,'bar-row');row.append(node('span',r.label,'bar-label'));
      const track=node('div',undefined,'bar-track'),fill=node('div',undefined,'bar-fill '+cls);fill.style.width=`${Math.max(0,(s[key]?.median??0)/max*100)}%`;track.append(fill);row.append(track,node('span',fmt(s[key]?.median,key==='ttft'?2:1),'bar-number'));block.append(row);
    }
    if(c.comparable)block.append(node('p',`B / A = ${fmt(c.ratios[key],2)} · розкид A: ${fmt(c.a[key]?.min)}–${fmt(c.a[key]?.max)}; B: ${fmt(c.b[key]?.min)}–${fmt(c.b[key]?.max)}`,'field-help'));
    body.append(block);
  }
  const meta=node('div',undefined,'compare-meta');
  for(const r of [a,b]){
    const threads=r.backend==='wasm'?`${r.runtime?.wasmThreads??'?'} WASM-потоків`:'службові CPU-потоки не вимірюються';
    meta.append(node('p',`${r.label}: ${r.backend}, ${threads}; ${r.promptTokens??'?'} вхідних → ${r.settings.generate} нових токенів. ${r.hardware?.userAgent??'Браузер невідомий'}. ${r.notes??''}`));
  }
  meta.append(node('p','Сайт не визначає статистично значущого переможця. Порівняй розкид і повтори серію. Дані swap, температури й потужності недоступні.'));body.append(meta);
}
for(const id of ['left-report','right-report','phase'])$(id).onchange=renderComparison;
$('import').onchange=async e=>{
  try{
    let count=0;
    for(const file of e.target.files){
      if(file.size>25*1024*1024)throw Error('Максимальний розмір JSON — 25 МБ.');
      const parsed=JSON.parse(await file.text());const data=Array.isArray(parsed)?parsed:[parsed];
      if(data.length>100)throw Error('Забагато звітів у файлі.');
      for(const raw of data){const r=validateReport(raw);if(!r.id)r.id=crypto.randomUUID();if(!reports.some(x=>x.id===r.id)){reports.push(r);count++;}}
    }
    saveReports();renderReports();toast(`Імпортовано звітів: ${count}`);
  }catch(e){toast(String(e.message??e));}finally{e.target.value='';}
};
$('export-all').onclick=()=>download(reports,'llm-browser-reports.json');
$('export-csv').onclick=()=>download(csv(reports),'llm-browser-measurements.csv','text/csv;charset=utf-8');
$('clear-reports').onclick=()=>{
  if(isRunning){toast('Спочатку заверши тест.');return;}
  if(!confirm('Видалити збережені звіти з цього браузера? Завантажені JSON-файли залишаться.'))return;
  reports=[];saveReports();renderReports();
};

async function init(){
  try{const stored=JSON.parse(localStorage.getItem(STORE)||'[]');reports=stored.map(validateReport).map(r=>r.status==='running'?{...r,status:'interrupted',error:'Сторінку закрито до завершення'}:r);}catch{reports=[];}
  try{
    const [m,b]=await Promise.all([fetch('./models.json').then(r=>{if(!r.ok)throw Error('Не вдалося прочитати каталог моделей');return r.json();}),fetch('./build-info.json').then(r=>r.json())]);
    models=m.models;build=b;setMode('webgpu');await capabilities();renderReports();
    await isolation();
  }catch(e){$('start').disabled=true;$('device-name').textContent='Не вдалося підготувати сайт';toast(String(e.message??e));log(String(e.message??e));}
}
init();

// Integration QA on a local preview. Results are not a laptop benchmark dataset.
// RUN_GPU=1 additionally downloads the 278 MB GPU model; default downloads CPU 181 MB.
import { chromium } from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
const out=process.env.QA_OUT??'test-results';await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1100}});
const page=await context.newPage();
const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE ERROR',e.message);});
page.on('console',m=>{if(m.type()==='error')console.log('CONSOLE',m.text().slice(0,500));});
try{
  await page.goto(process.env.SITE_URL??'http://127.0.0.1:4173/',{waitUntil:'networkidle'});
  await page.waitForFunction(()=>document.getElementById('cpu-pill')?.textContent.includes('●'));
  await page.waitForTimeout(3000);
  console.log('CAPABILITIES',await page.locator('.device-strip').innerText());
  console.log('ISOLATED',await page.evaluate(()=>crossOriginIsolated));
  await page.screenshot({path:out+'/desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  if(overflow)throw Error('Horizontal overflow on mobile');
  await page.screenshot({path:out+'/mobile.png',fullPage:true});
  await page.setViewportSize({width:1440,height:1100});
  if(process.env.UI_ONLY==='1'){
    console.log('UI_ONLY passed');
  }else{
    await page.locator('#cpu-mode').click();
    await page.locator('#model-select').selectOption('cpu135');
    await page.locator('#device-label').fill('QA — not a laptop comparison');
    await page.locator('#start').click();
    await page.waitForFunction(()=>['ЗАВЕРШЕНО','ПОМИЛКА'].includes(document.getElementById('run-state')?.textContent),{},{timeout:600000});
    const state=await page.locator('#run-state').innerText();
    console.log('CPU STATE',state);console.log('CPU LOG',await page.locator('#log').textContent());
    await page.screenshot({path:out+'/cpu-result.png',fullPage:true});
    const reports=await page.evaluate(()=>JSON.parse(localStorage.getItem('llm-browser-bench-v1')));
    await writeFile(out+'/qa-cpu-report.json',JSON.stringify(reports,null,2));
    if(state!=='ЗАВЕРШЕНО')throw Error('Real CPU smoke failed');
    if(reports.at(-1).samples.length!==3||reports.at(-1).samples.some(s=>!s.valid))throw Error('Invalid real CPU samples');
    const duplicate=structuredClone(reports.at(-1));duplicate.id='fixture-comparison';duplicate.label='QA copy — fixture';
    await page.locator('.nav[data-tab="compare"]').click();
    await page.locator('#import').setInputFiles({name:'fixture.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(duplicate))});
    await page.waitForFunction(()=>document.getElementById('comparison-body').textContent.includes('Параметри збігаються'));
    await page.screenshot({path:out+'/comparison.png',fullPage:true});
    await page.locator('#phase').selectOption('hot');
    await page.waitForFunction(()=>document.getElementById('comparison-body').textContent.includes('Немає повних коректних серій'));
    if(process.env.RUN_GPU==='1'){
      await page.locator('.nav[data-tab="bench"]').click();
      await page.locator('#gpu-mode').click();
      if(await page.locator('#start').isDisabled())console.log('GPU QA SKIPPED: no physical adapter available');
      else{
        await page.locator('#model-select').selectOption('gpu05');
        await page.locator('#start').click();
        await page.waitForFunction(()=>['ЗАВЕРШЕНО','ПОМИЛКА'].includes(document.getElementById('run-state')?.textContent),{},{timeout:600000});
        const gpuState=await page.locator('#run-state').innerText();console.log('GPU STATE',gpuState);console.log('GPU LOG',await page.locator('#log').textContent());
        await page.screenshot({path:out+'/gpu-result.png',fullPage:true});
        await writeFile(out+'/qa-all-reports.json',await page.evaluate(()=>localStorage.getItem('llm-browser-bench-v1')));
        if(gpuState!=='ЗАВЕРШЕНО')throw Error('Real GPU smoke failed');
      }
    }
  }
  if(errors.length)throw Error('Browser page errors: '+errors.join('; '));
  console.log('Browser QA passed');
}catch(e){await page.screenshot({path:out+'/failure.png',fullPage:true});console.error(e);process.exitCode=1;}
finally{await browser.close();}

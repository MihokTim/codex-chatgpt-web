import {afterAll,beforeAll,expect,test} from 'bun:test';
import {chromium,type Browser,type Page} from 'playwright-core';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {defaultChromeExecutable} from '../src/config';
import {ChatGptBrowserWorker} from '../src/adapters/chatgpt-web/browser-worker';
import {CHATGPT_WEB_MODEL_ID,resolveChatGptWebModelMode} from '../src/adapters/chatgpt-web/model';
let browser:Browser;
beforeAll(async()=>{browser=await chromium.launch({executablePath:defaultChromeExecutable(),headless:true});});
afterAll(async()=>{await browser?.close();});

test.each(['first-read','after-rebind'])('the worker never emits a foreign projection between receipt reads: %s',async(scenario)=>{
 const page=await browser.newPage();
 const root=mkdtempSync(join(tmpdir(),'response-receipt-loop-'));
 const capabilities={localToolsEnabled:false,solAvailable:true,extraHighAvailable:true,proAvailable:true};
 let draft='',inject=false,injected=false;
 const chunks:string[]=[];
 const worker:any=Object.assign(Object.create(ChatGptBrowserWorker.prototype),{
  config:{appName:'fixture',browserDiagnosticsPath:root,turnTimeoutMs:30000},
  prepareChatSurface:async()=>{await page.setContent('<main></main>');},
  selectModelAndEffort:async(_page:Page,model:string,effort:string)=>resolveChatGptWebModelMode(model,effort,capabilities),
  attachPromptWithCompactionRetry:async(_page:Page,text:string)=>{draft=text;},
  attachFiles:async()=>{},assertSelectedEffort:async()=>{},
  sendAttachedPrompt:async(_page:Page,baseline:any,_capture:unknown,_signal:unknown,_progress:unknown,lifecycle:any)=>{
   await lifecycle.onSendActivated?.();baseline.submissionAccepted=true;
   const receipt=draft.match(/CODEXRESPONSE[a-f0-9]{32}/)![0];
   await page.locator('main').evaluate((node,receipt)=>{node.innerHTML=`<div data-turn-key="fallback-turn-0"><div data-chatgpt-search-unit-key="fallback-turn-0:1:assistant"><div data-markdown-text-style="assistant-message"><p>${receipt}<br>OWNED ANSWER</p></div></div><button aria-label="Copy"></button></div>`;},receipt);
   await lifecycle.onSubmitted?.();return 'generation_running';
  },
 });
 const originalWait=worker.waitForNewAssistantTurn.bind(worker);
 worker.waitForNewAssistantTurn=async(...args:any[])=>{
  const binding=await originalWait(...args);
  if(scenario==='first-read')inject=true;
  else return {...binding,identity:'timeline-assistant:missing',locator:page.locator('[data-turn-key="missing"]')};
  return binding;
 };
 const originalRebind=worker.reconcileAssistantTurnBinding.bind(worker);
 worker.reconcileAssistantTurnBinding=async(...args:any[])=>{const binding=await originalRebind(...args);if(scenario==='after-rebind'&&!injected)inject=true;return binding;};
 const originalSnapshot=worker.responseDomSnapshot.bind(worker);
 worker.responseDomSnapshot=async(...args:any[])=>{
  const snapshot=await originalSnapshot(...args);
  if(inject&&!injected&&snapshot.responsePresent){inject=false;injected=true;return {...snapshot,visibleText:'FOREIGN ANSWER',fullHtml:'<p>FOREIGN ANSWER</p>',markdownSegments:[{key:'foreign',tag:'p',text:'FOREIGN ANSWER',html:'<p>FOREIGN ANSWER</p>',streamable:true}]};}
  return snapshot;
 };
 try{
  const answer=await worker.runBrowserTurn({traceId:'receipt_'+scenario.replaceAll('-','_'),modelId:CHATGPT_WEB_MODEL_ID,reasoning:'high',capabilities,
   onTextDelta:(text:string)=>chunks.push(text),prepare:async()=>({text:'Return OWNED ANSWER',images:[],release(){}})},undefined,page);
  expect(injected).toBeTrue();expect(answer).toBe('OWNED ANSWER');expect(chunks.join('')).toBe('OWNED ANSWER');
 }finally{
  await page.close();const path=relative(resolve(tmpdir()),resolve(root));
  if(!path||path.startsWith('..'))throw new Error('Unexpected fixture cleanup path');
  rmSync(root,{recursive:true,force:true});
 }
},40000);

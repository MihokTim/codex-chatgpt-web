import {afterAll, beforeAll, expect, test, setDefaultTimeout} from 'bun:test';
import {chromium, type Browser} from 'playwright-core';
import {defaultChromeExecutable} from '../src/config';
import {ChatGptBrowserWorker,ChatGptCompletionTracker} from '../src/adapters/chatgpt-web/browser-worker';
import {ChatGptLunaCheckpointStream,CHATGPT_LUNA_CHECKPOINT_MARKER} from '../src/adapters/chatgpt-web/rolling-checkpoint';
import {createChatGptStructuredOutputValidator} from '../src/adapters/chatgpt-web/output-validation';
import {hasResponseMarker, responseMarkerTraceText, ResponseMarkerStream, stripResponseMarker} from '../src/adapters/chatgpt-web/response-marker';
// Each candidate has a bounded DOM read; ambiguity fixtures observe two candidates.
setDefaultTimeout(15_000);
const render=(page:any,html:string)=>page.evaluate((value:string)=>{document.body.innerHTML=value;},html);
const marker='CODEXRESPONSE'+'a'.repeat(32);
const oldMarker='CODEXRESPONSE'+'b'.repeat(32);
let browser:Browser;
beforeAll(async()=>{browser=await chromium.launch({executablePath:defaultChromeExecutable(),headless:true});});
afterAll(async()=>{await browser?.close();});
const orphan=(key:string,text:string)=>`<div data-turn-key="${key}"><div data-chatgpt-search-unit-key="${key}:1:assistant" data-chatgpt-search-message-ids="response-${key}"><div data-markdown-text-style="assistant-message"><p>${text}</p></div></div><button aria-label="Copy"></button></div>`;
const user='<div data-turn-key="user-uuid"><div data-chatgpt-search-unit-key="fallback-turn-0:0:user" data-chatgpt-search-message-ids="user-uuid"><div data-user-message-bubble>request</div></div></div>';

test.each([false,true])('receipt binds a replaced user container, including reused positional keys (history=%s)',async(history)=>{
 const page=await browser.newPage();const worker:any=Object.create(ChatGptBrowserWorker.prototype);
 try{
  await render(page, history?orphan('fallback-turn-0','Old answer'): '');
  const baseline=await worker.captureSubmissionBaseline(page);
  baseline.responseMarker=marker;baseline.submissionAccepted=true;
  if(!history){await render(page, user);expect(await worker.currentSubmissionEvidence(page,baseline)).toBe('user_turn');}
  await render(page, orphan('fallback-turn-0',marker+'<br>Actual answer'));
  const binding=await worker.waitForNewAssistantTurn(page,baseline,Date.now()+2000);
  expect(binding.identity).toBe('timeline-assistant:fallback-turn-0');
  const snapshot=await worker.responseDomSnapshot(binding.locator,{});
  expect(stripResponseMarker(snapshot.visibleText,marker)).toBe('Actual answer');
 }finally{await page.close();}
});

test.each(['old','middle','partial','unsent','unknown-candidate','code','quote'])('receipt does not authorize an unproven response: %s',async(scenario)=>{
 const page=await browser.newPage();const worker:any=Object.create(ChatGptBrowserWorker.prototype);
 try{
  await render(page, '');const baseline=await worker.captureSubmissionBaseline(page);
  baseline.responseMarker=marker;baseline.submissionAccepted=scenario!=='unsent';
  const text=scenario==='old'?oldMarker+'<br>Old':scenario==='middle'?'Quoted '+marker:scenario==='partial'?marker.slice(0,-1):marker+'<br>Answer';
  await render(page, orphan('fallback-turn-0',scenario==='code'?'<pre><code>'+marker+'\nAnswer</code></pre>':scenario==='quote'?'<blockquote>'+marker+'<br>Answer</blockquote>':text)+(scenario==='unknown-candidate'?orphan('other','Unknown'):''));
  if(scenario==='unknown-candidate'){
   const original=worker.responseDomSnapshot.bind(worker);
   worker.responseDomSnapshot=async(locator:any,cache:any)=> (await locator.getAttribute('data-turn-key'))==='other'?{responsePresent:false,visibleText:''}:original(locator,cache);
  }
  const state=await worker.submissionDomState(page,{});
  await expect(worker.responseIdentityByReceipt(page,baseline,state)).resolves.toBeUndefined();
 }finally{await page.close();}
});

test.each(['duplicate','foreign-user'])('receipt rejects conflicting ownership: %s',async(scenario)=>{
 const page=await browser.newPage();const worker:any=Object.create(ChatGptBrowserWorker.prototype);
 try{
  await render(page, '');const baseline=await worker.captureSubmissionBaseline(page);
  baseline.responseMarker=marker;baseline.submissionAccepted=true;
  await render(page, orphan('one',marker+'<br>A')+(scenario==='duplicate'?orphan('two',marker+'<br>B'):user));
  await expect(worker.waitForNewAssistantTurn(page,baseline,Date.now()+20000)).rejects.toThrow(scenario==='duplicate'?'ambiguous':'another user');
 }finally{await page.close();}
},30000);

test('a previously bound user answer can rebind only through its own receipt after replacement',async()=>{
 const page=await browser.newPage();const worker:any=Object.create(ChatGptBrowserWorker.prototype);
 try{
  await render(page, '');const baseline=await worker.captureSubmissionBaseline(page);
  baseline.responseMarker=marker;baseline.submissionAccepted=true;
  await render(page, user.replace('</div></div></div>','</div></div><span data-chatgpt-agent-turn-start></span><div data-markdown-text-style="assistant-message">Starting</div></div>'));
  const binding=await worker.waitForNewAssistantTurn(page,baseline,Date.now()+2000);
  await render(page, orphan('fallback-turn-0',marker+'<br>Final'));
  expect((await worker.reconcileAssistantTurnBinding(page,baseline,binding)).identity).toBe('timeline-assistant:fallback-turn-0');
 }finally{await page.close();}
});

test('private receipt is removed across every stream split without changing the final answer',()=>{
 for(const newline of ['\n','\r\n','  \n','  \r\n']){
  const input=marker+newline+newline+'答え\n```json\n{"ok":true}\n```';
  for(let i=0;i<=input.length;i++){
   const stream=new ResponseMarkerStream(marker);
   expect(stream.push(input.slice(0,i))+stream.push(input.slice(i))+stream.finish()).toBe('答え\n```json\n{"ok":true}\n```');
  }
 }
 expect(hasResponseMarker('Quoted '+marker,marker)).toBeFalse();
 expect(hasResponseMarker(marker+'x\nanswer',marker)).toBeFalse();
 const normal=new ResponseMarkerStream(marker);
 expect(normal.push('CODE')+normal.push(' is ordinary text')+normal.finish()).toBe('CODE is ordinary text');
});

test('cumulative commentary is normalized before partial trace deltas can expose a receipt',()=>{
 for(let i=0;i<marker.length;i++)expect(responseMarkerTraceText(marker.slice(0,i),marker,false)).toBe('');
 expect(responseMarkerTraceText(marker+'\n\nProgress',marker,true)).toBe('Progress');
 expect(responseMarkerTraceText('CODE',marker,true)).toBe('CODE');
 expect(responseMarkerTraceText('Normal commentary',marker,false)).toBe('Normal commentary');
 const stream=new ResponseMarkerStream(marker);
 expect(stream.push(marker.slice(0,-3))).toBe('');
 expect(()=>stream.finish()).toThrow('incomplete response receipt');
});

test('a reused response container loses its receipt proof when its contents change',async()=>{
 const page=await browser.newPage();const worker:any=Object.create(ChatGptBrowserWorker.prototype);
 try{
  await render(page,'');const baseline=await worker.captureSubmissionBaseline(page);
  baseline.responseMarker=marker;baseline.submissionAccepted=true;
  await render(page,orphan('fallback-turn-0',marker+'<br>Owned'));
  const binding=await worker.waitForNewAssistantTurn(page,baseline,Date.now()+2000);
  expect(binding.receiptBound).toBeTrue();
  await render(page,orphan('fallback-turn-0',oldMarker+'<br>Different response'));
  expect(await binding.locator.count()).toBe(1);
  expect(await worker.responseIdentityByReceipt(page,baseline,await worker.submissionDomState(page,{}))).toBeUndefined();
 }finally{await page.close();}
});

test('normalizing the pre-tool receipt does not make an unchanged pre-tool answer complete',async()=>{
 const page=await browser.newPage();const worker:any=Object.create(ChatGptBrowserWorker.prototype);
 try{
  await render(page,'');const baseline=await worker.captureSubmissionBaseline(page);baseline.responseMarker=marker;
  await render(page,user.replace('</div></div></div>',`</div></div><div data-chatgpt-search-unit-key="fallback:1:assistant" data-chatgpt-search-message-ids="answer-uuid"><div data-markdown-text-style="assistant-message"><p>${marker}<br>Before tool</p></div></div></div>`));
  const tracker=new ChatGptCompletionTracker(0,10);
  const beforeTool=await worker.currentSubmissionAnswerText(page,baseline);
  expect(beforeTool).toBe('Before tool');
  tracker.observeToolBatch(1,beforeTool);
  const state={responsePresent:true,running:false,currentText:stripResponseMarker(marker+'\nBefore tool',marker),completionActionVisible:true};
  expect(tracker.update(state,0)).toBeFalse();
  expect(()=>tracker.update(state,11)).toThrow('after its last Codex tool call');
 }finally{await page.close();}
});

test('receipt removal composes with private Luna checkpoint streaming',()=>{
 const receipt=new ResponseMarkerStream(marker),checkpoint=new ChatGptLunaCheckpointStream();
 const raw=marker+'\n\nVisible answer.\n\n'+CHATGPT_LUNA_CHECKPOINT_MARKER+'\nObjective: preserve the fixture.';
 let visible='';
 for(const character of raw)visible+=checkpoint.push(receipt.push(character));
 visible+=checkpoint.push(receipt.finish());
 const result=checkpoint.finishOptional(stripResponseMarker(raw,marker));
 expect(visible+result.visibleRemainder).toBe('Visible answer.');
 expect(result.answer).toBe('Visible answer.');expect(result.captured).toBeDefined();
});

test('the public answer still satisfies strict JSON after a split transport receipt',()=>{
 const validate=createChatGptStructuredOutputValidator({type:'json_schema',name:'fixture',strict:true,
  schema:{type:'object',properties:{ok:{const:true}},required:['ok'],additionalProperties:false}})!;
 const wire=marker+'  \n{"ok":true}',stream=new ResponseMarkerStream(marker);
 let answer='';for(const character of wire)answer+=stream.push(character);answer+=stream.finish();
 expect(answer).toBe('{"ok":true}');expect(()=>validate(answer)).not.toThrow();
 expect(()=>validate(wire)).toThrow('malformed JSON');
});

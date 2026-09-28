const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {patchRenderer,readAsar,packedFile,rewriteAsar,verifyMembers,FILE,MAIN,patchMain,sha}=require('../scripts/orca-repair.cjs');
const root=process.env.ORCA_REPAIR_STAGE;

test('deployment distinguishes the desktop from the preserved terminal daemon',()=>{
  const {blockingProcesses}=require('../scripts/orca-repair.cjs');
  const app='C:\\Programs\\Orca',exe=path.win32.join(app,'Orca.exe');
  const daemon={ExecutablePath:'C:\\Local\\Orca\\daemon-host\\Orca.exe',CommandLine:'Orca.exe daemon-entry.js'};
  const crash={ExecutablePath:exe,CommandLine:'Orca.exe --type=crashpad-handler --database=x'};
  assert.equal(blockingProcesses([daemon,crash],app).length,0);
  for(const process of [{ExecutablePath:exe,CommandLine:'Orca.exe'},
    {ExecutablePath:exe.toLowerCase(),CommandLine:'Orca.exe --type=renderer'},
    {ExecutablePath:null,CommandLine:null}]) assert.equal(blockingProcesses([process],app).length,1);
});

test('unknown bundles and repeated patches fail closed',()=>{
  assert.throws(()=>patchRenderer('not the known bundle'),/anchor/);
  assert.throws(()=>patchRenderer('function orcaLegacyPasteOptions('),/Already patched/);
});

test('invalid archive headers fail',()=>assert.throws(()=>readAsar(Buffer.alloc(20)),/Invalid/));

test('staged real bundle: only intended member changed and candidate parses', {skip:!root},()=>{
  const before=fs.readFileSync(path.join(root,'app.original.asar'));
  const after=fs.readFileSync(path.join(root,'app.patched.asar'));
  assert.deepEqual(verifyMembers(before,after).sort(),[FILE,MAIN].sort());
  assert.equal(packedFile(after,FILE).toString(),patchRenderer(packedFile(before,FILE).toString()));
  const asar=require('../launcher/node_modules/@electron/asar');
  assert.ok(asar.listPackage(path.join(root,'app.patched.asar')).some(name=>name.endsWith(path.normalize(FILE))));
  assert.equal(asar.extractFile(path.join(root,'app.patched.asar'),path.normalize(FILE)).toString(),packedFile(after,FILE).toString());
  const changed=Buffer.from(packedFile(after,FILE));changed[0]^=1;
  assert.throws(()=>verifyMembers(before,rewriteAsar(after,new Map([['package.json',Buffer.from('{}')],[FILE,changed]]))),/Unexpected/);
});

test('staged real encoder: Japanese/CRLF/ESC preserved safely; all alternate targets opt out', {skip:!root},()=>{
  const before=fs.readFileSync(path.join(root,'app.original.asar'));
  const source=fs.readFileSync(path.join(root,'renderer','legacy-patched.js'),'utf8');
  const encoder=packedFile(before,'out/renderer/assets/terminal-pty-input-transaction-BoLSjNMd.js').toString().split('export{')[0];
  const aw=source.slice(source.indexOf('function Aw('),source.indexOf('function jw('));
  const helper=source.slice(source.indexOf('function orcaLegacyPasteOptions('),source.indexOf('function AT('));
  const status=packedFile(before,'out/renderer/assets/workspace-status-B-iYqCOV.js').toString();
  const predicate=status.slice(status.indexOf('function b('),status.indexOf('var A='));
  const predicateContext={a:cwd=>/^\\\\(?:wsl\$|wsl.localhost)\\/i.test(cwd)};
  vm.createContext(predicateContext);vm.runInContext(predicate+';globalThis.ha=k',predicateContext);
  const state={tabsByWorktree:{w:[{id:'tab'}]}};
  const context={G:{getState:()=>state},cl:id=>id.startsWith('remote:'),Ix:()=>({worktreeId:'w',worktreePath:'C:\\workspace'}),
    ft:()=>null,ri:()=> 'local',navigator:{userAgent:'Windows'},ha:predicateContext.ha};
  vm.createContext(context);
  vm.runInContext(encoder+';globalThis.yl=v;globalThis.bl=p;globalThis.gl=u;globalThis.kw=e=>/[\\r\\n]/.test(e);'+aw+helper,context);
  const target={ptyId:'30'},event={agent:'codex',terminalTabId:'tab'};
  const options=context.orcaLegacyPasteOptions(event,target);
  assert.equal(options.windowsInputRecordNewline,'alt-enter');
  for(const text of ['日本語一行目\n二行目\n三行目','a\r\nb\rc','a\x1bb']) {
    assert.equal(context.Aw(text,options),text.replace(/\x1b/g,'␛').replace(/\r\n|\r|\n/g,'\x1b\r'));
    assert.equal(context.Aw(text,{}),/[\r\n]/.test(text)?context.bl(text):context.gl(text));
  }
  assert.equal(Object.keys(context.orcaLegacyPasteOptions({...event,agent:'claude'},target)).length,0);
  assert.equal(Object.keys(context.orcaLegacyPasteOptions(event,{ptyId:'remote:1'})).length,0);
  state.tabsByWorktree.w[0].shellOverride='C:\\Windows\\System32\\wsl.exe';
  assert.equal(Object.keys(context.orcaLegacyPasteOptions(event,target)).length,0);
  delete state.tabsByWorktree.w[0].shellOverride;
  context.navigator.userAgent='Linux';assert.equal(Object.keys(context.orcaLegacyPasteOptions(event,target)).length,0);
  context.navigator.userAgent='Windows';context.ri=()=> 'ssh:host';assert.equal(Object.keys(context.orcaLegacyPasteOptions(event,target)).length,0);
  context.ri=()=> 'local';context.Ix=()=>null;assert.equal(Object.keys(context.orcaLegacyPasteOptions(event,target)).length,0);
  context.Ix=()=>({worktreeId:'w',worktreePath:'C:\\workspace',runtimeEnvironmentId:'host'});
  assert.equal(Object.keys(context.orcaLegacyPasteOptions(event,target)).length,0);
});

test('structured dispatch waits for same submission and never resends', {skip:!root},async()=>{
  const source=fs.readFileSync(path.join(root,'renderer','main-patched.cjs'),'utf8');
  const fn=source.slice(source.indexOf('async function Xkn('),source.indexOf('function Zkn('));
  class RuntimeError extends Error {constructor(code,message){super(message);this.code=code;}}
  const context=vm.createContext({Z:RuntimeError,Own:x=>x,own:()=> 'operation',cwn:()=> 'fingerprint'});
  vm.runInContext(fn,context);
  for(const target of ['accepted','rejected','pending','unknown','wait-error']){
    let sends=0,waits=0;
    const host={deps:{store:{getRecord:()=>({lease:{runtimeFence:1}})}},
      send:async()=>{sends++;return {ok:true,value:{clientMessageId:'same-id',submission:{dispatchState:'pending'}}};},
      waitForSendSettlement:async(session,id)=>{waits++;assert.equal(session,'session');assert.equal(id,'same-id');
        await new Promise(resolve=>setTimeout(resolve,5));
        if(target==='wait-error')throw new Error('lost observation');
        return target==='pending'?undefined:{ok:true,value:{clientMessageId:id,submission:{dispatchState:target}}};}};
    const run=context.Xkn({host,sessionId:'session',dispatchId:'dispatch',preamble:'probe'});
    if(target==='accepted')await run;
    else await assert.rejects(run,error=>error.code===(target==='rejected'?'dispatch_preamble_undelivered':'operation_unknown'));
    assert.equal(sends,1);assert.equal(waits,1);
  }
  let waited=false;
  await context.Xkn({host:{deps:{store:{getRecord:()=>({lease:{runtimeFence:1}})}},send:async()=>({ok:true,value:{submission:{dispatchState:'accepted'}}}),waitForSendSettlement:()=>{waited=true;}},sessionId:'session'});
  assert.equal(waited,false);
});

test('structured unknown outcome preserves the live session hold', {skip:!root},async()=>{
 const source=fs.readFileSync(path.join(root,'renderer','main-patched.cjs'),'utf8');
 const start=source.indexOf('e instanceof Z&&e.code===`operation_unknown`||await CFn(');
 assert.ok(start>=0);
 const end=source.indexOf(',bFn(',start);
 const expression=source.slice(start,end);
 class RuntimeError extends Error {constructor(code){super(code);this.code=code;}}
 let cleanup=0;
 const context=vm.createContext({Z:RuntimeError,CFn:async()=>{cleanup++;},n:{},C:{structuredSession:{}},y:{dispatch:{id:'dispatch'}}});
 for(const [error,expected] of [[new RuntimeError('operation_unknown'),0],[new RuntimeError('dispatch_preamble_undelivered'),1],[new Error('pre-create failure'),2]]){
  context.e=error;await vm.runInContext('(async()=>{'+expression+'})()',context);assert.equal(cleanup,expected);
 }
});

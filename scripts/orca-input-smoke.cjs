/* Isolated Windows ConPTY regression: fixed local response, no credentials/inference. */
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http');
const assert=require('node:assert/strict');
const {packedFile,FILE}=require('./orca-repair.cjs');
const pty=require(path.join(process.env.LOCALAPPDATA,'Programs','orca','resources','node_modules','node-pty'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const [stageArg,exeArg,outputArg]=process.argv.slice(2);
const stage=path.resolve(stageArg),exe=path.resolve(exeArg),output=path.resolve(outputArg);
if(fs.existsSync(output))throw new Error('Use a fresh output directory');
fs.mkdirSync(output,{recursive:true});
const archive=fs.readFileSync(path.join(stage,'app.original.asar'));
const encoder=packedFile(archive,'out/renderer/assets/terminal-pty-input-transaction-BoLSjNMd.js').toString().split('export{')[0];
const candidate=fs.readFileSync(path.join(stage,'renderer','legacy-patched.js'),'utf8');
const aw=candidate.slice(candidate.indexOf('function Aw('),candidate.indexOf('function jw('));
const context=vm.createContext({});
vm.runInContext(encoder+';globalThis.yl=v;globalThis.bl=p;globalThis.gl=u;globalThis.kw=e=>/[\\r\\n]/.test(e);'+aw,context);
const prompt='日本語で回答してください。\n現在の作業ディレクトリとGitブランチを、読み取り専用のコマンドで確認して報告してください。\nファイル変更、ビルド、ゲーム起動、子エージェントの起動は行わないでください。';
let count=0;
const server=http.createServer((req,res)=>{
 req.resume();req.on('end',()=>{
  if(!req.url.includes('/responses')){res.writeHead(404);res.end('{}');return;}
  count++;res.writeHead(200,{'Content-Type':'text/event-stream'});
  const id='resp_'+count,item={id:'msg_'+count,type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'LOCAL_PROBE_OK',annotations:[]}]};
  let seq=0;const send=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,sequence_number:seq++,...data})}\n\n`);
  send('response.created',{response:{id,object:'response',status:'in_progress',output:[]}});
  send('response.output_item.added',{output_index:0,item:{...item,status:'in_progress',content:[]}});
  send('response.content_part.added',{item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
  send('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:'LOCAL_PROBE_OK'});
  send('response.output_text.done',{item_id:item.id,output_index:0,content_index:0,text:'LOCAL_PROBE_OK'});
  send('response.content_part.done',{item_id:item.id,output_index:0,content_index:0,part:item.content[0]});
  send('response.output_item.done',{output_index:0,item});
  send('response.completed',{response:{id,object:'response',status:'completed',model:'local-input-probe',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();
 });
});
function files(dir){return fs.existsSync(dir)?fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]):[];}
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const results=[];
 try {
  for(const kind of ['legacy','patched']){
   const base=path.join(output,kind),home=path.join(base,'home'),cwd=path.join(base,'workspace');
   fs.mkdirSync(home,{recursive:true});fs.mkdirSync(cwd,{recursive:true});
   fs.writeFileSync(path.join(home,'config.toml'),`model = "local-input-probe"\nmodel_provider = "local_probe"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.local_probe]\nname = "Local input probe"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[projects.'${cwd}']\ntrust_level = "trusted"\n`);
   const env={...process.env};for(const key of Object.keys(env))if(/^(OPENAI|ANTHROPIC|ORCA|CHATGPT|CODEX)/i.test(key))delete env[key];env.CODEX_HOME=home;env.TERM='xterm-256color';
   let tail='',exited=false;
   const child=pty.spawn(exe,['--no-daemon','--no-alt-screen','-C',cwd],{name:'xterm-256color',cols:120,rows:35,cwd,env});
   child.onData(s=>{tail+=s;if(s.includes('\x1b[6n'))child.write('\x1b[1;1R');});child.onExit(()=>exited=true);
   try{
    await sleep(6000);
    const bytes=context.Aw(prompt,kind==='patched'?{windowsInputRecordNewline:'alt-enter'}:{});
    child.write('\x15');child.write(bytes);await sleep(500);child.write('\r');await sleep(9000);
    fs.writeFileSync(path.join(base,'terminal.txt'),tail);
   }finally{
    if(!exited){child.write('/quit\r');await sleep(1500);}if(!exited)child.kill();
   }
   const messages=files(path.join(home,'sessions')).filter(f=>f.endsWith('.jsonl')).flatMap(f=>fs.readFileSync(f,'utf8').trim().split('\n').map(s=>JSON.parse(s)))
     .filter(e=>e.type==='response_item'&&e.payload?.type==='message'&&e.payload.role==='user').flatMap(e=>e.payload.content??[]).filter(c=>c.type==='input_text'&&c.text.length>0&&prompt.includes(c.text)).map(c=>c.text);
   results.push({kind,messages,exactWholePrompt:messages.length===1&&messages[0]===prompt});
   console.log(kind,JSON.stringify({messages:messages.length,exactWholePrompt:results.at(-1).exactWholePrompt}));
  }
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({exe,realInference:false,results},null,2));
  assert.equal(results[1].exactWholePrompt,true,'Patched input must be exactly one complete user message');
 } finally { server.closeAllConnections();server.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;server.closeAllConnections();server.close();});

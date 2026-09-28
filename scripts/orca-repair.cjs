/* Version-pinned Orca 1.4.215 legacy Chat repair. No process is stopped here. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const FILE = 'out/renderer/assets/OnboardingInlineCommandTerminal-CEt11EKH.js';
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const MAIN = 'out/main/index.js';
const marker = 'function orcaLegacyPasteOptions(';

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Unsupported bundle: patch anchor count differs');
  return source.replace(before, after);
}

function patchRenderer(source) {
  if (source.includes(marker)) throw new Error('Already patched; compare manifest rather than patching twice');
  source = replaceOnce(source, 'function Aw(e){return kw(e)?bl(e):gl(e)}',
    'function Aw(e,t){if(t?.windowsInputRecordNewline){let n;return yl({input:e=>{n=e}},e,t),n}return kw(e)?bl(e):gl(e)}');
  source = replaceOnce(source, 'dl(e,t,Aw(n)),a(500,', 'dl(e,t,Aw(n,r)),a(500,');
  source = replaceOnce(source, 'dl(t,n,Aw(r)),c(500,', 'dl(t,n,Aw(r,a)),c(500,');
  // Reuse Orca's Windows ConPTY predicate, including WSL/SSH/runtime exclusion.
  // Missing workspace/target identity opts out; it never guesses the target OS.
  const helper = 'function orcaLegacyPasteOptions(e,t){if(e.agent!==`codex`||cl(t.ptyId))return{};let n=G.getState(),r=Ix(n,e.terminalTabId);if(!r||r.runtimeEnvironmentId)return{};let i=n.tabsByWorktree[r.worktreeId]?.find(t=>t.id===e.terminalTabId);return ha({userAgent:navigator.userAgent,connectionId:ft(n,r.worktreeId),cwd:r.worktreePath,shellOverride:i?.shellOverride,executionHostId:ri(n,r.worktreeId)})?{windowsInputRecordNewline:`alt-enter`}:{}}';
  source = replaceOnce(source, 'function AT(e){', helper + 'function AT(e){');
  source = replaceOnce(source, 'let i=e.classifySend(t),{sendOptions:a}=kT(', 'let i=e.classifySend(t),{sendOptions:orcaSendOptions}=kT(');
  source = replaceOnce(source, 'readScreen:()=>e.readTerminalScreen?.()}),o=null;',
    'readScreen:()=>e.readTerminalScreen?.()}),a={...orcaSendOptions,...orcaLegacyPasteOptions(e,r)},o=null;');
  return source;
}

function patchMain(source) {
  source=replaceOnce(source,'if(!r.ok)throw Error(`The dispatch preamble was refused: ${r.refusal.message}`);let i=r.value.submission;',
    'if(r.ok&&r.value.submission.dispatchState===`pending`){let t;try{t=await e.host.waitForSendSettlement(e.sessionId,r.value.clientMessageId)}catch(t){throw new Z(`operation_unknown`,`Dispatch settlement could not be observed: ${t instanceof Error?t.message:String(t)}`)}t&&(r={...r,...t})}if(!r.ok)throw Error(`The dispatch preamble was refused: ${r.refusal.message}`);let i=r.value.submission;');
  source=replaceOnce(source,'catch(e){return await CFn({runtime:n,structuredSession:C?.structuredSession??null,dispatchId:y.dispatch.id}),bFn(',
    'catch(e){return e instanceof Z&&e.code===`operation_unknown`||await CFn({runtime:n,structuredSession:C?.structuredSession??null,dispatchId:y.dispatch.id}),bFn(');
  return source;
}

function readAsar(buffer) {
  const headerSize = buffer.readUInt32LE(4), jsonSize = buffer.readUInt32LE(12);
  if (buffer.readUInt32LE(0) !== 4 || jsonSize > headerSize - 8) throw new Error('Invalid ASAR header');
  return { header: JSON.parse(buffer.subarray(16, 16 + jsonSize).toString()), dataOffset: 8 + headerSize };
}
function entries(header, prefix = '') {
  return Object.entries(header.files).flatMap(([name, value]) => {
    const key = prefix ? `${prefix}/${name}` : name; // ASAR archive keys use '/'.
    return value.files ? entries(value, key) : [{ key, value }];
  });
}
function packedFile(buffer, key) {
  const {header, dataOffset} = readAsar(buffer);
  const entry = entries(header).find(e => e.key === key)?.value;
  if (!entry || entry.unpacked || entry.link) throw new Error(`Not a packed member: ${key}`);
  return buffer.subarray(dataOffset + Number(entry.offset), dataOffset + Number(entry.offset) + entry.size);
}
function rewriteAsar(buffer, changes) {
  const {header, dataOffset} = readAsar(buffer);
  const members = entries(header).filter(e => !e.value.unpacked && !e.value.link).sort((a,b) => Number(a.value.offset)-Number(b.value.offset));
  let offset = 0;
  const data = members.map(({key, value}) => {
    const bytes = changes.get(key) ?? buffer.subarray(dataOffset + Number(value.offset), dataOffset + Number(value.offset) + value.size);
    value.offset = String(offset); value.size = bytes.length; offset += bytes.length;
    if (changes.has(key) && value.integrity) {
      if (value.integrity.algorithm !== 'SHA256') throw new Error('Unknown integrity algorithm');
      const blockSize = value.integrity.blockSize, blocks = [];
      if (!Number.isSafeInteger(blockSize) || blockSize <= 0) throw new Error('Invalid integrity block size');
      for (let start=0; start<bytes.length; start+=blockSize) blocks.push(sha(bytes.subarray(start,start+blockSize)));
      value.integrity = {algorithm:'SHA256', hash:sha(bytes), blockSize, blocks};
    }
    return bytes;
  });
  for (const key of changes.keys()) if (!members.some(m => m.key === key)) throw new Error('Missing target member');
  const json = Buffer.from(JSON.stringify(header)), payloadSize = 4 + json.length, padding = (4-payloadSize%4)%4;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4,0); prefix.writeUInt32LE(8+json.length+padding,4);
  prefix.writeUInt32LE(payloadSize+padding,8); prefix.writeUInt32LE(json.length,12);
  return Buffer.concat([prefix,json,Buffer.alloc(padding),...data]);
}
function verifyMembers(before, after) {
  const a = readAsar(before), b = readAsar(after), original = entries(a.header), updated = entries(b.header);
  if (original.length !== updated.length) throw new Error('Member inventory changed');
  const changed = [], indexed = new Map(updated.map(e => [e.key,e.value]));
  for (const {key,value} of original) {
    const other = indexed.get(key);
    if (!other) throw new Error('Member removed');
    if (value.unpacked || value.link) {
      if (JSON.stringify(value) !== JSON.stringify(other)) throw new Error('External member metadata changed');
    } else if (sha(before.subarray(a.dataOffset+Number(value.offset),a.dataOffset+Number(value.offset)+value.size)) !==
               sha(after.subarray(b.dataOffset+Number(other.offset),b.dataOffset+Number(other.offset)+other.size))) changed.push(key);
  }
  if (JSON.stringify(changed.slice().sort()) !== JSON.stringify([FILE,MAIN].sort())) throw new Error('Unexpected changed member(s): ' + changed);
  return changed;
}
function stage(source, output) {
  fs.mkdirSync(output,{recursive:true});
  const before = fs.readFileSync(source);
  const version = JSON.parse(packedFile(before,'package.json')).version;
  if (version !== '1.4.215') throw new Error('Only Orca 1.4.215 is supported');
  const original = packedFile(before,FILE).toString(), patched = patchRenderer(original);
  const after = rewriteAsar(before,new Map([[FILE,Buffer.from(patched)],[MAIN,Buffer.from(patchMain(packedFile(before,MAIN).toString()))]]));
  const changed = verifyMembers(before,after);
  const backup = path.join(output,'app.original.asar'), candidate = path.join(output,'app.patched.asar');
  for (const [file, bytes] of [[backup,before],[candidate,after]]) {
    if (fs.existsSync(file) && sha(fs.readFileSync(file)) !== sha(bytes)) throw new Error('Refusing to overwrite prior evidence: '+file);
    fs.writeFileSync(file,bytes);
  }
  const extracted = path.join(output,'renderer'); fs.mkdirSync(extracted,{recursive:true});
  fs.writeFileSync(path.join(extracted,'legacy-original.js'),original);
  fs.writeFileSync(path.join(extracted,'legacy-patched.js'),patched);
  fs.writeFileSync(path.join(extracted,'main-patched.cjs'),packedFile(after,MAIN));
  const manifest = {version,source:path.resolve(source),backup:path.resolve(backup),candidate:path.resolve(candidate),
    originalSha256:sha(before),patchedSha256:sha(after),changedMembers:changed,memberCount:entries(readAsar(before).header).length,
    applied:false,scope:'Windows Codex legacy composer and structured dispatch settlement; no resend, catalog or authentication edits'};
  fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2));
  return manifest;
}
function blockingProcesses(processes, appDirectory) {
  const executable=path.win32.resolve(appDirectory,'Orca.exe').toLowerCase();
  return processes.filter(process=> {
    if (!process.ExecutablePath || !process.CommandLine) return true;
    // Normal Quit intentionally preserves the separately installed terminal daemon.
    // Neither that daemon nor Crashpad loads the desktop's packed main/renderer files.
    return path.win32.resolve(process.ExecutablePath).toLowerCase()===executable
      && !/(?:^|\s)--type=crashpad-handler(?:\s|$)/.test(process.CommandLine);
  });
}
function apply(manifestPath, rollback=false) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  if (process.platform !== 'win32') throw new Error('Deployment requires Windows process verification');
  const running = JSON.parse(cp.execFileSync('powershell.exe',['-NoProfile','-Command',"ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter \"Name='Orca.exe'\" | Select-Object ExecutablePath,CommandLine)"],{encoding:'utf8'}));
  if (blockingProcesses(running,path.dirname(path.dirname(manifest.source))).length)
    throw new Error('Orca desktop is running: coordinator must arrange an approved normal shutdown first');
  const expected = rollback ? manifest.patchedSha256 : manifest.originalSha256;
  if (sha(fs.readFileSync(manifest.source)) !== expected) throw new Error('Installed ASAR changed; refusing deployment');
  const backup = fs.readFileSync(manifest.backup), candidate = fs.readFileSync(manifest.candidate);
  if (sha(backup)!==manifest.originalSha256 || sha(candidate)!==manifest.patchedSha256) throw new Error('Staging evidence changed');
  verifyMembers(backup,candidate);
  const bytes = rollback ? backup : candidate, temp = manifest.source + '.orca-repair-tmp';
  fs.writeFileSync(temp,bytes,{flag:'wx'});
  try { fs.renameSync(temp,manifest.source); } finally { if(fs.existsSync(temp)) fs.unlinkSync(temp); }
  if (sha(fs.readFileSync(manifest.source))!==sha(bytes)) throw new Error('Post-deployment hash mismatch');
  const receipt = {applied:!rollback,rolledBack:rollback,sha256:sha(bytes),time:new Date().toISOString()};
  fs.writeFileSync(path.join(path.dirname(manifestPath),rollback?'rollback.json':'deployment.json'),JSON.stringify(receipt,null,2));
  return receipt;
}
module.exports={FILE,MAIN,sha,patchMain,patchRenderer,readAsar,entries,packedFile,rewriteAsar,verifyMembers,stage,apply,blockingProcesses};
if(require.main===module){
  const [verb,a,b]=process.argv.slice(2);
  try {
    const result=verb==='stage'?stage(path.resolve(a),path.resolve(b)):
      verb==='apply'||verb==='rollback'?apply(path.resolve(a),verb==='rollback'):
      (()=>{throw new Error('Usage: node scripts/orca-repair.cjs stage <app.asar> <output> | apply <manifest> | rollback <manifest>')})();
    console.log(JSON.stringify(result,null,2));
  } catch(error){console.error(error.message);process.exitCode=1;}
}

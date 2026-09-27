import {expect, test} from 'bun:test';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {connectLauncherBrowserHost, LAUNCHER_BROWSER_IDLE_URL} from '../src/launcher-browser-host';

test.skipIf(process.platform !== 'win32')('owned hidden Electron views render model-control transitions without revealing the window', async () => {
  const root=mkdtempSync(join(tmpdir(),'launcher-hidden-frames-'));
  const electron=resolve('launcher/node_modules/electron/dist/electron.exe');
  const fixture=resolve('tests/fixtures/hidden-launcher.cjs');
  const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[fixture,root],{env,stdio:['pipe','ignore','pipe'],windowsHide:true});
  let stderr=''; child.stderr.on('data',chunk=>{stderr+=String(chunk)});
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  let connection: Awaited<ReturnType<typeof connectLauncherBrowserHost>> | undefined;
  try {
    const targetPath=join(root,'target.json'), portPath=join(root,'user-data','DevToolsActivePort');
    const deadline=Date.now()+15_000;
    while(!existsSync(targetPath)||!existsSync(portPath)) {
      if(Date.now()>deadline||child.exitCode!==null)throw new Error('Fixture startup failed: '+stderr);
      await Bun.sleep(50);
    }
    const target=JSON.parse(readFileSync(targetPath,'utf8'));
    const endpoint='http://127.0.0.1:'+readFileSync(portPath,'utf8').split(/\r?\n/)[0];
    const surfaceId='h'.repeat(32), descriptor=join(root,'descriptor.json');
    writeFileSync(descriptor,JSON.stringify({version:3,kind:'codex-web-gpt-launcher',profile:'production',pid:target.pid,endpoint,
      control:{endpoint,token:'t'.repeat(48)},helper:{executable:electron,script:fixture},partition:'persist:codex-web-gpt-chatgpt',
      idleUrl:LAUNCHER_BROWSER_IDLE_URL,surfaceId,surfaceTargets:{[surfaceId]:target.target},createdAt:new Date().toISOString()}));
    connection=await connectLauncherBrowserHost(descriptor);
    expect(connection.context.pages()).toHaveLength(1);
    await connection.page.locator('#choice').click({timeout:2_000});
    await connection.page.waitForFunction(()=>document.body.dataset.selected==='true',{},{timeout:2_000});
    expect(await connection.page.evaluate(()=>(window as any).framesObserved)).toBeGreaterThan(1);
  } finally {
    await connection?.browser.close();
    child.stdin.write('quit\n');
    await Promise.race([exited,Bun.sleep(3_000)]);
    if(child.exitCode===null){child.kill();await exited;}
    if (!resolve(root).startsWith(join(resolve(tmpdir()), 'launcher-hidden-frames-'))) throw new Error('Unexpected fixture path');
    rmSync(root,{recursive:true,force:true});
  }
},25_000);

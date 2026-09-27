const {app, BrowserWindow, WebContentsView} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
app.setPath('userData', path.join(root, 'user-data'));
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
app.commandLine.appendSwitch('remote-debugging-port', '0');
let window;
app.whenReady().then(async () => {
  window = new BrowserWindow({show:false, width:800, height:600});
  const owned = new WebContentsView({webPreferences:{backgroundThrottling:false}});
  window.contentView.addChildView(owned);
  owned.setBounds({x:801,y:601,width:800,height:600});
  owned.setVisible(true);
  await owned.webContents.loadURL('data:text/html,<button id="choice">Select</button><script>window.framesObserved=0;function frame(){window.framesObserved++;requestAnimationFrame(frame)}requestAnimationFrame(frame);document.querySelector("button").onclick=()=>requestAnimationFrame(()=>document.body.dataset.selected="true")</script>');
  owned.webContents.enableDeviceEmulation({screenPosition:'desktop',screenSize:{width:800,height:600},viewPosition:{x:0,y:0},deviceScaleFactor:0,viewSize:{width:800,height:600},scale:1});
  fs.writeFileSync(path.join(root,'target.json'),JSON.stringify({pid:process.pid,target:owned.webContents.getOrCreateDevToolsTargetId()}));
});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{if(line==='quit')app.quit()});

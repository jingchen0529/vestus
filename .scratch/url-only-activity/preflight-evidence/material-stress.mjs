import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const [chrome, guardPath, root] = process.argv.slice(2);
const video = await readFile(join(root, 'preview.webm'));
const guardSource = await readFile(guardPath, 'utf8');
const server = createServer((request, response) => {
  if (request.url.startsWith('/preview')) {
    response.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': video.length }); response.end(video); return;
  }
  if (request.url.startsWith('/image')) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#3b82f6"/><text x="25" y="100" fill="white">Synthetic material</text></svg>';
    response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public,max-age=3600' }); response.end(svg); return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  response.end('<!doctype html><style>.card{display:inline-block;width:160px;height:150px}img,video{width:150px;height:84px}</style><button id="start">choose material</button><input id="toggle" type="checkbox"><main id="grid"></main>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const guard = guardSource.replace('__VESTUS_LOGIN_ROUTE__', JSON.stringify({ origin, path: '/login' }));
const results = [];
for (let round = 1; round <= 2; round++) {
  const profile = await mkdtemp(join(root, `profile-${round}-`));
  const browser = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-background-mode', '--disable-breakpad', '--disable-quic', '--no-proxy-server', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  let ws; let id = 0; const waiting = new Map();
  const command = (method, params = {}, sessionId) => new Promise((resolve,reject) => {
    const requestId=++id; const timer=setTimeout(()=>{waiting.delete(requestId);reject(new Error(`Timeout ${method}`))},10000);
    waiting.set(requestId,{resolve,reject,timer}); ws.send(JSON.stringify({id:requestId,method,params,...(sessionId?{sessionId}:{})}));
  });
  const evaluate = async (sessionId, expression) => {
    const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true},sessionId);
    if(result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  const metrics = async sessionId => Object.fromEntries((await command('Performance.getMetrics',{},sessionId)).metrics.map(item=>[item.name,item.value]));
  try {
    let endpoint;
    for(let attempt=0;attempt<200;attempt++) { if(browser.exitCode!==null)throw new Error('browser exited');try{const lines=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n');if(lines[1]){endpoint=`ws://127.0.0.1:${lines[0]}${lines[1]}`;break;}}catch{}await delay(50); }
    if(!endpoint)throw new Error('No endpoint');ws=new WebSocket(endpoint);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
    ws.addEventListener('message', event=>{const value=JSON.parse(event.data);const item=waiting.get(value.id);if(!item)return;waiting.delete(value.id);clearTimeout(item.timer);value.error?item.reject(new Error(JSON.stringify(value.error))):item.resolve(value.result);});
    const version=await command('Browser.getVersion');
    for(const withVideos of [false,true]) for(const enabled of [false,true]) {
      const {targetId}=await command('Target.createTarget',{url:`${origin}/material`});const {sessionId}=await command('Target.attachToTarget',{targetId,flatten:true});
      for(let attempt=0;attempt<100;attempt++){if(await evaluate(sessionId,'document.readyState==="complete" && !!document.getElementById("grid")'))break;await delay(20);}
      await command('Page.enable',{},sessionId);await command('Page.getFrameTree',{},sessionId);await command('Performance.enable',{},sessionId);
      if(enabled){await command('Page.addScriptToEvaluateOnNewDocument',{source:guard},sessionId);await evaluate(sessionId,guard);}
      await evaluate(sessionId,`window.longTasks=[];window.pointerSeen=0;toggle.addEventListener('change',()=>pointerSeen++);new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(item=>item.duration))).observe({entryTypes:['longtask']});true`);
      const baseline=await metrics(sessionId);const cycles=[];
      for(let cycle=1;cycle<=6;cycle++) {
        const sample=await evaluate(sessionId,`(async()=>{
          const started=performance.now();const grid=document.getElementById('grid');
          const fragment=document.createDocumentFragment();
          for(let i=0;i<1000;i++){const card=document.createElement('div');card.className='card';const image=document.createElement('img');image.src='/image.svg';image.loading='lazy';card.append(image);const input=document.createElement('input');input.type='checkbox';input.name='material';card.append(input);fragment.append(card);}
          grid.append(fragment);const videos=[];if(${withVideos})for(let i=0;i<24;i++){const video=document.createElement('video');video.src='/preview.webm';video.muted=true;video.loop=true;video.playsInline=true;grid.prepend(video);videos.push(video);}
          const played=await Promise.all(videos.map(video=>video.play().then(()=>true,()=>false)));
          const fields=grid.querySelectorAll('input');const selection=[];
          for(let batch=0;batch<10;batch++){await new Promise(requestAnimationFrame);const start=performance.now();for(let i=0;i<20;i++)fields[batch*20+i].click();selection.push(performance.now()-start);}
          await new Promise(resolve=>setTimeout(resolve,300));
          const output={cycle:${cycle},cards:fields.length,selected:grid.querySelectorAll('input:checked').length,videos:videos.length,playing:played.filter(Boolean).length,readyVideos:videos.filter(video=>video.readyState>=2).length,selectionBatchMs:selection,phaseMs:performance.now()-started,guardInert:document.documentElement.inert,bindingType:typeof window.__vestusReportActivity};
          for(const video of videos){video.pause();video.removeAttribute('src');video.load();}grid.replaceChildren();await new Promise(requestAnimationFrame);return output;
        })()`);
        if(sample.selected!==200||sample.cards!==1000||sample.guardInert||sample.bindingType!=='undefined')throw new Error('fixture behavior assertion failed');
        const bounds=await evaluate(sessionId,'(()=>{const r=toggle.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
        const pointerStart=performance.now();await command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...bounds},sessionId);await command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...bounds},sessionId);
        const after=await metrics(sessionId);const processInfo=await command('SystemInfo.getProcessInfo');const pids=processInfo.processInfo.map(item=>item.id).filter(pid=>Number.isInteger(pid));
        let rssKb=0;try{const values=execFileSync('/bin/ps',['-o','rss=','-p',pids.join(',')],{encoding:'utf8'});rssKb=values.trim().split(/\s+/).filter(Boolean).map(Number).reduce((a,b)=>a+b,0);}catch{}
        cycles.push({...sample,pointerDispatchMs:performance.now()-pointerStart,metrics:after,totalOwnedRssKb:rssKb});
      }
      const beforeGc=await metrics(sessionId);await command('HeapProfiler.collectGarbage',{},sessionId);const afterGc=await metrics(sessionId);
      const final=await evaluate(sessionId,'({pointerSeen,longTasks,domNodes:document.querySelectorAll("*").length,inert:document.documentElement.inert})');
      if(final.pointerSeen!==6)throw new Error('trusted pointer inputs did not work');
      const row={round,withVideos,guard:enabled,version,baseline,cycles,beforeGc,afterGc,final};results.push(row);
      console.log(JSON.stringify({round,withVideos,guard:enabled,maxBatchMs:Math.max(...cycles.flatMap(c=>c.selectionBatchMs)),maxPointerMs:Math.max(...cycles.map(c=>c.pointerDispatchMs)),heapAfterGc:afterGc.JSHeapUsedSize,nodesAfterGc:afterGc.Nodes,rssStart:cycles[0].totalOwnedRssKb,rssEnd:cycles.at(-1).totalOwnedRssKb,longTasks:final.longTasks.length}));
      await command('Target.closeTarget',{targetId});
    }
  } finally {
    if(ws?.readyState===WebSocket.OPEN){try{await command('Browser.close');}catch{}ws.close();}await Promise.race([new Promise(resolve=>browser.once('exit',resolve)),delay(3000)]);if(browser.exitCode===null)browser.kill('SIGTERM');for(const item of waiting.values())clearTimeout(item.timer);
  }
}
server.close();
await writeFile(join(root,'material-stress-results.json'),JSON.stringify({method:'Two fresh Chromium/profile rounds, Page-only subscriptions (no Runtime.enable/binding). Actual fixed guard local origin. 4scenarios per round,6open/close cycles,1000cards/200native checkbox activations each,optional24synthetic video previews. Trusted mouse input after each cycle. Headless macOS, not production collect/Rust/network or customer platform. RSS is summed own Chromium process IDs; JS GC before/after separate, no proof against native decode memory leak. Autoplay test-only.',results},null,2));
console.log(`RESULTS ${join(root,'material-stress-results.json')}`);

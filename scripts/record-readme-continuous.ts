// Review-only continuous capture. Run from repository scripts for module resolution.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { chromium } from 'playwright-core';
import { initTheme } from '@earendil-works/pi-coding-agent';
initTheme();
const ROOT=process.env.PI_FORGE_MEDIA_OUT_DIR;
assert.ok(ROOT, 'Set PI_FORGE_MEDIA_OUT_DIR to a review output directory');
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const DISPLAY=':192'; // Never inherit the invoking desktop's DISPLAY.
assert.ok(!existsSync('/tmp/.X11-unix/X192'), 'Private recording display must be unused');
const env={...process.env,DISPLAY,XCURSOR_SIZE:'32'};
const wait=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const xvfb=spawn('Xvfb',[DISPLAY,'-screen','0','1440x900x24','-nolisten','tcp','-ac','+extension','XTEST'],{stdio:'ignore'});
await wait(700);assert.equal(xvfb.exitCode,null);
const globalDir=mkdtempSync(join(tmpdir(),'forge-video-global-'));
const oldGlobal=process.env.PI_FORGE_GLOBAL_DIR, oldConfig=process.env.PI_FORGE_GLOBAL_CONFIG_PATH;
process.env.PI_FORGE_GLOBAL_DIR=join(globalDir,'resources');process.env.PI_FORGE_GLOBAL_CONFIG_PATH=join(globalDir,'config.json');
const {createContext,createHarness,latestEditorUrl,startSession,writeStack}=await import('../tests/helpers/index-command-harness.ts');
const {createCapabilityAgentHarness}=await import('../tests/helpers/capability-agent-harness.ts'); // blocks Node network, isolates SDK credentials
const xd=(...args:string[])=>execFileSync('xdotool',args,{env,stdio:'ignore',timeout:5000});
let px=790,py=650;
async function move(x:number,y:number,duration=650){
 const sx=px,sy=py;const n=Math.ceil(duration/25);
 for(let i=1;i<=n;i++){const u=i/n,e=u*u*(3-2*u);px=Math.round(sx+(x-sx)*e);py=Math.round(sy+(y-sy)*e);xd('mousemove',String(px),String(py));await wait(duration/n);}
}
let actionLog:any[]=[],started=0;
function mark(action:string,detail:any={}){const entry={time:new Date().toISOString(),ms:started?Date.now()-started:0,action,...detail};actionLog.push(entry);console.log(JSON.stringify(entry));}
async function click(locator:any,name:string){
 const b=await locator.boundingBox();assert.ok(b,`visible ${name}`);assert.ok(b.x>=0&&b.y>=0&&b.x+b.width<=1441&&b.y+b.height<=901,`onscreen ${name}`);
 const editing=name.startsWith('Edit');
 await move(editing?b.x+Math.min(190,b.width/2):b.x+b.width/2,editing?b.y+54:b.y+b.height/2);await wait(350);mark('click',{name,x:px,y:py});xd('mousedown','1');await wait(90);xd('mouseup','1');await wait(350);
}
async function captureStart(out:string){
 started=Date.now();actionLog=[];mark('capture-start',{out});
 const proc=spawn('ffmpeg',['-hide_banner','-loglevel','warning','-y','-nostdin','-f','x11grab','-draw_mouse','1','-video_size','1440x900','-framerate','30','-i',DISPLAY+'.0','-c:v','libx264','-threads','2','-preset','veryfast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',out],{stdio:['ignore','ignore','pipe']});
 proc.stderr?.on('data',d=>process.stderr.write(d));await wait(900);assert.equal(proc.exitCode,null);return proc;
}
async function captureStop(proc:ChildProcess){
 const done=new Promise<void>((resolve,reject)=>{proc.once('close',code=>code===0||code===255?resolve():reject(Error('ffmpeg exit '+code)));});
 proc.kill('SIGINT');await done;mark('capture-stop');started=0;
}
async function makeBrowser(url:URL){
 const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:false,env,ignoreDefaultArgs:['--enable-automation'],args:['--no-sandbox','--disable-gpu','--window-size=1440,900','--window-position=0,0','--kiosk','--no-first-run','--no-default-browser-check','--disable-features=Translate,OptimizationHints']});
 const ctx=await browser.newContext({viewport:null});
 // Pointer visualization only. No application values, events or layout are changed.
 await ctx.addInitScript(()=>{
  addEventListener('DOMContentLoaded',()=>{
   const cursor=document.createElement('div');cursor.id='capture-pointer-annotation';cursor.style.cssText='position:fixed;left:-100px;top:-100px;width:28px;height:28px;border:2px solid rgba(80,215,244,.7);border-radius:50%;background:rgba(60,200,230,.07);transform:translate(-50%,-50%);z-index:2147483647;pointer-events:none;box-sizing:border-box';document.body.append(cursor);
   const update=(e:MouseEvent)=>{const host=(e.target as Element)?.closest?.('dialog[open]')||document.body;if(cursor.parentNode!==host)host.append(cursor);cursor.style.left=e.clientX+'px';cursor.style.top=e.clientY+'px';};
   document.addEventListener('pointermove',update,true);document.addEventListener('dragover',update,true);
   document.addEventListener('pointerdown',(e)=>{update(e);cursor.animate([{boxShadow:'0 0 0 0 rgba(91,224,245,.8)'},{boxShadow:'0 0 0 13px rgba(91,224,245,0)'}],{duration:550});},true);
   (window as any).__captureInput=[];
   for(const type of ['pointerdown','dragstart','drop'])document.addEventListener(type,(e:any)=>{(window as any).__captureInput.push({type,trusted:e.isTrusted,x:e.clientX,y:e.clientY,target:(e.target as HTMLElement)?.id||((e.target as HTMLElement)?.className??''),time:performance.now()});},true);
  });
 });
 const page=await ctx.newPage();page.setDefaultTimeout(8000);page.setDefaultNavigationTimeout(12000);
 const errors:string[]=[],external:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{const target=new URL(route.request().url());if(target.origin===url.origin)return route.continue();external.push(target.origin);return route.abort();});
 await page.goto(url.href);await page.locator('#itemContent').waitFor();
 xd('key','F11');await wait(700);
 const geometry=await page.evaluate(()=>({width:innerWidth,height:innerHeight,x:screenX,y:screenY}));
 assert.ok(geometry.x===0 && geometry.y===0 && geometry.width>=1439 && geometry.width<=1440 && geometry.height>=899 && geometry.height<=900,'fullscreen native coordinates (one-pixel X11 border allowed)');
 if(await page.locator('body').getAttribute('data-theme')!=='dark')await click(page.locator('#themeToggleBtn'),'Dark theme');
 await page.waitForFunction(()=>document.body.dataset.theme==='dark');
 px=790;py=650;xd('mousemove',String(px),String(py));await wait(250);
 return {browser,page,errors,external,geometry};
}
const locales=(process.env.LOCALES??'en,zh-CN').split(',');
const scenes=(process.env.SCENES??'context,diff,capability').split(',');
assert.ok(scenes.every(s=>['context','diff','capability'].includes(s)), 'Supported scenes: context,diff,capability');
try{
for(const locale of locales)for(const scene of scenes){
 const zh=locale==='zh-CN';const outdir=join(ROOT,scene==='save'?'docs':'media',locale);mkdirSync(outdir,{recursive:true});
 const out=join(outdir,scene+'.mp4');const cwd=mkdtempSync(join(tmpdir(),'forge-movie-'+scene+'-'));const root=join(cwd,'.pi','forge');mkdirSync(root,{recursive:true});
 writeFileSync(join(root,'config.json'),JSON.stringify({webEditor:{locale}}));
 const role=zh?'请审查当前改动。\n先阅读相关实现。\n概括主要改动。':'Review the current change.\nRead relevant code first.\nSummarize the change.';
 const changed=zh?'先总结风险，再列出验证结果。':'Summarize risks; list verified tests.';
 const rules=zh?'项目规则\n保持公共 API 稳定。':'Project rules\nKeep public APIs stable.';
 const projectNeedle=zh?'仅使用已批准的依赖。':'Use only approved dependencies.';
 const project=zh?'# 项目上下文\n\n'+projectNeedle:'# Project context\n\n'+projectNeedle;
 writeFileSync(join(cwd,'AGENTS.md'),project);
 const stack={schemaVersion:2,type:'pi-forge.prompt-stack',id:'review',name:zh?'代码审查':'Code Review',autoActivate:scene!=='save',mode:'replace',tools:{allow:['read','grep','find'],initial:['read']},items:[
  {id:'role',name:zh?'审查指令':'Review instructions',kind:'block',role:'system',content:role,enabled:true},
  ...(scene==='context'?[{id:'rules',name:zh?'项目规则':'Project rules',kind:'block',role:'system',content:rules,enabled:true}]:[]),
  ...(scene==='context'?[{id:'project',name:zh?'项目上下文':'Project context',kind:'slot',role:'system',slot:'project-context',options:{format:'plain'},enabled:true}]:[]),
  {id:'history',name:zh?'对话历史':'Conversation history',kind:'slot',slot:'chat-history',enabled:true},
 ]};writeStack(cwd,'review.json',stack);
 if(scene==='save')writeStack(cwd,'daily.json',{...stack,id:'daily',name:zh?'日常开发':'Daily work',autoActivate:true,items:[{id:'daily-role',name:zh?'工作指引':'Work guidelines',kind:'block',role:'system',content:zh?'逐步处理日常开发任务。':'Work through daily development tasks.',enabled:true},{id:'history',kind:'slot',slot:'chat-history',enabled:true}]});
 let h:any,c:any,ui:any,rec:ChildProcess|undefined,sdk:any;let verification:any={};
 try{
  let url:URL;
  if(scene==='capability'){
   mkdirSync(join(root,'capabilities'),{recursive:true});writeFileSync(join(root,'capabilities','explore.json'),JSON.stringify({schemaVersion:1,type:'pi-forge.capability',id:'explore',name:zh?'探索能力':'Explore capability',content:zh?'先阅读相关文件，再用证据回答。':'Read relevant files, then answer with evidence.',tools:{add:['grep','find'],remove:[]}}));
   sdk=await createCapabilityAgentHarness({cwd,native:true,allowedTools:['read','grep','find','fake_driver'],initialTools:[],responses:[]});sdk.session.setActiveToolsByName(['read']);sdk.manager.appendMessage({role:'system',content:'',sections:{tools:'',rules:''},timestamp:Date.now()} as any);sdk.session.refreshContext();await sdk.prompt('/preset ui');url=new URL((globalThis as any).__piForgeWebEditor.byCwd[cwd].server.url);
  }else{
   h=createHarness({activeTools:['read'],allTools:['read','grep','find']});c=createContext(cwd,[],{leafId:null});c.ctx.sessionManager.getSessionId=()=>`demo-${scene}`;
   c.ctx.getSystemPromptOptions=()=>({cwd,selectedTools:h.getActiveTools(),toolSnippets:{},promptGuidelines:[],contextFiles:[{path:'AGENTS.md',content:project}],skills:[]}) as any;
   await startSession(h,c.ctx);await h.commands.preset.handler('ui',c.ctx);url=latestEditorUrl(c.editors);
  }
  ui=await makeBrowser(url);const {page}=ui;
  if(scene==='context'||scene==='diff'){
   await click(page.locator('#previewTabBtn'),'Open Preview');await page.locator('.context-diff-compiled').waitFor();await click(page.locator('#focus-toggle'),'Widen panel before recording');
   await page.waitForFunction((n:string)=>document.querySelector('.context-diff-compiled')?.textContent?.includes(n),role.split('\n')[0]);await move(790,650,350);await wait(500);
  }
  if(scene==='capability'){
   await click(page.locator('#sessionSurfaceBtn'),'Current session');const panel=page.locator('[data-session-capabilities]');
   await panel.locator('option[value="capability:project:explore"]').waitFor({state:'attached'});
   await page.waitForFunction((n:string)=>document.querySelector('.session-inspector .context-diff-compiled')?.textContent?.includes(n),role.split('\n')[0]);
   assert.deepEqual(sdk.getActiveToolNames(),['read']);await move(790,650,350);await wait(500);
  }
  await page.screenshot({path:join(outdir,scene+'-poster.png')});rec=await captureStart(out);await wait(scene==='save'?2700:1300);
  if(scene==='context'){
   const source=page.locator('.item-row').filter({hasText:zh?'项目规则':'Project rules'}).locator('.drag-handle');const target=page.locator('.item-row').filter({hasText:zh?'审查指令':'Review instructions'});
   const a=await source.boundingBox(),b=await target.boundingBox();assert.ok(a&&b);
   await move(a.x+a.width/2,a.y+a.height/2);await wait(400);mark('drag-start',{x:px,y:py});xd('mousedown','1');await wait(200);await move(b.x+35,b.y+8,1500);await wait(500);mark('drop',{x:px,y:py});xd('mouseup','1');
   await page.waitForFunction((n:string)=>document.querySelector('.item-row .item-title')?.textContent===n,zh?'项目规则':'Project rules');
   await page.waitForFunction(({rules,role})=>{const t=document.querySelector('.context-diff-compiled')?.textContent||'';return t.includes(rules)&&t.includes(role)&&t.indexOf(rules)<t.indexOf(role);},{rules,role});mark('verified-reorder');await move(790,650,500);await wait(1900);
   const projectRow=page.locator('.item-row').filter({hasText:zh?'项目上下文':'Project context'});await click(projectRow.locator('.item-toggle'),'Turn off Project context');
   await page.waitForFunction(({r,n})=>{const t=document.querySelector('.context-diff-compiled')?.textContent||'';return t.includes(r)&&!t.includes(n);},{r:rules,n:projectNeedle});assert.equal(await projectRow.locator('.item-toggle').getAttribute('aria-pressed'),'false');mark('verified-slot-off');await move(790,650,500);await wait(2400);
   verification={nativeDrag:true,order:await page.locator('.item-title').allTextContents(),compiledOrderChanged:true,projectParagraphRemoved:true};
  }else if(scene==='diff'){
   await click(page.locator('#itemContent'),'Edit final instruction line');xd('key','ctrl+End');xd('key','shift+Home');await wait(400);mark('type-final-line',{text:changed});
   await page.keyboard.type(changed,{delay:45});
   await page.waitForFunction((n:string)=>document.querySelector('.context-diff-compiled')?.textContent?.includes(n),changed);mark('verified-live-preview');await move(790,650,500);await wait(1400);
   const before=await page.locator('#contextDiffPanel').boundingBox();await click(page.locator('.context-diff-mode-tabs [role=tab]').nth(1),'Draft diff');
   await page.locator('.git-line.added').first().waitFor();await page.locator('.git-line.removed').first().waitFor();const after=await page.locator('#contextDiffPanel').boundingBox();assert.equal(after?.x,before?.x);assert.equal(after?.width,before?.width);assert.equal(await page.locator('#itemContent').isVisible(),true);assert.equal(await page.locator('#dirtyBadge').isVisible(),true);mark('verified-diff-without-resize');await move(790,650,500);await wait(3000);
   verification={dirty:true,realAddedRemoved:true,editorVisible:true,panelGeometryUnchanged:true};
  }else if(scene==='capability'){
   const panel=page.locator('[data-session-capabilities]');const projection=page.locator('.session-inspector .context-diff-compiled');
   const capabilityText=zh?'先阅读相关文件，再用证据回答。':'Read relevant files, then answer with evidence.';
   const toolTags=async()=>(await panel.locator('[data-capabilities-tool-tag]').allTextContents()).map((t:string)=>t.replace(/^\+\s*/, '').trim());
   const select=panel.locator('[data-capabilities-picker-select]');await click(select,'Choose Explore capability');xd('key','End');await wait(300);xd('key','Return');
   await page.waitForFunction(()=>{const e=document.querySelector('[data-capabilities-picker-select]') as HTMLSelectElement;return e?.value==='capability:project:explore';});await wait(600);await click(panel.locator('[data-capabilities-enable-btn]'),'Enable Explore capability');
   await panel.locator('.active-item-card').waitFor();assert.deepEqual(sdk.getActiveToolNames(),['read','grep','find']);assert.deepEqual(await toolTags(),['read','grep','find']);
   await page.waitForFunction((n:string)=>document.querySelector('.session-inspector .context-diff-compiled')?.textContent?.includes(n),capabilityText);
   assert.match(await panel.locator('[data-capabilities-recent-change]').innerText(),/grep/);assert.match(await panel.locator('[data-capabilities-recent-change]').innerText(),/find/);
   mark('verified-tools-and-capability-added');await wait(1400);
   await click(panel.locator('[data-item-locate]'),'Locate capability');
   await page.waitForFunction(()=>{const e=document.querySelector('.session-inspector .capability-location-match');const p=document.querySelector('.session-inspector .context-diff-compiled');if(!e||!p)return false;const r=e.getBoundingClientRect(),b=p.getBoundingClientRect();return r.top>=b.top&&r.bottom<=b.bottom+1;});
   assert.match(await projection.locator('.capability-location-match').innerText(),new RegExp(capabilityText.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
   assert.equal(await panel.locator('.capabilities-controls').isVisible(),true);assert.equal(await page.locator('dialog[open]').count(),0);
   mark('verified-locate-with-controls-visible');await move(790,650,350);await wait(1900);
   await page.screenshot({path:join(outdir,'capability-active-proof.png')});
   await click(panel.locator('[data-item-disable-btn]'),'Disable');await panel.locator('[data-capabilities-empty]').waitFor();assert.deepEqual(sdk.getActiveToolNames(),['read']);assert.deepEqual(await toolTags(),['read']);
   await projection.locator('.named-section-notice.removed').waitFor();mark('verified-tools-restored-and-removal-projected');
   await click(panel.locator('[data-locate-recent]'),'Locate stopped update');
   await page.waitForFunction(()=>{const es=document.querySelectorAll('.session-inspector .capability-location-match');const e=es[es.length-1],p=document.querySelector('.session-inspector .context-diff-compiled');if(!e||!p)return false;const r=e.getBoundingClientRect(),b=p.getBoundingClientRect();return !!e.querySelector('.named-section-notice.removed')&&r.top>=b.top&&r.bottom<=b.bottom+1;});
   await move(790,650,350);await wait(2400);
   assert.equal(sdk.streamContexts.length,0);assert.equal(sdk.fetchAttempts,0);verification={toolsBefore:['read'],toolsActive:['read','grep','find'],toolsOff:['read'],capabilityAdded:capabilityText,realRemovalProjected:true,locateBothUpdatesVisible:true,controlsStayVisible:true,noModal:true,modelRequests:0,sdkFetches:0};
  }else{
   assert.equal(await page.locator('#resourceName').innerText(),zh?'日常开发':'Daily work');await click(page.locator('.stack-row').filter({hasText:zh?'代码审查':'Code Review'}),'Select inactive Code Review');
   await page.waitForFunction((n:string)=>document.querySelector('#resourceName')?.textContent===n,zh?'代码审查':'Code Review');await wait(2000);
   await click(page.locator('#itemContent'),'Edit inactive preset');xd('key','ctrl+End');xd('key','Return');await page.keyboard.type(changed,{delay:55});assert.equal(await page.locator('#activateBtn').isDisabled(),true);mark('verified-dirty-activate-disabled');await move(790,650,500);await wait(2200);
   await click(page.locator('#saveBtn'),'Save');await page.locator('#dirtyBadge').waitFor({state:'hidden'});
   const daily=page.locator('.stack-row').filter({hasText:zh?'日常开发':'Daily work'});assert.match(await daily.getAttribute('class')||'',/\bactive\b/);assert.ok(JSON.parse(readFileSync(join(root,'prompt-stacks','review.json'),'utf8')).items[0].content.includes(changed));mark('verified-save-disk-only-active-still-daily');await move(790,650,500);await wait(3400);
   await click(page.locator('#activateBtn'),'Activate');await page.waitForFunction(()=>document.querySelector('#runtimeBadge')?.classList.contains('active'));
   assert.match(await page.locator('.stack-row').filter({hasText:zh?'代码审查':'Code Review'}).getAttribute('class')||'',/\bactive\b/);mark('verified-explicit-activate-review');await move(790,650,500);await wait(5000);
   verification={savedOnDisk:true,saveKeptDailyActive:true,dirtyActivateDisabled:true,explicitActivateChangedToReview:true};
  }
  await page.screenshot({path:join(outdir,scene+'-result.png')});await captureStop(rec);rec=undefined;
  const input=await page.evaluate(()=>(window as any).__captureInput);assert.ok(input.some((e:any)=>e.type==='pointerdown'&&e.trusted));if(scene==='context')assert.ok(input.some((e:any)=>e.type==='drop'&&e.trusted),'Native trusted drop');
  assert.deepEqual(ui.errors,[]);assert.deepEqual(ui.external,[]);
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration,size:stream=codec_name,width,height,avg_frame_rate,pix_fmt','-of','json',out],{encoding:'utf8'}));
  writeFileSync(join(outdir,scene+'.evidence.json'),JSON.stringify({sourceCommit,locale,scene,verification,geometry:ui.geometry,probe,modelRequests:0,externalRequests:ui.external,pageErrors:ui.errors,cursor:'Native X11 cursor plus recording-only halo synced to trusted pointer/drag events',actions:actionLog,input},null,2));
  console.log(JSON.stringify({completed:scene,locale,probe:probe.format}));
 }catch(error){await ui?.page.screenshot({path:join(outdir,scene+'-failure.png')}).catch(()=>{});throw error;}finally{
  if(rec)await captureStop(rec).catch(console.error);await ui?.browser.close();if(sdk){await sdk.prompt('/preset ui stop').catch(()=>{});await sdk.dispose();}if(h){await h.commands.preset.handler('ui stop',c.ctx);await h.events.session_shutdown?.({type:'session_shutdown',reason:'exit'},c.ctx);}rmSync(cwd,{recursive:true,force:true});
 }
}
}finally{
 xvfb.kill();rmSync(globalDir,{recursive:true,force:true});if(oldGlobal===undefined)delete process.env.PI_FORGE_GLOBAL_DIR;else process.env.PI_FORGE_GLOBAL_DIR=oldGlobal;if(oldConfig===undefined)delete process.env.PI_FORGE_GLOBAL_CONFIG_PATH;else process.env.PI_FORGE_GLOBAL_CONFIG_PATH=oldConfig;
}

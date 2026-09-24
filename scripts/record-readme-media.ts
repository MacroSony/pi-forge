// Actual built App and production loopback; all authoring data is synthetic.
// No credentials, model transport or existing user project are used.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const OUT = process.env.PI_FORGE_MEDIA_OUT_DIR ?? mkdtempSync(join(tmpdir(), 'pi-forge-media-'));
console.log('Media output:', OUT);
mkdirSync(OUT,{recursive:true});
const isolationRoot = mkdtempSync(join(tmpdir(), 'pi-forge-media-global-'));
const envKeys = ['PI_FORGE_GLOBAL_DIR', 'PI_FORGE_GLOBAL_CONFIG_PATH'] as const;
const previousEnv = envKeys.map(key => process.env[key]);
process.env.PI_FORGE_GLOBAL_DIR = join(isolationRoot, 'resources');
process.env.PI_FORGE_GLOBAL_CONFIG_PATH = join(isolationRoot, 'config.json');
const { createContext, createHarness, latestEditorUrl, startSession, writeStack } = await import('../tests/helpers/index-command-harness.ts');
try {
for (const locale of ['en','zh-CN']) {
  const zh = locale === 'zh-CN';
  const output = join(OUT, locale); mkdirSync(output,{recursive:true});
  const cwd = mkdtempSync(join(tmpdir(),'pi-forge-readme-'));
  const root = join(cwd,'.pi','forge'); mkdirSync(root,{recursive:true});
  writeFileSync(join(root,'config.json'),JSON.stringify({webEditor:{locale}}));
  const role = zh
    ? '你是一位细心的代码审查者。\n先阅读相关实现，再给出建议。\n用一段话概括改动。'
    : 'You are a careful code reviewer.\nRead the relevant code before advising.\nSummarize the change in one paragraph.';
  const newRole = zh
    ? '你是一位细心的代码审查者。\n先阅读相关实现，再给出建议。\n先总结主要风险，再列出验证过的测试。'
    : 'You are a careful code reviewer.\nRead the relevant code before advising.\nSummarize key risks, then list the tests you ran.';
  const project = zh
    ? '# 项目约定\n\n- 保持公共 API 稳定。\n- 未经确认，不添加依赖。'
    : '# Project conventions\n\n- Keep public APIs stable.\n- Ask before adding dependencies.';
  writeFileSync(join(cwd,'AGENTS.md'), project);
  writeStack(cwd,'review.json',{
    schemaVersion:2,type:'pi-forge.prompt-stack',id:'review',name:zh?'代码审查':'Code Review',autoActivate:true,mode:'replace',
    tools:{allow:['read','grep','find','ls','bash','edit'],initial:['read','grep','find','ls']},
    items:[
      {id:'role',name:zh?'审查指令':'Review instructions',kind:'block',role:'system',content:role,enabled:true},
      {id:'project',name:zh?'项目上下文':'Project context',kind:'slot',role:'system',slot:'project-context',options:{format:'plain'},enabled:true},
      {id:'request',name:zh?'审查请求':'Review request',kind:'block',role:'user',content:zh?'审查当前改动，指出具体风险和可验证的建议。':'Review the current changes. Point out concrete risks and testable suggestions.',enabled:true},
      {id:'history',name:zh?'对话历史':'Conversation history',kind:'slot',slot:'chat-history',enabled:true},
    ],
  });
  const h = createHarness({activeTools:['read','grep','find','ls'],allTools:['read','grep','find','ls','bash','edit']});
  const c = createContext(cwd,[],{leafId:null});
  c.ctx.sessionManager.getSessionId = () => 'demo-session';
  // Public runtime input carries an owned example file, with a relative display path.
  c.ctx.getSystemPromptOptions = () => ({cwd,selectedTools:h.getActiveTools(),toolSnippets:{},promptGuidelines:[],contextFiles:[{path:'AGENTS.md',content:readFileSync(join(cwd,'AGENTS.md'),'utf8')}],skills:[]}) as any;
  let browser:any;
  try {
    await startSession(h,c.ctx); await h.commands.preset.handler('ui',c.ctx);
    const url = latestEditorUrl(c.editors);
    browser = await chromium.launch({executablePath:process.env.CHROME_PATH ?? '/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
    const page = await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
    page.setDefaultTimeout(8000);
    const errors:string[]=[];page.on('pageerror',(e:any)=>errors.push(e.message));
    await page.route('**/*',(r:any)=>new URL(r.request().url()).origin===url.origin?r.continue():r.abort());
    await page.goto(url.href); await page.locator('#itemContent').waitFor();
    if(await page.locator('body').getAttribute('data-theme')!=='dark')await page.locator('#themeToggleBtn').click();
    await page.locator('#previewTabBtn').click();
    const compiled = page.locator('.context-diff-compiled');
    const needle = zh?'保持公共 API 稳定':'Keep public APIs stable';
    await page.waitForFunction((n:string)=>document.querySelector('.context-diff-compiled')?.textContent?.includes(n),needle);
    await page.waitForTimeout(250);
    await page.screenshot({path:join(output,'editor-overview.png')});
    const projectRow = page.locator('.item-row').filter({hasText:zh?'项目上下文':'Project context'});
    await projectRow.click();
    await page.waitForTimeout(150);
    await page.screenshot({path:join(output,'toggle-on.png')});
    await projectRow.locator('.item-toggle').click();
    await page.waitForFunction(({needle,firstLine})=>{const text=document.querySelector('.context-diff-sections')?.textContent || '';return text.includes(firstLine) && !text.includes(needle);},{needle,firstLine:role.split('\n')[0]});
    await page.waitForTimeout(200);
    await page.screenshot({path:join(output,'toggle-off.png')});
    await projectRow.locator('.item-toggle').click();
    await page.waitForFunction((n:string)=>document.querySelector('.context-diff-compiled')?.textContent?.includes(n),needle);
    await page.waitForTimeout(200);
    await page.screenshot({path:join(output,'toggle-on-return.png')});
    // Restore the identical enabled state to disk before authoring one clear diff.
    await page.locator('#saveBtn').click();await page.locator('#dirtyBadge').waitFor({state:'hidden'});
    await page.locator('.item-row').first().click();await page.locator('#itemContent').fill(newRole);
    await page.locator('.context-diff-mode-tabs [role=tab]').nth(1).click();
    await page.setViewportSize({width:1440,height:620});
    await page.locator('.git-line.added').first().waitFor();await page.locator('.git-line.removed').first().waitFor();
    await page.waitForTimeout(220);
    await page.screenshot({path:join(output,'draft-diff.png')});
    assert.equal(await page.locator('#dirtyBadge').isVisible(),true);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({locale,projectToggleVerified:true,diffAddedRemoved:true,pageErrors:errors}));
  } finally {
    await browser?.close(); await h.commands.preset.handler('ui stop',c.ctx);
    await h.events.session_shutdown?.({type:'session_shutdown',reason:'exit'},c.ctx);
    rmSync(cwd,{recursive:true,force:true});
  }
}

} finally {
  envKeys.forEach((key,index) => { if (previousEnv[index] === undefined) delete process.env[key]; else process.env[key] = previousEnv[index]; });
  rmSync(isolationRoot,{recursive:true,force:true});
}

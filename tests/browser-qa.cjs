/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS browser QA runner. */
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const {chromium}=require('playwright');
const origin='http://127.0.0.1:5191';
const child=spawn('npm',['run','dev','--','--port','5191'],{stdio:['ignore','pipe','pipe'],detached:true});let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{let browser;try{
 for(let i=0;i<100;i++){try{if((await fetch(origin+'/api/state')).status===200)break;}catch{}await sleep(300);if(i===99)throw Error('Preview startup: '+logs);}
 const direct=await fetch(origin+'/api/state');const api=await direct.json();if(api.storage!=='ready'||api.mode!=='prelaunch'||api.rounds.length)throw Error('Invalid prelaunch DB response');
 console.log('REAL_D1_STATE',JSON.stringify(api));
 for(const path of ['/admin','/api/admin','/api/settle','/api/rounds']){const response=await fetch(origin+path,{method:path==='/admin'?'GET':'POST'});if(response.status!==404&&response.status!==405)throw Error('Unexpected privileged route '+path+' '+response.status);console.log('NO_ADMIN',path,response.status);}
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});fs.mkdirSync('outputs',{recursive:true});
 for(const [label,viewport] of [['mobile',{width:390,height:844}],['small-mobile',{width:320,height:740}],['desktop',{width:1440,height:1100}]]){
 const context=await browser.newContext({viewport});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/state')),page.goto(origin)]);await page.waitForTimeout(500);
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);if(overflow)throw Error(label+' horizontal overflow');if(errors.length)throw Error(errors.join(';'));
 await page.screenshot({path:'outputs/'+label+'.png',fullPage:true});console.log('BROWSER',label,await page.title(),JSON.stringify((await context.cookies()).map(({name,httpOnly,secure,sameSite})=>({name,httpOnly,secure,sameSite}))));
 const nasdaq=page.getByRole('tab',{name:/NASDAQ/});if(await nasdaq.count())await nasdaq.click();await page.screenshot({path:'outputs/'+label+'-nasdaq.png',fullPage:true});await context.close();
 }
 console.log('BROWSER_QA_PASS');
 }finally{if(browser)await browser.close();try{process.kill(-child.pid,'SIGTERM');}catch{}}})().catch(e=>{console.error(e);process.exitCode=1;});

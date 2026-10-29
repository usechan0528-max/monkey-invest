import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
test('canonical draw CLI records one synthetic audit and refuses rerolls or alternate paths',()=>{
 const dir=mkdtempSync(join(tmpdir(),'draw-fixture-')),now=Date.now(),open=Math.floor((now+3600000)/1000)*1000;
 const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(open));
 const input={market:'NASDAQ',sessionDate:date,opensAt:new Date(open).toISOString(),closesAt:new Date(open+6*3600000).toISOString(),calendarVerified:true,calendarSource:'https://www.nasdaq.com/market-activity/stock-market-holiday-schedule',calendarCheckedAt:new Date(now-1000).toISOString(),universeVerified:true,universeCheckedAt:new Date(now-1000).toISOString(),universePolicy:'direct-common-equity-v1',universeSource:'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt',universe:[{symbol:'SYNTHETIC_FIXTURE',name:'Isolated CLI fixture; never published'}]};
 const command=resolve('scripts/draw-round.mjs'),file=join(dir,'input.json'),output='ops/draws/NASDAQ-'+date+'.json';
 try{writeFileSync(file,JSON.stringify(input));assert.throws(()=>execFileSync(process.execPath,[command,file,'other.json'],{cwd:dir,stdio:'pipe'}));execFileSync(process.execPath,[command,file,output],{cwd:dir,stdio:'pipe'});const before=readFileSync(join(dir,output),'utf8');assert.throws(()=>execFileSync(process.execPath,[command,file,output],{cwd:dir,stdio:'pipe'}));assert.equal(readFileSync(join(dir,output),'utf8'),before);assert.match(JSON.parse(before).evidence.nonce,/^[a-f0-9]{64}$/);}finally{rmSync(dir,{recursive:true,force:true});}
});

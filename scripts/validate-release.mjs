import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {validateReleaseBundle} from '../lib/poll/release-validation.mjs';
const [flag,baseSha]=process.argv.slice(2);
if(flag!=='--base'||!/^[a-f0-9]{40}$/.test(baseSha??''))throw Error('Usage: node scripts/validate-release.mjs --base <last-successfully-deployed-full-SHA>');
const baseSource=execFileSync('git',['show',baseSha+':lib/poll/config.mjs'],{encoding:'utf8'});
const base=await import('data:text/javascript;base64,'+Buffer.from(baseSource).toString('base64'));
const current=await import(pathToFileURL(resolve('lib/poll/config.mjs')).href);
const audits=new Map();
for(const r of current.ROUND_RELEASES??[]){
 if(!/^(KOSPI|NASDAQ):\d{4}-\d{2}-\d{2}$/.test(r.id))throw Error('Invalid audit session ID');
 audits.set(r.id,JSON.parse(readFileSync(resolve('ops/draws',r.id.replace(':','-')+'.json'),'utf8')));
}
console.log(JSON.stringify({ok:true,baseSha,...validateReleaseBundle(current,base,audits)},null,2));

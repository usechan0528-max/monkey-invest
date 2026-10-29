import {readFileSync,writeFileSync,mkdirSync,existsSync,openSync,closeSync} from 'node:fs';
import {drawRound} from '../lib/poll/draw.mjs';
import {resolve,join,dirname} from 'node:path';
const [input,output]=process.argv.slice(2);if(!input||!output)throw Error('Usage: node scripts/draw-round.mjs verified-session.json new-audit-file.json');
// Exclusive creation prevents accidental overwrite. This never edits live releases.
const verified=JSON.parse(readFileSync(input,'utf8'));
if(!/^(KOSPI|NASDAQ)$/.test(verified.market)||!/^\d{4}-\d{2}-\d{2}$/.test(verified.sessionDate))throw Error('Invalid market session');
const canonical=resolve('ops/draws',verified.market+'-'+verified.sessionDate+'.json');
if(resolve(output)!==canonical)throw Error('Use the canonical immutable output path: '+canonical);
if(existsSync(canonical))throw Error('This session already has a draw. Preserve it; never redraw.');
mkdirSync(dirname(canonical),{recursive:true});
const lock=join(dirname(canonical),verified.market+'-'+verified.sessionDate+'.lock');
// Exclusive lock prevents a second process from consuming another random draw.
const fd=openSync(lock,'wx');
try{const result=drawRound(verified);writeFileSync(canonical,JSON.stringify(result,null,2)+'\n',{flag:'wx'});}finally{closeSync(fd);}
console.log('Committed draft saved. Keep both audit and lock; review before release. No round opened.');

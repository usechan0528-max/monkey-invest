import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {leaderboard,RATE_KEY_SQL,RELEASE_DIRECTION_SQL} from '../lib/poll/leaderboard.mjs';
import {records} from '../lib/poll/records.mjs';
import {digest} from '../lib/poll/password.mjs';

const origin='https://leaderboard.test',sessionToken='a'.repeat(64);
const request=(query='',loggedIn=false)=>new Request(origin+'/api/leaderboard'+query,{headers:loggedIn?{cookie:'__Host-monkey_session='+sessionToken}:{}});
async function setup(t){
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated local fixture")}}',compatibilityDate:'2026-05-15',d1Databases:['DB']});t.after(()=>mf.dispose());
 const db=await mf.getD1Database('DB');
 for(const f of (await readdir(new URL('../drizzle',import.meta.url))).filter(f=>f.endsWith('.sql')).sort()){
 const sql=await readFile(new URL('../drizzle/'+f,import.meta.url),'utf8');await db.batch(sql.split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
 }
 const now=(await db.prepare('SELECT unixepoch() AS n').first()).n;
 const addAccount=async id=>{await db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').bind(id,'login-'+id,'secret-salt-'+id,'secret-password-'+id).run();await db.prepare('INSERT INTO voters VALUES (?,0,?)').bind('voter-'+id,now+10000).run();};
 const login=async id=>db.prepare('INSERT OR REPLACE INTO account_sessions VALUES (?,?,?,?)').bind(digest(sessionToken),id,'private-csrf',now+10000).run();
 const addRound=async(id,{open='10',close='11',status='verified',closes=now-10,reveal=now-10,result=true,...event}={})=>{
 await db.prepare('INSERT INTO rounds VALUES (?,?,?,?,?,?)').bind(id,JSON.stringify({id,market:'KOSPI',symbol:'OWN-SYMBOL-'+id,name:'private history '+id}),now-10000,now-4000,closes,reveal).run();
 if(result)await db.prepare('INSERT INTO result_events VALUES (?,?,1,?,?)').bind(id+':1',id,JSON.stringify({status,open,close,...event}),now).run();
 };
 const cast=async(id,round,choice='up')=>db.prepare('INSERT INTO votes VALUES (?,?,?, ?,?)').bind(round,'voter-'+id,choice,now-5000,id).run();
 const addScore=async(id,wins,total)=>{await addAccount(id);for(let i=0;i<total;i++)await cast(id,'round:'+i,i<wins?'up':'down');};
 return {db,now,addAccount,login,addRound,cast,addScore};
}
async function response(db,query='',loggedIn=false){const response=await leaderboard(request(query,loggedIn),db);const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));assert.match(response.headers.get('cache-control'),/no-store/);return data;}
function instrument(db){const log=[];return {log,prepare(sql){const p=db.prepare(sql);const wrap=statement=>({bind(...args){return wrap(statement.bind(...args));},async first(){const value=await statement.first();log.push({sql,rows:value?1:0,value});return value;},async all(){const value=await statement.all();log.push({sql,rows:value.results.length,value});return value;}});return wrap(p);}};}

test('empty leaderboard is public, uncached and has usable empty pagination',async t=>{
 const {db}=await setup(t);const data=await response(db,'?page=2147483647');
 assert.deepEqual(data.counts,{accounts:0,ranked:0,provisional:0});assert.deepEqual(data.entries,[]);assert.equal(data.me,null);assert.equal(data.page,1);assert.equal(data.totalPages,1);assert.equal(data.minimumRounds,10);assert.ok(Number.isFinite(Date.parse(data.generatedAt)));
});

test('10-round eligibility, exact equivalent-rate competition ties, midrank and unranked zero-vote accounts',async t=>{
 const {db,addRound,addScore,login}=await setup(t);for(let i=0;i<20;i++)await addRound('round:'+i);
 for(const [id,wins,total] of [['top',10,10],['tie-a',6,10],['tie-b',9,15],['tie-c',12,20],['bottom',0,10],['nine',9,9],['zero',0,0]])await addScore(id,wins,total);
 await login('tie-c');const data=await response(db,'?pageSize=2',true);
 assert.deepEqual(data.counts,{accounts:7,ranked:5,provisional:2});assert.deepEqual(data.entries.map(e=>e.rank),[1,2]);assert.equal(data.me.rank,2);assert.equal(data.me.page,2);assert.equal(data.me.percentile.value,50);assert.equal(data.me.percentile.sample,5);
 const page2=await response(db,'?page=2&pageSize=2');assert.deepEqual(page2.entries.map(e=>e.rank),[2,2]);assert.equal(page2.me,null);assert.ok(page2.entries.every(e=>!e.isMe));
 const last=await response(db,'?page=999&pageSize=2');assert.equal(last.page,3);assert.equal(last.entries[0].rank,5);assert.equal(last.entries[0].percentile.value,10);
 const provisional=await response(db,'?group=provisional');assert.deepEqual(provisional.entries.map(e=>e.total),[9,0]);assert.ok(provisional.entries.every(e=>e.rank===null&&!e.eligible&&!e.percentile.ready&&e.percentile.value===null));assert.equal(provisional.entries[1].accuracy,null);
 await login('zero');const own=await response(db,'',true);assert.equal(own.me.total,0);assert.equal(own.me.page,1);assert.equal(own.me.rank,null);assert.ok(!own.entries.some(e=>e.isMe));
});

test('continued-fraction ordering distinguishes nearby 64-bit fractions and ties exact multiples',async t=>{
 const {db}=await setup(t);
 const pairs=[[0,10],[1,10],[1,3],[2,6],[6,10],[9,15],[1,2],[5,12],[3,7],[4,9],[9,10],[10,10],[9007199254740990,9007199254740991],[9007199254740989,9007199254740990]];
 // Denominators under 10 would be provisional in the real leaderboard.
 const values=pairs.map(([wins,total])=>[wins,total<10?total*10:total]);values[2]=[10,30];values[3]=[20,60];values[6]=[5,10];
 const result=await db.prepare(`WITH RECURSIVE account_scores(wins,total) AS (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?)),${RATE_KEY_SQL} SELECT wins,total,sort_key FROM rate_keys ORDER BY sort_key`).bind(JSON.stringify(values)).all();
 const expected=[...values].sort((a,b)=>{const diff=BigInt(a[0])*BigInt(b[1])-BigInt(b[0])*BigInt(a[1]);return diff<0n?-1:diff>0n?1:0;});
 assert.deepEqual(result.results.map(r=>[r.wins,r.total]),expected);
 assert.equal(result.results.find(r=>r.wins===6&&r.total===10).sort_key,result.results.find(r=>r.wins===9&&r.total===15).sort_key);
 assert.notEqual(result.results.at(-2).sort_key,result.results.at(-3).sort_key);
});

test('exact rate keys handle SQLite integer limits and decimal-future observations fail closed',async t=>{
 const {db,now,addRound}=await setup(t);
 const pairs=[['9223372036854775806','9223372036854775807'],['9223372036854775805','9223372036854775806'],['0','9223372036854775807'],['1','9223372036854775807'],['1','9223372036854775806'],['4611686018427387903','9223372036854775806']];
 const rows=(await db.prepare(`WITH RECURSIVE account_scores(wins,total) AS (SELECT CAST(json_extract(value,'$[0]') AS INTEGER),CAST(json_extract(value,'$[1]') AS INTEGER) FROM json_each(?)),${RATE_KEY_SQL} SELECT CAST(wins AS TEXT) AS wins,CAST(total AS TEXT) AS total FROM rate_keys ORDER BY sort_key`).bind(JSON.stringify(pairs)).all()).results;
 const expected=[...pairs].sort((a,b)=>{const difference=BigInt(a[0])*BigInt(b[1])-BigInt(b[0])*BigInt(a[1]);return difference<0n?-1:difference>0n?1:0;});assert.deepEqual(rows.map(r=>[r.wins,r.total]),expected);
 await addRound('fractional-future',{observedAt:new Date(now*1000+999).toISOString()});
 // Freeze only the trusted clock expression so the test cannot cross a second
 // while creating fixtures. Production always evaluates unixepoch() in D1.
 const directions=(await db.prepare(`WITH ${RELEASE_DIRECTION_SQL.replaceAll('unixepoch()',String(now))} SELECT * FROM release_directions`).all()).results;assert.deepEqual(directions,[]);
});

test('exact decimal prices, flat/void/pending/future isolation and latest correction are shared by own records',async t=>{
 const {db,now,addRound,addAccount,login,cast}=await setup(t);await addAccount('owner');await addAccount('other');await login('owner');
 const cases=[['tiny',{open:'10.00000000000000001',close:'10.00000000000000002'},'win'],['huge',{open:'999999999999999999999999999999999.999999',close:'1000000000000000000000000000000000'},'win'],['leading',{open:'000010.0100',close:'10.009999999999999999999999999999999999'},'loss'],['flat',{open:'000010.0100',close:'10.01'},'flat'],['void',{status:'void'},'void'],['pending',{result:false},'pending'],['close-future',{closes:now+9999,reveal:now-10},'pending'],['reveal-future',{reveal:now+9999},'pending'],['observation-future',{observedAt:new Date((now+9999)*1000).toISOString()},'pending'],['asof-future',{asOf:new Date((now+9999)*1000).toISOString()},'pending'],['unverified',{sourceVerified:false},'pending'],['incomplete',{regularSessionComplete:false},'pending'],['badprice',{open:'1e20'},'pending'],['zero-price',{open:'0'},'pending']];
 for(const [id,opts] of cases){await addRound(id,opts);await cast('owner',id);await cast('other',id,'down');}
 let mine=await (await records(request('',true),db)).json();assert.equal(mine.total,3);assert.equal(mine.wins,2);for(const [id,,verdict] of cases)assert.equal(mine.history.find(h=>h.roundId===id).verdict,verdict,id);
 const score=await response(db,'?group=provisional',true);assert.equal(score.me.total,mine.total);assert.equal(score.me.wins,mine.wins);assert.equal(score.me.percentile.ready,false);
 await db.prepare('INSERT INTO result_events VALUES (?,?,2,?,?)').bind('tiny:2','tiny',JSON.stringify({status:'verified',open:'10',close:'9'}),now).run();
 mine=await (await records(request('',true),db)).json();assert.equal(mine.wins,1);assert.equal((await response(db,'',true)).me.wins,1);
 await db.prepare('INSERT INTO result_events VALUES (?,?,3,?,?)').bind('tiny:3','tiny',JSON.stringify({status:'void'}),now).run();assert.equal((await response(db,'',true)).me.total,2);
 // A stored future row is not part of the current correction stream.
 await db.prepare('INSERT INTO result_events VALUES (?,?,4,?,?)').bind('tiny:4','tiny',JSON.stringify({status:'verified',open:'10',close:'11'}),now+9999).run();assert.equal((await response(db,'',true)).me.total,2);
});

test('corrections immediately move accounts between ranked and provisional without stale scores',async t=>{
 const {db,now,addRound,addScore,login}=await setup(t);for(let i=0;i<10;i++)await addRound('round:'+i);await addScore('owner',10,10);await login('owner');assert.equal((await response(db,'',true)).me.rank,1);
 await db.prepare('INSERT INTO result_events VALUES (?,?,2,?,?)').bind('void:2','round:0',JSON.stringify({status:'void'}),now).run();let data=await response(db,'',true);assert.equal(data.counts.ranked,0);assert.equal(data.me.total,9);assert.equal(data.me.rank,null);assert.equal(data.me.percentile.value,null);
 await db.prepare('INSERT INTO result_events VALUES (?,?,3,?,?)').bind('restore:3','round:0',JSON.stringify({status:'verified',open:'10',close:'11'}),now).run();data=await response(db,'',true);assert.equal(data.me.total,10);assert.equal(data.me.rank,1);assert.equal(data.me.percentile.value,50);
});

test('public response is allowlisted, pseudonyms are stable and session is the only owner selector',async t=>{
 const {db,addAccount,addRound,cast,login}=await setup(t);await addAccount('raw-owner-id');await addAccount('raw-other-id');await addRound('secret-round');await cast('raw-owner-id','secret-round','down');await cast('raw-other-id','secret-round','up');await login('raw-owner-id');
 const data=await response(db,'?group=provisional',true),text=JSON.stringify(data);
 for(const secret of ['raw-owner-id','raw-other-id','login-','secret-salt','secret-password','private-csrf','voter-','secret-round','OWN-SYMBOL','choice','actualDirection','token_hash',sessionToken])assert.ok(!text.includes(secret),secret);
 const entryKeys=['accuracy','displayName','eligible','isMe','losses','percentile','publicId','rank','total','wins'].sort();assert.deepEqual(Object.keys(data.entries[0]).sort(),entryKeys);assert.deepEqual(Object.keys(data.me).sort(),[...entryKeys,'page'].sort());assert.equal(data.entries.filter(e=>e.isMe).length,1);
 const ownId=data.me.publicId;assert.match(ownId,/^[a-f0-9]{24}$/);await db.prepare("UPDATE accounts SET username='renamed-login' WHERE id='raw-owner-id'").run();assert.equal((await response(db,'',true)).me.publicId,ownId);
 for(const query of ['?account_id=raw-other-id','?user_id=raw-other-id','?username=login-raw-other-id'])assert.equal((await leaderboard(request(query,true),db)).status,400);
 const mine=await (await records(request('?account_id=raw-other-id',true),db)).json();assert.equal(mine.history.length,1);assert.equal(mine.history[0].choice,'down');
 assert.equal((await records(request(),db)).status,401);await db.prepare('UPDATE account_sessions SET expires_at=0').run();assert.equal((await response(db,'',true)).me,null);assert.equal((await records(request('',true),db)).status,401);
});

test('strict query bounds reject abusive inputs before database access and page size is capped',async t=>{
 const {db}=await setup(t),wrapped=instrument(db);
 for(const query of ['?group=all','?group=','?page=0','?page=-1','?page=1.5','?page=1e3','?page=+1','?page=01','?page=NaN','?page=2147483648','?page=99999999999999999','?pageSize=0','?pageSize=51','?pageSize=2.5','?pageSize=100000000','?page=1&page=2','?group=ranked&group=ranked','?search=anyone', '?page='+ '1'.repeat(3000)])assert.equal((await leaderboard(request(query),wrapped)).status,400,query.slice(0,60));
 assert.equal(wrapped.log.length,0);assert.equal((await leaderboard(new Request(origin,{method:'POST'}),wrapped)).status,405);assert.equal((await response(db,'?pageSize=50')).pageSize,50);
});

test('deleted accounts disappear; anonymous retained votes do not become a participant',async t=>{
 const {db,addRound,addScore,login}=await setup(t);for(let i=0;i<10;i++)await addRound('round:'+i);await addScore('deleted',10,10);await addScore('remaining',5,10);await login('deleted');
 assert.equal((await response(db)).counts.ranked,2);await db.batch([db.prepare("UPDATE votes SET account_id=NULL WHERE account_id='deleted'"),db.prepare("DELETE FROM account_sessions WHERE account_id='deleted'"),db.prepare("DELETE FROM accounts WHERE id='deleted'")]);
 const data=await response(db,'',true);assert.deepEqual(data.counts,{accounts:1,ranked:1,provisional:0});assert.equal(data.me,null);assert.equal(data.entries[0].rank,1);assert.equal(data.entries[0].percentile.value,50);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM votes').first()).n,20);
});

test('5000 accounts / 100000 votes stay bounded to one page and one own score in two statements',async t=>{
 const {db,addRound,login}=await setup(t);for(let i=0;i<20;i++)await addRound('round:'+i);
 await db.prepare("WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<4999) INSERT INTO accounts SELECT printf('scale-%06d',i),printf('login-%06d',i),'private-salt','private-password' FROM n").run();
 await db.prepare('INSERT INTO voters SELECT id,0,2147483647 FROM accounts').run();
 await db.prepare("INSERT INTO votes SELECT r.id,a.id,CASE WHEN CAST(substr(r.id,7) AS INTEGER)<CAST(substr(a.id,7) AS INTEGER)%21 THEN 'up' ELSE 'down' END,0,a.id FROM accounts a CROSS JOIN rounds r").run();await login('scale-004999');
 const wrapped=instrument(db),started=performance.now();const data=await response(wrapped,'?page=100&pageSize=20',true);const elapsed=performance.now()-started;
 assert.equal(data.counts.accounts,5000);assert.equal(data.counts.ranked,5000);assert.equal(data.entries.length,20);assert.equal(data.totalPages,250);assert.equal(data.page,100);assert.ok(data.me);assert.equal(wrapped.log.length,2);assert.ok(wrapped.log.every(q=>q.rows===1));
 const snapshot=wrapped.log.find(q=>q.value?.entries_json);assert.equal(JSON.parse(snapshot.value.entries_json).length,20);assert.ok(JSON.stringify(data).length<12000);assert.ok(!JSON.stringify(data).includes('private-'));assert.equal(data.me.total,20);
 const own=instrument(db);const personal=await (await records(request('',true),own)).json();assert.equal(personal.history.length,20);assert.equal(personal.total,20);assert.equal(own.log.length,3);assert.deepEqual(own.log.map(q=>q.rows),[1,1,20]);assert.equal(JSON.parse(own.log[1].value.entries_json).length,0);
 t.diagnostic(`Isolated local D1: 5,000 accounts, 100,000 votes, ${elapsed.toFixed(1)} ms leaderboard; 2 statements authenticated, 20 page entries + own score. This is not a hosted latency guarantee.`);
});

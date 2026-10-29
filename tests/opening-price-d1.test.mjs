import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { state, syncReleases, hashToken, validateOpeningPrice } from '../lib/poll/service.mjs';
import { records } from '../lib/poll/records.mjs';
import { RULES } from '../lib/poll/config.mjs';

// Synthetic observations in disposable local D1 only. No hosted data or API writes.
const origin='https://opening.example.test';
const iso=seconds=>new Date(seconds*1000).toISOString();
const request=()=>new Request(origin+'/api/state');
const dbNow=async db=>Number((await db.prepare('SELECT unixepoch() AS now').first()).now);
const count=async(db,table)=>Number((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n);
const migrations=await Promise.all((await readdir(new URL('../drizzle/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort().map(f=>readFile(new URL('../drizzle/'+f,import.meta.url),'utf8')));
async function setup(t){
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("Local opening tests only")}}',compatibilityDate:'2026-05-15',cf:false,d1Databases:['DB']});
 t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
 await db.batch(migrations.join('\n--> statement-breakpoint\n').split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
 return db;
}
function fixture(now,patch={}){
 const r={market:'KOSPI',symbol:'LOCAL-SECRET-SYMBOL',name:'Synthetic private draw',opensAt:iso(now-120),deadline:iso(now+1800),closesAt:iso(now+5400),revealAt:iso(now+5400),calendarVerified:true,calendarSource:'https://example.test/calendar',draw:{validated:true,universeHash:'local-universe',commitmentHash:'local-commitment',sourceUrl:'https://example.test/draw'},...patch};
 r.id=r.market+':'+new Intl.DateTimeFormat('en-CA',{timeZone:r.market==='KOSPI'?'Asia/Seoul':'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(r.opensAt));return r;
}
function opening(r,patch={}){return {id:r.id+':opening:1',roundId:r.id,market:r.market,symbol:r.symbol,revision:1,status:'verified',price:'123.4500',sessionDate:r.id.split(':')[1],currency:r.market==='KOSPI'?'KRW':'USD',observedAt:r.opensAt,sourceVerified:true,sourceUrl:'https://example.test/official-opening',sourceLabel:'Synthetic official source',reason:'Verified opening observation',...patch};}
function result(r,patch={}){return {id:r.id+':result:1',roundId:r.id,revision:1,status:'verified',open:'100',close:'101',sessionDate:r.id.split(':')[1],currency:r.market==='KOSPI'?'KRW':'USD',observedAt:r.closesAt,sourceVerified:true,regularSessionComplete:true,sourceUrl:'https://example.test/completed-session',sourceLabel:'Synthetic settlement source',reason:'Completed verified session',...patch};}
const config=(rounds=[],openingPrices=[],results=[])=>({rules:RULES,rounds,openingPrices,results});
async function readState(db,c=config()){const response=await state(request(),db,c);assert.equal(response.status,200);return response.json();}
async function rawOpening(db,e,recordedAt){await db.prepare('INSERT INTO opening_price_events (id,round_id,revision,payload_json,recorded_at) VALUES (?,?,?,?,?)').bind(e.id,e.roundId,e.revision,JSON.stringify(e),recordedAt).run();}
async function seedVote(db,r){const hash=await hashToken('synthetic-voter-'+r.id);await db.batch([db.prepare('INSERT INTO voters VALUES (?,unixepoch(),unixepoch()+1000)').bind(hash),db.prepare('INSERT INTO votes (round_id,voter_hash,choice,accepted_at) VALUES (?,?,?,?)').bind(r.id,hash,'up',Math.floor(Date.parse(r.opensAt)/1000)+1)]);}

test('empty release fixture has no rounds, observations, results, or fabricated points',async t=>{
 const db=await setup(t);assert.equal(RULES.rulesConfirmed,true);assert.equal(RULES.noScorePolicyConfirmed,true);
 const data=await readState(db,config());assert.equal(data.mode,'prelaunch');assert.deepEqual(data.score,{humans:0,chimp:0});assert.deepEqual(data.rounds,[]);
});
test('a committed session must first reach D1 before open, not at or after it',async t=>{
 const db=await setup(t),now=await dbNow(db),late=fixture(now,{opensAt:iso(now)});late.draw.commitmentVersion='preopen-v1';
 await assert.rejects(syncReleases(db,RULES,[late],[]),/provisioned before open/);assert.equal(await count(db,'rounds'),0);
 const future=fixture(now,{opensAt:iso(now+120)});future.draw.commitmentVersion='preopen-v1';
 await syncReleases(db,RULES,[future],[]);assert.equal(await count(db,'rounds'),1);
 await syncReleases(db,RULES,[future],[]);assert.equal(await count(db,'rounds'),1);
});

test('before open, even an incorrectly stored future observation reveals neither symbol nor opening price',async t=>{
 const db=await setup(t),now=await dbNow(db),r=fixture(now,{opensAt:iso(now+120)}),e=opening(r);
 await syncReleases(db,RULES,[r],[]);await rawOpening(db,e,now);
 const data=await readState(db,config([r]));assert.equal(data.rounds[0].status,'upcoming');assert.equal(data.rounds[0].symbol,'');assert.equal(data.rounds[0].openingPrice,null);assert.equal(data.rounds[0].result,null);
 assert.ok(!JSON.stringify(data).includes(r.symbol));assert.ok(!JSON.stringify(data).includes(e.price));assert.ok(!JSON.stringify(data).includes(e.sourceUrl));
});

test('future opening releases fail safely before a round or any release is ingested',async t=>{
 const db=await setup(t),now=await dbNow(db),r=fixture(now,{opensAt:iso(now+120)}),e=opening(r);
 await assert.rejects(syncReleases(db,RULES,[r],[],[e]),/Unverified opening/);
 assert.equal(await count(db,'rounds'),0);assert.equal(await count(db,'opening_price_events'),0);
 const response=await state(request(),db,config([r],[e]));assert.equal(response.status,503);const text=await response.text();assert.ok(!text.includes(r.symbol));assert.ok(!text.includes(e.price));
});

test('at and after open, the verified decimal and allowlisted source audit appear without pre-close tallies',async t=>{
 const db=await setup(t),now=await dbNow(db),r=fixture(now,{opensAt:iso(now)}),e=opening(r,{ownerOnlyNote:'PRIVATE-NOTE',rawProviderResponse:{secret:'PRIVATE-RAW'}});
 await syncReleases(db,RULES,[r],[],[e]);const data=await readState(db,config([r],[e])),p=data.rounds[0].openingPrice;
 assert.equal(data.rounds[0].symbol,r.symbol);assert.equal(data.rounds[0].status,'open');assert.equal(p.price,'123.4500');assert.equal(p.sourceUrl,e.sourceUrl);assert.equal(p.sourceLabel,e.sourceLabel);assert.equal(p.observedAt,e.observedAt);assert.equal(p.revision,1);assert.equal(p.auditHistory.length,1);
 assert.equal(data.rounds[0].tally,null);assert.equal(data.rounds[0].result,null);assert.deepEqual(data.score,{humans:0,chimp:0});assert.doesNotMatch(JSON.stringify(data),/PRIVATE-NOTE|PRIVATE-RAW|ownerOnlyNote|rawProviderResponse/);
});

test('strict opening market, session date, currency, source, positive exact decimal and timestamps reject atomically',async t=>{
 const db=await setup(t),now=await dbNow(db),r=fixture(now);
 const patches=[{roundId:'KOSPI:2000-01-01'},{market:'NASDAQ'},{market:undefined},{symbol:'WRONG-SYMBOL'},{symbol:undefined},{sessionDate:'2000-01-01'},{currency:'USD'},{currency:'EUR'},{status:'pending'},{sourceVerified:false},{sourceLabel:''},{sourceUrl:'javascript:alert(1)'},{sourceUrl:'http://example.test/source'},{sourceUrl:'https://password:secret@example.test/source'},{reason:''},{price:'0'},{price:'0.000'},{price:'-1'},{price:'1e2'},{price:'NaN'},{price:1},{price:'Infinity'},{price:'1.'},{price:'.5'},{price:'9'.repeat(121)},{observedAt:iso(now-121)},{observedAt:iso(now+3600)},{observedAt:'2026-10-09T09:00:00'},{observedAt:'2026-02-30T09:00:00Z'},{observedAt:'2026-10-09T09:00:00+14:59'},{asOf:'bad'},{asOf:iso(now-121)},{asOf:iso(now+3600)},{asOf:iso(now-1)},{revision:0},{revision:1.1},{revision:2},{correctsEventId:'missing'}];
 for(const patch of patches){await assert.rejects(syncReleases(db,RULES,[r],[],[opening(r,patch)]),undefined,JSON.stringify(patch));assert.equal(await count(db,'rounds'),0);assert.equal(await count(db,'opening_price_events'),0);}
});

test('pure preflight handles explicit offsets and rejects untrusted or future clocks',async t=>{
 const db=await setup(t),now=await dbNow(db),r=fixture(now),e=opening(r,{observedAt:iso(now-10),asOf:r.opensAt});
 assert.ok(validateOpeningPrice(e,r,now));
 const asOffset=iso(now-10).replace('Z','+00:00');assert.ok(validateOpeningPrice({...e,observedAt:asOffset},r,now));
 for(const clock of [NaN,Infinity,undefined,now-11])assert.throws(()=>validateOpeningPrice(e,r,clock));
});

test('invalid later observation or malformed later round cannot partially ingest an earlier valid release',async t=>{
 const db=await setup(t),now=await dbNow(db),r=fixture(now),e=opening(r),invalid=opening(r,{id:'invalid-later',revision:2,correctsEventId:e.id,price:'0'});
 await assert.rejects(syncReleases(db,RULES,[r],[],[e,invalid]));assert.equal(await count(db,'rounds'),0);assert.equal(await count(db,'opening_price_events'),0);
 const other=fixture(now,{market:'NASDAQ',deadline:'invalid'});await assert.rejects(syncReleases(db,RULES,[r,other],[],[e]));assert.equal(await count(db,'rounds'),0);
});

test('corrections append in order, preserve every original payload and never mutate round configuration',async t=>{
 const db=await setup(t),now=await dbNow(db),r=fixture(now),first=opening(r),second=opening(r,{id:r.id+':opening:2',revision:2,correctsEventId:first.id,price:'124.2500',observedAt:iso(now-10),asOf:r.opensAt,reason:'Official opening correction'});
 await syncReleases(db,RULES,[r],[],[first]);const original=await db.prepare('SELECT * FROM opening_price_events WHERE id=?').bind(first.id).first();
 await syncReleases(db,RULES,[r],[],[first,second]);await syncReleases(db,RULES,[r],[],[first,second]);
 assert.deepEqual(await db.prepare('SELECT * FROM opening_price_events WHERE id=?').bind(first.id).first(),original);assert.equal((await db.prepare('SELECT config_json FROM rounds').first()).config_json,JSON.stringify(r));assert.equal(await count(db,'opening_price_events'),2);
 const data=await readState(db,config([r],[first,second])),p=data.rounds[0].openingPrice;assert.equal(p.revision,2);assert.equal(p.price,second.price);assert.equal(p.asOf,r.opensAt);assert.deepEqual(p.auditHistory.map(e=>e.price),[first.price,second.price]);assert.equal(p.auditHistory[1].correctsEventId,first.id);assert.deepEqual(data.score,{humans:0,chimp:0});
 await assert.rejects(syncReleases(db,RULES,[r],[],[{...first,price:'999'}]),/immutable/);await assert.rejects(syncReleases(db,RULES,[r],[],[{...first,id:'conflicting-revision'}]),/already published/);
 await assert.rejects(db.prepare('UPDATE opening_price_events SET payload_json=? WHERE id=?').bind(JSON.stringify({...first,price:'999'}),first.id).run(),/append-only/);
 await assert.rejects(db.prepare('DELETE FROM opening_price_events WHERE id=?').bind(first.id).run(),/append-only/);
 await assert.rejects(db.prepare('INSERT OR REPLACE INTO opening_price_events VALUES (?,?,?,?,?)').bind(first.id,r.id,1,JSON.stringify({...first,price:'999'}),now).run(),/immutable/);
 await db.prepare('INSERT OR REPLACE INTO opening_price_events VALUES (?,?,?,?,?)').bind(first.id,r.id,1,JSON.stringify(first),now+100).run();assert.deepEqual(await db.prepare('SELECT * FROM opening_price_events WHERE id=?').bind(first.id).first(),original);
});

test('missing, skipped, cross-round and out-of-order correction chains are rejected',async t=>{
 const db=await setup(t),now=await dbNow(db),r=fixture(now),other=fixture(now,{market:'NASDAQ'}),a=opening(r),b=opening(other);
 await syncReleases(db,RULES,[r,other],[],[a,b]);
 for(const patch of [{revision:2,correctsEventId:'missing'},{revision:3,correctsEventId:a.id},{revision:2,correctsEventId:b.id}])await assert.rejects(syncReleases(db,RULES,[],[],[opening(r,{...patch,id:'bad-chain'})]),/correction chain/);
 const second=opening(r,{id:'second',revision:2,correctsEventId:a.id}),third=opening(r,{id:'third',revision:3,correctsEventId:second.id});await assert.rejects(syncReleases(db,RULES,[],[],[third,second]),/correction chain/);assert.equal(await count(db,'opening_price_events'),2);
 await assert.rejects(rawOpening(db,opening(r,{id:'raw-invalid',revision:2,correctsEventId:b.id}),now),/correction chain/);
});

test('latest eligible verified opening survives an ineligible future correction in storage',async t=>{
 const db=await setup(t),now=await dbNow(db),r=fixture(now),first=opening(r),future=opening(r,{id:'future-correction',revision:2,correctsEventId:first.id,price:'999.999',observedAt:iso(now+100)});
 await syncReleases(db,RULES,[r],[],[first]);await rawOpening(db,future,now);
 const data=await readState(db,config([r]));assert.equal(data.rounds[0].openingPrice.price,first.price);assert.equal(data.rounds[0].openingPrice.revision,1);assert.equal(data.rounds[0].openingPrice.auditHistory.length,1);assert.ok(!JSON.stringify(data).includes(future.price));
});

test('an opening observation alone cannot settle a closed round or affect personal/team scores',async t=>{
 const db=await setup(t),now=await dbNow(db),r=fixture(now,{opensAt:iso(now-10000),deadline:iso(now-3620),closesAt:iso(now-20),revealAt:iso(now-20)}),e=opening(r,{price:'999999.12'});
 await syncReleases(db,RULES,[r],[],[e]);await seedVote(db,r);
 const memberToken='c'.repeat(64);await db.batch([db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').bind('local-member','local-member','synthetic','synthetic'),db.prepare('INSERT INTO account_sessions VALUES (?,?,?,unixepoch()+1000)').bind(await hashToken(memberToken),'local-member','test-csrf'),db.prepare('UPDATE votes SET account_id=? WHERE round_id=?').bind('local-member',r.id)]);
 const myRecords=async()=>{const response=await records(new Request(origin+'/api/me',{headers:{cookie:'__Host-monkey_session='+memberToken}}),db);assert.equal(response.status,200);return response.json();};
 let personal=await myRecords();assert.equal(personal.total,0);assert.equal(personal.wins,0);assert.equal(personal.losses,0);assert.equal(personal.history[0].verdict,'pending');
 let data=await readState(db,config([r],[e]));assert.equal(data.rounds[0].status,'locked');assert.equal(data.rounds[0].result,null);assert.deepEqual(data.score,{humans:0,chimp:0});assert.equal(await count(db,'result_events'),0);
 const settled=result(r);data=await readState(db,config([r],[e],[settled]));assert.equal(data.rounds[0].status,'settled');assert.equal(data.rounds[0].result.open,'100');assert.equal(data.rounds[0].openingPrice.price,e.price);assert.deepEqual(data.score,{humans:1,chimp:0});
 const correction=opening(r,{id:'display-correction',revision:2,correctsEventId:e.id,price:'0.01',observedAt:iso(now-1)});data=await readState(db,config([r],[e,correction],[settled]));assert.deepEqual(data.score,{humans:1,chimp:0});assert.equal(data.rounds[0].result.open,'100');personal=await myRecords();assert.equal(personal.total,1);assert.equal(personal.wins,1);assert.equal(personal.history[0].verdict,'win');
});

test('post-close future result observation fails before even a valid opening release is stored',async t=>{
 const db=await setup(t),now=await dbNow(db),r=fixture(now,{opensAt:iso(now-10000),deadline:iso(now-3620),closesAt:iso(now-20),revealAt:iso(now-20)});
 for(const patch of [{observedAt:iso(now+100)},{asOf:iso(now+100)}])await assert.rejects(syncReleases(db,RULES,[r],[result(r,patch)],[opening(r)]),/future/);
 for(const patch of [{symbol:'WRONG-SYMBOL'},{market:'NASDAQ'}])await assert.rejects(syncReleases(db,RULES,[r],[result(r,patch)],[opening(r)]),/Unverified result/);
 for(const table of ['rounds','opening_price_events','result_events'])assert.equal(await count(db,table),0);
});

test('opening ingestion adds no public anonymous administration API',async()=>{
 assert.deepEqual((await readdir(new URL('../app/api/',import.meta.url))).sort(),['account','leaderboard','me','state','vote']);
 const ranking=await readFile(new URL('../app/api/leaderboard/route.ts',import.meta.url),'utf8');assert.match(ranking,/export async function GET\(/);assert.doesNotMatch(ranking,/export (?:async )?function (?:POST|PUT|PATCH|DELETE)\(/);
 for(const route of ['state','vote','me','leaderboard']){const source=await readFile(new URL('../app/api/'+route+'/route.ts',import.meta.url),'utf8');assert.match(source,/OPEN_PRICE_RELEASES/);assert.doesNotMatch(source,/request\.json\(\).*opening|admin|secret.*key/i);}
});


test('public draw commitment allowlists audit hashes before and after open without revealing the secret draw',async t=>{
 const db=await setup(t),now=await dbNow(db),draw={validated:true,commitmentHash:'a'.repeat(64),universeHash:'b'.repeat(64),sourceUrl:'https://example.test/draw',drawnAt:iso(now-1000),universeCount:831,nonce:'PRIVATE-NONCE',selectedIndex:27,privateField:'PRIVATE-FIELD'};
 const future=fixture(now,{opensAt:iso(now+100),draw}),opened=fixture(now,{market:'NASDAQ',draw});
 const data=await readState(db,config([future,opened]));
 for(const r of data.rounds)assert.deepEqual(r.drawCommitment,{commitmentHash:draw.commitmentHash,universeHash:draw.universeHash,drawnAt:draw.drawnAt,universeCount:831});
 const upcoming=data.rounds.find(r=>r.id===future.id);assert.equal(upcoming.symbol,'');assert.equal(upcoming.openingPrice,null);assert.doesNotMatch(JSON.stringify(data),/PRIVATE-NONCE|PRIVATE-FIELD|selectedIndex|nonce/);
});

test('concurrent duplicate opening releases are idempotent and conflicting revisions cannot both persist',async t=>{
 const db=await setup(t),now=await dbNow(db),r=fixture(now),e=opening(r);
 await Promise.all(Array.from({length:8},()=>syncReleases(db,RULES,[r],[],[e])));assert.equal(await count(db,'opening_price_events'),1);
 const a=opening(r,{id:'correction-a',revision:2,correctsEventId:e.id,price:'124'}),b={...a,id:'correction-b',price:'125'};
 const results=await Promise.allSettled([syncReleases(db,RULES,[r],[],[a]),syncReleases(db,RULES,[r],[],[b])]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal(await count(db,'opening_price_events'),2);
});

test('a database-time conflict rolls back earlier writes in the same release bundle',async t=>{
 const db=await setup(t),now=await dbNow(db),r=fixture(now),other=fixture(now,{market:'NASDAQ'}),e=opening(r);
 await syncReleases(db,RULES,[r],[]);
 const racingDB={prepare:db.prepare.bind(db),async batch(statements){await rawOpening(db,{...e,price:'999'},now);return db.batch(statements);}};
 await assert.rejects(syncReleases(racingDB,RULES,[r,other],[],[e]),/immutable/);assert.equal(await count(db,'rounds'),1);assert.equal(await count(db,'opening_price_events'),1);assert.equal((await db.prepare('SELECT id FROM rounds').first()).id,r.id);
});


test('empty prelaunch state detects a missing opening migration without inserting test rounds',async t=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("Migration health only")}}',compatibilityDate:'2026-05-15',cf:false,d1Databases:['DB']});t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
 await db.batch(migrations.slice(0,2).join('\n--> statement-breakpoint\n').split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
 const response=await state(request(),db,config());assert.equal(response.status,503);assert.equal((await response.json()).code,'STORAGE_UNAVAILABLE');assert.equal(await count(db,'rounds'),0);
});

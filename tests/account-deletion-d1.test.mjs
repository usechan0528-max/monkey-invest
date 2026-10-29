import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {account,memberSession} from '../lib/poll/member.mjs';
import {digest} from '../lib/poll/password.mjs';
import {records} from '../lib/poll/records.mjs';
import {state} from '../lib/poll/service.mjs';
const origin='https://deletion.test',password='test-only-deletion-password-123',empty={rules:{rulesConfirmed:false},rounds:[],results:[]};
async function setup(t){
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("local test only")}}',compatibilityDate:'2026-05-15',d1Databases:['DB']});t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
 for(const f of (await readdir(new URL('../drizzle',import.meta.url))).filter(f=>f.endsWith('.sql')).sort()){
  const sql=await readFile(new URL('../drizzle/'+f,import.meta.url),'utf8');await db.batch(sql.split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
 }
 function client(){let csrf='',jar={};return {jar,get csrf(){return csrf;},request(body,headers={}){return new Request(origin+'/api/account',{method:body?'POST':'GET',headers:{cookie:Object.entries(jar).map(([k,v])=>k+'='+v).join('; '),...(body?{'content-type':'application/json',origin,'x-csrf-token':csrf}:{}),...headers},body:body?JSON.stringify(body):undefined});},async call(body,headers={},database=db){const response=await account(this.request(body,headers),database);for(const c of response.headers.getSetCookie()){const [k,v]=c.split(';')[0].split('=');jar[k]=v;}const data=await response.json();if(data.csrf)csrf=data.csrf;return {response,data};}};}
 const register=async name=>{const c=client();await c.call();assert.equal((await c.call({action:'register',username:name,password})).response.status,200);await c.call();return c;};
 const login=async name=>{const c=client();await c.call();assert.equal((await c.call({action:'login',username:name,password})).response.status,200);await c.call();return c;};
 return {db,client,register,login};
}
const count=async(db,table)=>(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
async function seedRound(db,id){await db.prepare('INSERT INTO rounds VALUES (?,?,unixepoch()-10000,unixepoch()-4000,unixepoch()-100,unixepoch()-100)').bind(id,JSON.stringify({id,market:'KOSPI',symbol:'TEST',name:'로컬 테스트',opensAt:'2026-01-01T00:00:00Z',deadline:'2026-01-01T01:00:00Z',closesAt:'2026-01-01T02:00:00Z',revealAt:'2026-01-01T02:00:00Z'})).run();await db.prepare('INSERT INTO result_events VALUES (?,?,1,?,unixepoch())').bind(id+':1',id,JSON.stringify({status:'verified',open:'10',close:'11'})).run();}
async function seedVote(db,id,hash,accountId,choice='up'){
 await db.prepare('INSERT OR IGNORE INTO voters VALUES (?,unixepoch(),unixepoch()+7776000)').bind(hash).run();await db.prepare('INSERT INTO votes VALUES (?,?,?,unixepoch()-5000,?)').bind(id,hash,choice,accountId).run();await db.prepare('INSERT OR IGNORE INTO attempts VALUES (?,1,1)').bind(hash).run();
}
async function snapshot(db){const result={};for(const table of ['accounts','account_sessions','votes','voters','attempts','result_events'])result[table]=(await db.prepare('SELECT * FROM '+table).all()).results;return result;}
function raceDatabase(db,inject){let deleting=false,attempt=0;return {prepare(sql){if(sql.includes('INSERT INTO auth_attempts(key,count,expires_at)'))deleting=true;return db.prepare(sql);},async batch(operations){if(deleting){deleting=false;await inject(++attempt,operations);}return db.batch(operations);}};}
const removal={action:'delete',password,confirm:true};

test('삭제는 로그인·Origin·CSRF·현재 비밀번호·명시적 확인이 모두 필요하다',async t=>{
 const {db,client,register}=await setup(t);const guest=client();await guest.call();assert.equal((await guest.call(removal)).response.status,401);
 const a=await register('alice');const before=await snapshot(db);
 for(const [value,headers,status] of [[removal,{origin:'https://evil.test'},403],[removal,{'x-csrf-token':'wrong'},403],[{...removal,password:'incorrect-long-password'}, {},401],[{...removal,confirm:false},{},400],[{action:'delete',password},{},400],[{...removal,confirm:'true'},{},400],[{...removal,password:''},{},400]])assert.equal((await a.call(value,headers)).response.status,status);
 assert.deepEqual(await snapshot(db),before);assert.equal(await count(db,'accounts'),1);
});

test('삭제 대상은 세션 본인으로 고정되고 다른 계정 지정은 거부한다',async t=>{
 const {db,register}=await setup(t),a=await register('alice'),b=await register('bob');const bob=(await memberSession(b.request(),db)).account_id;
 assert.equal((await a.call({...removal,account_id:bob})).response.status,400);assert.equal((await a.call({...removal,username:'bob'})).response.status,400);assert.equal(await count(db,'accounts'),2);
});

test('탈퇴는 모든 세션·개인 기록을 없애고 다른 회원·익명 집계·확정 점수를 보존한다',async t=>{
 const {db,register,login}=await setup(t),a=await register('alice'),a2=await login('alice'),b=await register('bob');
 const alice=(await memberSession(a.request(),db)).account_id,bob=(await memberSession(b.request(),db)).account_id;
 const oldCookie=a.request().headers.get('cookie'),oldSecond=a2.request().headers.get('cookie'),ownHash=digest('only-alice'),sharedHash=digest('shared-browser');
 for(let i=0;i<12;i++){await seedRound(db,'round:'+i);await seedVote(db,'round:'+i,i===0?sharedHash:ownHash,alice,i%3?'up':'down');await seedVote(db,'round:'+i,digest('bob:'+i),bob,'up');}
 await seedRound(db,'round:shared');await seedVote(db,'round:shared',sharedHash,bob,'down');await seedVote(db,'round:shared',digest('guest'),null,'up');
 await db.prepare('INSERT OR REPLACE INTO auth_attempts VALUES (?,2,unixepoch()+900)').bind('session:'+digest(a2.jar['__Host-monkey_session'])).run();
 const beforeCounts=(await db.prepare("SELECT round_id,choice,count(*) AS n FROM votes GROUP BY round_id,choice ORDER BY round_id,choice").all()).results;
 const beforeEvents=(await db.prepare('SELECT * FROM result_events').all()).results,beforeBob=(await records(b.request(),db)).status;
 const stateBefore=await (await state(a.request(),db,empty)).json();
 const result=await a.call(removal);assert.equal(result.response.status,200);assert.equal(result.data.deleted,true);assert.match(result.response.headers.getSetCookie()[0],/Max-Age=0/);
 assert.equal(await db.prepare('SELECT 1 FROM accounts WHERE id=?').bind(alice).first(),null);assert.equal(await db.prepare('SELECT 1 FROM account_sessions WHERE account_id=?').bind(alice).first(),null);assert.equal(await db.prepare('SELECT 1 FROM votes WHERE account_id=?').bind(alice).first(),null);
 assert.equal(await db.prepare('SELECT 1 FROM auth_attempts WHERE key=?').bind('account:'+digest('alice')).first(),null);assert.equal(await db.prepare('SELECT 1 FROM auth_attempts WHERE key=?').bind('session:'+digest(a2.jar['__Host-monkey_session'])).first(),null);assert.ok(await db.prepare("SELECT 1 FROM auth_attempts WHERE key='global'").first());
 for(const cookie of [oldCookie,oldSecond]){const r=new Request(origin+'/api/me',{headers:{cookie}});assert.equal(await memberSession(r,db),null);assert.equal((await records(r,db)).status,401);}
 assert.equal(await db.prepare('SELECT 1 FROM voters WHERE token_hash=?').bind(ownHash).first(),null);assert.equal(await db.prepare('SELECT 1 FROM attempts WHERE voter_hash=?').bind(ownHash).first(),null);assert.ok(await db.prepare('SELECT 1 FROM voters WHERE token_hash=?').bind(sharedHash).first());
 const anonymous=(await db.prepare('SELECT v.*,r.created_at,r.expires_at FROM votes v JOIN voters r ON r.token_hash=v.voter_hash WHERE account_id IS NULL AND accepted_at=0').all()).results;
 assert.equal(anonymous.length,12);assert.equal(new Set(anonymous.map(v=>v.voter_hash)).size,12);assert.ok(anonymous.every(v=>v.voter_hash!==ownHash&&v.voter_hash!==sharedHash&&v.created_at===0&&v.expires_at===0));
 assert.deepEqual((await db.prepare("SELECT round_id,choice,count(*) AS n FROM votes GROUP BY round_id,choice ORDER BY round_id,choice").all()).results,beforeCounts);assert.deepEqual((await db.prepare('SELECT * FROM result_events').all()).results,beforeEvents);
 assert.deepEqual((await (await state(b.request(),db,empty)).json()).score,stateBefore.score);assert.equal((await records(b.request(),db)).status,beforeBob);assert.equal((await (await records(b.request(),db)).json()).history.length,13);
 assert.equal(await db.prepare("SELECT 1 FROM auth_attempts WHERE key LIKE 'delete-guard:%'").first(),null);
});

test('동시 로그아웃은 삭제 트랜잭션을 거부하고 계정·투표를 보존한다',async t=>{
 const {db,register}=await setup(t),a=await register('alice');const session=await memberSession(a.request(),db);await seedRound(db,'round:guard');await seedVote(db,'round:guard',digest('alice'),session.account_id);
 const beforeVotes=(await db.prepare('SELECT * FROM votes').all()).results;
 const wrapped=raceDatabase(db,async()=>{await db.prepare('DELETE FROM account_sessions WHERE token_hash=?').bind(session.token_hash).run();});
 assert.equal((await a.call(removal,{},wrapped)).response.status,401);assert.equal(await count(db,'accounts'),1);assert.deepEqual((await db.prepare('SELECT * FROM votes').all()).results,beforeVotes);assert.equal(await count(db,'voters'),1);assert.equal(await db.prepare("SELECT 1 FROM auth_attempts WHERE key LIKE 'delete-guard:%'").first(),null);
});

test('동시 투표는 원자적으로 되돌린 뒤 한 번 재시도하며 합계를 보존한다',async t=>{
 const {db,register}=await setup(t),a=await register('alice');const id=(await memberSession(a.request(),db)).account_id;await seedRound(db,'round:first');await seedRound(db,'round:race');await seedVote(db,'round:first',digest('first'),id);let calls=0;
 const wrapped=raceDatabase(db,async(attempt,operations)=>{calls++;assert.equal(operations.length,9);if(attempt===1)await seedVote(db,'round:race',digest('race'),id,'down');});
 assert.equal((await a.call(removal,{},wrapped)).response.status,200);assert.equal(calls,2);assert.equal(await count(db,'accounts'),0);assert.equal(await count(db,'votes'),2);assert.equal(await count(db,'voters'),2);assert.equal((await db.prepare('SELECT count(*) AS n FROM votes WHERE account_id IS NULL AND accepted_at=0').first()).n,2);
});

test('누적 회원 기록이 많아도 삭제 배치는 일정한 쿼리 수를 사용한다',async t=>{
 const {db,register}=await setup(t),a=await register('alice');const id=(await memberSession(a.request(),db)).account_id;
 for(let i=0;i<60;i++){await seedRound(db,'round:bulk'+i);await seedVote(db,'round:bulk'+i,digest('bulk'+i),id);}
 const wrapped=raceDatabase(db,async(_attempt,operations)=>assert.equal(operations.length,9));assert.equal((await a.call(removal,{},wrapped)).response.status,200);assert.equal(await count(db,'votes'),60);assert.equal(await count(db,'voters'),60);assert.equal(await count(db,'accounts'),0);
});

test('삭제된 아이디로 재가입해도 기존 전적은 복구되지 않는다',async t=>{
 const {db,register}=await setup(t),a=await register('alice');const id=(await memberSession(a.request(),db)).account_id;await seedRound(db,'round:old');await seedVote(db,'round:old',digest('old'),id);assert.equal((await a.call(removal)).response.status,200);
 const again=await register('alice');assert.notEqual((await memberSession(again.request(),db)).account_id,id);assert.equal((await (await records(again.request(),db)).json()).history.length,0);assert.equal(await count(db,'votes'),1);
});

test('삭제 비밀번호 추측도 기존 계정·세션·전역 시도 제한을 따른다',async t=>{
 const {db,register}=await setup(t),a=await register('alice');
 for(let i=0;i<9;i++)assert.equal((await a.call({...removal,password:'incorrect-long-password'})).response.status,401);
 assert.equal((await a.call(removal)).response.status,429);assert.equal(await count(db,'accounts'),1);assert.ok(await memberSession(a.request(),db));
});

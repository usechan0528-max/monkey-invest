import {memberSession,memberCSRF} from './member.mjs';
const COOKIE='monkey_voter';
const MAX_AGE=90*24*60*60;
const HEADERS={'Cache-Control':'no-store, private, max-age=0','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin'};
export class PollError extends Error { constructor(code,message,status=400){super(message);this.code=code;this.status=status;} }
const json=(value,status=200,extra={})=>Response.json(value,{status,headers:{...HEADERS,...extra}});
export const epoch=s=>{
 if(typeof s!=='string')return NaN;
 const m=s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/);
 if(!m)return NaN;const [,y,mo,d,h,mi,se]=m.map(Number);if(mo<1||mo>12||d<1||d>new Date(Date.UTC(y,mo,0)).getUTCDate()||h>23||mi>59||se>59)return NaN;
 return Math.floor(Date.parse(s)/1000);
};
const isSourceUrl=value=>{try{return typeof value==='string'&&['https:','http:'].includes(new URL(value).protocol);}catch{return false;}};
export async function hashToken(token){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))).map(x=>x.toString(16).padStart(2,'0')).join('');}
function tokenFrom(request){const token=request.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);return /^[a-f0-9]{64}$/.test(token||'')?token:null;}
async function now(db){return Number((await db.prepare('SELECT unixepoch() AS now').first()).now);}
export function validateRound(r,rules){
 if(!rules.rulesConfirmed||!rules.noScorePolicyConfirmed)throw new PollError('RULES_UNCONFIRMED','운영 규칙 확정 전에는 라운드를 열 수 없습니다.',503);
 if(!/^(KOSPI|NASDAQ):\d{4}-\d{2}-\d{2}$/.test(r.id)||!['KOSPI','NASDAQ'].includes(r.market)||!r.id.startsWith(r.market+':')||typeof r.symbol!=='string'||!r.symbol||!r.name)throw new Error('Invalid round identity');
 const [o,d,c,v]=[r.opensAt,r.deadline,r.closesAt,r.revealAt].map(epoch);
 if([r.opensAt,r.deadline,r.closesAt,r.revealAt].some(s=>Number.isFinite(Date.parse(s))&&Date.parse(s)%1000!==0))throw new Error('Round times require whole seconds');
 if(![o,d,c,v].every(Number.isFinite)||!(o<d&&d<=c&&v>=d))throw new Error('Invalid round times');
 if(rules.voteWindow!=='regular_session_until_last_hour'||c-d!==3600)throw new Error('Deadline must match the confirmed voting window');
 if(!['after_close','after_deadline'].includes(rules.resultVisibility))throw new Error('Invalid result visibility policy');
 if(rules.resultVisibility==='after_close'&&v<c)throw new Error('Results cannot be revealed before market close');
 if(!isSourceUrl(r.calendarSource)||r.calendarVerified!==true||!r.draw?.universeHash||!r.draw?.commitmentHash||!isSourceUrl(r.draw?.sourceUrl)||r.draw?.validated!==true)throw new Error('Unverified calendar or random draw');
 const localDate=new Intl.DateTimeFormat('en-CA',{timeZone:r.market==='KOSPI'?'Asia/Seoul':'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(o*1000));
 if(r.id.split(':')[1]!==localDate)throw new Error('Exchange-local session date mismatch');
 return {o,d,c,v};
}
const nonempty=(value,max=1000)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
const positivePrice=value=>typeof value==='string'&&value.length<=120&&/^\d+(\.\d+)?$/.test(value)&&compareDecimal(value,'0')>0;
const openingSource=value=>{try{const url=new URL(value);return typeof value==='string'&&url.protocol==='https:'&&!url.username&&!url.password;}catch{return false;}};
function validateOpeningEvent(e,r,ts){
 const round=JSON.parse(r.config_json),observedAt=epoch(e.observedAt),asOf=epoch(e.asOf??e.observedAt);
 if(!Number.isFinite(ts)||!Number.isFinite(r.opens_at)||!['KOSPI','NASDAQ'].includes(round.market)||!new RegExp('^'+round.market+':\\d{4}-\\d{2}-\\d{2}$').test(r.id)||!nonempty(e.id,160)||e.roundId!==r.id||e.market!==round.market||!nonempty(round.symbol,120)||e.symbol!==round.symbol||e.sessionDate!==r.id.split(':')[1]||e.currency!==(round.market==='KOSPI'?'KRW':'USD')||e.status!=='verified'||e.sourceVerified!==true||!openingSource(e.sourceUrl)||!nonempty(e.sourceLabel,200)||!nonempty(e.reason)||!positivePrice(e.price)||!Number.isSafeInteger(e.revision)||e.revision<1||!Number.isFinite(observedAt)||!Number.isFinite(asOf)||observedAt<r.opens_at||asOf<r.opens_at||Date.parse(e.observedAt)>ts*1000||Date.parse(e.asOf??e.observedAt)>Date.parse(e.observedAt))throw new Error('Unverified opening price event');
 if(e.revision===1&&e.correctsEventId!=null)throw new Error('Initial opening price cannot correct another event');
 if(e.revision>1&&!nonempty(e.correctsEventId,160))throw new Error('Opening price correction must identify prior event');
 return {observedAt,asOf};
}
// Pure validator for owner preflight. The caller must supply a trusted current
// Unix-second timestamp, never a request body or browser-provided clock.
export function validateOpeningPrice(event,round,nowSeconds){
 return validateOpeningEvent(event,{id:round.id,config_json:JSON.stringify(round),opens_at:epoch(round.opensAt)},nowSeconds);
}
function checkEventIdentity(e,payload,events,label){
 const existing=events.get(e.id);
 if(existing&&existing.payload_json!==payload)throw new Error(label+' event immutable');
 for(const prior of events.values())if(prior.round_id===e.roundId&&prior.revision===e.revision&&prior.id!==e.id)throw new Error(label+' revision already published with another event ID');
 if(e.correctsEventId){const prior=events.get(e.correctsEventId);if(!prior||prior.round_id!==e.roundId||prior.revision!==e.revision-1)throw new Error('Invalid correction chain');}
}
/** Release inputs are read-only; immutable source arrays are never mutated.
 * @param {any} db
 * @param {any} rules
 * @param {ReadonlyArray<any>} rounds
 * @param {ReadonlyArray<any>} results
 * @param {ReadonlyArray<any>} openingPrices
 */
export async function syncReleases(db,rules,rounds=[],results=[],openingPrices=[]){
 if(![rounds,results,openingPrices].every(Array.isArray))throw new Error('Release lists must be arrays');
 const ts=await now(db),stored=await db.prepare('SELECT * FROM rounds').all();
 const roundMap=new Map(stored.results.map(r=>[r.id,r])),writes=[];
 // Validate the complete release bundle before any writes. The final D1 batch is
 // transactional, including uniqueness conflicts from concurrent ingestion.
 for(const r of rounds){
  const t=validateRound(r,rules),payload=JSON.stringify(r),existing=roundMap.get(r.id);
  if(existing&&existing.config_json!==payload)throw new Error('Published round is immutable: '+r.id);
  if(!existing&&r.draw?.commitmentVersion==='preopen-v1'&&ts>=t.o)throw new Error('A committed session must be provisioned before open; do not backfill');
  roundMap.set(r.id,{id:r.id,config_json:payload,opens_at:t.o,deadline:t.d,closes_at:t.c,reveal_at:t.v});
  writes.push(db.prepare(`INSERT INTO rounds (id,config_json,opens_at,deadline,closes_at,reveal_at) VALUES (?,?,?,?,?,?)
   ON CONFLICT(id) DO UPDATE SET config_json=NULL WHERE rounds.config_json<>excluded.config_json`).bind(r.id,payload,t.o,t.d,t.c,t.v));
 }
 if(results.length){
  const rows=await db.prepare('SELECT * FROM result_events').all(),events=new Map(rows.results.map(e=>[e.id,e]));
  for(const e of results){
   const r=roundMap.get(e.roundId),round=r?JSON.parse(r.config_json):null,observedAt=epoch(e.observedAt),asOf=epoch(e.asOf??e.observedAt);
   if(!r||(e.market!==undefined&&e.market!==round.market)||(e.symbol!==undefined&&e.symbol!==round.symbol)||!nonempty(e.id,160)||!Number.isSafeInteger(e.revision)||e.revision<1||!nonempty(e.reason)||!isSourceUrl(e.sourceUrl)||!nonempty(e.sourceLabel,200)||e.sessionDate!==r.id.split(':')[1]||e.currency!==(r.id.startsWith('KOSPI:')?'KRW':'USD')||!Number.isFinite(observedAt)||!Number.isFinite(asOf)||observedAt<r.closes_at||asOf<r.closes_at)throw new Error('Unverified result event');
   if(e.revision>1&&!e.correctsEventId)throw new Error('Correction must identify prior event');
   if(e.revision===1&&e.correctsEventId)throw new Error('Initial result cannot correct another event');
   if(e.status!=='void'&&(e.status!=='verified'||e.sourceVerified!==true||e.regularSessionComplete!==true||!positivePrice(e.open)||!positivePrice(e.close)))throw new Error('Verified same-provider regular-session open/close fields required');
   const payload=JSON.stringify(e);checkEventIdentity(e,payload,events,'Result');
   // Preserve scheduled pre-close result non-ingestion. Once close has passed,
   // future-dated observations fail closed against the trusted database clock.
   if(ts<r.closes_at)continue;
   if(Date.parse(e.observedAt)>ts*1000||Date.parse(e.asOf??e.observedAt)>ts*1000)throw new Error('Result observation cannot be in the future');
   events.set(e.id,{id:e.id,round_id:e.roundId,revision:e.revision,payload_json:payload});
   writes.push(db.prepare(`INSERT INTO result_events (id,round_id,revision,payload_json,recorded_at) VALUES (?,?,?,?,unixepoch())
    ON CONFLICT(id) DO UPDATE SET payload_json=NULL WHERE result_events.payload_json<>excluded.payload_json`).bind(e.id,e.roundId,e.revision,payload));
  }
 }
 if(openingPrices.length){
  const rows=await db.prepare('SELECT * FROM opening_price_events').all(),events=new Map(rows.results.map(e=>[e.id,e]));
  for(const e of openingPrices){
   const r=roundMap.get(e.roundId);if(!r)throw new Error('Opening price requires a published round');
   validateOpeningEvent(e,r,ts);
   const payload=JSON.stringify(e);checkEventIdentity(e,payload,events,'Opening price');
   events.set(e.id,{id:e.id,round_id:e.roundId,revision:e.revision,payload_json:payload});
   writes.push(db.prepare(`INSERT INTO opening_price_events (id,round_id,revision,payload_json,recorded_at) VALUES (?,?,?,?,unixepoch()) ON CONFLICT(id) DO NOTHING`).bind(e.id,e.roundId,e.revision,payload));
  }
 }
 if(writes.length)await db.batch(writes);
}
function publicOpeningPrice(rows,round,ts){
 if(ts<round.opens_at)return null;
 const auditHistory=[],eligible=new Map();
 for(const row of rows){
  try{
   const e=JSON.parse(row.payload_json);
   if(row.recorded_at>ts||row.round_id!==round.id||row.id!==e.id||row.revision!==e.revision)continue;
   validateOpeningEvent(e,round,ts);
   if(e.revision>1){const prior=eligible.get(e.correctsEventId);if(!prior||prior.revision!==e.revision-1)continue;}
   eligible.set(e.id,e);
   // Explicit fields only: owner-only notes or additional config never leak.
   auditHistory.push({id:e.id,revision:e.revision,price:e.price,sourceLabel:e.sourceLabel,sourceUrl:e.sourceUrl,observedAt:e.observedAt,...(e.asOf?{asOf:e.asOf}:{}),reason:e.reason,...(e.correctsEventId?{correctsEventId:e.correctsEventId}:{})});
  }catch{/* A malformed stored observation cannot become public or affect scores. */}
 }
 if(!auditHistory.length)return null;
 const latest=auditHistory[auditHistory.length-1];
 return {price:latest.price,sourceLabel:latest.sourceLabel,sourceUrl:latest.sourceUrl,observedAt:latest.observedAt,...(latest.asOf?{asOf:latest.asOf}:{}),revision:latest.revision,auditHistory};
}
async function voter(db,request,create){
 let token=tokenFrom(request);let hash=token?await hashToken(token):null;
 if(hash){const v=await db.prepare('SELECT token_hash FROM voters WHERE token_hash=? AND expires_at>unixepoch()').bind(hash).first();if(v)return {hash,cookie:null};}
 if(!create)return null;
 token=Array.from(crypto.getRandomValues(new Uint8Array(32))).map(x=>x.toString(16).padStart(2,'0')).join('');hash=await hashToken(token);
 await db.prepare('INSERT INTO voters(token_hash,created_at,expires_at) VALUES (?,unixepoch(),unixepoch()+?)').bind(hash,MAX_AGE).run();
 const secure=new URL(request.url).protocol==='https:'?'; Secure':'';
 return {hash,cookie:`${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure}`};
}
function compareDecimal(a,b){const parts=[a,b].map(s=>s.split('.'));const scale=Math.max(...parts.map(p=>(p[1]||'').length));const vals=parts.map(p=>BigInt(p[0]+(p[1]||'').padEnd(scale,'0')));return vals[0]<vals[1]?-1:vals[0]>vals[1]?1:0;}
export function outcome(event,tally){
 if(event.status==='void')return {winner:null,reason:event.reason,actualDirection:null};
 const diff=compareDecimal(event.open,event.close), actualDirection=diff<0?'up':diff>0?'down':null;
 if(tally.total===0)return {winner:null,reason:'참여 없음',actualDirection};
 if(tally.up===tally.down)return {winner:null,reason:'상승·하락 동률',actualDirection};
 if(!actualDirection)return {winner:null,reason:'시가·종가 동일',actualDirection};
 const majority=tally.up>tally.down?'up':'down';return {winner:majority===actualDirection?'humans':'chimp',reason:null,actualDirection,humanDirection:majority};
}
function publicDrawCommitment(draw){
 // The nonce and selected index remain private until separate audit release.
 if(!/^[a-f0-9]{64}$/.test(draw?.commitmentHash??'')||!/^[a-f0-9]{64}$/.test(draw?.universeHash??''))return null;
 return {commitmentHash:draw.commitmentHash,universeHash:draw.universeHash,...(Number.isFinite(epoch(draw.drawnAt))?{drawnAt:draw.drawnAt}:{}),...(Number.isSafeInteger(draw.universeCount)&&draw.universeCount>0?{universeCount:draw.universeCount}:{})};
}
export async function state(request,db,config){
 try{
 await syncReleases(db,config.rules,config.rounds,config.results,config.openingPrices);
 const identity=await voter(db,request,true), ts=await now(db),member=await memberSession(request,db);
 const all=await db.prepare('SELECT * FROM rounds ORDER BY opens_at DESC').all();
 // Query even during prelaunch, so a healthy state response verifies migration
 // 0002 exists without creating a synthetic public round or observation.
 const openingRows=await db.prepare('SELECT e.* FROM opening_price_events e JOIN rounds r ON r.id=e.round_id WHERE r.opens_at<=? AND e.recorded_at<=? ORDER BY e.round_id,e.revision ASC').bind(ts,ts).all(),openingByRound=new Map();
 for(const row of openingRows.results){if(!openingByRound.has(row.round_id))openingByRound.set(row.round_id,[]);openingByRound.get(row.round_id).push(row);}
 const score={humans:0,chimp:0};const rounds=[];
 for(const stored of all.results){
 const r=JSON.parse(stored.config_json),drawCommitment=publicDrawCommitment(r.draw);
 // Do not disclose selected symbols before the scheduled market open.
 if(ts<stored.opens_at){rounds.push({id:r.id,market:r.market,symbol:'',name:'장 시작 때 공개',opensAt:r.opensAt,deadline:r.deadline,closesAt:r.closesAt,revealAt:r.revealAt,status:'upcoming',myVote:null,tally:null,result:null,openingPrice:null,drawCommitment});continue;}
 const openingPrice=publicOpeningPrice(openingByRound.get(r.id)??[],stored,ts);
 const mine=member?.account_id?await db.prepare('SELECT choice FROM votes WHERE round_id=? AND account_id=?').bind(r.id,member.account_id).first():await db.prepare('SELECT choice FROM votes WHERE round_id=? AND voter_hash=? AND account_id IS NULL').bind(r.id,identity.hash).first();
 const participated=await db.prepare('SELECT 1 FROM votes WHERE round_id=? AND (voter_hash=? OR account_id=?)').bind(r.id,identity.hash,member?.account_id??null).first();
 let tally=null,result=null;let status=ts<stored.deadline?'open':'locked';
 if(ts>=stored.reveal_at){const counts=await db.prepare("SELECT COALESCE(SUM(choice='up'),0) AS up,COALESCE(SUM(choice='down'),0) AS down,COUNT(*) AS total FROM votes WHERE round_id=?").bind(r.id).first();tally={up:Number(counts.up),down:Number(counts.down),total:Number(counts.total)};}
 if(ts>=stored.closes_at&&tally){const observed=await db.prepare('SELECT payload_json FROM result_events WHERE round_id=? ORDER BY revision ASC').bind(r.id).all();if(observed.results.length){const auditHistory=observed.results.map(row=>{const event=JSON.parse(row.payload_json);return {...event,...outcome(event,tally)};});result={...auditHistory[auditHistory.length-1],auditHistory};status=result.status==='void'?'void':'settled';if(result.winner)score[result.winner]++;}}
 rounds.push({id:r.id,market:r.market,symbol:r.symbol,name:r.name,opensAt:r.opensAt,deadline:r.deadline,closesAt:r.closesAt,revealAt:r.revealAt,status,myVote:mine?.choice||null,hasVoted:!!participated,tally,result,openingPrice,drawCommitment});
 }
 return json({serverNow:new Date(ts*1000).toISOString(),mode:all.results.length?'live':'prelaunch',proposal:config.rules,score,rounds,storage:'ready',member:member?.account_id?{username:member.username}:null,csrf:member?.csrf??null},200,identity.cookie?{'Set-Cookie':identity.cookie}:{});
 }catch(e){console.error('Poll state failed',e instanceof Error?e.message:'unknown');return json({error:'투표 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.',code:'STORAGE_UNAVAILABLE'},503);}
}
export async function vote(request,db,config){
 try{
 if(request.method!=='POST')throw new PollError('METHOD','지원하지 않는 요청입니다.',405);
 if(request.headers.get('origin')!==new URL(request.url).origin)throw new PollError('ORIGIN','이 페이지에서 다시 투표해 주세요.',403);
 if(request.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json')throw new PollError('CONTENT_TYPE','잘못된 요청 형식입니다.',415);
 if(Number(request.headers.get('content-length')||0)>1024)throw new PollError('SIZE','요청이 너무 큽니다.',413);
 const reader=request.body?.getReader();let raw='',size=0;const decoder=new TextDecoder();if(reader){for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024){await reader.cancel();throw new PollError('SIZE','요청이 너무 큽니다.',413);}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();}
 let body;try{body=JSON.parse(raw);}catch{throw new PollError('JSON','잘못된 요청입니다.');}
 if(!body||Object.keys(body).some(k=>!['roundId','choice'].includes(k))||typeof body.roundId!=='string'||body.roundId.length>80||!['up','down'].includes(body.choice))throw new PollError('CHOICE','상승 또는 하락을 선택해 주세요.');
 const identity=await voter(db,request,false);if(!identity)throw new PollError('SESSION','페이지를 새로고침한 후 다시 투표해 주세요.',401);
 const member=await memberSession(request,db);
 if(member?.account_id){try{memberCSRF(request,member);}catch{throw new PollError('CSRF','페이지를 새로고침한 후 다시 시도하세요.',403);}}
 await syncReleases(db,config.rules,config.rounds,config.results,config.openingPrices);
 if(!config.rules.rulesConfirmed)throw new PollError('NOT_LIVE','첫 라운드를 준비 중입니다.',409);
 // Use one database-derived bucket throughout the transaction, including at minute rollover.
 const bucket=Math.floor((await now(db))/60);
 // D1 batch is transactional; the acceptance statement checks database time at insertion.
 const response=await db.batch([
 db.prepare('INSERT INTO attempts(voter_hash,bucket,count) VALUES (?,?,1) ON CONFLICT(voter_hash,bucket) DO UPDATE SET count=count+1').bind(identity.hash,bucket),
 db.prepare(`INSERT OR IGNORE INTO votes(round_id,voter_hash,choice,accepted_at,account_id)
 SELECT id,?,?,unixepoch(),? FROM rounds WHERE id=? AND opens_at<=unixepoch() AND unixepoch()<deadline
 AND EXISTS(SELECT 1 FROM voters WHERE token_hash=? AND expires_at>unixepoch())
 AND (SELECT count FROM attempts WHERE voter_hash=? AND bucket=?)<=10`).bind(identity.hash,body.choice,member?.account_id??null,body.roundId,identity.hash,identity.hash,bucket),
 db.prepare('SELECT choice FROM votes WHERE round_id=? AND (voter_hash=? OR account_id=?)').bind(body.roundId,identity.hash,member?.account_id??null),
 db.prepare('SELECT count FROM attempts WHERE voter_hash=? AND bucket=?').bind(identity.hash,bucket),
 db.prepare('DELETE FROM attempts WHERE bucket<(unixepoch()/60)-5')
 ]);
 if(response[3].results[0]?.count>10)throw new PollError('RATE_LIMIT','요청이 많아요. 1분 뒤 다시 시도해 주세요.',429);
 const accepted=response[1].meta?.changes>0;
 if(accepted)return json({ok:true,choice:body.choice});
 if(response[2].results.length)throw new PollError('ALREADY_VOTED','이미 투표했어요. 선택은 변경할 수 없습니다.',409);
 const round=await db.prepare('SELECT opens_at,deadline FROM rounds WHERE id=?').bind(body.roundId).first();
 if(!round)throw new PollError('ROUND_NOT_FOUND','라운드를 찾을 수 없습니다.',404);
 const ts=await now(db);if(ts<round.opens_at)throw new PollError('NOT_OPEN','아직 투표가 시작되지 않았습니다.',409);
 throw new PollError('CLOSED','투표가 마감되었습니다.',410);
 }catch(e){if(e instanceof PollError)return json({error:e.message,code:e.code},e.status);console.error('Poll vote failed',e instanceof Error?e.message:'unknown');return json({error:'투표를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.',code:'STORAGE_UNAVAILABLE'},503);}
}

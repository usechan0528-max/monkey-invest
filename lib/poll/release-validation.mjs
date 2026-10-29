import {createHash} from 'node:crypto';
import {epoch,validateRound,validateOpeningPrice} from './service.mjs';
import {drawCommitment} from './draw.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const requireValue=(test,message)=>{if(!test)throw Error(message);};
const positive=value=>typeof value==='string'&&value.length<=120&&/^\d+(\.\d+)?$/.test(value)&&/[1-9]/.test(value);
export function publicSource(value,domains){
 try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&[...u.searchParams.keys()].every(k=>!/(token|api.?key|auth|credential|signature|password|secret)/i.test(k))&&(!domains||domains.some(d=>u.hostname===d||u.hostname.endsWith('.'+d)));}catch{return false;}
}
function immutablePrefix(current,base,name){
 requireValue(Array.isArray(current)&&Array.isArray(base)&&current.length>=base.length,name+' must remain append-only');
 for(let i=0;i<base.length;i++)requireValue(JSON.stringify(current[i])===JSON.stringify(base[i]),name+' changed or removed an existing object at '+i);
}
export function validateDrawAudit(round,audit){
 const e=audit?.evidence,d=round.draw;
 requireValue(e&&JSON.stringify(audit.round)===JSON.stringify(round),'Exact immutable draw audit required for '+round.id);
 requireValue(d.commitmentVersion==='preopen-v1'&&e.roundId===round.id,'Wrong commitment version/session');
 requireValue(Array.isArray(e.universe)&&e.universe.length>0&&e.universe.length<=100000&&Number.isInteger(e.index)&&e.index>=0&&e.index<e.universe.length&&hex(e.nonce),'Invalid universe/index/nonce');
 const symbols=new Set();
 for(const stock of e.universe){requireValue(Object.keys(stock).length===2&&typeof stock.symbol==='string'&&stock.symbol&&typeof stock.name==='string'&&stock.name&&!symbols.has(stock.symbol),'Invalid or duplicate universe entry');symbols.add(stock.symbol);}
 requireValue(e.universe[e.index].symbol===round.symbol&&e.universe[e.index].name===round.name,'Chosen stock differs from committed index');
 requireValue(hex(d.universeHash)&&hash(JSON.stringify(e.universe))===d.universeHash&&e.universeHash===d.universeHash&&d.universeCount===e.universe.length,'Universe hash/count mismatch');
 requireValue(hex(d.commitmentHash)&&drawCommitment({roundId:round.id,universeHash:d.universeHash,index:e.index,nonce:e.nonce,drawnAt:e.drawnAt})===d.commitmentHash&&d.drawnAt===e.drawnAt,'Draw commitment mismatch');
 const draw=Date.parse(e.drawnAt),open=Date.parse(round.opensAt),calendar=Date.parse(e.calendarCheckedAt),universe=Date.parse(e.universeCheckedAt);
 requireValue([e.drawnAt,e.calendarCheckedAt,e.universeCheckedAt].every(t=>Number.isFinite(epoch(t)))&&draw<open&&open-draw<=86400000,'Draw must be committed within 24h before open');
 requireValue([calendar,universe].every(t=>t<=draw&&open-t<=86400000),'Calendar/universe evidence is future-dated or stale for this session');
 requireValue(round.calendarCheckedAt===e.calendarCheckedAt&&round.calendarSource===e.calendarSource&&d.sourceUrl===e.universeSource&&d.universeCheckedAt===e.universeCheckedAt&&d.universePolicy===e.universePolicy,'Provenance mismatch');
 const kospi=round.market==='KOSPI';
 requireValue(publicSource(round.calendarSource,[kospi?'krx.co.kr':'nasdaq.com']),'Official exchange HTTPS calendar required');
 requireValue(publicSource(d.sourceUrl,[kospi?'krx.co.kr':'nasdaqtrader.com']),'Approved universe source required');
 requireValue(d.universePolicy===(kospi?'kind-kospi-company-representatives-v1':'direct-common-equity-v1'),'Universe policy mismatch');
 return true;
}
function validatePriceIdentity(e,r,kind,ts){
 const allowed=new Set(['id','roundId','revision','market','symbol','status','sessionDate','currency','observedAt','asOf','reason','sourceUrl','sourceLabel','sourceVerified','correctsEventId',...(kind==='opening'?['price']:['open','close','regularSessionComplete'])]);
 requireValue(e&&Object.keys(e).every(k=>allowed.has(k)),'Unexpected price fields; do not publish private metadata');
 requireValue(e&&r&&e.market===r.market&&e.symbol===r.symbol&&e.sessionDate===r.id.split(':')[1]&&e.currency===(r.market==='KOSPI'?'KRW':'USD'),'Price instrument/date/currency mismatch');
 requireValue(typeof e.id==='string'&&e.id&&typeof e.reason==='string'&&e.reason.trim()&&typeof e.sourceLabel==='string'&&e.sourceLabel.trim(),'Price provenance fields required');
 const domains=r.market==='KOSPI'?['investing.com']:['chartexchange.com'];
 if(e.status==='void')domains.push(...(r.market==='KOSPI'?['krx.co.kr']:['nasdaq.com','nasdaqtrader.com']));
 requireValue(publicSource(e.sourceUrl,domains),'Fixed approved price provider (or official void evidence) required');
 const boundary=epoch(kind==='opening'?r.opensAt:r.closesAt),observed=epoch(e.observedAt),asOf=epoch(e.asOf??e.observedAt);
 requireValue(Number.isFinite(observed)&&Number.isFinite(asOf)&&observed>=boundary&&asOf>=boundary&&Date.parse(e.observedAt)<=ts*1000&&Date.parse(e.asOf??e.observedAt)<=Date.parse(e.observedAt),'Price is premature, future-dated, or missing its actual retrieval time');
 if(kind==='opening')validateOpeningPrice(e,r,ts);
 else if(e.status!=='void')requireValue(e.status==='verified'&&e.sourceVerified===true&&e.regularSessionComplete===true&&positive(e.open)&&positive(e.close),'Completed same-provider positive decimal open/close required');
}
function validateChain(events,rounds,kind,ts){
 const ids=new Set(),last=new Map();
 for(const e of events){
  validatePriceIdentity(e,rounds.get(e.roundId),kind,ts);
  requireValue(!ids.has(e.id)&&Number.isInteger(e.revision),'Duplicate event or invalid revision');ids.add(e.id);
  const prior=last.get(e.roundId);
  requireValue(prior?e.revision===prior.revision+1&&e.correctsEventId===prior.id:e.revision===1&&!e.correctsEventId,'Broken correction chain');
  last.set(e.roundId,e);
 }
}
export function validateReleaseBundle(current,base,audits,nowMilliseconds=Date.now()){
 const ts=Math.floor(nowMilliseconds/1000),rules=current.RULES;
 requireValue(Number.isFinite(ts)&&rules?.rulesConfirmed===true&&rules.noScorePolicyConfirmed===true&&rules.voteWindow==='regular_session_until_last_hour'&&rules.resultVisibility==='after_close','Operator rules are not configured');
 const names=['ROUND_RELEASES','RESULT_RELEASES','OPEN_PRICE_RELEASES'];
 for(const name of names)immutablePrefix(current[name]??[],base[name]??[],name);
 const rounds=new Map(),oldIds=new Set((base.ROUND_RELEASES??[]).map(r=>r.id));
 for(const r of current.ROUND_RELEASES??[]){
  validateRound(r,rules);requireValue(!rounds.has(r.id),'Duplicate round ID');rounds.set(r.id,r);
  validateDrawAudit(r,audits.get(r.id));
  requireValue(Date.parse(r.draw.drawnAt)<=nowMilliseconds,'Draw cannot be in the future');
  if(!oldIds.has(r.id))requireValue(nowMilliseconds+120000<Date.parse(r.opensAt),'New round needs at least two minutes of deployment lead time before open; do not backfill or reroll');
 }
 validateChain(current.RESULT_RELEASES??[],rounds,'result',ts);
 validateChain(current.OPEN_PRICE_RELEASES??[],rounds,'opening',ts);
 return {rounds:rounds.size,results:(current.RESULT_RELEASES??[]).length,openingPrices:(current.OPEN_PRICE_RELEASES??[]).length};
}

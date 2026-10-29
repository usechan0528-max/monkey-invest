import {randomInt,randomBytes,createHash} from 'node:crypto';
import {epoch,validateRound} from './service.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
export const drawCommitment = ({roundId,universeHash,index,nonce,drawnAt}) => hash(JSON.stringify({roundId,universeHash,index,nonce,drawnAt}));
export function drawRound(input,nowMilliseconds=Date.now()){
 if(!['KOSPI','NASDAQ'].includes(input.market)||input.calendarVerified!==true||!Array.isArray(input.universe)||input.universe.length===0)throw Error('Verified calendar and predetermined universe required');
 const seen=new Set();for(const entry of input.universe){if(typeof entry.symbol!=='string'||!entry.symbol||typeof entry.name!=='string'||!entry.name||seen.has(entry.symbol))throw Error('Invalid or duplicated universe symbol');seen.add(entry.symbol);}
 const url=new URL(input.calendarSource),domain=input.market==='KOSPI'?'krx.co.kr':'nasdaq.com';if(url.protocol!=='https:'||!(url.hostname===domain||url.hostname.endsWith('.'+domain)))throw Error('Official exchange calendar HTTPS source required');
 if(!Number.isFinite(epoch(input.calendarCheckedAt))||!Number.isFinite(epoch(input.closesAt))||!Number.isFinite(epoch(input.opensAt)))throw Error('Explicit-offset calendar timestamps required');
 const timezone=input.market==='KOSPI'?'Asia/Seoul':'America/New_York';const date=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(input.opensAt));
 if(input.sessionDate!==date)throw Error('Exchange-local session date mismatch');
 const checked=Date.parse(input.calendarCheckedAt),universeChecked=Date.parse(input.universeCheckedAt),drawnAt=new Date(nowMilliseconds).toISOString();
 if(!Number.isFinite(nowMilliseconds)||nowMilliseconds>=Date.parse(input.opensAt))throw Error('A committed draw must be prepared before the session opens');
 if(input.universeVerified!==true||typeof input.universePolicy!=='string'||!input.universePolicy.trim()||!Number.isFinite(epoch(input.universeCheckedAt)))throw Error('Reviewed universe provenance required');
 if([checked,universeChecked].some(t=>t>nowMilliseconds||nowMilliseconds-t>86400000))throw Error('Calendar and universe checks must be real, nonfuture and within the last 24 hours');
 const index=randomInt(input.universe.length),nonce=randomBytes(32).toString('hex'),universeHash=hash(JSON.stringify(input.universe)),id=input.market+':'+date;
 const round={id,market:input.market,...input.universe[index],opensAt:input.opensAt,deadline:new Date((epoch(input.closesAt)-3600)*1000).toISOString(),closesAt:input.closesAt,revealAt:input.closesAt,calendarVerified:true,calendarSource:input.calendarSource,calendarCheckedAt:input.calendarCheckedAt,draw:{validated:true,commitmentVersion:'preopen-v1',universeHash,commitmentHash:drawCommitment({roundId:id,universeHash,index,nonce,drawnAt}),sourceUrl:input.universeSource,drawnAt,universeCount:input.universe.length,universePolicy:input.universePolicy,universeCheckedAt:input.universeCheckedAt}};
 validateRound(round,{rulesConfirmed:true,noScorePolicyConfirmed:true,voteWindow:'regular_session_until_last_hour',resultVisibility:'after_close'});
 return {round,evidence:{roundId:id,universe:input.universe,index,nonce,universeHash,drawnAt,universeSource:input.universeSource,universePolicy:input.universePolicy,universeCheckedAt:input.universeCheckedAt,calendarSource:input.calendarSource,calendarCheckedAt:input.calendarCheckedAt}};
}

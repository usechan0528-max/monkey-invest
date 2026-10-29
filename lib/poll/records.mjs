import {memberSession,accountJSON} from './member.mjs';
import {outcome} from './service.mjs';
import {MINIMUM_ROUNDS,RELEASE_DIRECTION_SQL,readLeaderboard} from './leaderboard.mjs';

// Retained pure helper for callers/tests. Integer win/total comparisons preserve
// equivalent fractions; older accuracy-only callers retain their old behavior.
export function rank(me,all){
 const pool=all.filter(p=>p.total>=MINIMUM_ROUNDS);
 if(me.total<MINIMUM_ROUNDS)return {ready:false,sample:pool.length,value:null};
 const compare=p=>Number.isSafeInteger(p.wins)&&Number.isSafeInteger(me.wins)?
 (BigInt(p.wins)*BigInt(me.total)<BigInt(me.wins)*BigInt(p.total)?-1:BigInt(p.wins)*BigInt(me.total)>BigInt(me.wins)*BigInt(p.total)?1:0):
 (p.accuracy<me.accuracy?-1:p.accuracy>me.accuracy?1:0);
 const less=pool.filter(p=>compare(p)<0).length,same=pool.filter(p=>compare(p)===0).length;
 return {ready:true,sample:pool.length,value:100*(less+same/2)/pool.length};
}
export function personalVerdict(event,choice){
 if(!event)return {verdict:'pending',actualDirection:null};
 if(event.status==='void')return {verdict:'void',actualDirection:null};
 const actualDirection=outcome(event,{up:0,down:0,total:0}).actualDirection;
 return {verdict:actualDirection?(actualDirection===choice?'win':'loss'):'flat',actualDirection};
}
export async function records(request,db){try{
 const session=await memberSession(request,db);
 if(!session?.account_id)return accountJSON({error:'로그인이 필요합니다.'},401);
 const {me}=await readLeaderboard(db,{accountId:session.account_id,includeEntries:false});
 if(!me)return accountJSON({error:'로그인이 필요합니다.'},401);
 // This is the only vote-level transfer, restricted to the authenticated owner.
 const rows=(await db.prepare(`WITH ${RELEASE_DIRECTION_SQL}
 SELECT v.round_id,v.choice,r.config_json,d.status,d.direction FROM votes v
 JOIN rounds r ON r.id=v.round_id LEFT JOIN release_directions d ON d.round_id=v.round_id
 WHERE v.account_id=? ORDER BY r.opens_at DESC,v.round_id DESC`).bind(session.account_id).all()).results;
 const history=rows.map(row=>{
 const r=JSON.parse(row.config_json),verdict=!row.status?'pending':row.status==='void'?'void':row.direction?(row.direction===row.choice?'win':'loss'):'flat';
 return {roundId:row.round_id,market:r.market,name:r.name,symbol:r.symbol,choice:row.choice,actualDirection:row.direction??null,verdict};
 });
 return accountJSON({wins:me.wins,losses:me.losses,total:me.total,accuracy:me.accuracy,percentile:me.percentile,history});
 }catch{return accountJSON({error:'전적을 불러오지 못했습니다. 잠시 후 다시 시도하세요.'},503);}}

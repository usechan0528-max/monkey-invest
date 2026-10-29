import {accountJSON,memberSession} from './member.mjs';
import {digest} from './password.mjs';
import {syncReleases} from './service.mjs';

export const MINIMUM_ROUNDS=10;
const DEFAULT_PAGE_SIZE=20,MAX_PAGE_SIZE=50;

// Only released, database-clock-visible latest revisions may affect a score.
// Prices stay decimal strings: normalization and binary lexical comparison avoid
// rounding close values (including prices beyond IEEE-754 precision) to a tie.
// JSON guards also make an invalid stored event fail closed rather than leak data.
export const RELEASE_DIRECTION_SQL=`
released_events AS MATERIALIZED (
 SELECT e.round_id,CASE WHEN json_valid(e.payload_json) THEN e.payload_json ELSE '{}' END AS payload
 FROM result_events e JOIN rounds r ON r.id=e.round_id
 WHERE r.closes_at<=unixepoch() AND r.reveal_at<=unixepoch() AND e.recorded_at<=unixepoch()
 AND e.revision=(SELECT MAX(x.revision) FROM result_events x WHERE x.round_id=e.round_id AND x.recorded_at<=unixepoch())
),
result_fields AS (
 SELECT round_id,json_extract(payload,'$.status') AS status,
 json_extract(payload,'$.open') AS open_price,json_extract(payload,'$.close') AS close_price,
 json_type(payload,'$.open') AS open_type,json_type(payload,'$.close') AS close_type,
 CASE WHEN (json_type(payload,'$.sourceVerified') IS NULL OR json_type(payload,'$.sourceVerified')='true')
 AND (json_type(payload,'$.regularSessionComplete') IS NULL OR json_type(payload,'$.regularSessionComplete')='true') THEN 1 ELSE 0 END AS verified_flags,
 CASE WHEN (json_type(payload,'$.observedAt') IS NULL OR (json_type(payload,'$.observedAt')='text' AND julianday(json_extract(payload,'$.observedAt'))<=julianday(unixepoch(),'unixepoch')))
 AND (json_type(payload,'$.asOf') IS NULL OR (json_type(payload,'$.asOf')='text' AND julianday(json_extract(payload,'$.asOf'))<=julianday(unixepoch(),'unixepoch'))) THEN 1 ELSE 0 END AS visible
 FROM released_events
),
valid_prices AS (
 SELECT * FROM result_fields WHERE visible=1 AND verified_flags=1 AND status='verified'
 AND open_type='text' AND close_type='text'
 AND length(open_price) BETWEEN 1 AND 120 AND length(close_price) BETWEEN 1 AND 120
 AND open_price NOT GLOB '*[^0-9.]*' AND close_price NOT GLOB '*[^0-9.]*'
 AND open_price NOT LIKE '.%' AND open_price NOT LIKE '%.' AND close_price NOT LIKE '.%' AND close_price NOT LIKE '%.'
 AND length(open_price)-length(replace(open_price,'.',''))<=1 AND length(close_price)-length(replace(close_price,'.',''))<=1
),
price_parts AS (
 SELECT round_id,
 ltrim(CASE WHEN instr(open_price,'.')=0 THEN open_price ELSE substr(open_price,1,instr(open_price,'.')-1) END,'0') AS oi,
 ltrim(CASE WHEN instr(close_price,'.')=0 THEN close_price ELSE substr(close_price,1,instr(close_price,'.')-1) END,'0') AS ci,
 rtrim(CASE WHEN instr(open_price,'.')=0 THEN '' ELSE substr(open_price,instr(open_price,'.')+1) END,'0') AS ofr,
 rtrim(CASE WHEN instr(close_price,'.')=0 THEN '' ELSE substr(close_price,instr(close_price,'.')+1) END,'0') AS cfr
 FROM valid_prices
),
release_directions AS MATERIALIZED (
 SELECT round_id,'verified' AS status,
 CASE WHEN length(oi)<length(ci) OR (length(oi)=length(ci) AND oi<ci COLLATE BINARY) OR (oi=ci AND ofr<cfr COLLATE BINARY) THEN 'up'
 WHEN length(oi)>length(ci) OR (length(oi)=length(ci) AND oi>ci COLLATE BINARY) OR (oi=ci AND ofr>cfr COLLATE BINARY) THEN 'down' ELSE NULL END AS direction
 FROM price_parts WHERE (oi<>'' OR ofr<>'') AND (ci<>'' OR cfr<>'')
 UNION ALL SELECT round_id,'void',NULL FROM result_fields WHERE visible=1 AND status='void'
)`;

// A continued-fraction sort key gives exact rational ordering and exact ties
// (6/10 = 9/15), without floating point or cross-products that can overflow.
// Euclidean division terminates in O(log total). Alternating complemented,
// fixed-width quotients and an alternating terminal byte preserve numeric order.
export const RATE_KEY_SQL=`
rate_steps(wins,total,numerator,denominator,step,sort_key) AS (
 SELECT DISTINCT wins,total,wins,total,0,'' FROM account_scores WHERE total>=${MINIMUM_ROUNDS}
 UNION ALL
 SELECT wins,total,denominator,numerator%denominator,step+1,
 sort_key||printf('%019d',CASE WHEN step%2=0 THEN numerator/denominator ELSE 9223372036854775807-numerator/denominator END)
 FROM rate_steps WHERE denominator>0
),
rate_keys AS MATERIALIZED (
 SELECT wins,total,sort_key||CASE WHEN step%2=1 THEN '!' ELSE '~' END AS sort_key
 FROM rate_steps WHERE denominator=0
)`;

export const SCORE_SQL=`
${RELEASE_DIRECTION_SQL},
vote_totals AS MATERIALIZED (
 SELECT v.account_id,COUNT(*) AS total,SUM(CASE WHEN v.choice=d.direction THEN 1 ELSE 0 END) AS wins
 FROM votes v JOIN release_directions d ON d.round_id=v.round_id
 WHERE v.account_id IS NOT NULL AND d.direction IS NOT NULL AND v.choice IN ('up','down')
 GROUP BY v.account_id
),
account_scores AS MATERIALIZED (
 SELECT a.id AS account_id,COALESCE(v.total,0) AS total,COALESCE(v.wins,0) AS wins
 FROM accounts a LEFT JOIN vote_totals v ON v.account_id=a.id
),
${RATE_KEY_SQL},
ranked_scores AS MATERIALIZED (
 SELECT s.account_id,RANK() OVER (ORDER BY k.sort_key DESC) AS rank,
 COUNT(*) OVER (PARTITION BY k.sort_key) AS tied
 FROM account_scores s JOIN rate_keys k ON k.wins=s.wins AND k.total=s.total
),
scored_accounts AS MATERIALIZED (
 SELECT s.*,r.rank,r.tied,ROW_NUMBER() OVER (
 PARTITION BY s.total>=${MINIMUM_ROUNDS} ORDER BY r.rank ASC,CASE WHEN s.total<${MINIMUM_ROUNDS} THEN s.total ELSE 0 END DESC,s.account_id COLLATE BINARY ASC
 ) AS position FROM account_scores s LEFT JOIN ranked_scores r ON r.account_id=s.account_id
),
score_counts AS (
 SELECT COUNT(*) AS accounts,COUNT(CASE WHEN total>=${MINIMUM_ROUNDS} THEN 1 END) AS ranked,
 COUNT(CASE WHEN total<${MINIMUM_ROUNDS} THEN 1 END) AS provisional FROM account_scores
)`;

const scoreJSON=`json_object('accountId',account_id,'wins',wins,'total',total,'rank',rank,'tied',tied,'position',position)`;

export function leaderboardQuery(request){
 if(request.url.length>2048)throw new Error('Invalid leaderboard query');
 const params=new URL(request.url).searchParams;
 if([...params.keys()].some(k=>!['group','page','pageSize'].includes(k))||[...new Set(params.keys())].some(k=>params.getAll(k).length!==1))throw new Error('Invalid leaderboard query');
 const group=params.get('group')??'ranked',pageText=params.get('page')??'1',sizeText=params.get('pageSize')??String(DEFAULT_PAGE_SIZE);
 if(!['ranked','provisional'].includes(group)||!/^[1-9]\d{0,9}$/.test(pageText)||!/^[1-9]\d?$/.test(sizeText))throw new Error('Invalid leaderboard query');
 const page=Number(pageText),pageSize=Number(sizeText);
 if(!Number.isSafeInteger(page)||page<1||page>2147483647||pageSize<1||pageSize>MAX_PAGE_SIZE)throw new Error('Invalid leaderboard query');
 return {group,page,pageSize};
}

export function publicStanding(row,accountId,sample){
 if(!row)return null;
 const eligible=row.total>=MINIMUM_ROUNDS,publicId=digest('monkey-market:public-member:v1:'+row.accountId).slice(0,24);
 return {publicId,displayName:'참가자 '+publicId.slice(0,10).toUpperCase(),wins:row.wins,losses:row.total-row.wins,total:row.total,
 accuracy:row.total?row.wins/row.total:null,eligible,rank:eligible?row.rank:null,
 percentile:{ready:eligible,sample,value:eligible?100*(sample-row.rank+1-row.tied/2)/sample:null},isMe:row.accountId===accountId};
}

// One snapshot query, regardless of account/vote count. Only the bounded page
// and the session owner's score leave D1, never all accounts or private votes.
// Own-only /api/me reuses the same query with includeEntries=false.
export async function readLeaderboard(db,{accountId=null,group='ranked',page=1,pageSize=DEFAULT_PAGE_SIZE,includeEntries=true}={}){
 const row=await db.prepare(`WITH RECURSIVE ${SCORE_SQL},
 options AS (SELECT ? AS own_id,? AS selected_group,CAST(? AS INTEGER) AS requested_page,CAST(? AS INTEGER) AS page_size,? AS include_entries),
 pagination AS (
 SELECT c.*,o.*,CASE WHEN selected_group='ranked' THEN ranked ELSE provisional END AS filtered_total,
 MAX(1,(CASE WHEN selected_group='ranked' THEN ranked ELSE provisional END+page_size-1)/page_size) AS total_pages
 FROM score_counts c CROSS JOIN options o
 ),
 page_metadata AS (SELECT *,MIN(requested_page,total_pages) AS current_page FROM pagination)
 SELECT accounts,ranked,provisional,filtered_total,total_pages,current_page,strftime('%Y-%m-%dT%H:%M:%SZ','now') AS generated_at,
 (SELECT json_group_array(json(${scoreJSON})) FROM (
 SELECT * FROM scored_accounts WHERE (SELECT include_entries FROM options)=1
 AND CASE WHEN (SELECT selected_group FROM options)='ranked' THEN total>=${MINIMUM_ROUNDS} ELSE total<${MINIMUM_ROUNDS} END
 ORDER BY rank ASC,CASE WHEN total<${MINIMUM_ROUNDS} THEN total ELSE 0 END DESC,account_id COLLATE BINARY ASC
 LIMIT (SELECT page_size FROM options) OFFSET (SELECT (current_page-1)*page_size FROM page_metadata)
 )) AS entries_json,
 (SELECT ${scoreJSON} FROM scored_accounts WHERE account_id=(SELECT own_id FROM options)) AS me_json
 FROM page_metadata`).bind(accountId,group,page,pageSize,includeEntries?1:0).first();
 const counts={accounts:row.accounts,ranked:row.ranked,provisional:row.provisional},own=row.me_json?JSON.parse(row.me_json):null;
 return {minimumRounds:MINIMUM_ROUNDS,generatedAt:row.generated_at,group,page:row.current_page,pageSize,totalPages:row.total_pages,total:row.filtered_total,counts,
 entries:JSON.parse(row.entries_json).map(entry=>publicStanding(entry,accountId,counts.ranked)),
 me:own?{...publicStanding(own,accountId,counts.ranked),page:Math.floor((own.position-1)/pageSize)+1}:null};
}

export async function leaderboard(request,db,config){
 if(request.method!=='GET')return accountJSON({error:'지원하지 않는 요청입니다.'},405);
 let options;
 try{options=leaderboardQuery(request);}catch{return accountJSON({error:'순위 조회 조건을 확인해 주세요.'},400);}
 try{
 if(config)await syncReleases(db,config.rules,config.rounds,config.results,config.openingPrices);
 const session=await memberSession(request,db);
 return accountJSON(await readLeaderboard(db,{...options,accountId:session?.account_id??null}));
 }catch{return accountJSON({error:'순위를 불러오지 못했습니다. 잠시 후 다시 시도하세요.'},503);}
}

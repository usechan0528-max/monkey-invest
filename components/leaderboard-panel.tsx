"use client";

import {useEffect,useState,type FormEvent} from 'react';
import {ArrowLeft,ArrowRight,RefreshCw,Trophy,Users} from 'lucide-react';

type Group='ranked'|'provisional';
type Entry={publicId:string;displayName:string;wins:number;losses:number;total:number;accuracy:number|null;eligible:boolean;rank:number|null;percentile:{ready:boolean;sample:number;value:number|null};isMe:boolean;page?:number};
type Board={minimumRounds:number;group:Group;page:number;pageSize:number;totalPages:number;total:number;counts:{accounts:number;ranked:number;provisional:number};entries:Entry[];me:Entry|null;generatedAt?:string};
const rate=(value:number|null)=>value===null?'—':`${(value*100).toFixed(1)}%`;
const position=(entry:Entry)=>entry.eligible?`${entry.rank}위`:'순위 준비 중';

export default function LeaderboardPanel(){
 const [group,setGroup]=useState<Group>('ranked'),[page,setPage]=useState(1),[board,setBoard]=useState<Board|null>(null),[busy,setBusy]=useState(true),[error,setError]=useState(''),[refresh,setRefresh]=useState(0),[jump,setJump]=useState('1');
 useEffect(()=>{
  const controller=new AbortController();let active=true;
  async function load(){
   setBusy(true);setError('');
   try{
    const response=await fetch(`/api/leaderboard?group=${group}&page=${page}&pageSize=20`,{cache:'no-store',credentials:'same-origin',signal:controller.signal});
    const value=await response.json() as Board & {error?:string};
    if(!response.ok)throw new Error(value.error??'순위를 불러오지 못했습니다.');
    if(active){setBoard(value);setJump(String(value.page));}
   }catch(e){if(active)setError(e instanceof Error?e.message:'순위를 불러오지 못했습니다.');}
   finally{if(active)setBusy(false);}
  }
  void load();return()=>{active=false;controller.abort();};
 },[group,page,refresh]);
 function selectGroup(next:Group){setGroup(next);setPage(1);setJump('1');}
 function goToPage(next:number){setPage(next);setJump(String(next));}
 function findMe(){if(!board?.me)return;setGroup(board.me.eligible?'ranked':'provisional');goToPage(board.me.page??1);}
 function jumpPage(event:FormEvent){event.preventDefault();if(!board||!/^\d+$/.test(jump))return;const next=Number(jump);if(Number.isSafeInteger(next)&&next>=1&&next<=board.totalPages)goToPage(next);}
 const current=board?.group===group?board:null;
 return <section id="leaderboard" className="leaderboard-section page-width" aria-labelledby="leaderboard-title">
  <div className="section-heading"><div><span className="section-kicker">EVERY PREDICTION COUNTS</span><h2 id="leaderboard-title">전체 사용자 순위</h2></div><button className="leaderboard-refresh" type="button" disabled={busy} onClick={()=>setRefresh(v=>v+1)}><RefreshCw size={15}/><span>순위 새로고침</span></button></div>
  <p className="leaderboard-intro">인간 팀의 승부와는 별개로, 나의 예측 실력을 비교해 보세요.<br/>검증된 상승·하락 예측 10회부터 정식 순위에 올라요.</p>
  {error&&board&&<p className="member-error" role="status">아래 내 순위와 회원 수는 마지막으로 불러온 정보입니다.</p>}
  <div className="leaderboard-own">
   {board?.me?<><div><span className="leaderboard-eyebrow">MY PLACE</span><h3>내 순위 <strong>{position(board.me)}</strong></h3><p>{board.me.displayName} · {board.me.wins}승 {board.me.losses}패 · 유효 {board.me.total}회 · 적중률 {rate(board.me.accuracy)}</p>{board.me.eligible?<p>백분위 {board.me.percentile.value?.toFixed(1)} · 자격 충족 {board.me.percentile.sample}명 중 비교</p>:<p>정식 순위까지 유효 참여 {Math.max(0,(board?.minimumRounds??10)-board.me.total)}회가 더 필요해요.</p>}</div><button type="button" className="member-button" disabled={busy||!!error} onClick={findMe}>내 위치 보기 <ArrowRight size={14}/></button></>:<><div><span className="leaderboard-eyebrow">YOUR NEXT CHALLENGE</span><h3>나의 순위도 남겨 보세요.</h3><p>비회원도 투표할 수 있어요. 회원으로 남긴 예측만 개인 전적과 순위에 반영됩니다.</p></div><a className="member-button" href="#records">내 전적 / 로그인 <ArrowRight size={14}/></a></>}
  </div>
  <div className="leaderboard-toolbar"><div className="leaderboard-tabs" role="group" aria-label="순위 참가자 구분"><button type="button" aria-pressed={group==='ranked'} className={group==='ranked'?'active':''} onClick={()=>selectGroup('ranked')}><Trophy size={16}/>정식 순위 <span>{board?board.counts.ranked.toLocaleString():'—'}</span></button><button type="button" aria-pressed={group==='provisional'} className={group==='provisional'?'active':''} onClick={()=>selectGroup('provisional')}><Users size={16}/>순위 준비 중 <span>{board?board.counts.provisional.toLocaleString():'—'}</span></button></div><p>{board?`전체 회원 ${board.counts.accounts.toLocaleString()}명`:'회원 수 확인 중'}</p></div>
  <p id="leaderboard-group-note" className="leaderboard-group-note">{group==='ranked'?'적중률 높은 순 · 같은 적중률은 공동 순위 · 20명씩 표시':'유효 참여 10회 미만 회원 · 참여 횟수 순으로 표시하며 아직 순위를 부여하지 않아요.'}</p>
  <div className="leaderboard-results" aria-busy={busy} aria-describedby="leaderboard-group-note">
   {error?<div className="leaderboard-empty" role="alert"><h3>순위를 불러오지 못했어요.</h3><p>{error}</p><button type="button" className="member-button" onClick={()=>setRefresh(v=>v+1)}>다시 시도</button></div>:busy?<div className="leaderboard-empty" role="status"><p>최신 전적을 확인하고 있어요…</p></div>:current?.entries.length?<>
    <div className="leaderboard-table-wrap"><table className="leaderboard-table"><caption className="sr-only">{group==='ranked'?'전체 회원 정식 순위':'순위 준비 중인 회원의 전적'}</caption><thead><tr><th scope="col">{group==='ranked'?'순위':'상태'}</th><th scope="col">참가자</th><th scope="col">승 / 패</th><th scope="col">유효 참여</th><th scope="col">적중률</th></tr></thead><tbody>{current.entries.map(entry=><tr key={entry.publicId} className={entry.isMe?'is-me':''}><td className="leaderboard-rank">{entry.eligible?<><strong>{entry.rank}</strong><span>위</span></>:<span className="provisional-badge">준비 중</span>}</td><th scope="row"><span className="leaderboard-name">{entry.displayName}</span>{entry.isMe&&<span className="leaderboard-me-label">나</span>}</th><td><strong>{entry.wins}</strong><span className="muted"> / {entry.losses}</span></td><td>{entry.total}<span className="muted">회</span></td><td className="leaderboard-rate">{rate(entry.accuracy)}</td></tr>)}</tbody></table></div>
   </>:<div className="leaderboard-empty"><span className="leaderboard-empty-icon" aria-hidden="true"><Trophy size={27}/></span><h3>{group==='ranked'?'아직 순위에 오른 참가자가 없어요.':'아직 순위를 준비 중인 회원이 없어요.'}</h3><p>{group==='ranked'?'첫 대결부터 차곡차곡. 유효 예측 10회를 채우면 이곳에 순위가 표시돼요.':'회원으로 참여하면 예측 기록이 이곳에 쌓입니다.'}</p>{group==='ranked'&&!!board?.counts.provisional&&<button type="button" className="member-button" onClick={()=>selectGroup('provisional')}>순위 준비 중인 회원 보기</button>}</div>}
  </div>
  {!busy&&!error&&current&&current.total>0&&<div className="leaderboard-pagination"><p aria-live="polite">{((current.page-1)*current.pageSize+1).toLocaleString()}–{Math.min(current.page*current.pageSize,current.total).toLocaleString()} / {current.total.toLocaleString()}명</p><nav aria-label="순위 페이지"><button type="button" disabled={current.page<=1} aria-label="이전 순위 페이지" onClick={()=>goToPage(current.page-1)}><ArrowLeft size={16}/></button><span>{current.page} / {current.totalPages} 페이지</span><button type="button" disabled={current.page>=current.totalPages} aria-label="다음 순위 페이지" onClick={()=>goToPage(current.page+1)}><ArrowRight size={16}/></button></nav>{current.totalPages>1&&<form onSubmit={jumpPage}><label className="sr-only" htmlFor="leaderboard-page">이동할 페이지</label><input id="leaderboard-page" type="number" inputMode="numeric" min={1} max={current.totalPages} value={jump} onChange={e=>setJump(e.target.value)} required/><button type="submit">이동</button></form>}</div>}
  <details className="leaderboard-rules"><summary>동점·백분위·공개 정보는 어떻게 정하나요?</summary><div><p>정식 순위는 적중률로 정합니다. 같은 적중률은 공동 순위이며 다음 순위는 동점 인원만큼 건너뜁니다. 예: 공동 1위 2명 다음은 3위. 소수점으로 반올림한 화면 숫자가 같아도 실제 비율이 다르면 순위가 다를 수 있어요. 동점자의 표시 순서는 익명 식별자로 고정하며 승패나 순위에 영향을 주지 않습니다.</p><p>백분위는 (나보다 낮은 적중률 인원 + 동점 인원 ÷ 2) ÷ 자격을 충족한 전체 인원 × 100입니다. 높을수록 더 높은 상대적 성적이며, 본인을 포함한 동점자는 같은 값을 갖습니다.</p><p>보합·무효·가격 미확정은 유효 참여에서 제외합니다. 개인 전적은 각자의 선택과 실제 가격 방향을 비교하므로 인간 팀의 다수결 승패와 다를 수 있습니다. 가격 정정이 공개되면 최신 검증 결과로 다시 계산합니다.</p><p>로그인 아이디와 관계없는 익명 참가자 이름으로 합산 전적만 공개합니다. 로그인 아이디·비밀번호·회차별 선택 내역을 직접 공개하지 않습니다. 전적 변화로 일부 선택을 추측할 수는 있습니다. 계정을 삭제하면 순위에서도 빠집니다. 비회원 표는 팀 집계에는 반영되지만 개인 순위에는 연결하지 않습니다.</p></div></details>
 </section>;
}

"use client";
import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import PrivacyNotice from '@/components/privacy-notice';
import {personalVerdictLabel} from '@/lib/poll/presentation.mjs';
type User={username:string}|null;
type Records={wins:number;losses:number;total:number;accuracy:number|null;percentile:{ready:boolean;sample:number;value:number|null};history:{roundId:string;market:string;name:string;symbol:string;choice:string;verdict:string}[]};
export default function MemberPanel({onChange}:{onChange:()=>Promise<void>}){
 const [user,setUser]=useState<User>(null),[csrf,setCSRF]=useState(''),[records,setRecords]=useState<Records|null>(null),[error,setError]=useState(''),[authError,setAuthError]=useState(''),[deleteError,setDeleteError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[ready,setReady]=useState(false),[confirmed,setConfirmed]=useState(false);
 const dialog=useRef<HTMLDialogElement>(null),deleteDialog=useRef<HTMLDialogElement>(null),deleteForm=useRef<HTMLFormElement>(null),pending=useRef(false),currentUser=useRef<User>(null);
 const loadAccount=useCallback(async()=>{
  const r=await fetch('/api/account',{cache:'no-store'});const d=await r.json() as {user:User;csrf:string;error?:string};if(!r.ok)throw Error(d.error);
  currentUser.current=d.user;setUser(d.user);setCSRF(d.csrf);setReady(true);return d.user;
 },[]);
 const loadRecords=useCallback(async()=>{
  const expectedUser=currentUser.current;if(!expectedUser)return;
  const r=await fetch('/api/me',{cache:'no-store'});const d=await r.json() as Records & {error?:string};
  if(currentUser.current!==expectedUser)return;
  if(!r.ok)throw Error(d.error);setRecords(d);
 },[]);
 useEffect(()=>{void Promise.resolve().then(loadAccount).catch(()=>setError('회원 정보를 불러오지 못했습니다. 새로고침해 주세요.'));},[loadAccount]);
 useEffect(()=>{if(user)void loadRecords().catch(e=>setError(e.message));},[user,loadRecords]);
 const start=()=>{if(pending.current)return false;pending.current=true;setBusy(true);return true;};
 const finish=()=>{pending.current=false;setBusy(false);};
 function clearMember(){currentUser.current=null;setUser(null);setRecords(null);setCSRF('');setReady(false);}
 async function authenticate(e:FormEvent<HTMLFormElement>){
  e.preventDefault();if(!start())return;const form=e.currentTarget;const submitter=(e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement|null;const fields=Object.fromEntries(new FormData(form));setAuthError('');setError('');setNotice('');
  try{const r=await fetch('/api/account',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({...fields,action:submitter?.value??'login'})});const d=await r.json() as {error?:string};if(!r.ok)throw Error(d.error);form.reset();dialog.current?.close();clearMember();try{await Promise.all([onChange(),loadAccount()]);}catch{setError('로그인은 완료됐지만 회원 정보를 불러오지 못했습니다. 새로고침해 주세요.');}}
  catch(e){setAuthError(e instanceof Error?e.message:'처리하지 못했습니다.');}finally{finish();}
 }
 async function logout(){
  if(!start())return;setError('');setNotice('');
  try{const r=await fetch('/api/account',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({action:'logout'})});if(!r.ok)throw Error('로그아웃하지 못했습니다. 새로고침해 주세요.');clearMember();await Promise.all([onChange(),loadAccount()]);}
  catch(e){setError(e instanceof Error?e.message:'처리하지 못했습니다.');}finally{finish();}
 }
 function resetDelete(){deleteForm.current?.reset();setConfirmed(false);setDeleteError('');}
 async function removeAccount(e:FormEvent<HTMLFormElement>){
  e.preventDefault();if(!confirmed||!start())return;const password=new FormData(e.currentTarget).get('password');setDeleteError('');setError('');setNotice('');
  try{
   const r=await fetch('/api/account',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({action:'delete',password,confirm:true})});const d=await r.json() as {error?:string;deleted?:boolean};
   if(!r.ok||!d.deleted)throw Error(d.error??'삭제 완료를 확인하지 못했습니다. 다시 로그인 상태를 확인해 주세요.');
   clearMember();deleteDialog.current?.close();setNotice('계정과 개인 전적을 삭제했어요. 익명 처리한 표는 대결 집계에 남습니다.');
   try{await Promise.all([onChange(),loadAccount()]);}catch{setError('계정 삭제는 완료됐습니다. 최신 화면을 보려면 새로고침해 주세요.');}
  }catch(e){setDeleteError(e instanceof Error?e.message:'삭제 완료를 확인하지 못했습니다. 연결을 확인해 주세요.');}
  finally{finish();}
 }
 return <section id="records" className="member-section page-width" aria-labelledby="member-title">
  <div className="section-heading"><div><span className="section-kicker">MY PREDICTIONS</span><h2 id="member-title">내 선택, 내 전적</h2></div>
   {user?<div className="member-actions"><button className="member-button" disabled={busy} onClick={()=>void logout()}>{user.username} · 로그아웃</button><button className="member-button member-delete-link" disabled={busy} onClick={()=>{resetDelete();deleteDialog.current?.showModal();}}>계정 삭제</button></div>:<button className="member-button" disabled={!ready||busy} onClick={()=>{setAuthError('');dialog.current?.showModal();}}>로그인 / 회원가입</button>}
  </div>
  {!user?<p>로그인 없이도 투표할 수 있어요. 아이디와 비밀번호로 가입하면 나의 선택과 전적을 남길 수 있습니다. 가입 전 익명 투표는 전적에 소급 연결하지 않습니다.</p>:records?<>
   <div className="member-stats"><div>누적 전적<strong>{records.wins}승 {records.losses}패</strong></div><div>적중률<strong>{records.accuracy===null?'—':(records.accuracy*100).toFixed(1)+'%'}</strong></div><div>유효 참여<strong>{records.total}회</strong></div></div>
   <p>{records.percentile.ready?`백분위 ${records.percentile.value?.toFixed(1)} · 10회 이상 참여자 ${records.percentile.sample}명 기준`:`순위 준비 중 · 유효 참여 ${records.total}/10회`}</p><p className="member-note">내 선택과 실제 가격 방향을 비교한 전적입니다. 인간 팀의 다수결 승패와 다를 수 있어요. <a href="#leaderboard">전체 순위에서 내 위치 보기 ↗</a></p>
   <button className="member-button" disabled={busy} onClick={()=>void loadRecords().catch(e=>setError(e.message))}>전적 새로고침</button>
   {records.history.length?<ul className="member-history">{records.history.map(v=><li key={v.roundId}><span>{v.roundId} · {v.name||v.symbol}</span><strong>{v.choice==='up'?'상승':'하락'} · {personalVerdictLabel(v.verdict)}</strong></li>)}</ul>:<p>아직 회원으로 참여한 기록이 없습니다.</p>}
  </>:<p>전적을 불러오는 중입니다.</p>}
  <p className="member-notice" role="status">{notice}</p><p className="member-error" role="status">{error}</p>
  <details className="member-policy"><summary>순위 기준과 비밀번호 복구 안내</summary><p>가격 방향이 검증된 상승·하락 참여 10회부터 순위를 표시합니다. 적중률로 비교하며 백분위는 (나보다 낮은 적중률 인원 + 동점 인원 ÷ 2) ÷ 자격을 충족한 참여자 수 × 100입니다. 본인을 포함한 동점자는 같은 백분위입니다. 보합·무효·가격 미확정은 유효 참여에서 제외합니다. 전체 순위에는 익명 참가자 이름과 합산 전적만 공개하며 로그인 아이디와 회차별 선택 내역을 직접 공개하지 않습니다.</p><p>이메일을 받지 않으므로 비밀번호를 잊으면 계정 복구를 제공할 수 없습니다. 비밀번호를 안전하게 보관하고 다른 서비스의 비밀번호를 재사용하지 마세요.</p></details>
  <dialog ref={dialog} className="member-dialog" aria-labelledby="auth-title" onCancel={e=>{if(busy)e.preventDefault();}} onClose={()=>dialog.current?.querySelector('form')?.reset()}>
   <button type="button" className="member-close" aria-label="로그인 창 닫기" disabled={busy} onClick={()=>dialog.current?.close()}>×</button><h2 id="auth-title">나의 전적 남기기</h2><p>가입은 선택입니다. 이메일이나 이름은 받지 않습니다.</p>
   <details className="member-policy signup-privacy"><summary>가입 전 회원정보 수집·보관·삭제 안내</summary><PrivacyNotice /></details>
   <form onSubmit={e=>void authenticate(e)}><label htmlFor="member-username">아이디</label><input id="member-username" name="username" autoComplete="username" required pattern="[a-zA-Z0-9_]{3,24}" minLength={3} maxLength={24} placeholder="영문·숫자·밑줄 3~24자" disabled={busy}/><label htmlFor="member-password">비밀번호</label><input id="member-password" name="password" type="password" autoComplete="current-password" required minLength={12} maxLength={128} placeholder="12~128자" disabled={busy}/><p className="member-note">이메일 없는 계정은 비밀번호 복구가 불가능합니다.</p><p className="member-error" role="alert">{authError}</p><button className="member-button" name="action" value="login" disabled={busy}>로그인</button><button className="member-button filled" name="action" value="register" disabled={busy}>새 계정 만들기</button></form>
  </dialog>
  <dialog ref={deleteDialog} className="member-dialog" aria-labelledby="delete-title" aria-describedby="delete-description" onCancel={e=>{if(busy)e.preventDefault();}} onClose={resetDelete}>
   <button type="button" className="member-close" aria-label="계정 삭제 창 닫기" disabled={busy} onClick={()=>deleteDialog.current?.close()}>×</button><h2 id="delete-title">계정을 삭제할까요?</h2>
   <div id="delete-description" className="delete-description"><p><strong>{user?.username}</strong> 계정의 아이디·비밀번호 해시·모든 로그인 세션과 개인 전적·순위 연결을 삭제합니다. 복구할 수 없습니다.</p><p>이미 받아들인 표는 계정과 브라우저의 연결을 끊고 익명 집계에 남겨 누적 대결 점수를 유지합니다. 별도의 비회원·다른 회원 기록과 호스팅 제공자의 로그·백업은 이 삭제 기능의 대상이 아닙니다.</p></div>
   <form ref={deleteForm} onSubmit={e=>void removeAccount(e)}><label htmlFor="delete-password">현재 비밀번호 확인</label><input id="delete-password" name="password" type="password" autoComplete="current-password" required minLength={12} maxLength={128} disabled={busy}/><label className="delete-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} required disabled={busy}/><span>계정과 개인 전적은 복구되지 않고 익명 처리한 표는 집계에 남는 것을 확인했습니다.</span></label><p className="member-error" role="alert">{deleteError}</p><button type="button" className="member-button" autoFocus disabled={busy} onClick={()=>deleteDialog.current?.close()}>취소하고 돌아가기</button><button type="submit" className="member-button filled" disabled={busy||!confirmed}>{busy?'삭제 처리 중…':'확인하고 계정 영구 삭제'}</button></form>
  </dialog>
 </section>;
}

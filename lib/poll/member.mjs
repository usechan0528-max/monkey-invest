import {token,digest,passwordHash,equalHash} from './password.mjs';
const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin'};
export const accountJSON=(data,status=200,cookies=[])=>{const h=new Headers({...headers,'Content-Type':'application/json; charset=utf-8'});for(const c of cookies)h.append('Set-Cookie',c);return new Response(JSON.stringify(data),{status,headers:h});};
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
function cookieName(request){return new URL(request.url).protocol==='https:'?'__Host-monkey_session':'monkey_session';}
function cookie(request,value,age=604800){return `${cookieName(request)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${new URL(request.url).protocol==='https:'?'; Secure':''}`;}
export async function memberSession(request,db){
 const raw=request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName(request)+'='))?.split('=')[1];
 if(!/^[a-f0-9]{64}$/.test(raw??''))return null;
 return await db.prepare('SELECT s.*,a.username FROM account_sessions s LEFT JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.expires_at>unixepoch()').bind(digest(raw)).first();
}
export function memberCSRF(request,session){if(request.headers.get('origin')!==new URL(request.url).origin||!session||request.headers.get('x-csrf-token')!==session.csrf)fail(403,'요청을 확인할 수 없습니다. 새로고침 후 다시 시도하세요.');}
async function limitAttempts(db,session,username){
 const keys=['account:'+digest(username),'session:'+session.token_hash,'global'];
 const attempts=await db.batch(keys.map(key=>db.prepare('INSERT INTO auth_attempts VALUES (?,1,unixepoch()+900) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=unixepoch() THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<=unixepoch() THEN excluded.expires_at ELSE expires_at END RETURNING count').bind(key)));
 if(attempts.some((r,i)=>r.results[0].count>(i===2?120:10)))fail(429,'시도가 너무 많습니다. 15분 후 다시 시도하세요.');
}
async function deleteAccount(request,db,session,value){
 if(!session.account_id)fail(401,'계정을 삭제하려면 로그인하세요.');
 if(Object.keys(value).some(key=>!['action','password','confirm'].includes(key)))fail(400,'본인의 계정만 삭제할 수 있습니다.');
 if(value.confirm!==true)fail(400,'삭제 안내를 확인하고 삭제에 동의해 주세요.');
 if(typeof value.password!=='string'||value.password.length<12||value.password.length>128)fail(400,'현재 비밀번호를 입력해 주세요.');
 const existing=await db.prepare('SELECT * FROM accounts WHERE id=?').bind(session.account_id).first();
 if(!existing)fail(401,'다시 로그인해 주세요.');
 await limitAttempts(db,session,existing.username);
 const hash=await passwordHash(value.password,existing.salt);
 if(!equalHash(hash,existing.password_hash))fail(401,'현재 비밀번호를 확인하세요.');
 // Retain accepted choices but sever browser/account links, cross-round keys and
 // exact submission times. A final FK check makes concurrent new votes fail closed.
 for(let attempt=0;attempt<2;attempt++){
 const ownVotes=(await db.prepare('SELECT round_id,voter_hash FROM votes WHERE account_id=?').bind(existing.id).all()).results;
 const guardKey='delete-guard:'+token();
 // A transaction-local guard revalidates the session and the password version.
 // NULL violates the existing NOT NULL constraint, rolling back before mutation.
 const operations=[db.prepare(`INSERT INTO auth_attempts(key,count,expires_at) VALUES (?,
 (SELECT 1 FROM account_sessions s JOIN accounts a ON a.id=s.account_id
 WHERE s.token_hash=? AND s.account_id=? AND s.csrf=? AND s.expires_at>unixepoch() AND a.password_hash=?),0)`)
 .bind(guardKey,session.token_hash,existing.id,session.csrf,existing.password_hash)];
 const mapping=JSON.stringify(ownVotes.map(v=>({...v,anonymous_key:token()})));
 // Bulk JSON mapping keeps query count bounded even for long-lived accounts.
 operations.push(db.prepare(`INSERT INTO voters(token_hash,created_at,expires_at)
 SELECT json_extract(j.value,'$.anonymous_key'),0,0 FROM json_each(?) j
 WHERE EXISTS(SELECT 1 FROM votes v WHERE v.account_id=? AND v.round_id=json_extract(j.value,'$.round_id') AND v.voter_hash=json_extract(j.value,'$.voter_hash'))`).bind(mapping,existing.id));
 operations.push(db.prepare(`UPDATE votes SET voter_hash=(SELECT json_extract(j.value,'$.anonymous_key') FROM json_each(?) j
 WHERE votes.round_id=json_extract(j.value,'$.round_id') AND votes.voter_hash=json_extract(j.value,'$.voter_hash')),
 account_id=NULL,accepted_at=0 WHERE account_id=? AND EXISTS(SELECT 1 FROM json_each(?) j
 WHERE votes.round_id=json_extract(j.value,'$.round_id') AND votes.voter_hash=json_extract(j.value,'$.voter_hash'))`).bind(mapping,existing.id,mapping));
 operations.push(db.prepare(`DELETE FROM attempts WHERE voter_hash IN (SELECT json_extract(value,'$.voter_hash') FROM json_each(?))
 AND NOT EXISTS(SELECT 1 FROM votes WHERE votes.voter_hash=attempts.voter_hash)`).bind(mapping));
 operations.push(db.prepare(`DELETE FROM voters WHERE token_hash IN (SELECT json_extract(value,'$.voter_hash') FROM json_each(?))
 AND NOT EXISTS(SELECT 1 FROM votes WHERE votes.voter_hash=voters.token_hash)`).bind(mapping));
 operations.push(db.prepare("DELETE FROM auth_attempts WHERE key=? OR key IN (SELECT 'session:'||token_hash FROM account_sessions WHERE account_id=?)").bind('account:'+digest(existing.username),existing.id));
 operations.push(db.prepare('DELETE FROM account_sessions WHERE account_id=?').bind(existing.id));
 operations.push(db.prepare('DELETE FROM accounts WHERE id=?').bind(existing.id));
 operations.push(db.prepare('DELETE FROM auth_attempts WHERE key=?').bind(guardKey));
 try{await db.batch(operations);break;}catch(error){
 if(String(error).includes('NOT NULL constraint failed: auth_attempts.count'))fail(401,'로그인이 만료되었습니다. 다시 로그인해 주세요.');
 if(!String(error).includes('FOREIGN KEY constraint failed'))throw error;
 if(attempt===1)fail(409,'투표 처리와 겹쳐 삭제하지 못했습니다. 잠시 후 다시 시도하세요.');
 }
 }
 return accountJSON({ok:true,deleted:true},200,[cookie(request,'',0)]);
}
async function body(request){
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')fail(415,'JSON 요청이 필요합니다.');
 if(Number(request.headers.get('content-length'))>8192)fail(413,'입력이 너무 깁니다.');
 const reader=request.body?.getReader(),chunks=[];let size=0;if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>8192){await reader.cancel();fail(413,'입력이 너무 깁니다.');}chunks.push(value);}
 const bytes=new Uint8Array(size);let p=0;for(const c of chunks){bytes.set(c,p);p+=c.length;}
 let value;try{value=JSON.parse(new TextDecoder().decode(bytes));}catch{fail(400,'잘못된 입력입니다.');}
 if(!value||Array.isArray(value)||typeof value!=='object')fail(400,'잘못된 입력입니다.');return value;
}
export async function account(request,db){
 try{
 let session=await memberSession(request,db);
 if(request.method==='GET'){
 const cookies=[];if(!session){const raw=token();session={token_hash:digest(raw),account_id:null,csrf:token()};await db.prepare('INSERT INTO account_sessions VALUES (?,?,?,unixepoch()+604800)').bind(session.token_hash,null,session.csrf).run();cookies.push(cookie(request,raw));}
 return accountJSON({user:session.account_id?{username:session.username}:null,csrf:session.csrf},200,cookies);
 }
 if(request.method!=='POST')fail(405,'지원하지 않는 요청입니다.');memberCSRF(request,session);const value=await body(request);
 if(value.action==='delete')return await deleteAccount(request,db,session,value);
 if(value.action==='logout'){await db.prepare('DELETE FROM account_sessions WHERE token_hash=?').bind(session.token_hash).run();return accountJSON({ok:true},200,[cookie(request,'',0)]);}
 if(!['register','login'].includes(value.action))fail(400,'잘못된 요청입니다.');
 const username=typeof value.username==='string'?value.username.toLowerCase():'',password=value.password;
 if(!/^[a-z0-9_]{3,24}$/.test(username)||typeof password!=='string'||password.length<12||password.length>128)fail(400,'아이디는 영문·숫자·밑줄 3~24자, 비밀번호는 12~128자입니다.');
 await limitAttempts(db,session,username);
 const existing=await db.prepare('SELECT * FROM accounts WHERE username=?').bind(username).first();let id;
 if(value.action==='register'){
 if(existing)fail(409,'사용할 수 없는 아이디입니다.');const salt=token(),hash=await passwordHash(password,salt);id=crypto.randomUUID();
 try{await db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').bind(id,username,salt,hash).run();}catch(e){if(String(e).includes('UNIQUE'))fail(409,'사용할 수 없는 아이디입니다.');throw e;}
 }else{const hash=await passwordHash(password,existing?.salt??'dummy-salt-timing');if(!existing||!equalHash(hash,existing.password_hash))fail(401,'아이디 또는 비밀번호를 확인하세요.');id=existing.id;}
 const raw=token();await db.batch([db.prepare('DELETE FROM account_sessions WHERE token_hash=?').bind(session.token_hash),db.prepare('INSERT INTO account_sessions VALUES (?,?,?,unixepoch()+604800)').bind(digest(raw),id,token()),db.prepare('DELETE FROM account_sessions WHERE expires_at<unixepoch()'),db.prepare('DELETE FROM auth_attempts WHERE expires_at<unixepoch()-900')]);
 return accountJSON({ok:true},200,[cookie(request,raw)]);
 }catch(e){return accountJSON({error:e.status?e.message:'처리하지 못했습니다. 잠시 후 다시 시도하세요.'},e.status??503);}
}

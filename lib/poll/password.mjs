import {randomBytes,scrypt as scryptCb,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(scryptCb);
export const token=()=>randomBytes(32).toString('hex');
export const digest=s=>createHash('sha256').update(s).digest('hex');
// OWASP scrypt profile: ~16 MiB; bound aggregate KDF memory per isolate.
let hashing=false;
export async function passwordHash(password,salt){
 if(hashing)throw Object.assign(Error('로그인 요청이 많습니다. 잠시 후 다시 시도하세요.'),{status:503});
 hashing=true;try{return 'scrypt:16384:8:5:'+ (await scrypt(password,salt,64,{N:16384,r:8,p:5,maxmem:32*1024*1024})).toString('hex');}finally{hashing=false;}
}
export function equalHash(a,b){return typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}

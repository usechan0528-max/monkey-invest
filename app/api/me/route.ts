import {env} from 'cloudflare:workers';
import {records} from '@/lib/poll/records.mjs';
import {syncReleases} from '@/lib/poll/service.mjs';
import {RULES,ROUND_RELEASES,RESULT_RELEASES,OPEN_PRICE_RELEASES} from '@/lib/poll/config.mjs';
export const dynamic='force-dynamic';
export async function GET(request:Request){const db=env.DB?.withSession('first-primary');try{await syncReleases(db,RULES,ROUND_RELEASES,RESULT_RELEASES,OPEN_PRICE_RELEASES);return records(request,db);}catch{return Response.json({error:'전적을 불러오지 못했습니다.'},{status:503,headers:{'Cache-Control':'no-store'}});}}

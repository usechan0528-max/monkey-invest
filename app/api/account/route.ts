import {env} from 'cloudflare:workers';
import {account} from '@/lib/poll/member.mjs';
export const dynamic='force-dynamic';
export async function GET(request:Request){return account(request,env.DB?.withSession('first-primary'));}
export async function POST(request:Request){return account(request,env.DB?.withSession('first-primary'));}

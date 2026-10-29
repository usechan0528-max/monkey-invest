import { env } from 'cloudflare:workers';
import { vote } from '@/lib/poll/service.mjs';
import { RULES, ROUND_RELEASES, RESULT_RELEASES, OPEN_PRICE_RELEASES } from '@/lib/poll/config.mjs';
export const dynamic='force-dynamic';
export async function POST(request:Request){return vote(request,env.DB?.withSession('first-primary'),{rules:RULES,rounds:ROUND_RELEASES,results:RESULT_RELEASES,openingPrices:OPEN_PRICE_RELEASES});}

import test from 'node:test';
import assert from 'node:assert/strict';
import {drawRound} from '../lib/poll/draw.mjs';
import {validateDrawAudit,validateReleaseBundle,publicSource} from '../lib/poll/release-validation.mjs';
const rules={rulesConfirmed:true,noScorePolicyConfirmed:true,voteWindow:'regular_session_until_last_hour',resultVisibility:'after_close'};
const input={market:'NASDAQ',sessionDate:'2026-10-12',opensAt:'2026-10-12T09:30:00-04:00',closesAt:'2026-10-12T16:00:00-04:00',calendarVerified:true,calendarSource:'https://www.nasdaq.com/market-activity/stock-market-holiday-schedule',calendarCheckedAt:'2026-10-12T12:00:00Z',universeVerified:true,universeSource:'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt',universePolicy:'direct-common-equity-v1',universeCheckedAt:'2026-10-12T12:00:00Z',universe:[{symbol:'FIXTURE',name:'Synthetic fixture only'}]};
const drawn=Date.parse('2026-10-12T12:30:00Z');
const clone=v=>JSON.parse(JSON.stringify(v));
function setup(){const a=drawRound(input,drawn);const c={RULES:rules,ROUND_RELEASES:[a.round],RESULT_RELEASES:[],OPEN_PRICE_RELEASES:[]};return {a,c,audits:new Map([[a.round.id,a]])};}
function opening(r){return {id:r.id+':open:1',roundId:r.id,revision:1,market:r.market,symbol:r.symbol,status:'verified',price:'123.45',sessionDate:'2026-10-12',currency:'USD',observedAt:'2026-10-12T13:31:00Z',sourceUrl:'https://chartexchange.com/symbol/nasdaq-fixture/historical/',sourceLabel:'Synthetic provider fixture',sourceVerified:true,reason:'Synthetic test only'};}
function result(r){const e=opening(r);delete e.price;return {...e,id:r.id+':result:1',open:'123.45',close:'124.00',regularSessionComplete:true,observedAt:'2026-10-12T20:01:00Z'};}
test('empty operator-ready release and committed pre-open draft pass',()=>{
 assert.deepEqual(validateReleaseBundle({RULES:rules,ROUND_RELEASES:[],RESULT_RELEASES:[],OPEN_PRICE_RELEASES:[]},{},new Map(),drawn),{rounds:0,results:0,openingPrices:0});
 const {c,audits}=setup();assert.equal(validateReleaseBundle(c,{},audits,drawn+1000).rounds,1);
});
test('audit guards reject changed universe, index, nonce and selected stock',()=>{
 const {a}=setup();assert.equal(validateDrawAudit(a.round,a),true);
 for(const mutate of [x=>x.evidence.universe[0].name='changed',x=>x.evidence.index=1,x=>x.evidence.nonce=(x.evidence.nonce[0]==='a'?'b':'a')+x.evidence.nonce.slice(1),x=>x.evidence.universe.push({...x.evidence.universe[0]})]){const copy=clone(a);mutate(copy);assert.throws(()=>validateDrawAudit(a.round,copy));}
 const copy=clone(a);copy.round.symbol='OTHER';assert.throws(()=>validateDrawAudit(copy.round,copy));
});
test('new rounds cannot be added at/after open and published objects cannot change',()=>{
 const {c,audits}=setup();assert.throws(()=>validateReleaseBundle(c,{},audits,Date.parse(input.opensAt)),/before open/);
 const base=clone(c),changed=clone(c);changed.ROUND_RELEASES[0].name='changed';assert.throws(()=>validateReleaseBundle(changed,base,audits,drawn),/changed/);
 assert.throws(()=>validateReleaseBundle({...c,ROUND_RELEASES:[]},base,audits,drawn),/append-only/);
});
test('opening and completed result use separate time gates without fake quotes',()=>{
 const {c,audits}=setup(),base=clone(c),r=c.ROUND_RELEASES[0];
 c.OPEN_PRICE_RELEASES=[opening(r)];assert.equal(validateReleaseBundle(c,base,audits,Date.parse('2026-10-12T13:32:00Z')).openingPrices,1);
 assert.throws(()=>validateReleaseBundle(c,base,audits,drawn),/premature|future/);
 c.RESULT_RELEASES=[result(r)];assert.equal(validateReleaseBundle(c,base,audits,Date.parse('2026-10-12T20:02:00Z')).results,1);
 assert.throws(()=>validateReleaseBundle(c,base,audits,Date.parse('2026-10-12T19:00:00Z')),/premature|future/);
});
test('quote identity, currency, fixed provider, prices and private metadata fail closed',()=>{
 const {c,audits}=setup(),base=clone(c),r=c.ROUND_RELEASES[0],now=Date.parse('2026-10-12T20:02:00Z');
 for(const change of [{symbol:'OTHER'},{market:'KOSPI'},{currency:'KRW'},{sessionDate:'2026-10-13'},{sourceUrl:'https://example.com/'},{close:'0'},{open:123.45},{privateOwnerEmail:'fixture@example.com'},{observedAt:'2026-10-13T00:00:00Z'}])assert.throws(()=>validateReleaseBundle({...c,RESULT_RELEASES:[{...result(r),...change}]},base,audits,now));
});
test('corrections are complete, sequential and append-only',()=>{
 const {c,audits}=setup(),r=c.ROUND_RELEASES[0],original=result(r);c.RESULT_RELEASES=[original];const base=clone(c);
 const correction={...original,id:r.id+':result:2',revision:2,correctsEventId:original.id,close:'122.00',reason:'Synthetic correction'};c.RESULT_RELEASES.push(correction);
 assert.equal(validateReleaseBundle(c,base,audits,Date.parse('2026-10-12T20:02:00Z')).results,2);
 const bad=clone(c);bad.RESULT_RELEASES[1].correctsEventId='wrong';assert.throws(()=>validateReleaseBundle(bad,base,audits,Date.parse('2026-10-12T20:02:00Z')),/chain/);
});
test('source URLs reject credentials, secret query parameters and lookalike hosts',()=>{
 assert.equal(publicSource('https://kr.investing.com/equities/example-historical-data',['investing.com']),true);
 for(const u of ['http://kr.investing.com','https://secret:password@kr.investing.com','https://kr.investing.com/?api_key=fixture','https://investing.com.evil.test'])assert.equal(publicSource(u,['investing.com']),false);
});

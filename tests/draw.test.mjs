import test from 'node:test';
import assert from 'node:assert/strict';
import {drawRound} from '../lib/poll/draw.mjs';
const base={market:'NASDAQ',calendarVerified:true,calendarSource:'https://www.nasdaq.com/market-activity/stock-market-holiday-schedule',calendarCheckedAt:'2026-01-05T00:00:00Z',universeSource:'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt',universeVerified:true,universePolicy:'direct-common-equity-v1',universeCheckedAt:'2026-01-05T00:00:00Z',universe:[{symbol:'ONE',name:'Fixture only'}]};
test('draft draw preserves exchange-local DST and early-close cutoff without publishing',()=>{
 for(const [date,offset,close] of [['2026-01-05','-05:00','16:00:00'],['2026-07-06','-04:00','16:00:00'],['2026-11-27','-05:00','13:00:00']]){
 const input={...base,calendarCheckedAt:date+'T00:00:00Z',universeCheckedAt:date+'T00:00:00Z',sessionDate:date,opensAt:date+'T09:30:00'+offset,closesAt:date+'T'+close+offset};const {round,evidence}=drawRound(input,Date.parse(input.opensAt)-3600000);
 assert.equal(Date.parse(round.closesAt)-Date.parse(round.deadline),3600000);assert.equal(round.id,'NASDAQ:'+date);assert.equal(round.symbol,'ONE');assert.equal(evidence.index,0);assert.match(evidence.nonce,/^[a-f0-9]{64}$/);
 }
});
test('draft draw rejects unverified calendar, wrong local date and duplicate universe',()=>{
 const input={...base,sessionDate:'2026-01-05',opensAt:'2026-01-05T09:30:00-05:00',closesAt:'2026-01-05T16:00:00-05:00'};
 for(const change of [{calendarVerified:false},{calendarSource:'https://example.com'},{sessionDate:'2026-01-06'},{opensAt:'2026-02-30T09:30:00-05:00'},{universe:[...base.universe,...base.universe]},{opensAt:'2026-01-05T09:30:00.001-05:00'},{universeVerified:false},{universeCheckedAt:'2025-01-01T00:00:00Z'}])assert.throws(()=>drawRound({...input,...change},Date.parse(input.opensAt)-3600000));
 assert.throws(()=>drawRound(input,Date.parse(input.opensAt)),/before/);
});

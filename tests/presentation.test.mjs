import test from 'node:test';
import assert from 'node:assert/strict';
import {resultLabel,openingDetails,decimalLabel,personalVerdictLabel} from '../lib/poll/presentation.mjs';
import {personalVerdict} from '../lib/poll/records.mjs';
test('settled zero-point outcomes are distinct from pending verification',()=>{
 for(const reason of ['참여 없음','상승·하락 동률','시가·종가 동일'])assert.equal(resultLabel({status:'settled',result:{winner:null,reason}}),'점수 없음 · '+reason);
 assert.equal(resultLabel({status:'void',result:{winner:null}}),'대결 무효 · 점수 없음');
 assert.match(resultLabel({status:'locked',result:null}),/가격 확인 중/);
 assert.equal(resultLabel({status:'settled',result:{winner:'humans'}}),'인간 승리');
 assert.equal(resultLabel({status:'settled',result:{winner:'chimp'}}),'침팬지 승리');
});
test('opening presentation never reveals future rounds or invents missing prices',()=>{
 const r={id:'KOSPI:2026-10-12',market:'KOSPI',status:'open',openingPrice:{price:'269500',sourceLabel:'Provider fixture',sourceUrl:'https://example.com',observedAt:'2026-10-12T00:01:00Z'}};
 assert.equal(openingDetails({...r,status:'upcoming'}),null);
 assert.equal(openingDetails({...r,openingPrice:null,result:null}),null);
 assert.equal(openingDetails({...r,openingPrice:{price:'0'}}),null);
 assert.equal(openingDetails({...r,openingPrice:{price:'NaN'}}),null);
 assert.equal(openingDetails(r).currency,'KRW');
 assert.equal(openingDetails(r).sessionDate,'2026-10-12');
 assert.equal(decimalLabel('269500.00'),'269,500.00');
 assert.equal(decimalLabel('0'),null);
 assert.equal(decimalLabel('1e9'),null);
 assert.equal(openingDetails({...r,status:'settled',openingPrice:null,result:{status:'verified',open:'250000',sourceLabel:'Final source'}}).price,'250000');
 assert.equal(openingDetails({...r,status:'settled',result:{status:'verified',open:'270000',sourceLabel:'Corrected final provider row'}}).price,'270000');
});
test('personal flat and void are final exclusions, distinct from pending prices',()=>{
 assert.equal(personalVerdict(undefined,'up').verdict,'pending');
 assert.equal(personalVerdict({status:'void'},'up').verdict,'void');
 assert.equal(personalVerdict({status:'verified',open:'10',close:'10.0'},'up').verdict,'flat');
 assert.equal(personalVerdict({status:'verified',open:'10',close:'11'},'up').verdict,'win');
 assert.match(personalVerdictLabel('flat'),/보합/);assert.match(personalVerdictLabel('void'),/무효/);assert.equal(personalVerdictLabel('pending'),'가격 확인 중');
});

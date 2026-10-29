import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {validateNasdaqCefReview,readNasdaqDirectory} from '../scripts/nasdaq-universe-policy.mjs';
const dir=new URL('../ops/session-evidence/NASDAQ-2026-10-27/',import.meta.url);
const json=name=>JSON.parse(readFileSync(new URL(name,dir),'utf8'));
const rows=readNasdaqDirectory(new URL('nasdaqlisted_browser_text.txt',dir));
const review=json('closed-end-descriptor-review.json'), universe=json('universe.json');
const included='ARCC BCIC CGBD FDUS GBDC GECC GLAD MFIC NSLR OCSL OFS OXSQ PSEC RAND SLRC TCPC WHF'.split(' ');
const excluded='BANX CCD CGO CHI CHW CHY CPZ CSQ DXR FUND HERZ OCCI OXLC QQQX TBLD'.split(' ');
test('complete primary review includes BDC commons, excludes actual CEF instruments',()=>{
  assert.deepEqual(review.eligible,included);assert.deepEqual(review.excluded,excluded);
  assert.deepEqual(validateNasdaqCefReview(rows,review,universe),{reviewed:32,eligible:17,excluded:15});
});
test('corrected pre-draw ordered universe is immutable regression fixture',()=>{
  assert.equal(universe.length,3228);
  assert.deepEqual(universe.map(x=>x.symbol),universe.map(x=>x.symbol).sort());
  for(const row of universe) assert.deepEqual(Object.keys(row),['symbol','name']);
  assert.equal(createHash('sha256').update(JSON.stringify(universe)).digest('hex'),'f5a0d94c39479c5f73e3541335e0661a635418877fba9bcb83c4346e78726c89');
});
test('new or missing CEF evidence fails closed instead of blanket exclusion',()=>{
  const absent=structuredClone(review);delete absent.decisions.ARCC;
  assert.throws(()=>validateNasdaqCefReview(rows,absent,universe),/exactly one/);
  assert.throws(()=>validateNasdaqCefReview([...rows,{Symbol:'NEWBDC','Security Name':'New BDC - Closed End Fund'}],review,universe),/exactly one/);
  const changed=structuredClone(rows);changed.find(r=>r.Symbol==='ARCC')['Security Name']+=' changed';
  assert.throws(()=>validateNasdaqCefReview(changed,review,universe),/Changed descriptor/);
});
test('unsubstantiated decisions and BDC omission cannot silently pass',()=>{
  const absent=structuredClone(review);absent.decisions.ARCC.sources=[];
  assert.throws(()=>validateNasdaqCefReview(rows,absent,universe),/Incomplete/);
  assert.throws(()=>validateNasdaqCefReview(rows,review,universe.filter(r=>r.symbol!=='ARCC')),/contradicts/);
  const blocked=structuredClone(review);blocked.blockers=['unresolved classification'];
  assert.throws(()=>validateNasdaqCefReview(rows,blocked,universe),/Unresolved/);
});

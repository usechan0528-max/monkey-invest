import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';

// Review gate only: never selects, redraws, mutates evidence, or infers BDC
// status from a directory label. New/changed descriptors require source review.
export function validateNasdaqCefReview(rows, review, universe) {
  if (review.policy !== 'direct-common-equity-v1' || !Array.isArray(review.blockers) || review.blockers.length) throw Error('Unresolved universe policy review');
  const cef = rows.filter(row => /closed[ -]end fund/i.test(row['Security Name']));
  const symbols = cef.map(row => row.Symbol).sort();
  const decisions = review.decisions ?? {};
  if (new Set(symbols).size !== symbols.length || JSON.stringify(Object.keys(decisions).sort()) !== JSON.stringify(symbols)) throw Error('Every current CEF descriptor needs exactly one primary decision');
  const population = new Map(universe.map(row => [row.symbol,row.name]));
  if (population.size !== universe.length) throw Error('Duplicate universe symbol');
  for (const row of cef) {
    const d = decisions[row.Symbol];
    if (d.symbol !== row.Symbol || d.expected_directory_security_name !== row['Security Name']) throw Error('Changed descriptor requires new review: '+row.Symbol);
    if (!['eligible','excluded'].includes(d.decision) || !d.reason || !Number.isFinite(Date.parse(d.checkedAt)) || !Array.isArray(d.sources) || !d.sources.length) throw Error('Incomplete primary decision: '+row.Symbol);
    for (const source of d.sources) {
      if (!/^https:\/\//.test(source.url ?? '') || !source.evidence || !Number.isFinite(Date.parse(source.checkedAt ?? d.checkedAt))) throw Error('Incomplete source evidence: '+row.Symbol);
    }
    if ((d.decision === 'eligible') !== population.has(row.Symbol) || (d.decision === 'eligible' && population.get(row.Symbol) !== row['Security Name'])) throw Error('Population contradicts reviewed decision: '+row.Symbol);
  }
  for (const status of ['eligible','excluded']) {
    const expected = symbols.filter(s => decisions[s].decision === status);
    if (JSON.stringify(review[status]) !== JSON.stringify(expected)) throw Error('Decision summary mismatch: '+status);
  }
  return {reviewed:cef.length, eligible:review.eligible.length, excluded:review.excluded.length};
}
export function readNasdaqDirectory(path) {
  const lines=readFileSync(path,'utf8').trimEnd().split(/\r?\n/);
  if (!lines.pop().startsWith('File Creation Time:')) throw Error('Missing directory trailer');
  const headers=lines.shift().split('|');
  return lines.map(line => { const cells=line.split('|'); if(cells.length!==headers.length) throw Error('Malformed directory row'); return Object.fromEntries(headers.map((h,i)=>[h,cells[i]])); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dir=process.argv[2]; if(!dir) throw Error('Usage: node scripts/nasdaq-universe-policy.mjs <session-evidence-directory>');
  const json=name=>JSON.parse(readFileSync(join(dir,name),'utf8'));
  console.log(JSON.stringify(validateNasdaqCefReview(readNasdaqDirectory(join(dir,'nasdaqlisted_browser_text.txt')),json('closed-end-descriptor-review.json'),json('universe.json'))));
}

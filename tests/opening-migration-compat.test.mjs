import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { Miniflare } from 'miniflare';

const require=createRequire(import.meta.url);
const repaired=await readFile(new URL('../drizzle/0002_opening_price_events.sql',import.meta.url),'utf8');
const safeBody="SELECT RAISE(ABORT, 'Opening price event immutable') WHERE EXISTS (SELECT 1 FROM `opening_price_events` WHERE `id`=NEW.`id` AND (`payload_json`<>NEW.`payload_json` OR `round_id`<>NEW.`round_id` OR `revision`<>NEW.`revision`));";
const unsafeBody="SELECT CASE WHEN EXISTS (SELECT 1 FROM `opening_price_events` WHERE `id`=NEW.`id` AND (`payload_json`<>NEW.`payload_json` OR `round_id`<>NEW.`round_id` OR `revision`<>NEW.`revision`)) THEN RAISE(ABORT, 'Opening price event immutable') END;";
const original=repaired.replace(safeBody,unsafeBody);
const splitBreakpoints=sql=>sql.split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean);
const base=await Promise.all(['0000_dear_shriek.sql','0001_material_roland_deschain.sql'].map(f=>readFile(new URL('../drizzle/'+f,import.meta.url),'utf8')));

// Exercise the installed official splitter without importing Wrangler's CLI,
// which would initialize log/telemetry machinery unrelated to these tests.
const wrangler=await readFile(require.resolve('wrangler'),'utf8');
const start=wrangler.indexOf('function splitSqlIntoStatements(sql) {');
const end=wrangler.indexOf('var init_splitter',start);
assert.ok(start>=0&&end>start,'Installed Wrangler splitter must be inspectable');
const splitterSource=wrangler.slice(start,end);
const currentSplit=runInNewContext(splitterSource+'; splitSqlIntoStatements');
// Deliberately model the historical BEGIN-only bug from Cloudflare issues
// 4326/4727. This is a regression model, not proof of the remote host's parser.
const legacySource=splitterSource.replace('(BEGIN|CASE)','(BEGIN)');
assert.notEqual(legacySource,splitterSource,'Regression model must remove CASE nesting');
const legacySplit=runInNewContext(legacySource+'; splitSqlIntoStatements');

test('opening migration preserves all triggers and avoids the remote CASE/END parser hazard',()=>{
 assert.ok(repaired.includes(safeBody));assert.notEqual(original,repaired);
 assert.doesNotMatch(repaired,/\bCASE\b/i);
 const parts=currentSplit(repaired);assert.equal(parts.length,6);
 assert.equal(parts.filter(s=>/^CREATE TRIGGER/.test(s)).length,4);
 assert.ok(parts[2].includes('SELECT RAISE(IGNORE);'));
});

test('historical BEGIN-only splitter model truncates the old trigger but preserves the repaired statement',()=>{
 const broken=legacySplit(original),fixed=legacySplit(repaired);
 assert.ok(broken.length>6);assert.ok(!broken[2].includes('SELECT RAISE(IGNORE);'));
 assert.equal(fixed.length,6);assert.ok(fixed[2].includes('SELECT RAISE(IGNORE);'));
 assert.equal(currentSplit(original).length,6,'Current local parser already fixes CASE nesting');
});

test('original and repaired complete statements preserve identical local D1 immutability guarantees',{timeout:30000},async()=>{
 for(const [label,sql] of [['original',original],['repaired',repaired]]){
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("Isolated migration compatibility only")}}',compatibilityDate:'2026-05-15',cf:false,d1Databases:['DB']});
  try{
   const db=await mf.getD1Database('DB');
   for(const previous of base)await db.batch(splitBreakpoints(previous).map(s=>db.prepare(s)));
   await db.batch(splitBreakpoints(sql).map(s=>db.prepare(s)));
   assert.equal((await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'opening_price_%'").first()).n,4,label);
   await db.prepare('INSERT INTO rounds VALUES (?,?,?,?,?,?)').bind('KOSPI:2000-01-01','{}',0,1,2,2).run();
   const first={id:'local-opening',roundId:'KOSPI:2000-01-01',revision:1,price:'100'},payload=JSON.stringify(first);
   const insert=(id,revision,value,recordedAt=10)=>db.prepare('INSERT OR REPLACE INTO opening_price_events VALUES (?,?,?,?,?)').bind(id,first.roundId,revision,JSON.stringify(value),recordedAt).run();
   await insert(first.id,1,first);await insert(first.id,1,first,99);
   assert.deepEqual(await db.prepare('SELECT payload_json,recorded_at FROM opening_price_events').first(),{payload_json:payload,recorded_at:10},label);
   await assert.rejects(insert(first.id,1,{...first,price:'999'}),/immutable/,label);
   await assert.rejects(db.prepare('UPDATE opening_price_events SET recorded_at=99').run(),/append-only/,label);
   await assert.rejects(db.prepare('DELETE FROM opening_price_events').run(),/append-only/,label);
   await assert.rejects(insert('broken-correction',2,{id:'broken-correction',correctsEventId:'missing'}),/correction chain/,label);
   const correction={id:'local-correction',revision:2,correctsEventId:first.id,price:'101'};
   await insert(correction.id,2,correction);assert.equal((await db.prepare('SELECT count(*) AS n FROM opening_price_events').first()).n,2,label);
  }finally{await mf.dispose();}
 }
});

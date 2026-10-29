import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Miniflare } from 'miniflare';
import { state, vote, syncReleases, hashToken, outcome, validateRound } from '../lib/poll/service.mjs';
import { RULES, ROUND_RELEASES, RESULT_RELEASES, OPEN_PRICE_RELEASES } from '../lib/poll/config.mjs';

// Every fixture is created in isolated local Miniflare D1, never hosted D1.
const ORIGIN = 'https://poll.example.test';
const CONFIRMED = Object.freeze({ rulesConfirmed: true, noScorePolicyConfirmed: true, voteWindow: 'regular_session_until_last_hour', resultVisibility: 'after_close' });
const migrations = await Promise.all((await readdir(new URL('../drizzle/', import.meta.url))).filter(f => f.endsWith('.sql')).sort().map(f => readFile(new URL('../drizzle/'+f, import.meta.url), 'utf8')));
const statements = migrations.join('\n--> statement-breakpoint\n').split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean);
const configFor = (rounds = [], results = [], rules = CONFIRMED) => ({ rules, rounds, results });
const iso = seconds => new Date(seconds * 1000).toISOString();
const parse = value => Math.floor(Date.parse(value) / 1000);
const dbNow = async db => Number((await db.prepare('SELECT unixepoch() AS now').first()).now);
const count = async (db, table) => Number((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n);
const request = (cookie, origin = ORIGIN) => new Request(`${origin}/api/state`, { headers: cookie ? { cookie } : {} });
function voteRequest(cookie, body, overrides = {}) {
  const headers = new Headers({ origin: ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) });
  for (const [key, value] of Object.entries(overrides.headers || {})) {
    if (value === null) headers.delete(key); else headers.set(key, value);
  }
  const method = overrides.method || 'POST';
  return new Request(`${ORIGIN}/api/vote`, {
    method, headers,
    ...(!['GET', 'HEAD'].includes(method) ? { body: overrides.raw ?? JSON.stringify(body), duplex: 'half' } : {}),
  });
}
function fixture(now, overrides = {}) {
  const round = {
    id: 'KOSPI:2026-10-09', market: 'KOSPI', symbol: 'TEST-ONLY', name: '로컬 테스트 종목',
    opensAt: iso(now - 60), deadline: iso(now + 1740), closesAt: iso(now + 5340), revealAt: iso(now + 5340),
    calendarSource: 'https://example.test/test-calendar', calendarVerified: true,
    draw: { universeHash: 'test-only-universe', commitmentHash: 'test-only-commitment', sourceUrl: 'https://example.test/test-draw', validated: true },
    ...overrides,
  };
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:round.market==='KOSPI'?'Asia/Seoul':'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(round.opensAt));
  round.id=round.market+':'+date;return round;
}
function closedFixture(now, overrides = {}) {
  return fixture(now, { opensAt: iso(now - 10000), deadline: iso(now - 3620), closesAt: iso(now - 20), revealAt: iso(now - 20), ...overrides });
}
function eventFixture(round, overrides = {}) {
  return {
    id: `${round.id}:result:1`, roundId: round.id, revision: 1, status: 'verified',
    open: '100.00', close: '101.000', observedAt: round.closesAt, reason: 'Test-only verified regular session',
    sourceUrl: 'https://example.test/test-prices', sourceLabel: 'Local test provider',
    sessionDate: round.id.split(':')[1], currency: round.market === 'KOSPI' ? 'KRW' : 'USD',
    sourceVerified: true, regularSessionComplete: true,
    ...overrides,
  };
}
function createMiniflare(persist = false) {
  return new Miniflare({
    modules: true, script: 'export default { fetch() { return new Response("Local tests only"); } }',
    compatibilityDate: '2026-05-01', cf: false,
    d1Databases: { DB: 'anonymous-poll-tests' }, d1Persist: persist,
  });
}
async function migrate(db) { await db.batch(statements.map(sql => db.prepare(sql))); }
async function clear(db) {
  await db.batch(['votes', 'attempts', 'result_events', 'rounds', 'voters', 'account_sessions', 'auth_attempts', 'accounts'].map(table => db.prepare(`DELETE FROM ${table}`)));
}
async function session(db, config = configFor(), cookie = undefined, origin = ORIGIN) {
  const response = await state(request(cookie, origin), db, config);
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie');
  return { cookie: setCookie?.split(';')[0] || cookie, setCookie, response, data: await response.json() };
}
async function assertError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal((await response.json()).code, code);
  assert.match(response.headers.get('cache-control'), /no-store/);
}
async function seedHistoricalVotes(db, round, choices) {
  for (let i = 0; i < choices.length; i++) {
    const hash = await hashToken(`local-fixture-${round.id}-${i}`);
    await db.batch([
      db.prepare('INSERT INTO voters(token_hash,created_at,expires_at) VALUES (?,unixepoch()-20000,unixepoch()+10000)').bind(hash),
      db.prepare('INSERT INTO votes(round_id,voter_hash,choice,accepted_at) VALUES (?,?,?,?)').bind(round.id, hash, choices[i], parse(round.opensAt) + 10),
    ]);
  }
}
async function waitUntilDatabaseSecond(db, target) {
  for (;;) {
    const now = await dbNow(db);
    if (now >= target) return now;
    await sleep(15);
  }
}

let mf, db;
before(async () => { mf = createMiniflare(); db = await mf.getD1Database('DB'); await migrate(db); });
after(async () => { await mf?.dispose(); });
beforeEach(async () => { await clear(db); });

describe('release readiness and empty local state', () => {
  test('production release containers stay frozen and configured rounds pass readiness validation', () => {
    assert.equal(RULES.rulesConfirmed, true);
    assert.equal(RULES.noScorePolicyConfirmed, true);
    for (const releases of [ROUND_RELEASES, RESULT_RELEASES, OPEN_PRICE_RELEASES]) {
      assert.ok(Array.isArray(releases));
      assert.ok(Object.isFrozen(releases));
    }
    assert.equal(new Set(ROUND_RELEASES.map(r => r.id)).size, ROUND_RELEASES.length);
    for (const round of ROUND_RELEASES) assert.doesNotThrow(() => validateRound(round, RULES));
  });
  test('empty release fixture has no rounds, votes, results, or fabricated score', async () => {
    const { data, cookie } = await session(db, configFor([], [], RULES));
    assert.equal(data.mode, 'prelaunch');
    assert.equal(data.storage, 'ready');
    assert.deepEqual(data.rounds, []);
    assert.deepEqual(data.score, { humans: 0, chimp: 0 });
    assert.equal(await count(db, 'rounds'), 0);
    await assertError(await vote(voteRequest(cookie, { roundId: 'KOSPI:2026-10-09', choice: 'up' }), db, configFor([], [], RULES)), 404, 'ROUND_NOT_FOUND');
    assert.equal(await count(db, 'votes'), 0);
  });
});

describe('anonymous token and minimal data', () => {
  test('uses a random opaque 256-bit HttpOnly SameSite cookie for exactly 90 days, storing only its SHA-256 hash', async () => {
    const { cookie, setCookie, response } = await session(db);
    assert.match(cookie, /^monkey_voter=[a-f0-9]{64}$/);
    assert.match(setCookie, /; HttpOnly;/);
    assert.match(setCookie, /; SameSite=Lax;/);
    assert.match(setCookie, /; Max-Age=7776000; Secure$/);
    assert.match(setCookie, /; Path=\//);
    assert.equal(response.headers.get('cache-control'), 'no-store, private, max-age=0');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const row = await db.prepare('SELECT * FROM voters').first();
    const token = cookie.split('=')[1];
    assert.equal(row.token_hash, await hashToken(token));
    assert.notEqual(row.token_hash, token);
    assert.equal(row.expires_at - row.created_at, 7776000);
    assert.deepEqual(Object.keys(row).sort(), ['created_at', 'expires_at', 'token_hash']);
  });
  test('repeat visits reuse identity without a second registration; distinct browsers get different tokens', async () => {
    const first = await session(db);
    const again = await session(db, configFor(), first.cookie);
    assert.equal(again.setCookie, null);
    assert.equal(again.cookie, first.cookie);
    assert.equal(await count(db, 'voters'), 1);
    const another = await session(db);
    assert.notEqual(first.cookie, another.cookie);
    assert.equal(await count(db, 'voters'), 2);
  });
  test('localhost HTTP remains testable; HTTPS cookies are always Secure', async () => {
    const local = await session(db, configFor(), undefined, 'http://localhost:4173');
    assert.doesNotMatch(local.setCookie, /; Secure/);
  });
  test('invalid, unknown, altered, absent, and expired tokens cannot vote or create a voter by POST', async () => {
    const round = fixture(await dbNow(db));
    const config = configFor([round]);
    const valid = await session(db, config);
    const beforeCount = await count(db, 'voters');
    const altered = `${valid.cookie.slice(0, -1)}${valid.cookie.endsWith('0') ? '1' : '0'}`;
    for (const cookie of [undefined, 'monkey_voter=bad', `monkey_voter=${'a'.repeat(64)}`, altered, `${valid.cookie}00`]) {
      await assertError(await vote(voteRequest(cookie, { roundId: round.id, choice: 'up' }), db, config), 401, 'SESSION');
    }
    await db.prepare('UPDATE voters SET expires_at=unixepoch()').run();
    await assertError(await vote(voteRequest(valid.cookie, { roundId: round.id, choice: 'up' }), db, config), 401, 'SESSION');
    assert.equal(await count(db, 'voters'), beforeCount);
    assert.equal(await count(db, 'votes'), 0);
    const renewed = await session(db, config, valid.cookie);
    assert.notEqual(renewed.cookie, valid.cookie);
  });
  test('cookie deletion creates a new browser identity: deliberately light duplicate protection', async () => {
    const round = fixture(await dbNow(db));
    const config = configFor([round]);
    const one = await session(db, config);
    assert.equal((await vote(voteRequest(one.cookie, { roundId: round.id, choice: 'up' }), db, config)).status, 200);
    const two = await session(db, config);
    assert.equal(two.data.rounds[0].myVote, null);
    assert.equal((await vote(voteRequest(two.cookie, { roundId: round.id, choice: 'down' }), db, config)).status, 200);
    assert.equal(await count(db, 'votes'), 2);
  });
});

describe('one immutable vote per anonymous browser and round', () => {
  test('accepts a vote using D1 time, acknowledges only its choice, and shows only that browser’s vote', async () => {
    const round = fixture(await dbNow(db));
    const config = configFor([round]);
    const { cookie } = await session(db, config);
    const response = await vote(voteRequest(cookie, { roundId: round.id, choice: 'up' }), db, config);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, choice: 'up' });
    const stored = await db.prepare('SELECT * FROM votes').first();
    assert.ok(stored.accepted_at >= parse(round.opensAt));
    assert.ok(stored.accepted_at < parse(round.deadline));
    assert.ok(Math.abs(stored.accepted_at - await dbNow(db)) <= 1);
    const mine = await session(db, config, cookie);
    assert.equal(mine.data.rounds[0].myVote, 'up');
    assert.equal((await session(db, config)).data.rounds[0].myVote, null);
  });
  test('a duplicate request and attempted change are both rejected; first vote remains unchanged', async () => {
    const round = fixture(await dbNow(db));
    const config = configFor([round]);
    const { cookie } = await session(db, config);
    assert.equal((await vote(voteRequest(cookie, { roundId: round.id, choice: 'up' }), db, config)).status, 200);
    for (const choice of ['up', 'down']) await assertError(await vote(voteRequest(cookie, { roundId: round.id, choice }), db, config), 409, 'ALREADY_VOTED');
    assert.equal(await count(db, 'votes'), 1);
    assert.equal((await db.prepare('SELECT choice FROM votes').first()).choice, 'up');
  });
  test('30 concurrent requests commit exactly one vote without race-condition duplicates', async () => {
    const round = fixture(await dbNow(db));
    const config = configFor([round]);
    const { cookie } = await session(db, config);
    const responses = await Promise.all(Array.from({ length: 30 }, (_, i) => vote(voteRequest(cookie, { roundId: round.id, choice: i % 2 ? 'up' : 'down' }), db, config)));
    assert.equal(responses.filter(r => r.status === 200).length, 1);
    assert.ok(responses.every(r => [200, 409, 429].includes(r.status)));
    assert.equal(await count(db, 'votes'), 1);
  });
  test('the same browser may vote once in each independent market round', async () => {
    const now = await dbNow(db);
    const rounds = [fixture(now), fixture(now, { id: 'NASDAQ:2026-10-09', market: 'NASDAQ' })];
    const config = configFor(rounds);
    const { cookie } = await session(db, config);
    for (const round of rounds) assert.equal((await vote(voteRequest(cookie, { roundId: round.id, choice: 'up' }), db, config)).status, 200);
    assert.equal(await count(db, 'votes'), 2);
  });
  test('storage primary key independently prevents duplicate records', async () => {
    const round = fixture(await dbNow(db));
    await syncReleases(db, CONFIRMED, [round], []);
    await seedHistoricalVotes(db, round, ['up']);
    const stored = await db.prepare('SELECT * FROM votes').first();
    await assert.rejects(db.prepare('INSERT INTO votes(round_id,voter_hash,choice,accepted_at) VALUES (?,?,?,?)').bind(round.id, stored.voter_hash, 'down', stored.accepted_at).run(), /UNIQUE constraint/);
  });
});

describe('request validation and CSRF protection', () => {
  test('rejects wrong method and missing, null, cross-site, subdomain, and wrong-port origins', async () => {
    const config = configFor();
    await assertError(await vote(voteRequest(undefined, {}, { method: 'GET' }), db, config), 405, 'METHOD');
    for (const origin of [null, 'null', 'https://evil.test', 'https://sub.poll.example.test', `${ORIGIN}:444`, `${ORIGIN}.evil.test`]) {
      await assertError(await vote(voteRequest(undefined, {}, { headers: { origin } }), db, config), 403, 'ORIGIN');
    }
    assert.equal(await count(db, 'voters'), 0);
    assert.equal(await count(db, 'attempts'), 0);
  });
  test('rejects form/text bodies and near-match media types rather than accepting a JSON prefix', async () => {
    for (const type of [null, 'text/plain', 'application/x-www-form-urlencoded', 'application/jsonevil']) {
      await assertError(await vote(voteRequest(undefined, {}, { headers: { 'content-type': type } }), db, configFor()), 415, 'CONTENT_TYPE');
    }
    const round = fixture(await dbNow(db));
    const config = configFor([round]);
    const { cookie } = await session(db, config);
    assert.equal((await vote(voteRequest(cookie, { roundId: round.id, choice: 'up' }, { headers: { 'content-type': 'application/json; charset=utf-8' } }), db, config)).status, 200);
  });
  test('rejects malformed JSON and invalid choices, extra fields, or client timestamps', async () => {
    await assertError(await vote(voteRequest(undefined, {}, { raw: '{' }), db, configFor()), 400, 'JSON');
    for (const body of [null, [], 'up', {}, { roundId: 123, choice: 'up' }, { roundId: 'x'.repeat(81), choice: 'up' }, { roundId: 'x', choice: 'UP' }, { roundId: 'x', choice: 'sideways' }, { roundId: 'x', choice: 'up', acceptedAt: 1 }, { roundId: 'x', choice: 'up', now: 1 }, { roundId: 'x', choice: 'up', timestamp: '2020-01-01' }]) {
      await assertError(await vote(voteRequest(undefined, body), db, configFor()), 400, 'CHOICE');
    }
    assert.equal(await count(db, 'votes'), 0);
  });
  test('limits advertised and actual UTF-8 bytes, including streamed bodies without content-length', async () => {
    await assertError(await vote(voteRequest(undefined, {}, { headers: { 'content-length': '1025' } }), db, configFor()), 413, 'SIZE');
    await assertError(await vote(voteRequest(undefined, {}, { raw: 'x'.repeat(1025), headers: { 'content-length': '1' } }), db, configFor()), 413, 'SIZE');
    const encoder = new TextEncoder();
    const stream = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('한'.repeat(200))); controller.enqueue(encoder.encode('한'.repeat(200))); controller.close(); } });
    await assertError(await vote(voteRequest(undefined, {}, { raw: stream }), db, configFor()), 413, 'SIZE');
  });
  test('unknown round does not accept a vote', async () => {
    const { cookie } = await session(db);
    await assertError(await vote(voteRequest(cookie, { roundId: 'KOSPI:2026-10-01', choice: 'up' }), db, configFor()), 404, 'ROUND_NOT_FOUND');
    assert.equal(await count(db, 'votes'), 0);
  });
});

describe('database-clock opening and exact cutoff', () => {
  test('before open is locked and does not expose the selected symbol', async () => {
    const now = await dbNow(db);
    const round = fixture(now, { opensAt: iso(now + 120), deadline: iso(now + 1920), closesAt: iso(now + 5520), revealAt: iso(now + 5520) });
    const config = configFor([round]);
    const { cookie, data } = await session(db, config);
    assert.equal(data.rounds[0].status, 'upcoming');
    assert.equal(data.rounds[0].symbol, '');
    assert.equal(data.rounds[0].tally, null);
    await assertError(await vote(voteRequest(cookie, { roundId: round.id, choice: 'up' }), db, config), 409, 'NOT_OPEN');
  });
  test('opening second is inclusive', async () => {
    const now = await dbNow(db);
    const round = fixture(now, { opensAt: iso(now), deadline: iso(now + 1800), closesAt: iso(now + 5400), revealAt: iso(now + 5400) });
    const config = configFor([round]);
    const { cookie } = await session(db, config);
    assert.equal((await vote(voteRequest(cookie, { roundId: round.id, choice: 'up' }), db, config)).status, 200);
  });
  test('last second before cutoff accepts; the exact database cutoff second rejects', { timeout: 15000 }, async () => {
    const target = await dbNow(db) + 3;
    const round = fixture(target, { opensAt: iso(target - 1800), deadline: iso(target), closesAt: iso(target + 3600), revealAt: iso(target + 3600) });
    const config = configFor([round]);
    const early = await session(db, config);
    const late = await session(db, config);
    assert.equal(await waitUntilDatabaseSecond(db, target - 1), target - 1);
    assert.equal((await vote(voteRequest(early.cookie, { roundId: round.id, choice: 'up' }), db, config)).status, 200);
    assert.equal((await db.prepare('SELECT accepted_at FROM votes').first()).accepted_at, target - 1);
    assert.equal(await waitUntilDatabaseSecond(db, target), target);
    await assertError(await vote(voteRequest(late.cookie, { roundId: round.id, choice: 'down' }), db, config), 410, 'CLOSED');
    assert.equal(await count(db, 'votes'), 1);
    assert.equal((await session(db, config, late.cookie)).data.rounds[0].status, 'locked');
  });
  test('changing JavaScript/client clocks does not reopen a closed database-time round', async () => {
    const now = await dbNow(db);
    const round = closedFixture(now);
    const config = configFor([round]);
    const { cookie } = await session(db, config);
    const original = Date.now;
    Date.now = () => 0;
    try { await assertError(await vote(voteRequest(cookie, { roundId: round.id, choice: 'up' }), db, config), 410, 'CLOSED'); }
    finally { Date.now = original; }
    assert.equal(await count(db, 'votes'), 0);
  });
});

describe('privacy and browser-only rate limit', () => {
  test('open and locked pre-reveal state expose no tally or total, including direct API response', async () => {
    const now = await dbNow(db);
    const rounds = [fixture(now), fixture(now, { id: 'NASDAQ:2026-10-09', market: 'NASDAQ', opensAt: iso(now - 1801), deadline: iso(now - 1), closesAt: iso(now + 3599), revealAt: iso(now + 3599) })];
    const config = configFor(rounds);
    await syncReleases(db, CONFIRMED, rounds, []);
    for (const round of rounds) await seedHistoricalVotes(db, round, ['up', 'down', 'up']);
    const { data } = await session(db, config);
    assert.deepEqual(data.rounds.map(r => r.status).sort(), ['locked', 'open']);
    for (const round of data.rounds) {
      assert.equal(round.tally, null);
      assert.equal(round.result, null);
      assert.equal('total' in round, false);
      assert.equal('up' in round, false);
      assert.equal('down' in round, false);
    }
    assert.doesNotMatch(JSON.stringify(data), /"(?:total|up|down)":/);
  });
  test('eleventh attempt in the same browser bucket is rate-limited without changing the vote', async () => {
    const round = fixture(await dbNow(db));
    const config = configFor([round]);
    const { cookie } = await session(db, config);
    const hash = await hashToken(cookie.split('=')[1]);
    await db.prepare('INSERT INTO attempts(voter_hash,bucket,count) VALUES (?,unixepoch()/60,10)').bind(hash).run();
    await assertError(await vote(voteRequest(cookie, { roundId: round.id, choice: 'up' }), db, config), 429, 'RATE_LIMIT');
    assert.equal(await count(db, 'votes'), 0);
    await db.prepare('DELETE FROM attempts WHERE voter_hash=?').bind(hash).run();
    await db.prepare('INSERT INTO attempts(voter_hash,bucket,count) VALUES (?,(unixepoch()/60)-1,100)').bind(hash).run();
    assert.equal((await vote(voteRequest(cookie, { roundId: round.id, choice: 'up' }), db, config)).status, 200);
  });
  test('15 browsers sharing identical IP and user-agent all vote independently', async () => {
    const round = fixture(await dbNow(db));
    const config = configFor([round]);
    const sessions = await Promise.all(Array.from({ length: 15 }, () => session(db, config)));
    const responses = await Promise.all(sessions.map(({ cookie }) => vote(voteRequest(cookie, { roundId: round.id, choice: 'up' }, { headers: { 'cf-connecting-ip': '192.0.2.1', 'x-forwarded-for': '192.0.2.1', 'user-agent': 'Same shared browser family' } }), db, config)));
    assert.ok(responses.every(r => r.status === 200));
    assert.equal(await count(db, 'votes'), 15);
    const tables = await db.prepare("SELECT sql FROM sqlite_master WHERE type='table'").all();
    assert.doesNotMatch(tables.results.map(r => r.sql).join(' '), /email|ip_address|fingerprint|user_agent|phone|authenticated_user/i);
  });
  test('old rate buckets are pruned during voting', async () => {
    const round = fixture(await dbNow(db));
    const config = configFor([round]);
    const { cookie } = await session(db, config);
    await db.prepare('INSERT INTO attempts(voter_hash,bucket,count) VALUES (?,(unixepoch()/60)-10,7)').bind(await hashToken(cookie.split('=')[1])).run();
    assert.equal((await vote(voteRequest(cookie, { roundId: round.id, choice: 'up' }), db, config)).status, 200);
    assert.equal(await count(db, 'attempts'), 1);
  });
});

describe('auditable releases and deterministic scoring', () => {
  test('rejects unconfirmed rules, bad timing, shortened voting windows, and reveal-before-close', async () => {
    const round = fixture(await dbNow(db));
    await assert.rejects(syncReleases(db, { ...RULES, rulesConfirmed: false }, [round], []), /규칙 확정/);
    await assert.rejects(syncReleases(db, { ...CONFIRMED, noScorePolicyConfirmed: false }, [round], []), /규칙 확정/);
    await assert.rejects(syncReleases(db, CONFIRMED, [{ ...round, deadline: 'bad' }], []), /Invalid round times/);
    await assert.rejects(syncReleases(db, CONFIRMED, [{ ...round, deadline: iso(parse(round.deadline) - 1) }], []), /voting window/);
    await assert.rejects(syncReleases(db, CONFIRMED, [{ ...round, revealAt: round.deadline }], []), /before market close/);
    await assert.rejects(syncReleases(db, CONFIRMED, [{ ...round, draw: { ...round.draw, validated: false } }], []), /Unverified calendar/);
    assert.equal(await count(db, 'rounds'), 0);
  });
  test('round releases are idempotent and immutable', async () => {
    const round = fixture(await dbNow(db));
    await syncReleases(db, CONFIRMED, [round], []);
    await syncReleases(db, CONFIRMED, [round], []);
    assert.equal(await count(db, 'rounds'), 1);
    await assert.rejects(syncReleases(db, CONFIRMED, [{ ...round, symbol: 'CHANGED' }], []), /immutable/);
    assert.equal(JSON.parse((await db.prepare('SELECT config_json FROM rounds').first()).config_json).symbol, 'TEST-ONLY');
  });
  test('future close prevents premature result event insertion', async () => {
    const round = fixture(await dbNow(db));
    await syncReleases(db, CONFIRMED, [round], [eventFixture(round)]);
    assert.equal(await count(db, 'result_events'), 0);
  });
  test('invalid event timestamps, unaudited prices, invalid decimals, and broken correction chains fail closed', async () => {
    const round = closedFixture(await dbNow(db));
    await syncReleases(db, CONFIRMED, [round], []);
    for (const patch of [{ observedAt: 'not-a-date' }, { asOf: 'not-a-date' }, { asOf: iso(parse(round.closesAt) - 1) }, { sourceUrl: 'javascript:alert(1)' }, { sourceUrl: '/relative' }, { sourceLabel: '' }, { sessionDate: '2000-01-01' }, { currency: 'EUR' }, { observedAt: iso(parse(round.closesAt) - 1) }, { sourceVerified: false }, { regularSessionComplete: false }, { open: 'NaN' }, { close: '-1' }, { open: '0' }, { close: 101 }, { revision: 2 }, { revision: 2, correctsEventId: 'missing' }, { correctsEventId: 'missing' }]) {
      await assert.rejects(syncReleases(db, CONFIRMED, [round], [eventFixture(round, patch)]));
    }
    assert.equal(await count(db, 'result_events'), 0);
  });
  test('event IDs and round/revision pairs cannot be silently overwritten or ignored', async () => {
    const round = closedFixture(await dbNow(db));
    const event = eventFixture(round);
    await syncReleases(db, CONFIRMED, [round], [event]);
    await assert.rejects(syncReleases(db, CONFIRMED, [round], [{ ...event, close: '999' }]), /immutable/);
    await assert.rejects(syncReleases(db, CONFIRMED, [round], [{ ...event, id: 'conflicting-event-same-revision' }]), /already published/);
    assert.equal(await count(db, 'result_events'), 1);
  });
  test('revealed tally is exact and repeated reads/releases do not accumulate score', async () => {
    const now = await dbNow(db);
    const humanRound = closedFixture(now);
    const chimpRound = closedFixture(now, { id: 'NASDAQ:2026-10-09', market: 'NASDAQ' });
    const rounds = [humanRound, chimpRound];
    const events = [eventFixture(humanRound), eventFixture(chimpRound)];
    const config = configFor(rounds, events);
    await syncReleases(db, CONFIRMED, rounds, events);
    await seedHistoricalVotes(db, humanRound, ['up', 'up', 'down']);
    await seedHistoricalVotes(db, chimpRound, ['down', 'down', 'up']);
    for (let i = 0; i < 3; i++) {
      const { data } = await session(db, config);
      assert.deepEqual(data.score, { humans: 1, chimp: 1 });
      const human = data.rounds.find(r => r.id === humanRound.id);
      assert.deepEqual(human.tally, { up: 2, down: 1, total: 3 });
      assert.equal(human.result.winner, 'humans');
      assert.equal(human.result.actualDirection, 'up');
      assert.equal(human.status, 'settled');
    }
    assert.equal(await count(db, 'result_events'), 2);
  });
  test('a correction appends history, reverses the derived score once, and preserves original event', async () => {
    const round = closedFixture(await dbNow(db));
    const first = eventFixture(round);
    await syncReleases(db, CONFIRMED, [round], [first]);
    await seedHistoricalVotes(db, round, ['up', 'up', 'down']);
    assert.deepEqual((await session(db, configFor([round], [first]))).data.score, { humans: 1, chimp: 0 });
    const correction = { ...first, id: `${round.id}:result:2`, revision: 2, correctsEventId: first.id, close: '99.00', reason: 'Test-only official correction' };
    for (let i = 0; i < 3; i++) {
      const { data } = await session(db, configFor([round], [first, correction]));
      assert.deepEqual(data.score, { humans: 0, chimp: 1 });
      assert.equal(data.rounds[0].result.revision, 2);
      assert.deepEqual(data.rounds[0].result.auditHistory.map(event => event.revision), [1, 2]);
      assert.deepEqual(data.rounds[0].result.auditHistory.map(event => event.winner), ['humans', 'chimp']);
      assert.equal(data.rounds[0].result.auditHistory[1].correctsEventId, first.id);
    }
    assert.equal(await count(db, 'result_events'), 2);
    assert.deepEqual(JSON.parse((await db.prepare('SELECT payload_json FROM result_events WHERE id=?').bind(first.id).first()).payload_json), first);
  });
  test('stored result and audit history remain private until the scheduled reveal even after close', async () => {
    const now = await dbNow(db);
    const round = closedFixture(now, { revealAt: iso(now + 3600) });
    const event = eventFixture(round);
    await syncReleases(db, CONFIRMED, [round], [event]);
    await seedHistoricalVotes(db, round, ['up', 'up', 'down']);
    const { data } = await session(db, configFor([round], [event]));
    assert.equal(await count(db, 'result_events'), 1);
    assert.equal(data.rounds[0].result, null);
    assert.equal(data.rounds[0].tally, null);
    assert.equal(data.rounds[0].status, 'locked');
    assert.deepEqual(data.score, { humans: 0, chimp: 0 });
    assert.doesNotMatch(JSON.stringify(data), /auditHistory|test-prices/);
  });
  test('a void event gives no point and preserves its explanation', async () => {
    const round = closedFixture(await dbNow(db));
    const event = eventFixture(round, { status: 'void', reason: 'Test-only market data invalid' });
    await syncReleases(db, CONFIRMED, [round], [event]);
    await seedHistoricalVotes(db, round, ['up']);
    const { data } = await session(db, configFor([round], [event]));
    assert.deepEqual(data.score, { humans: 0, chimp: 0 });
    assert.equal(data.rounds[0].status, 'void');
    assert.equal(data.rounds[0].result.winner, null);
    assert.equal(data.rounds[0].result.reason, event.reason);
  });
  test('tie, no votes, and equal open/close never award points', () => {
    const event = { status: 'verified', open: '100', close: '101' };
    assert.equal(outcome(event, { up: 0, down: 0, total: 0 }).winner, null);
    assert.equal(outcome(event, { up: 2, down: 2, total: 4 }).winner, null);
    assert.equal(outcome({ ...event, close: '100.000' }, { up: 2, down: 1, total: 3 }).winner, null);
    assert.equal(outcome({ ...event, open: '9007199254740992.01', close: '9007199254740992.02' }, { up: 2, down: 1, total: 3 }).winner, 'humans');
    assert.equal(outcome({ ...event, open: '0.00000002', close: '0.00000001' }, { up: 2, down: 1, total: 3 }).winner, 'chimp');
  });
});

test('local D1 persists votes across disposal and reopening of the runtime', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anonymous-poll-persistence-'));
  let persistent = createMiniflare(directory);
  try {
    let storage = await persistent.getD1Database('DB');
    await migrate(storage);
    const round = fixture(await dbNow(storage));
    const config = configFor([round]);
    const { cookie } = await session(storage, config);
    assert.equal((await vote(voteRequest(cookie, { roundId: round.id, choice: 'up' }), storage, config)).status, 200);
    await persistent.dispose();
    persistent = createMiniflare(directory);
    storage = await persistent.getD1Database('DB');
    const reread = await session(storage, config, cookie);
    assert.equal(reread.data.rounds[0].myVote, 'up');
    assert.equal(reread.setCookie, null);
    await assertError(await vote(voteRequest(cookie, { roundId: round.id, choice: 'down' }), storage, config), 409, 'ALREADY_VOTED');
    assert.equal(await count(storage, 'votes'), 1);
  } finally { await persistent.dispose(); await rm(directory, { recursive: true, force: true }); }
});

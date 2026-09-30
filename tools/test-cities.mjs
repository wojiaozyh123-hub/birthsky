#!/usr/bin/env node
// Smoke test for src/js/cities.js against the generated src/data/cities.json.
//   node tools/test-cities.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DATA_URL = new URL('../src/data/cities.json', import.meta.url);

// fetch shim: Node's fetch cannot read file: URLs
globalThis.fetch = async (url) => {
  const text = await readFile(fileURLToPath(new URL(String(url))), 'utf8');
  return { ok: true, status: 200, json: async () => JSON.parse(text) };
};

const { loadCities, citiesReady, searchCities, getCity, nearestCity, guessHomeCity } = await import('../src/js/cities.js');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message.split('\n').join('\n       ')}`);
  }
}
const top = (q) => searchCities(q)[0] ?? {};
const brief = (r) => `${r.label} [${r.en}, ${r.cc}, ${r.tz}]`;

assert.equal(citiesReady(), false);
assert.equal(guessHomeCity(), null, 'guessHomeCity() is null before load');
assert.deepEqual(searchCities('杭州'), [], 'search returns [] before load');
const n = await loadCities(DATA_URL);
const again = loadCities(DATA_URL);
assert.equal(await again, n, 'loadCities is memoized');
assert.equal(citiesReady(), true);
console.log(`loaded ${n} cities\n`);

console.log('search:');
check('杭州 -> Hangzhou, 浙江, Asia/Shanghai', () => {
  const r = top('杭州');
  assert.equal(r.en, 'Hangzhou');
  assert.equal(r.region, '浙江');
  assert.equal(r.tz, 'Asia/Shanghai');
  assert.equal(r.label, '杭州 · 浙江');
});
check('hangzhou -> Hangzhou', () => assert.equal(top('hangzhou').en, 'Hangzhou'));
check(' HangZhou  -> Hangzhou (trim/case)', () => assert.equal(top(' HangZhou ').en, 'Hangzhou'));
check('杭州市 -> Hangzhou', () => assert.equal(top('杭州市').en, 'Hangzhou'));
check('多伦多 -> Toronto, America/Toronto', () => {
  const r = top('多伦多');
  assert.equal(r.en, 'Toronto');
  assert.equal(r.tz, 'America/Toronto');
  assert.equal(r.label, '多伦多 · 安大略 · 加拿大');
});
check('toronto -> Toronto', () => assert.equal(top('toronto').tz, 'America/Toronto'));
check('北京 -> Beijing', () => {
  const r = top('北京');
  assert.equal(r.en, 'Beijing');
  assert.equal(r.label, '北京');
});
check('香港 -> Hong Kong, Asia/Hong_Kong', () => {
  const r = top('香港');
  assert.equal(r.en, 'Hong Kong');
  assert.equal(r.tz, 'Asia/Hong_Kong');
});
check('台北 -> Taipei, Asia/Taipei', () => {
  const r = top('台北');
  assert.equal(r.en, 'Taipei');
  assert.equal(r.tz, 'Asia/Taipei');
});
check('纽约 -> New York City, America/New_York', () => {
  const r = top('纽约');
  assert.equal(r.en, 'New York City');
  assert.equal(r.tz, 'America/New_York');
});
check('london -> London GB, Europe/London', () => {
  const r = top('london');
  assert.equal(r.cc, 'GB');
  assert.equal(r.tz, 'Europe/London');
});
check('悉尼 -> Sydney AU', () => {
  const r = top('悉尼');
  assert.equal(r.en, 'Sydney');
  assert.equal(r.cc, 'AU');
});
check('朝阳 -> several distinct cities incl. 辽宁', () => {
  const rs = searchCities('朝阳');
  assert.ok(rs.length >= 2, `only ${rs.length} result(s)`);
  assert.equal(new Set(rs.map((r) => r.label)).size, rs.length, 'labels not distinct');
  assert.ok(rs.some((r) => r.region === '辽宁'), 'no 辽宁 朝阳');
  assert.ok(rs.some((r) => r.region !== '辽宁'), 'no second 朝阳');
});
check('朝阳 吉林 -> region-qualified first', () => assert.equal(top('朝阳 吉林').region, '吉林'));
check('london ca -> London, Ontario', () => assert.equal(top('london ca').tz, 'America/Toronto'));
check('sao paulo -> São Paulo (diacritics)', () => assert.equal(top('sao paulo').en, 'São Paulo'));
check("xi'an / xian -> Xi’an", () => {
  assert.equal(top("xi'an").region, '陕西');
  assert.equal(top('xian').region, '陕西');
});
check('limit is honoured', () => assert.equal(searchCities('a', 3).length, 3));
check('empty / garbage query -> []', () => {
  assert.deepEqual(searchCities('   '), []);
  assert.deepEqual(searchCities('zzqqxx'), []);
});

console.log('\nother API:');
check('getCity(id) round-trips', () => {
  const r = top('杭州');
  assert.deepEqual(getCity(r.id), r);
  assert.equal(getCity(-1), null);
  assert.equal(getCity(1e9), null);
});
check('nearestCity(West Lake) -> Hangzhou', () => assert.equal(nearestCity(30.25, 120.14).en, 'Hangzhou'));
check('nearestCity(Brooklyn-ish) -> New York City (populous within 15 km)', () =>
  assert.equal(nearestCity(40.65, -73.95).en, 'New York City'));
check('nearestCity(mid-Pacific) -> something, no throw', () => assert.ok(nearestCity(0, -160)));
check('guessHomeCity() -> a city in this machine tz (or 北京)', () => {
  const r = guessHomeCity();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.ok(r, 'null');
  console.log(`       (host tz ${tz} -> ${brief(r)})`);
});

console.log('\ndata:');
const json = JSON.parse(await readFile(DATA_URL, 'utf8'));
check(`every tz is valid for Intl (${json.tz.length} ids)`, () => {
  const bad = json.tz.filter((timeZone) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone });
      return false;
    } catch {
      return true;
    }
  });
  assert.deepEqual(bad, []);
});
check('every row well-formed', () => {
  for (const [zh, en, a1, cc, lat, lon, tz, pop] of json.c) {
    assert.ok(typeof zh === 'string' && typeof en === 'string' && en);
    assert.ok(a1 === -1 || (a1 >= 0 && a1 < json.a1.length));
    assert.ok(json.cc[cc], `no country name for ${cc}`);
    assert.ok(Math.abs(lat) <= 90 && Math.abs(lon) <= 180);
    assert.ok(tz >= 0 && tz < json.tz.length && Number.isInteger(pop));
  }
});

console.log('\ntiming:');
const queries = ['杭州', 'hangzhou', '多伦多', 'toronto', '朝阳', 'san', 'a', '市', 'new york', '朝阳 辽宁', '圣'];
const t0 = performance.now();
const rounds = 50;
for (let i = 0; i < rounds; i++) for (const q of queries) searchCities(q);
const per = (performance.now() - t0) / (rounds * queries.length);
console.log(`  ${per.toFixed(3)} ms per query (avg over ${queries.length} queries x ${rounds})`);
check('search < 5 ms per query', () => assert.ok(per < 5));

console.log('\nsamples:');
for (const q of ['杭州', 'toronto', '朝阳', '香港', '台中', 'london', '悉尼', '宝安区', '吉隆坡', 'waterloo']) {
  console.log(`  ${q.padEnd(10)} → ${searchCities(q, 3).map(brief).join('  |  ')}`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);

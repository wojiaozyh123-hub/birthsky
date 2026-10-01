// Content tests for copy.js / facts.js / hepan.js / share.js, run in Node with tiny fetch/DOM shims.
//   node tools/dev/test-content.mjs            assertions + the printed copy for a few real nights
//   node tools/dev/test-content.mjs --quiet    assertions only
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import qrcode from 'qrcode-generator';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const quiet = process.argv.includes('--quiet');
const log = (...a) => { if (!quiet) console.log(...a); };

// ---------------------------------------------------------------- shims (catalog.js needs fetch, Image, canvas)
globalThis.fetch = async (url) => {
  const f = path.join(root, 'src', String(url).split('?')[0]);
  const buf = fs.readFileSync(f);
  return {
    ok: true, status: 200,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    json: async () => JSON.parse(buf.toString('utf8')),
  };
};
globalThis.Image = class { set src(v) { this._src = v; setTimeout(() => this.onload?.(), 0); } get src() { return this._src; } };
globalThis.document = {
  createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) }) }),
};
globalThis.location = { origin: 'https://wojiaozyh123-hub.github.io', pathname: '/birthsky/', search: '', hash: '' };

const { loadCatalog } = await import('../../src/js/catalog.js');
const { zonedToUtc, skyState, altAz, mul } = await import('../../src/js/astro.js');
const copy = await import('../../src/js/copy.js');
const facts = await import('../../src/js/facts.js');
const { computeHepan } = await import('../../src/js/hepan.js');
const share = await import('../../src/js/share.js');
const { T, DISPLAY_STRINGS, noWidow, wrapCanvas, fmtWhen, fmtDot, fmtCount, cjk } = copy;

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
};

const catalog = await loadCatalog('data/');
const momentOf = (p) => {
  const [y, m, d] = p.date.split('-').map(Number);
  const [hh, mm] = p.time.split(':').map(Number);
  return zonedToUtc(y, m, d, hh, mm, p.city.tz);
};
const NOW = new Date('2026-09-30T12:00:00+08:00');

const CITY = {
  杭州: { name: '杭州', region: '浙江', lat: 30.29, lon: 120.16, tz: 'Asia/Shanghai' },
  成都: { name: '成都', region: '四川', lat: 30.66, lon: 104.07, tz: 'Asia/Shanghai' },
  北京: { name: '北京', region: '北京', lat: 39.90, lon: 116.40, tz: 'Asia/Shanghai' },
  Sydney: { name: '悉尼', region: '新南威尔士', lat: -33.87, lon: 151.21, tz: 'Australia/Sydney' },
  Toronto: { name: 'Toronto', region: 'Ontario', lat: 43.65, lon: -79.38, tz: 'America/Toronto' },
  Quito: { name: '基多', region: '皮钦查', lat: -0.22, lon: -78.51, tz: 'America/Guayaquil' },
};
const person = (name, date, time, city, unknownTime = false) => ({ name, date, time, unknownTime, city: CITY[city] });

// ---------------------------------------------------------------- copy.js
test('DISPLAY_STRINGS verbatim', () => {
  assert.deepEqual(DISPLAY_STRINGS, ['你来的那晚', '这一夜，你来到世上', '两个人的星空', '你是哪一天来到这世上的？', 'TA 是哪一天来到这世上的？', '你是这一天来的吗？', '那一夜', '关于']);
  // every fixed title that is set in the display serif is one of them
  for (const s of [T.intro.title, T.arrive.titleOwn, T.pairInvite.title, T.form.title, T.form.partnerTitle, T.form.confirmTitle, T.night.title, T.about.title, T.gift.formTitle, T.gift.receiverTitle]) {
    assert.ok(DISPLAY_STRINGS.includes(s), s);
  }
});

test('formatters', () => {
  const p = person('小明', '1998-07-14', '22:00', '杭州');
  assert.equal(fmtWhen(p), '1998 年 7 月 14 日 22:00 · 杭州');
  assert.equal(fmtWhen(p, { name: true }), '小明 · 1998 年 7 月 14 日 22:00 · 杭州');
  assert.equal(fmtWhen({ ...p, unknownTime: true }), '1998 年 7 月 14 日 夜里 · 杭州');
  assert.equal(fmtWhen(p, { at: { y: 1998, m: 7, d: 15, hh: 1, mm: 5 } }), '1998 年 7 月 15 日 01:05 · 杭州');
  assert.equal(fmtDot(p), '1998.07.14');
  assert.equal(fmtDot({ y: 2026, m: 9, d: 30 }), '2026.09.30');
  assert.equal(fmtCount(4267), '4,267');
  assert.equal(fmtCount(1234567), '1,234,567');
  assert.equal(fmtCount(12), '12');
  assert.equal(copy.fmtMag(-1.23), '−1.2');
  assert.equal(copy.fmtMag(-0.02), '0.0');
  assert.equal(copy.fmtDeg(10.44, 1), '10.4°');
  assert.equal(T.rewind.counter(new Date(2026, 8, 30), p), '2026.09.30 → 1998.07.14');
  assert.equal(T.rewind.ago(momentOf(p), NOW), '28 年，一夜一夜往回走');
  assert.equal(T.rewind.ago(new Date(NOW.getTime() - 45 * 86400000), NOW), '往回走 45 个夜晚');
  assert.equal(T.rewind.place(p), '杭州 · 小明');
  assert.equal(T.rewind.place({ ...p, name: '' }), '杭州');
  assert.equal(T.arrive.sub(p), '22:00 · 杭州');
  assert.equal(T.arrive.sub({ ...p, unknownTime: true }), '夜里 · 杭州');
  assert.equal(T.ruler.rel(100), '出生后 1 小时 40 分');
  assert.equal(T.ruler.rel(-120), '出生前 2 小时');
  assert.equal(T.ruler.rel(0), '出生那一刻');
  assert.equal(T.export.cardDate(p), '1998.07.14  22:00');
  assert.equal(T.export.cardPlace(p), '杭州 · 小明来的那一夜');
  assert.equal(T.export.cardPlace({ ...p, name: '' }), '杭州');
  assert.equal(T.result.fileName(p, 'wallpaper'), '你来的那晚-1998-07-14-壁纸.jpg');
  assert.equal(T.result.fileName(p, 'gift'), '你来的那晚-1998-07-14-贺卡.jpg');
  assert.equal(T.gift.fileName(p), T.result.fileName(p, 'gift'));
});

test('cjk spacing', () => {
  assert.equal(cjk`发给${'TA'}，请${'TA'}填生日`, '发给 TA，请 TA 填生日');
  assert.equal(cjk`今晚${'小明'}看到的`, '今晚小明看到的');
  assert.equal(cjk`那年${'TA'} ${3} 岁`, '那年 TA 3 岁');
  assert.equal(T.arrive.titleGuest('小明'), '这一夜，小明来到世上');
  assert.equal(T.arrive.titleGuest(''), '这一夜，TA 来到世上');
  assert.equal(T.guest.together('小明'), '和小明一起看');
  assert.equal(T.guest.together('欧阳娜娜酱'), '和 TA 一起看');
  assert.equal(T.link.person(person('', '1998-07-14', '22:00', '杭州')), '有人想领你去一个很远的夜晚：\n1998 年 7 月 14 日，杭州的星空下。');
  assert.equal(T.titles.person(person('', '1998-07-14', '22:00', '杭州')), '我出生那一夜，杭州的星空是这样的｜你来的那晚');
  assert.equal(T.titles.person(person('小明', '1998-07-14', '22:00', '杭州')), '小明出生那一夜，头顶是这样一片星空｜你来的那晚');
  assert.equal(T.titles.invite(person('小明', '1998-07-14', '22:00', '杭州')), '小明想把你们来的那两夜，放进同一片天空｜你来的那晚');
  assert.equal(T.titles.result({ name: '小明' }, { name: '小红' }, 3316), '小明和小红：3,316 颗星，照过我们两个｜你来的那晚');
  assert.equal(T.titles.result({}, {}, 3316), '3,316 颗星，曾照过我们两个人｜你来的那晚');
  assert.deepEqual(T.share.guide('result', '小红'), ['点右上角 ···', '把这片星空，也捎给小红']);
  // 两处必须一致: the tour caption and the 那一夜 row
  assert.equal(T.tour.planetsNone, T.night.planetsNone);
  assert.equal(T.tour.count('4,267'), T.night.count('4,267'));
  // 星空贺卡 (poster.js giftCardText)
  assert.equal(T.gift.cardTo('小红'), '给 小红');
  assert.equal(T.gift.cardTo(''), '给 你');
  assert.equal(T.gift.cardFrom('小明'), '小明 赠');
  assert.equal(T.gift.cardWhose('成都', '小红'), '成都 · 小红来的那一夜');
  assert.equal(T.gift.cardWhose('成都', ''), '成都');
  assert.equal(T.gift.cardWhose('Toronto', 'Tom'), 'Toronto · Tom 来的那一夜');
  assert.equal(T.export.giftQrCaption, '长按识别，回到你来的那晚');
  assert.equal(T.gift.receiverLede('小明', person('', '2000-05-20', '23:10', '成都')), '小明为你寻回了一片星空：\n2000 年 5 月 20 日，成都，你来的那一夜。');
  assert.equal(T.tour.poemPlace('TA', '杭州'), '诗里的杭州，正是 TA 出生的地方。');
});

test('noWidow', () => {
  const tailOf = (html) => html.match(/<span class="nw">([^<]*)<\/span>(?:<br>)?$/)?.[1];
  const h = noWidow('那晚是一轮亏凸月，被照亮 73%。月光从那里出发，1.3 秒后落进你的眼睛。');
  log('  ', h);
  assert.ok(h.includes('<span class="nw">73%。</span>') || h.includes('照亮 73%。</span>'), 'first sentence tail');
  assert.ok(h.endsWith('<span class="nw">你的眼睛。</span>'));
  assert.ok(h.includes('<span class="nw">1.3 秒</span>'), 'number stays with its unit');
  // a line without 。 is one sentence: its last 4 characters (punctuation included) stay together
  const two = noWidow('小明想让你看看，\n1998 年 7 月 14 日，杭州的夜空。');
  assert.equal(two.split('<br>').length, 2);
  assert.ok(two.split('<br>')[0].endsWith('<span class="nw">你看看，</span>'), two);
  assert.ok(two.includes('<span class="nw">1998 年</span>'), two);
  // spaces are not counted: 「你 3 岁。」 stays together
  assert.equal(tailOf(noWidow('那年你 3 岁。')), '你 3 岁。');
  assert.equal(noWidow('<b>&'), '&lt;b&gt;&amp;');
  assert.equal(noWidow('1179 × 2556'), '1179 × 2556');
  // names registered by facts.js never break
  copy.keepWords(['天纪二']);
  assert.ok(noWidow('离你头顶最近的亮星，是武仙座的天纪二，距离地球 35 光年。').includes('<span class="nw">天纪二，</span>'));
  // stripping the markup gives the text back
  for (const s of ['今晚你看到的织女星，光是在 2001 年出发的，那年你 3 岁。', '把你们相差的 4.2 年换成光走过的路，差不多能从这里抵达南门二（4.3 光年）。']) {
    assert.equal(noWidow(s).replace(/<[^>]+>/g, ''), s);
  }
});

// fake 2D context: CJK/fullwidth = 1 em (30 px), everything else 0.5 em
const fakeCtx = { measureText: (s) => ({ width: [...s].reduce((w, c) => w + (/[⺀-￯—]/.test(c) ? 30 : 15), 0) }) };
test('wrapCanvas', () => {
  const s = '今晚你看到的织女星，光是在 2001 年出发的，那年你 3 岁。';
  const lines = wrapCanvas(fakeCtx, s, 700, 2);
  log('  wrapCanvas 700px:', lines);
  assert.ok(lines.length <= 2);
  for (const w of [180, 240, 300, 360, 420, 500]) {
    const ls = wrapCanvas(fakeCtx, s, w);
    const last = ls[ls.length - 1];
    assert.ok([...last.replace(/ /g, '')].length >= 3, `widow at ${w}: ${JSON.stringify(ls)}`);
    for (const l of ls) assert.ok(fakeCtx.measureText(l).width <= w, `overflow at ${w}: ${l}`);
    for (const l of ls) assert.ok(!/^[，。、；：！？）」%]/.test(l), `line starts with closer: ${l}`);
    assert.equal(ls.join('').replace(/ /g, ''), s.replace(/ /g, ''));
  }
  const cut = wrapCanvas(fakeCtx, s, 300, 2);
  assert.equal(cut.length, 2);
  assert.ok(cut[1].endsWith('…'));
  assert.deepEqual(wrapCanvas(fakeCtx, 'a\nb', 100), ['a', 'b']);
  assert.deepEqual(wrapCanvas(fakeCtx, 'Toronto Maple', 120), ['Toronto', 'Maple']);
});

test('no markup or banned copy in T', () => {
  const p = person('小明', '1998-07-14', '22:00', '杭州');
  const q = person('', '2000-01-02', '06:10', '成都', true);
  const all = [];
  const walk = (o) => {
    if (typeof o === 'string') all.push(o);
    else if (Array.isArray(o) || (o && typeof o === 'object')) Object.values(o).forEach(walk);
  };
  walk(T);
  const calls = [
    T.intro.loading(62), T.link.person(p), T.link.person(q), T.link.invite(p), T.link.invite(q), T.link.result(p, q), T.link.result(q, q),
    T.form.cityValue(p.city), T.form.inviteOver('小明'), T.form.confirmOver(''), T.form.confirmLine(p),
    T.rewind.place(p), T.arrive.sub(q), T.arrive.titleGuest('Tom'), T.meta.guest(q),
    T.hero.lightBefore('你', '大角星', 1989, 9), T.hero.lightAfter('TA', '织女星', 2001, 3), T.hero.lightSame('小明', '牛郎星', '16.7'),
    T.hero.lightYoung('TA'), T.hero.moon('你', '亏凸月', 73, '1.3'), T.hero.planet('你', '红色的', '火星', '荧惑', '12 分钟'),
    T.hero.core('TA'), T.hero.star('你', '大角星', '37 光年'), T.hero.south('你', '南', '4,267'), T.hero.day('TA', '东南'), T.hero.twilight('黄昏'),
    T.hint.drawing(1179, 2556), T.hint.pairLine('小红'), T.hint.pairIncoming(''),
    T.tour.moonUp('亏凸月', 73, '东南'), T.tour.moonDown('亏凸月'), T.tour.zenith('你', '武仙座', '天纪二', '35 光年'),
    T.tour.planets('火星在西南方，木星在东方', '你', '火星', '12 分钟'), T.tour.count('4,267'), T.tour.date('农历闰五月廿一', '小暑', 7),
    T.tour.date('农历闰五月廿一', '小暑', 0), T.tour.marker('月亮', 12), T.tour.tagMoon('亏凸月', 73), T.tour.tagPlanet('火星', '12 分钟'),
    T.night.moonUp('亏凸月', 73, '东南'), T.night.moonDown('亏凸月', 73), T.night.zenith('你', '武仙座', '天纪二'), T.night.term('小暑', 0),
    T.night.sponsor('某天文馆'), T.strip.starMeta('牧夫座', '0.0', '37 光年'), T.strip.lightBefore(1989, '你', 9), T.strip.moonStory('1.3', '你', '农历闰五月廿一'),
    T.strip.sunStory(8, 19, '你'), T.strip.below('大角星', 12), T.strip.pairOnly('小明'),
    T.ruler.rel(100), T.ruler.sunset('19:02'), T.keep.size(1179, 2556), T.keep.sentence('织女星', 2001),
    T.result.fileName(p, 'pair'), T.pair.where('小明', '杭州'), T.pair.switchTo('小红'), T.pair.date('小明', p), T.pair.headline('3,316'),
    T.pair.brightest(['大角星', '织女星', '牛郎星', '角宿一']), T.pair.vegaAltairSplit('小明', '小红'), T.pair.moons('小明', '亏凸月', '小红', '残月'),
    T.pair.moonSame('亏凸月'), T.pair.planets(['火星', '木星']), T.pair.apart('1,541', '568'), T.pair.sameCity('568'),
    T.pair.lightYears('4.2', '南门二', '4.4 光年'), T.pair.definition(64, '3,316', '5,181'), T.pair.horizon('小红'),
    T.guest.together('小明'), ...T.share.guide('invite'), T.titles.person(q, { own: false }), T.titles.invite(q), T.titles.result(p, q, 3316),
    T.export.wallDate(p, '小明'), T.export.cardDate(q), T.export.cardPlace(p), T.export.pairTitle('小明', '小红'), T.export.pairCount(3316),
    T.export.pairDates(p, q), T.export.pairWallTitle('小明', '小红', p, q), T.export.pairWallCount(3316), T.export.pairHorizon('小红'),
    T.strip.lightSame(1998, 'TA'), T.strip.lightAfter(2001, '你', 3), T.strip.lightPlain(1850), T.strip.lightBC(320), T.strip.planetLight('TA', '火星', '12 分钟'),
    T.strip.pairOnly(''), T.tour.date('', '小暑', 7), T.tour.date('', '小暑', 0), T.tour.tagLight('织女星', 2001), T.tour.poemPlace('你', '杭州'),
    T.night.poemPlace('杭州'), T.night.term('小暑', 7), T.keep.note('杜甫《旅夜书怀》', '遇见这一句的，还有 1,233 人。'), T.keep.notePlace('杭州'),
    T.link.result(q, q), T.link.result(p, { ...q, name: '' }), T.share.guide2.result(''), T.titles.result(q, q, 12),
    T.gift.arriveCaption('小红'), T.gift.arriveCaption(''), T.gift.cardWhose('成都', '小红'), T.gift.guide2(''), T.gift.receiverLede('小明', q),
    T.gift.receiverCaption('小明'), T.gift.docTitle('小明'), T.gift.fileName(q),
  ];
  for (const c of calls) { assert.equal(typeof c, 'string'); all.push(c); }
  for (const s of all) {
    assert.ok(!/<\/?(em|b|br|span)|undefined|NaN|\[object/.test(s), `bad text: ${s}`);
    assert.ok(!/合盘|时 光|星 空|冲印|生成|海报|哦/.test(s), `banned copy in ${s}`);
    // the city-page placeholder 「输入城市，如 杭州、成都、Toronto」 is verbatim spec copy
    // and 「1998 年 7 月 14 日 夜里 · 杭州」 is the spec's unknown-time date format
    if (s !== T.city.placeholder) assert.ok(!/\p{Script=Han} +\p{Script=Han}/u.test(s.replace('日 夜里', '日夜里')), `space between CJK in ${s}`);
  }
  log(`  scanned ${all.length} strings`);
  if (!quiet) calls.forEach((c) => log('   ', JSON.stringify(c)));
});

// ---------------------------------------------------------------- share.js
const people = [
  person('小明', '1998-07-14', '22:00', '杭州'),
  person('', '2000-01-02', '06:10', '成都'),
  person('小红', '1995-12-20', '23:10', '北京', true),
  person('Zoë 🌙👩‍👩‍👧', '2010-06-01', '13:00', 'Sydney'),
  person('a|b|c', '1900-01-01', '00:00', 'Toronto'),
  person('一二三四五六七八九十十一十二十三', '2079-06-06', '23:59', 'Quito'),
];

test('v2 round trip', () => {
  for (const p of people) {
    const s = share.encodePerson(p);
    assert.equal(s[0], '2');
    const q = share.decodePerson(s);
    assert.ok(q, `decode failed for ${p.name}`);
    const cap = [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(p.name)].slice(0, 12).map((x) => x.segment).join('').trim();
    assert.equal(q.name, cap);
    assert.equal(q.date, p.date);
    assert.equal(q.time, p.time);
    assert.equal(q.unknownTime, p.unknownTime);
    assert.equal(q.city.name, p.city.name);
    assert.equal(q.city.lat, p.city.lat);
    assert.equal(q.city.lon, p.city.lon);
    assert.equal(q.city.tz, p.city.tz);
    assert.equal(q.city.region, '');
    log(`  v2 ${String(s.length).padStart(3)} chars  ${p.name || '(无名)'} → ${JSON.stringify(q.name)}, ${q.date} ${q.time}${q.unknownTime ? ' 夜里' : ''}, ${q.city.name} ${q.city.lat},${q.city.lon}`);
  }
});

test('v1 still decodes', () => {
  for (const p of people) {
    const s = share.encodePersonV1(p);
    assert.equal(s[0], 'M');
    const q = share.decodePerson(s);
    assert.ok(q);
    assert.equal(q.date, p.date);
    assert.equal(q.time, p.time);
    assert.equal(q.unknownTime, p.unknownTime);
    assert.equal(q.city.name, p.city.name);
    assert.equal(q.city.region, p.city.region);
    assert.equal(q.city.tz, p.city.tz);
    assert.equal(q.name, p.name.includes('|') ? 'a b c' : [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(p.name)].slice(0, 12).map((x) => x.segment).join('').trim());
  }
  // the exact v1 string tools/qa.mjs builds
  const raw = ['1', '小明', '19980714', '2200', '0', '杭州', '浙江', '30.29', '120.16', 'Asia/Shanghai'].join('|');
  const legacy = Buffer.from(raw, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const q = share.decodePerson(legacy);
  assert.equal(q.name, '小明'); assert.equal(q.city.region, '浙江');
  // v1 and v2 of the same person decode to the same sky
  const v2 = share.decodePerson(share.encodePerson(q));
  for (const k of ['name', 'date', 'time', 'unknownTime']) assert.equal(v2[k], q[k]);
  for (const k of ['name', 'lat', 'lon', 'tz']) assert.equal(v2.city[k], q.city[k]);
});

test('garbage never decodes', () => {
  for (const s of ['', '2', '2AAAA', '2!!!', 'hello', '2' + 'A'.repeat(40), share.encodePerson(people[0]).slice(0, 12)]) {
    assert.equal(share.decodePerson(s), null, s);
  }
  // bad tz inside a well-formed v2 payload
  const bad = share.encodePerson({ ...people[0], city: { ...people[0].city, tz: 'Mars/Olympus' } });
  assert.equal(share.decodePerson(bad), null);
});

test('QR stays ≤ version 6 for a typical person', () => {
  for (const p of people.slice(0, 3)) {
    const url = share.linkFor('person', p);
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    const ver = (qr.getModuleCount() - 17) / 4;
    const v1url = `${share.baseUrl()}?p=${share.encodePersonV1(p)}`;
    const q1 = qrcode(0, 'M'); q1.addData(v1url); q1.make();
    log(`  ${url.length} chars → QR v${ver} (v1 link ${v1url.length} chars → v${(q1.getModuleCount() - 17) / 4})  ${url}`);
    assert.ok(ver <= 6, `QR version ${ver} for ${url}`);
  }
  const r = share.linkFor('result', people[0], people[2]);
  const qr = qrcode(0, 'M'); qr.addData(r); qr.make();
  log(`  result link ${r.length} chars → QR v${(qr.getModuleCount() - 17) / 4}`);
});

test('parseLink reads v1 and v2', () => {
  const save = globalThis.location.search;
  try {
    globalThis.location.search = new URL(share.linkFor('result', people[0], people[3])).search;
    const L = share.parseLink();
    assert.equal(L.kind, 'result');
    assert.equal(L.a.name, '小明');
    assert.equal(L.b.city.tz, 'Australia/Sydney');
    globalThis.location.search = `?p=${share.encodePersonV1(people[2])}`;
    const P = share.parseLink();
    assert.equal(P.kind, 'person');
    assert.equal(P.a.unknownTime, true);
  } finally { globalThis.location.search = save; }
});

test('shareFor', () => {
  const s = share.shareFor('own', { person: people[0] });
  assert.equal(s.title, '小明出生那一夜，头顶是这样一片星空｜你来的那晚');
  assert.deepEqual(s.guide, ['点右上角 ···', '寄给一个人，或发到朋友圈']);
  assert.ok(s.url.startsWith('https://wojiaozyh123-hub.github.io/birthsky/?p=2'));
  assert.deepEqual(share.shareFor('guest', { person: people[0] }).guide[1], '把这片星空，递给下一个人');
  assert.equal(share.shareFor('invite', { a: people[0] }).text, '我们来的那两夜，有多少颗星，曾照过我们两个人？');
  assert.equal(share.shareFor('result', { a: people[0], b: people[2], both: 3316 }).guide[1], '把这片星空，也捎给小红');
});

// ---------------------------------------------------------------- facts.js
const nights = [
  ['1998-07-14 22:00 杭州', person('', '1998-07-14', '22:00', '杭州')],
  ['2000-01-02 06:10 成都', person('', '2000-01-02', '06:10', '成都')],
  ['1995-12-20 23:10 北京', person('', '1995-12-20', '23:10', '北京')],
  ['2010-06-01 13:00 悉尼 (daytime)', person('', '2010-06-01', '13:00', 'Sydney')],
  ['2010-06-01 22:30 悉尼 (southern night)', person('', '2010-06-01', '22:30', 'Sydney')],
  ['2024-03-10 19:35 Toronto (dusk)', person('', '2024-03-10', '19:35', 'Toronto')],
  ['2023-08-20 21:00 杭州 (young)', person('', '2023-08-20', '21:00', '杭州')],
  ['1987-02-11 03:30 基多 (equator)', person('', '1987-02-11', '03:30', 'Quito', true)],
];

const KINDS = new Set(['light', 'moon', 'planet', 'core', 'star', 'south', 'day', 'twilight']);
const results = [];
for (const [label, p] of nights) {
  test(`facts ${label}`, () => {
    const t = momentOf(p);
    const sky = skyState(t, p.city.lat, p.city.lon);
    const f = facts.computeFacts(catalog, p, t, sky, NOW);
    const hero = facts.chooseHero(catalog, sky, f, '你');
    assert.ok(KINDS.has(hero.kind));
    assert.ok(Array.isArray(hero.n) && hero.n.length === 3);
    const tour = facts.buildTour(catalog, f, sky, hero, '你');
    const rows = facts.nightRows(f, '你');
    const tags = facts.tagsFor(catalog, sky, f);
    const guestHero = facts.heroCaption(hero, f, p.name || 'TA');
    results.push({ label, p, sky, f, hero, tour, rows, tags });
    const texts = [hero.caption, guestHero, ...tour.map((x) => x.text), ...rows.flatMap((r) => [r.text, r.meta]), ...tags.map((x) => x.text), facts.factsPeek(f), facts.lightStarShort(f)];
    for (const s of texts) {
      assert.equal(typeof s, 'string');
      assert.ok(!/[<>]|undefined|NaN|null/.test(s), `bad text: ${s}`);
      assert.ok(!/\p{Script=Han} +\p{Script=Han}/u.test(s), `space between CJK: ${s}`);
    }
    assert.equal(tour[0].hero, true);
    assert.equal(tour[0].text, hero.caption);
    assert.ok(facts.lightStarShort(f).length <= 20, facts.lightStarShort(f));
    // rules: day births face away from the Sun; night heroes sit where the rules say
    if (sky.sun.alt > -6) assert.ok(['day', 'twilight'].includes(hero.kind));
    if (hero.kind === 'light') assert.ok(hero.alt >= 12 && hero.alt <= 50);
    if (hero.kind === 'planet') assert.ok(hero.alt >= 10 && hero.alt <= 50);
    if (hero.kind === 'star') assert.ok(hero.alt >= 15 && hero.alt <= 50);
    if (hero.kind === 'south') assert.equal(hero.az, p.city.lat < 0 ? 0 : 180);
    // the hero n is where the hero is
    const aa = altAz(hero.n);
    assert.ok(Math.abs(aa.alt - hero.alt) < 0.01);
  });
}

// the priority list: brute-force a year of nights in 杭州 and check every pick against the rules
test('chooseHero rules over a year', () => {
  const counts = {};
  const p = person('', '2001-01-01', '21:00', '杭州');
  for (let d = 0; d < 366; d += 3) {
    for (const hh of [2, 5, 19, 21, 23]) {
      const date = new Date(Date.UTC(2001, 0, 1 + d, hh - 8, 0));
      const sky = skyState(date, p.city.lat, p.city.lon);
      const f = facts.computeFacts(catalog, p, date, sky, NOW);
      const h = facts.chooseHero(catalog, sky, f);
      counts[h.kind] = (counts[h.kind] || 0) + 1;
      if (sky.sun.alt > -6) { assert.ok(['day', 'twilight'].includes(h.kind)); continue; }
      const lightOk = f.light && f.light.alt >= 12 && f.light.alt <= 50;
      if (lightOk) assert.equal(h.kind, 'light');
      else if (sky.moon.alt >= 8 && sky.moon.alt <= 50) assert.ok(['moon', 'core'].includes(h.kind));
      assert.ok(h.caption && !/undefined|NaN/.test(h.caption), h.caption);
    }
  }
  log('  hero kinds over a year in 杭州:', counts);
});

// ---------------------------------------------------------------- describe
test('describe', () => {
  const r = results[0];
  const byEn = (en) => [...catalog.names.values()].find((s) => s.en === en).i;
  for (const en of ['Arcturus', 'Vega', 'Altair', 'Dubhe', 'Deneb', 'Sirius']) {
    const d = facts.describe(catalog, { type: 'star', index: byEn(en) }, r.sky, r.f, { subject: '你' });
    assert.ok(d && d.name && d.meta && d.story, en);
    assert.ok(!/<|undefined|NaN/.test(d.story + d.meta), d.story);
    if (d.below) assert.ok(d.story.startsWith('那一刻，'), d.story);
  }
  for (const id of ['Moon', 'Sun', 'Mars', 'Jupiter']) {
    const d = facts.describe(catalog, { type: 'body', id }, r.sky, r.f, { subject: '小明' });
    assert.ok(d && d.name && d.meta && d.story, id);
    assert.ok(!/<|undefined|NaN/.test(d.story + d.meta), d.story);
  }
});

// ---------------------------------------------------------------- hepan.js
test('computeHepan', () => {
  const a = person('小明', '1998-07-14', '22:00', '杭州');
  const b = person('小红', '2000-01-02', '06:10', '成都');
  const r = computeHepan(catalog, a, b, momentOf);
  assert.ok(r.both > 0 && r.either >= r.both);
  assert.equal(r.score, Math.round((r.both / r.either) * 100));
  assert.ok(r.lines.length <= 4 && r.lines.length >= 1);
  assert.ok(Math.abs(Math.hypot(...r.zB) - 1) < 1e-6);
  // zB agrees with the star count: a star is up for B iff dot(n_A, zB) > 0
  const pos = catalog.stars.pos;
  let both2 = 0;
  for (let i = 0; i < catalog.stars.count; i++) {
    const n = mul(r.sa.M, [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
    if (n[2] > 0 && n[0] * r.zB[0] + n[1] * r.zB[1] + n[2] * r.zB[2] > 0) both2++;
  }
  assert.ok(Math.abs(both2 - r.both) <= 2, `${both2} vs ${r.both}`);
  for (const s of [r.headline, ...r.lines, r.definition, r.hint, r.horizonLabel, r.where, r.switchLabel, ...r.dates]) {
    assert.ok(!/[<>]|undefined|NaN/.test(s), s);
  }
  const same = computeHepan(catalog, a, { ...a, name: '小红', time: '22:05' }, momentOf);
  assert.equal(same.nearlySame, true);
  assert.equal(same.hint, '你们的地平线，几乎叠成了同一条。');
  const anon = computeHepan(catalog, { ...a, name: '' }, { ...b, name: '' }, momentOf, { me: { ...a, name: '' } });
  assert.equal(anon.nameA, '你'); assert.equal(anon.nameB, 'TA');
  const strangers = computeHepan(catalog, { ...a, name: '' }, { ...b, name: '' }, momentOf);
  assert.notEqual(strangers.nameA, strangers.nameB);
  const swapped = computeHepan(catalog, b, a, momentOf);
  assert.equal(swapped.both, r.both);
  assert.equal(swapped.switchLabel, '看小明的天空');

  if (!quiet) {
    console.log('\n两个人 · 小明 1998-07-14 22:00 杭州 × 小红 2000-01-02 06:10 成都');
    console.log(' ', r.where, '|', r.switchLabel);
    r.dates.forEach((d) => console.log(' ', d));
    console.log(' ', r.headline);
    r.lines.forEach((l) => console.log('   ·', l));
    console.log(' ', r.definition);
    console.log(' ', r.hint, '|', r.horizonLabel);
    console.log('  targets', r.targets.map((t) => catalog.names.get(t.index).zh), 'vegaAltair', r.vegaAltair, 'zB', r.zB.map((x) => x.toFixed(3)));
    console.log('  export:', T.export.pairTitle(r.nameA, r.nameB), '/', T.export.pairCount(r.both), '/', T.export.pairDates(a, b));
    const vega = [...catalog.names.values()].find((s) => s.en === 'Vega').i;
    console.log('  strip pair line (织女星):', facts.describe(catalog, { type: 'star', index: vega }, r.sa, results[0].f, { pair: r }).lead);
    console.log('  anon:', anon.lines[anon.lines.length - 1], '|', anon.hint);
    console.log('  strangers:', strangers.nameA, strangers.nameB, strangers.lines.find((l) => l.includes('月亮')) || '');
    console.log('  swapped:', swapped.lines.join(' / '));
  }
});

// ---------------------------------------------------------------- print the copy for reading
if (!quiet) {
  for (const { label, p, f, hero, tour, rows, tags } of results) {
    console.log(`\n=== ${label}  hero=${hero.kind}${hero.label ? `(${hero.label})` : ''} az ${hero.az.toFixed(0)}° alt ${hero.alt.toFixed(1)}°  sun ${f.sun.alt.toFixed(1)}°`);
    console.log('  meta   ', fmtWhen(p));
    console.log('  summary', facts.factsPeek(f));
    console.log('  guest  ', facts.heroCaption(hero, f, '小明'));
    console.log('  tour:');
    tour.forEach((t) => console.log(`    [${t.key}${t.belowHorizon ? ' ↓' : ''}${t.n ? '' : ' 镜头不动'}] ${t.text}${t.marker ? `   ⟨${t.marker.label}⟩` : ''}`));
    console.log('  那一夜:');
    rows.forEach((r) => console.log(`    ${r.label}｜${r.text}｜${r.meta}${r.action ? `｜${r.action}` : ''}`));
    const note = facts.nightNote(f);
    if (note) console.log(`    ${note}`);
    console.log('  tags   ', tags.map((t) => t.text).join(' / '));
    console.log('  壁纸句 ', facts.lightStarShort(f));
  }
  const r = results[0];
  console.log('\n=== name strips (1998-07-14 杭州)');
  const byEn = (en) => [...catalog.names.values()].find((s) => s.en === en).i;
  for (const sel of [{ type: 'star', index: byEn('Arcturus') }, { type: 'star', index: byEn('Dubhe') }, { type: 'star', index: byEn('Deneb') }, { type: 'star', index: byEn('Sirius') },
    { type: 'body', id: 'Mars' }, { type: 'body', id: 'Moon' }, { type: 'body', id: 'Sun' }]) {
    const d = facts.describe(catalog, sel, r.sky, r.f, { subject: '你' });
    console.log(`  ${d.name}${d.latin ? `　${d.latin}` : ''}｜${d.meta}｜${d.story}`);
  }
}

console.log(`\n${passed} tests passed${process.exitCode ? ', some FAILED' : ''}`);

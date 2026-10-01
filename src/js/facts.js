// What was true on the night: moon, lunar date, solar term, the star overhead, planets, how many stars
// were up, and the "light-year star" whose light left home the year you were born — and how to say it.
// All returned text is plain (no HTML). Strings come from copy.js.
//
// Public API
//   computeFacts(catalog, person, moment, sky, now = new Date()) → facts
//   chooseHero(catalog, sky, facts, subject = '你') → { kind, n, alt, az, target, label, caption, body?, info? }
//      kind: 'light'|'moon'|'planet'|'core'|'star'|'south'|'day'|'twilight' (spec §3.2, first match wins)
//      n: NEU unit vector to face (for south/day/twilight: a point on the horizon at az)
//      target: {type:'star', index} | {type:'body', id} | null  (null → no strip, nothing to select)
//      label: text for the small tag beside the hero (织女星 / 月亮 / 火星 / 银河中心) or null
//      reticle: true when there is a thing at n worth marking (everything but south/day/twilight)
//   heroCaption(hero, facts, subject) → string                           (S5)
//   buildTour(catalog, facts, sky, hero, subject) → [{ key, text, target, n, az, alt, belowHorizon, marker, label, hero? }]
//      marker: { n, label: '月亮 · 地平线下 12°' } | null; n null → "the camera does not move"
//   nightRows(facts, subject) → [{ key, label, text, meta, target, action }]   (S10; action '在天上看' | '')
//   nightNote(facts) → '时间未知，画的是当晚 22:00 的天空' | ''
//   factsPeek(facts) → '亏凸月 · 农历闰五月廿一 · 小暑 · 4,267 颗星'
//   describe(catalog, sel, sky, facts, { subject, pair }) → { name, latin, meta, story, lead, below, alt, az, n } | null
//      lead: first-line text (below-horizon line + two-person line), already included at the start of story
//      pair: a computeHepan() result (uses its sa/sb/nameA/nameB)
//   tagText(kind, obj, facts) → string        kind 'moon'|'planet'|'zenith'|'light'
//   tagsFor(catalog, sky, facts) → [{ key, kind, n, text, target }]   look-to-reveal candidates that are up
//   lightStarSentence(facts, subject) → string;  lightStarShort(facts) → '织女星的光，2001 年就动身了。'
//   fmtLy(ly) → '25 光年';  momentYear(date, tz);  STAR_NOTES;  BODY_NOTES;  MW_CORE
import { mul, radec, altAz, dirName, lunarDate, solarTerm, zonedParts, yearsBetween } from './astro.js';
import { T, fmtCount, fmtMag, fmtDeg, fmtLightTime, keepWords } from './copy.js';

const AU_KM = 149597870.7;
const C_KMS = 299792.458;
const DEG = Math.PI / 180;

export const STAR_NOTES = {
  Sirius: '冬夜的南天，有一粒蓝白的光颤个不停，那便是全天最亮的恒星。',
  Canopus: '全天第二亮的恒星。古人只在南天低处偶尔望见它，说见者添寿，唤它老人星。',
  'Rigil Kentaurus': '离我们最近的恒星系统，比邻星也在其中。光只走 4.3 年，像是住在隔壁。',
  Arcturus: '北半球春夜最亮的星。顺着北斗斗柄的弧线往外走，会遇见一点橙色的暖光。',
  Vega: '七夕里的织女，夏夜头顶最亮的星之一。隔着一道银河，牛郎在对岸望了千年。',
  Altair: '七夕里的牛郎，古称河鼓二。身旁两颗小星，说是他挑着的一双儿女，正要过河。',
  Deneb: '天鹅座的尾巴。天津，是银河上的渡口。它远得惊人，却依旧亮成夏季大三角的一角。',
  Capella: '御夫座最亮的星，冬夜高悬头顶。远看是一粒金黄，其实是两对恒星，四颗结伴同行。',
  Rigel: '猎户座的一只脚。比太阳亮上万倍的蓝白超巨星，隔得太远，只剩一点寒光。',
  Procyon: '冬季大三角的一角。离我们 11 光年多一点，在星空里，已算近在咫尺。',
  Betelgeuse: '猎户座肩头一点暗红的炭火，其实是颗超巨星：放在太阳的位置，它会吞下火星的轨道。',
  Aldebaran: '金牛的红眼睛。冬夜，它总跟在昴星团身后，从东方的屋檐上慢慢升起。',
  Antares: '天蝎的心脏，一颗火红的超巨星，古人叫它大火。七月流火，是它西沉，天要转凉了。',
  Spica: '处女座最亮的星。在古人的天上，它是东方苍龙的一只角，春夜里青白地亮着。',
  Pollux: '双子座两兄弟里更亮的那个，一颗橙色的巨星。它的光走三十多年，约是人的半生。',
  Castor: '双子座的另一个兄弟。它是六颗星的一大家子，两两相携，绕着彼此慢慢地转。',
  Fomalhaut: '秋夜的南天亮星寥寥，它独自亮着，像远水上的一点渔火，一眼就能认出。',
  Regulus: '狮子座的心脏，几乎就躺在黄道上。每年八月，太阳都从它身旁轻轻走过。',
  Polaris: '它并不很亮，只是几乎不动。它守在正北，满天星斗都绕着它，一夜一夜地转。',
  Algol: '一颗会眨眼的星。每隔不到三天，伴星从它面前走过，它便垂下眼睑，暗上几个小时。',
  Alcyone: '昴星团里最亮的一颗。它和身边的姊妹差不多同时出生，论星的年岁，都还年少。',
  Mimosa: '南十字座的一颗亮星。要一路往南走得够远，它才肯在天边露面。',
  Acrux: '南十字座最亮的星。南天没有一颗明亮的极星，赶夜路的人，便看南十字找正南。',
  Achernar: '波江座这条河的尽头，水流到这里，聚成一颗星。它转得太快，把自己甩成了扁球。',
};
const DIPPER = new Set(['Dubhe', 'Merak', 'Phecda', 'Megrez', 'Alioth', 'Mizar', 'Alkaid']);

export const BODY_NOTES = {
  Moon: '',
  Sun: '',
  Mercury: '离太阳最近的行星，古称辰星。只在晨光暮色里，贴着天边露一露脸。',
  Venus: '除了日月，天上数它最亮。破晓时它叫启明，到了黄昏，又叫长庚。',
  Mars: '古人叫它荧惑。荧荧一点红火，在星间忽进忽退，叫人看不透。',
  Jupiter: '太阳系最大的行星。约十二年绕天一周，古人数着它纪年，唤作岁星。',
  Saturn: '戴着光环的镇星。约二十九年才绕天一周，每年坐镇一宿，从不着急。',
};

const PLANETS = new Set(['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn']);
// how a planet looks, and what it was called (S5 行星 caption)
const PLANET_LOOK = {
  Mercury: ['低垂的', '辰星'],
  Venus: ['灼灼的', ''], // 启明 in the east (morning), 长庚 in the west (evening)
  Mars: ['泛红的', '荧惑'],
  Jupiter: ['静静亮着的', '岁星'],
  Saturn: ['淡金色的', '镇星'],
};

/** Galactic centre, J2000 (spec §3.2). */
export const MW_CORE = { ra: 266.4, dec: -29.0 };

// ---------------------------------------------------------------- helpers
function starN(catalog, M, i, out = [0, 0, 0]) {
  const p = catalog.stars.pos;
  return mul(M, [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]], out);
}

function horizonVec(azDeg, altDeg = 0) {
  const a = azDeg * DEG, h = altDeg * DEG;
  return [Math.cos(h) * Math.cos(a), Math.cos(h) * Math.sin(a), Math.sin(h)];
}

const norm360 = (x) => ((x % 360) + 360) % 360;

/** Display name of a named star: the catalogue's first Chinese name (「天市右垣七 蜀」 → 天市右垣七). */
export function starName(info) {
  const zh = String(info?.zh || '');
  return /\p{Script=Han}/u.test(zh) ? zh.split(/\s+/)[0] : zh;
}
const named = (info) => (info ? { ...info, zh: starName(info) } : null);
const pctOf = (illum) => Math.round(illum * 100);
const lightMinutes = (distAu) => (distAu * AU_KM) / C_KMS / 60;
const belowDeg = (alt) => Math.max(1, Math.round(-alt));

export function momentYear(date, tz) {
  return zonedParts(date, tz).y;
}

export function fmtLy(ly) {
  if (ly < 20) return `${ly.toFixed(1)} 光年`;
  return `${fmtCount(ly)} 光年`;
}
const lyNum = (ly) => (ly < 20 ? ly.toFixed(1) : fmtCount(ly));

// ---------------------------------------------------------------- facts
// names the line breakers must keep whole (copy.keepWords): once per catalogue, plus the person
const registered = new WeakSet();
function registerNames(catalog, person) {
  if (!registered.has(catalog)) {
    registered.add(catalog);
    keepWords([...catalog.names.values()].map(starName));
    keepWords(Object.values(catalog.conZh || {}));
  }
  keepWords([person?.name, person?.city?.name]);
}

export function computeFacts(catalog, person, moment, sky, now = new Date()) {
  registerNames(catalog, person);
  const { M } = sky;
  let visible = 0, zenith = -1, zenZ = -1;
  const pos = catalog.stars.pos, mag = catalog.stars.mag, count = catalog.stars.count;
  const m2 = M[2], m5 = M[5], m8 = M[8];
  for (let i = 0; i < count; i++) {
    const z = m2 * pos[i * 3] + m5 * pos[i * 3 + 1] + m8 * pos[i * 3 + 2];
    if (z <= 0) continue;
    visible++;
    if (mag[i] <= 3 && z > zenZ && catalog.names.has(i)) { zenZ = z; zenith = i; }
  }
  const withPos = (info) => {
    if (!info) return null;
    const n = starN(catalog, M, info.i);
    const { alt, az } = altAz(n);
    return { ...named(info), n, alt, az };
  };
  const zenithInfo = zenith >= 0 ? { ...withPos(catalog.names.get(zenith)), fromZenith: 90 - Math.asin(Math.min(1, zenZ)) / DEG } : null;

  const allPlanets = sky.bodies.filter((b) => PLANETS.has(b.id));
  const planets = allPlanets.filter((b) => b.alt > 0).sort((a, b) => a.mag - b.mag);

  const age = Math.max(0, yearsBetween(moment, now));
  const tz = person.city.tz;
  return {
    visible,
    zenith: zenithInfo,
    planets, allPlanets,
    moon: { ...sky.moonPhase, up: sky.moon.alt > 0, alt: sky.moon.alt, az: sky.moon.az, n: sky.moon.n, distKm: sky.moon.dist * AU_KM },
    sun: { alt: sky.sun.alt, az: sky.sun.az, n: sky.sun.n, dist: sky.sun.dist },
    daylight: sky.daylight,
    lunar: lunarDate(moment, tz),
    term: solarTerm(moment, tz),
    age, light: withPos(lightYearStar(catalog, age, M)),
    birthYear: momentYear(moment, tz),
    nowYear: now.getFullYear(),
    unknownTime: !!person.unknownTime,
    lat: person.city.lat,
  };
}

// The "light-year star": a star you could find, whose light has been travelling about as long as you
// have been alive. Under 4 the sentence names 南门二, so that is the star. Otherwise the distance
// match is traded against brightness (a recognisable star) and against being below the horizon on
// the birth night (spec example: 1998-07-14 杭州 → 织女星, 25 光年).
function lightYearStar(catalog, age, M) {
  if (age < 4) {
    for (const info of catalog.names.values()) if (info.en === 'Rigil Kentaurus') return info;
  }
  let best = null, bestScore = Infinity;
  for (const info of catalog.names.values()) {
    if (!info.ly || info.mag > 3.5 || info.ly > 400) continue;
    let score = Math.abs(info.ly - age) + 1.5 * Math.max(0, info.mag - 1);
    if (M && starN(catalog, M, info.i)[2] <= 0) score += 5;
    if (score < bestScore) { bestScore = score; best = info; }
  }
  return best;
}

// ---------------------------------------------------------------- light-year star
export function lightStarSentence(f, subject = '你') {
  const s = f.light;
  if (!s) return '';
  if (f.age < 4) return T.hero.lightYoung(subject);
  const dep = Math.round(f.nowYear - s.ly);
  const diff = s.ly - f.age;
  if (Math.abs(diff) < 1.2) return T.hero.lightSame(subject, s.zh, lyNum(s.ly));
  if (diff < 0) return T.hero.lightAfter(subject, s.zh, dep, Math.max(1, dep - f.birthYear));
  return T.hero.lightBefore(subject, s.zh, dep, Math.max(1, f.birthYear - dep));
}

export function lightStarShort(f) {
  const s = f.light;
  if (!s) return '';
  return T.keep.sentence(s.zh, Math.round(f.nowYear - s.ly));
}

// ---------------------------------------------------------------- hero (spec §3.2)
export function chooseHero(catalog, sky, facts, subject = '你') {
  const hero = pickHero(catalog, sky, facts);
  hero.reticle = !['south', 'day', 'twilight'].includes(hero.kind);
  hero.caption = heroCaption(hero, facts, subject);
  return hero;
}

function pickHero(catalog, sky, facts) {
  const sun = sky.sun;
  if (sun.alt > -6) {
    const az = norm360(sun.az + 180);
    return { kind: sun.alt > 0 ? 'day' : 'twilight', n: horizonVec(az), alt: 0, az, target: null, label: null };
  }
  // 1. the light-year star
  const L = facts.light;
  if (L && L.alt >= 12 && L.alt <= 50) {
    return { kind: 'light', n: L.n, alt: L.alt, az: L.az, target: { type: 'star', index: L.i }, label: L.zh, info: L };
  }
  const coreN = mul(sky.M, radec(MW_CORE.ra, MW_CORE.dec));
  const core = { kind: 'core', n: coreN, ...altAz(coreN), target: null, label: T.hero.coreLabel };
  // 2. the Moon — unless it is bright and high while the core is well up
  const moon = sky.moon;
  if (moon.alt >= 8 && moon.alt <= 50) {
    if (sky.moonPhase.illum > 0.8 && moon.alt > 45 && core.alt > 20) return core;
    return { kind: 'moon', n: moon.n, alt: moon.alt, az: moon.az, target: { type: 'body', id: 'Moon' }, label: moon.zh };
  }
  // 3. the brightest planet at 10–50°
  const pl = sky.bodies.filter((b) => PLANETS.has(b.id) && b.alt >= 10 && b.alt <= 50).sort((a, b) => a.mag - b.mag)[0];
  if (pl) return { kind: 'planet', n: pl.n, alt: pl.alt, az: pl.az, target: { type: 'body', id: pl.id }, label: pl.zh, body: pl };
  // 4. the Milky Way core in a dark sky
  if (core.alt >= 8 && core.alt <= 45 && sun.alt < -12) return core;
  // 5. the brightest named star (≤ 1.5 等) at 15–50°
  let best = null;
  for (const info of catalog.names.values()) {
    if (info.mag > 1.5 || (best && info.mag >= best.mag)) continue;
    const n = starN(catalog, sky.M, info.i);
    const { alt, az } = altAz(n);
    if (alt >= 15 && alt <= 50) best = { ...named(info), n, alt, az };
  }
  if (best) return { kind: 'star', n: best.n, alt: best.alt, az: best.az, target: { type: 'star', index: best.i }, label: best.zh, info: best };
  // 6. face due south (due north in the southern hemisphere)
  const az = sky.lat < 0 ? 0 : 180;
  return { kind: 'south', n: horizonVec(az), alt: 0, az, target: null, label: null };
}

function planetLook(b) {
  const [look, ancient] = PLANET_LOOK[b.id] || ['明亮的', ''];
  return [look, ancient || (norm360(b.az) < 180 ? '启明' : '长庚')];
}

export function heroCaption(hero, f, subject = '你') {
  const S = subject;
  switch (hero.kind) {
    case 'light': return lightStarSentence(f, S);
    case 'moon': return T.hero.moon(S, f.moon.name, pctOf(f.moon.illum), (f.moon.distKm / C_KMS).toFixed(1));
    case 'planet': {
      const b = hero.body || f.allPlanets.find((p) => p.id === hero.target?.id);
      const [look, ancient] = planetLook(b);
      return T.hero.planet(S, look, b.zh, ancient, fmtLightTime(lightMinutes(b.dist)));
    }
    case 'core': return T.hero.core(S);
    case 'star': return T.hero.star(S, hero.info.zh, hero.info.ly ? fmtLy(hero.info.ly) : '');
    case 'day': return T.hero.day(S, dirName(f.sun.az));
    case 'twilight': return T.hero.twilight(f.daylight.zh);
    default: return T.hero.south(S, norm360(hero.az) < 90 || norm360(hero.az) > 270 ? '北' : '南', fmtCount(f.visible));
  }
}

// ---------------------------------------------------------------- tour (S9)
function markerFor(name, n, alt) {
  return alt < 0 ? { n, label: T.tour.marker(name, belowDeg(alt)) } : null;
}

export function buildTour(catalog, f, sky, hero, subject = '你') {
  const S = subject;
  const items = [];
  const push = (it) => items.push({ belowHorizon: false, marker: null, target: null, n: null, az: null, alt: null, label: null, ...it });

  // 1. the hero
  push({ key: hero.kind, hero: true, text: heroCaption(hero, f, S), target: hero.target, n: hero.n, az: hero.az, alt: hero.alt, label: hero.label });

  // 2. the light-year star, if it was not the hero
  if (hero.kind !== 'light' && f.light) {
    const L = f.light;
    push({ key: 'light', text: lightStarSentence(f, S), target: { type: 'star', index: L.i }, n: L.n, az: L.az, alt: L.alt,
      belowHorizon: L.alt < 0, marker: markerFor(L.zh, L.n, L.alt), label: L.zh });
  }

  // 3. the Moon (skipped when it was the hero: the caption already said it)
  if (hero.kind !== 'moon') {
    const m = f.moon;
    push({ key: 'moon', text: m.up ? T.tour.moonUp(m.name, pctOf(m.illum), dirName(m.az)) : T.tour.moonDown(m.name),
      target: { type: 'body', id: 'Moon' }, n: m.n, az: m.az, alt: m.alt, belowHorizon: !m.up, marker: markerFor('月亮', m.n, m.alt), label: '月亮' });
  }

  // 4. overhead
  if (f.zenith) {
    const z = f.zenith;
    push({ key: 'zenith', text: T.tour.zenith(S, z.conZh, z.zh, z.ly ? fmtLy(z.ly) : ''), target: { type: 'star', index: z.i },
      n: z.n, az: z.az, alt: z.alt, label: z.zh });
  }

  // 5. planets (skipped when a planet was the hero)
  if (hero.kind !== 'planet') {
    if (f.planets.length) {
      const p0 = f.planets[0];
      const list = f.planets.map((p) => T.tour.planetAt(p.zh, dirName(p.az))).join('，');
      push({ key: 'planets', text: T.tour.planets(list, S, p0.zh, fmtLightTime(lightMinutes(p0.dist))),
        target: { type: 'body', id: p0.id }, n: p0.n, az: p0.az, alt: p0.alt, label: p0.zh });
    } else {
      push({ key: 'planets', text: T.tour.planetsNone });
    }
  }

  // 6. the star count (the day / twilight / south heroes already said theirs)
  if (!['day', 'twilight', 'south'].includes(hero.kind)) push({ key: 'count', text: T.tour.count(fmtCount(f.visible)) });

  // 7. the day: lunar date and solar term
  push({ key: 'date', text: T.tour.date(f.lunar?.text, f.term.name, f.term.days) });
  return items;
}

// ---------------------------------------------------------------- 那一夜 plate (S10)
function countText(f, S) {
  if (f.daylight.key === 'day') return T.hero.day(S, dirName(f.sun.az));
  if (f.daylight.key === 'civil') return T.hero.twilight(f.daylight.zh);
  return T.night.count(fmtCount(f.visible));
}

export function nightRows(f, subject = '你') {
  const S = subject;
  const L = T.night.labels;
  const rows = [];
  const row = (r) => rows.push({ target: null, meta: '', ...r, action: r.target ? T.night.look : '' });
  if (f.light) {
    const s = f.light;
    row({ key: 'light', label: L.light, text: lightStarSentence(f, S), meta: T.night.lightMeta(s.zh, s.conZh, fmtLy(s.ly)), target: { type: 'star', index: s.i } });
  }
  const m = f.moon, pct = pctOf(m.illum);
  const lunarYear = f.lunar?.yearName ? `${f.lunar.yearName}${f.lunar.animal || ''}年` : '';
  row({ key: 'moon', label: L.moon, text: m.up ? T.night.moonUp(m.name, pct, dirName(m.az)) : T.night.moonDown(m.name, pct),
    meta: T.night.moonMeta(f.lunar?.text, lunarYear), target: { type: 'body', id: 'Moon' } });
  if (f.zenith) {
    const z = f.zenith;
    row({ key: 'zenith', label: L.zenith, text: T.night.zenith(S, z.conZh, z.zh),
      meta: T.night.zenithMeta(fmtDeg(z.fromZenith, 1), z.ly ? fmtLy(z.ly) : ''), target: { type: 'star', index: z.i } });
  }
  row({ key: 'planets', label: L.planets,
    text: f.planets.length ? T.night.planets(f.planets.map((p) => T.tour.planetAt(p.zh, dirName(p.az))).join('，')) : T.night.planetsNone,
    meta: f.planets.map((p) => T.night.planetMeta(p.zh, fmtMag(p.mag))).join(' · '),
    target: f.planets[0] ? { type: 'body', id: f.planets[0].id } : null });
  row({ key: 'count', label: L.count, text: countText(f, S), meta: T.night.countMeta });
  row({ key: 'term', label: L.term, text: T.night.term(f.term.name, f.term.days), meta: f.lunar?.text || '' });
  return rows;
}

export function nightNote(f) {
  return f.unknownTime ? T.night.unknownTime : '';
}

/** Summary line: 亏凸月 · 农历闰五月廿一 · 小暑 · 4,267 颗星 */
export function factsPeek(f) {
  return [f.moon.name, f.lunar?.text, f.term.name, `${fmtCount(f.visible)} 颗星`].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- look-to-reveal tags (S9)
export function tagText(kind, obj, f) {
  if (kind === 'moon') return T.tour.tagMoon(f.moon.name, pctOf(f.moon.illum));
  if (kind === 'planet') return T.tour.tagPlanet(obj.zh, fmtLightTime(lightMinutes(obj.dist)));
  if (kind === 'zenith') return T.tour.tagZenith(starName(obj || f.zenith));
  if (kind === 'light') {
    const s = obj || f.light;
    return T.tour.tagLight(starName(s), Math.round(f.nowYear - s.ly));
  }
  return '';
}

/** Tag candidates that are above the horizon in `sky` (the chrome decides which one is centred). */
export function tagsFor(catalog, sky, f) {
  const out = [];
  if (sky.moon.alt > 0) out.push({ key: 'moon', kind: 'moon', n: sky.moon.n, text: tagText('moon', sky.moon, f), target: { type: 'body', id: 'Moon' } });
  for (const b of sky.bodies) {
    if (PLANETS.has(b.id) && b.alt > 0) out.push({ key: b.id, kind: 'planet', n: b.n, text: tagText('planet', b, f), target: { type: 'body', id: b.id } });
  }
  for (const [kind, s] of [['zenith', f.zenith], ['light', f.light]]) {
    if (!s) continue;
    const n = starN(catalog, sky.M, s.i);
    if (n[2] > 0 && !out.some((o) => o.target?.index === s.i)) {
      out.push({ key: kind, kind, n, text: tagText(kind, s, f), target: { type: 'star', index: s.i } });
    }
  }
  return out;
}

// ---------------------------------------------------------------- name strip (S11)
export function describe(catalog, sel, sky, f, { subject = '你', pair = null } = {}) {
  const S = subject;
  let d;
  if (sel.type === 'star') {
    const info = catalog.names.get(sel.index);
    if (!info) return null;
    const n = starN(catalog, sky.M, sel.index);
    let light = '';
    if (info.ly) {
      if (info.ly > 3000) light = T.strip.far;
      else {
        const dep = Math.round(f.nowYear - info.ly);
        if (dep <= 0) light = T.strip.lightBC(1 - dep);
        else if (info.ly < 150) {
          light = dep < f.birthYear ? T.strip.lightBefore(dep, S, f.birthYear - dep)
            : dep === f.birthYear ? T.strip.lightSame(dep, S)
              : T.strip.lightAfter(dep, S, dep - f.birthYear);
        } else light = T.strip.lightPlain(dep);
      }
    }
    const note = STAR_NOTES[info.en] || (DIPPER.has(info.en) ? T.strip.dipper : '');
    d = {
      name: starName(info), latin: info.en || '', n,
      meta: T.strip.starMeta(info.conZh, fmtMag(info.mag), info.ly ? fmtLy(info.ly) : ''),
      body: note + light,
    };
  } else {
    const b = sky.bodies.find((x) => x.id === sel.id);
    if (!b) return null;
    const lm = lightMinutes(b.dist);
    if (b.id === 'Moon') {
      const km = Math.round((b.dist * AU_KM) / 100) * 100;
      d = { name: T.strip.moonName, latin: '', n: b.n,
        meta: T.strip.moonMeta(sky.moonPhase.name, pctOf(sky.moonPhase.illum), fmtCount(km)),
        body: T.strip.moonStory((lm * 60).toFixed(1), S, f.lunar?.text) };
    } else if (b.id === 'Sun') {
      const sec = Math.round(lm * 60);
      d = { name: T.strip.sunName, latin: '', n: b.n,
        meta: T.strip.sunMeta(fmtDeg(b.alt, 0), dirName(b.az)),
        body: T.strip.sunStory(Math.floor(sec / 60), sec % 60, S) };
    } else {
      d = { name: b.zh, latin: b.id, n: b.n,
        meta: T.strip.planetMeta(fmtMag(b.mag), b.dist.toFixed(2)),
        body: (BODY_NOTES[b.id] || '') + T.strip.planetLight(S, b.zh, fmtLightTime(lm)) };
    }
  }
  const { alt, az } = altAz(d.n);
  const lead = (alt < 0 ? T.strip.below(d.name, belowDeg(alt)) : '') + pairUp(catalog, sel, pair);
  // The strip clamps at 4 lines. The light sentences carry their own line break ('\n'); with a lead line
  // in front (below the horizon / two people) that break would push the story past 4 lines, so then the
  // same words flow as one paragraph.
  const body = lead ? d.body.replace(/\n/g, '') : d.body;
  return { name: d.name, latin: d.latin, meta: d.meta, story: lead + body, lead, below: alt < 0, alt, az, n: d.n };
}

function pairUp(catalog, sel, pair) {
  if (!pair || !pair.sa || !pair.sb) return '';
  let upA, upB;
  if (sel.type === 'star') {
    upA = starN(catalog, pair.sa.M, sel.index)[2] > 0;
    upB = starN(catalog, pair.sb.M, sel.index)[2] > 0;
  } else {
    const a = pair.sa.bodies.find((x) => x.id === sel.id), b = pair.sb.bodies.find((x) => x.id === sel.id);
    if (!a || !b) return '';
    upA = a.alt > 0; upB = b.alt > 0;
  }
  if (upA && upB) return T.strip.pairBoth;
  if (upA) return T.strip.pairOnly(pair.nameA);
  if (upB) return T.strip.pairOnly(pair.nameB);
  return '';
}

// The poem library: the only text on a wallpaper (plus a faint date line) and the sentence on a 便签.
// A poem is 1–4 short lines of classical Chinese: real lines of classical poetry and prose ('classic',
// shown with author and title), 成语 ('idiom'), or our own lines in classical form ('site', no
// attribution) (data: poem-library.js, generated from content/poems.json).
//
// Choosing a person's poem:
//   1. Only poems that are TRUE of their birth night are eligible: a line about the Moon at the window
//      needs the Moon above the horizon, a crescent needs a crescent, the Dipper needs the northern
//      hemisphere, an original about snow needs a winter birth; pair poems need their pair conditions
//      (different years, far apart, a winter and a summer birth…).
//   2. Poems written about the birthplace come first (city, then province, then 海外 for people born
//      abroad), then the general pool; within each, poems whose season matches come first.
//   3. The pick inside that order is stable for the person (hashed from date, time and city), so they
//      get the same default every visit — that default is what poemstats.js counts. 「换一首」 walks on.
//
// API
//   POEMS, PAIR_POEMS                                  arrays of library items
//   poemForPerson(person, step = 0, {pair, partner})   → { poem, regional, place }
//   poemFor(seed, step, {pair})                        → poem (seeded, no conditions)
//   attribution(poem)       → 「杜甫《旅夜书怀》」 / 「仓央嘉措　曾缄 译」 / 「传李白《夜宿山寺》」 / 「成语」 / ''
//   poemSeed(person), poemCount({pair}), poemById(id), placeNames(person), nightContext(person)
import { LIBRARY } from './poem-library.js';
import { zonedToUtc, skyState, greatCircleKm } from './astro.js';

export const POEMS = LIBRARY.filter((p) => !p.pair);
export const PAIR_POEMS = LIBRARY.filter((p) => p.pair);

const CN_ZONES = new Set(['Asia/Shanghai', 'Asia/Urumqi', 'Asia/Kashgar', 'Asia/Chongqing', 'Asia/Chungking',
  'Asia/Harbin', 'Asia/Hong_Kong', 'Asia/Macau', 'Asia/Macao', 'Asia/Taipei', 'PRC', 'ROC']);

/** Place names to match against poem regions: city (with and without 市/区/县), province, or 海外. */
export function placeNames(person) {
  const c = person?.city;
  if (!c) return [];
  const names = [];
  const add = (s) => {
    if (!s) return;
    s = String(s).trim();
    if (!s || names.includes(s)) return;
    names.push(s);
    const bare = s.replace(/(特别行政区|自治区|自治州|地区|省|市|区|县)$/u, '');
    if (bare.length >= 2 && !names.includes(bare)) names.push(bare);
  };
  add(c.name);
  for (const part of String(c.region || '').split(/[·,，\s]+/u)) add(part);
  if (c.tz && !CN_ZONES.has(c.tz)) names.push('海外');
  return names;
}

function hash(str) {
  let h = 0x811c9dc5;
  for (const ch of String(str)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function poemSeed(person) {
  return person ? `${person.date}|${person.time || ''}|${person.city?.name || ''}` : 'sky';
}

// ------------------------------------------------------------------------------------ the night's facts
const ctxCache = new Map();
function seasonOf(month, north) {
  const s = month >= 3 && month <= 5 ? '春' : month >= 6 && month <= 8 ? '夏' : month >= 9 && month <= 11 ? '秋' : '冬';
  if (north) return s;
  return { 春: '秋', 夏: '冬', 秋: '春', 冬: '夏' }[s];
}

/** What was true of the birth night, for poem conditions. null when the person is incomplete. */
export function nightContext(person) {
  const c = person?.city;
  if (!person?.date || !c || !Number.isFinite(c.lat)) return null;
  const key = poemSeed(person) + `|${c.lat}|${c.lon}`;
  if (ctxCache.has(key)) return ctxCache.get(key);
  let ctx = null;
  try {
    const [y, m, d] = person.date.split('-').map(Number);
    const [hh, mm] = String(person.time || '22:00').split(':').map(Number);
    const sky = skyState(zonedToUtc(y, m, d, hh, mm, c.tz), c.lat, c.lon);
    const phase = sky.moonPhase.name;
    ctx = {
      year: y, lat: c.lat, lon: c.lon, north: c.lat >= 0, season: seasonOf(m, c.lat >= 0),
      moonUp: sky.moon.alt > 0, crescent: phase === '蛾眉月' || phase === '残月', newMoon: phase === '新月',
    };
  } catch { ctx = null; }
  ctxCache.set(key, ctx);
  return ctx;
}

/** Hard conditions: is this poem true of this night (and this pair)? Unknown context → only unconditioned poems. */
function fits(p, ctx, pctx) {
  const w = p.when;
  if (!w) return true;
  if (!ctx) return false;
  if (w.moon === 'up' && !ctx.moonUp) return false;
  if (w.moon === 'down' && ctx.moonUp && !ctx.newMoon) return false;
  if (w.moon === 'crescent' && !ctx.crescent) return false;
  if (w.moon === 'crescent-up' && !(ctx.crescent && ctx.moonUp)) return false;
  if (w.north && !ctx.north) return false;
  if (w.seasons && !w.seasons.includes(ctx.season)) return false;
  if (w.pairYears || w.pairFarKm || w.pairLonDiff || w.pairSeasons) {
    if (!pctx) return false;
    if (w.pairYears === 'diff' && pctx.a.year === pctx.b.year) return false;
    if (w.pairFarKm && pctx.km < w.pairFarKm) return false;
    if (w.pairLonDiff && pctx.dLon < w.pairLonDiff) return false;
    if (w.pairSeasons) {
      const s = [pctx.a.season, pctx.b.season].sort().join('');
      if (s !== [...w.pairSeasons].sort().join('')) return false;
    }
  }
  return true;
}

const soft = (p, ctx) => (ctx && p.when?.seasonsSoft ? (p.when.seasonsSoft.includes(ctx.season) ? 0 : 1) : 0);

/**
 * The poem for a person (and, for pair poems, their partner), stable across visits.
 * `regional` is true when it was chosen for the birthplace; `place` names the matched place.
 */
export function poemForPerson(person, step = 0, { pair = false, partner = null } = {}) {
  const ctx = nightContext(person);
  let pctx = null;
  if (pair && partner) {
    const b = nightContext(partner);
    if (ctx && b) {
      const d = Math.abs(ctx.lon - b.lon) % 360;
      pctx = { a: ctx, b, km: greatCircleKm(ctx.lat, ctx.lon, b.lat, b.lon), dLon: d > 180 ? 360 - d : d };
    }
  }
  const list = (pair ? PAIR_POEMS : POEMS).filter((p) => fits(p, ctx, pctx));
  const seed = hash(poemSeed(person) + (partner ? `+${poemSeed(partner)}` : ''));
  let regional = [], place = '';
  if (!pair) {
    for (const name of placeNames(person)) {
      regional = list.filter((p) => p.regions?.includes(name));
      if (regional.length) { place = name; break; }
    }
  }
  const rest = list.filter((p) => !regional.includes(p));
  // seasonal matches first, then a stable rotation inside each group
  const arrange = (arr) => {
    const groups = [arr.filter((p) => soft(p, ctx) === 0), arr.filter((p) => soft(p, ctx) === 1)];
    return groups.flatMap((g) => {
      if (!g.length) return g;
      const k = seed % g.length;
      return [...g.slice(k), ...g.slice(0, k)];
    });
  };
  // A place with only one or two poems would hand everyone born there the same line; so a birthplace
  // poem is the default for everyone only when the place has 3+, otherwise for a stable share of people
  // (1 → 50%, 2 → 70%), and for the rest it is the first 「换一首」.
  const share = regional.length >= 3 ? 100 : regional.length === 2 ? 70 : regional.length === 1 ? 50 : 0;
  const local = arrange(regional), general = arrange(rest);
  const order = ((seed >>> 8) % 100) < share ? [...local, ...general] : [...general.slice(0, 1), ...local, ...general.slice(1)];
  if (!order.length) return { poem: POEMS[0], regional: false, place: '' };
  const i = ((step % order.length) + order.length) % order.length;
  const hit = regional.includes(order[i]);
  return { poem: order[i], regional: hit, place: hit ? place : '' };
}

export function poemFor(seed, step = 0, { pair = false } = {}) {
  const list = pair ? PAIR_POEMS : POEMS;
  return list[(((hash(seed) + step) % list.length) + list.length) % list.length];
}

export function poemById(id) {
  return LIBRARY.find((p) => p.id === id) || null;
}

export function poemCount({ pair = false } = {}) {
  return (pair ? PAIR_POEMS : POEMS).length;
}

export function attribution(poem) {
  if (poem?.kind === 'idiom') return '成语';
  if (!poem || !poem.by) return '';
  const work = poem.title ? `${poem.by}《${poem.title}》` : poem.by;
  return poem.translator && poem.translator !== '本站译' ? `${work}　${poem.translator} 译` : work;
}

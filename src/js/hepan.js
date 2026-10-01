// 两个人: put two birth skies together and say, plainly, what they share. All real astronomy, no
// fortune-telling. The overlap figure is simply the share of naked-eye stars that were up for both.
// Compute only — the pair screen (S17) lives in pair.js.
//
// Public API
//   computeHepan(catalog, a, b, momentOf, { me, nameA, nameB } = {}) → {
//     a, b, ta, tb, sa, sb,              people, birth instants, skyState() of each
//     both, either, score,               stars up for both / for at least one / round(100·both/either)
//     zB, zA,                            B's zenith in A's NEU, A's zenith in B's NEU (unit [3])
//     nearlySame,                        zeniths within 3° → no line, T.hint.pairSame
//     nameA, nameB,                      display names (a.name, or 你 when it is `me`, else TA)
//     headline, lines (≤ 4 plain strings, spec order), definition,
//     hint, horizonLabel, where, switchLabel, dates: [lineA, lineB],
//     targets: [{type:'star', index, n}]  Vega + Altair when both are shared, else the brightest shared star
//     vegaAltair: 'both' | 'split' | null,
//     shared: [star info …] (≤ 4 named stars brighter than 1.6 up for both, brightest first),
//     planetsShared: [body …], bodyShared: { Moon: bool, Mercury: bool, … } (up for both),
//     km, days, years }
//   The swapped standpoint (看小红的天空) is computeHepan(catalog, b, a, momentOf, opts): every field,
//   including the subjects of the lines, swaps with it.
import { skyState, mul, greatCircleKm, YEAR_MS } from './astro.js';
import { T, fmtCount, keepWords } from './copy.js';
import { fmtLy, starName } from './facts.js';

const DEG = Math.PI / 180;
const PLANETS = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'];
// which lines survive when there are more than four (highest first); they are shown in spec order
const PRIORITY = ['vegaAltair', 'brightest', 'moon', 'apart', 'lightYears', 'planets'];

function samePerson(p, q) {
  return !!(p && q && p.date === q.date && p.time === q.time
    && Math.abs(p.city.lat - q.city.lat) < 0.01 && Math.abs(p.city.lon - q.city.lon) < 0.01);
}

/** Zenith of the frame with matrix Mfrom, expressed in the NEU frame of Mto: Mto · Mfromᵀ · [0,0,1]. */
function zenithIn(Mto, Mfrom) {
  const z = mul(Mto, [Mfrom[2], Mfrom[5], Mfrom[8]]);
  const l = Math.hypot(z[0], z[1], z[2]) || 1;
  return [z[0] / l, z[1] / l, z[2] / l];
}

export function computeHepan(catalog, a, b, momentOf, opts = {}) {
  const ta = momentOf(a), tb = momentOf(b);
  const sa = skyState(ta, a.city.lat, a.city.lon);
  const sb = skyState(tb, b.city.lat, b.city.lon);
  const pos = catalog.stars.pos, count = catalog.stars.count;
  const A2 = sa.M[2], A5 = sa.M[5], A8 = sa.M[8], B2 = sb.M[2], B5 = sb.M[5], B8 = sb.M[8];
  let both = 0, either = 0;
  const upA = new Set(), upB = new Set();
  for (let i = 0; i < count; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const A = A2 * x + A5 * y + A8 * z > 0, B = B2 * x + B5 * y + B8 * z > 0;
    if (A || B) either++;
    if (A && B) both++;
    if (catalog.names.has(i)) { if (A) upA.add(i); if (B) upB.add(i); }
  }
  const score = either ? Math.round((both / either) * 100) : 0;

  const zB = zenithIn(sa.M, sb.M);
  const zA = zenithIn(sb.M, sa.M);
  const nearlySame = zB[2] > Math.cos(3 * DEG);

  // names: a stored-but-unnamed "me" is 你; anyone else unnamed is TA
  const pick = (p, given) => (given || (p.name && p.name.trim()) || (samePerson(p, opts.me) ? '你' : 'TA'));
  let nameA = pick(a, opts.nameA), nameB = pick(b, opts.nameB);
  if (nameA === nameB && !opts.nameA && !opts.nameB) {
    // two unnamed strangers, or two people with the same name
    if (!(a.name || '').trim() && !(b.name || '').trim()) { nameA = '一个人'; nameB = '另一个人'; }
    else nameB = `另一个${nameB}`;
  }

  keepWords([nameA, nameB, a.city.name, b.city.name]);

  const shared = [...catalog.names.values()]
    .filter((s) => s.mag < 1.6 && upA.has(s.i) && upB.has(s.i))
    .sort((x, y) => x.mag - y.mag).slice(0, 4);
  const bodyShared = {};
  for (const p of sa.bodies) bodyShared[p.id] = p.alt > 0 && sb.bodies.find((q) => q.id === p.id).alt > 0;
  const planetsShared = sa.bodies.filter((p) => PLANETS.includes(p.id) && bodyShared[p.id]);

  const find = (en) => [...catalog.names.values()].find((s) => s.en === en);
  const vega = find('Vega'), altair = find('Altair');
  let vegaAltair = null, vegaAltairLine = '';
  if (vega && altair) {
    const aV = upA.has(vega.i), aA = upA.has(altair.i), bV = upB.has(vega.i), bA = upB.has(altair.i);
    if (aV && aA && bV && bA) { vegaAltair = 'both'; vegaAltairLine = T.pair.vegaAltairBoth; }
    else if ((aV && bA) || (aA && bV)) {
      vegaAltair = 'split';
      vegaAltairLine = aV && bA ? T.pair.vegaAltairSplit(nameA, nameB) : T.pair.vegaAltairSplit(nameB, nameA);
    }
  }

  const km = greatCircleKm(a.city.lat, a.city.lon, b.city.lat, b.city.lon);
  const days = Math.round(Math.abs(tb - ta) / 86400000);
  const years = Math.abs(tb - ta) / YEAR_MS;
  const sameCity = km < 30;
  let apart;
  if (sameCity) apart = days === 0 ? T.pair.sameCitySameDay : T.pair.sameCity(fmtCount(days));
  else apart = days === 0 ? T.pair.apartSameDay(fmtCount(km)) : T.pair.apart(fmtCount(km), fmtCount(days));

  let lightYears = '';
  if (years >= 3.8) {
    let near = null;
    for (const s of catalog.names.values()) {
      if (!s.ly || s.mag > 3.5) continue;
      if (!near || Math.abs(s.ly - years) < Math.abs(near.ly - years)) near = s;
    }
    if (near) lightYears = T.pair.lightYears(years.toFixed(1), starName(near), fmtLy(near.ly));
  }

  const pa = sa.moonPhase.name, pb = sb.moonPhase.name;
  const candidates = {
    brightest: shared.length ? T.pair.brightest(shared.map(starName)) : '',
    vegaAltair: vegaAltairLine,
    moon: pa === pb ? T.pair.moonSame(pa) : T.pair.moons(nameA, pa, nameB, pb),
    planets: planetsShared.length ? T.pair.planets(planetsShared.map((p) => p.zh)) : '',
    apart,
    lightYears,
  };
  const keep = new Set(PRIORITY.filter((k) => candidates[k]).slice(0, 4));
  const ORDER = ['brightest', 'vegaAltair', 'moon', 'planets', 'apart', 'lightYears'];
  const lines = ORDER.filter((k) => keep.has(k)).map((k) => candidates[k]);

  const withN = (s) => ({ type: 'star', index: s.i, n: mul(sa.M, [pos[s.i * 3], pos[s.i * 3 + 1], pos[s.i * 3 + 2]]) });
  const targets = vegaAltair === 'both' ? [withN(vega), withN(altair)] : shared.length ? [withN(shared[0])] : [];

  return {
    a, b, ta, tb, sa, sb,
    both, either, score, zB, zA, nearlySame,
    nameA, nameB,
    headline: T.pair.headline(fmtCount(both)),
    lines,
    definition: T.pair.definition(score, fmtCount(both), fmtCount(either)),
    hint: nearlySame ? T.hint.pairSame : T.hint.pairLine(nameB),
    horizonLabel: T.pair.horizon(nameB),
    where: T.pair.where(nameA, a.city.name),
    switchLabel: T.pair.switchTo(nameB),
    dates: [T.pair.date(nameA, a), T.pair.date(nameB, b)],
    targets, vegaAltair, shared, planetsShared, bodyShared,
    km, days, years,
  };
}

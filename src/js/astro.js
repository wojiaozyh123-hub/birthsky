// Astronomy for a moment + place: sky rotation, Sun/Moon/planets, lunar calendar, solar terms.
// Horizontal vectors throughout the app use NEU axes: x = north, y = east, z = up (zenith).
import * as A from 'astronomy-engine';

export const DEG = Math.PI / 180;
const SIDEREAL_DAY_MS = 86164090.5;
const YEAR_MS = 365.2425 * 86400000;
export { SIDEREAL_DAY_MS, YEAR_MS };

// ---------------------------------------------------------------- time zones
const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a time zone. */
export function zonedParts(date, tz) {
  const parts = dtf(tz).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { y: +get('year'), m: +get('month'), d: +get('day'), hh: +get('hour') % 24, mm: +get('minute'), s: +get('second'), wd };
}

function offsetMs(tz, utcMs) {
  const p = zonedParts(new Date(utcMs), tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.s) - Math.floor(utcMs / 1000) * 1000;
}

/** Local wall-clock time in an IANA zone → UTC Date (handles historical DST via the browser's tz data). */
export function zonedToUtc(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off1 = offsetMs(tz, guess);
  let utc = guess - off1;
  const off2 = offsetMs(tz, utc);
  if (off2 !== off1) utc = guess - off2;
  return new Date(utc);
}

export function isValidTz(tz) {
  try { dtf(tz); return true; } catch { return false; }
}

// ---------------------------------------------------------------- vectors
export function radec(raDeg, decDeg) {
  const ra = raDeg * DEG, dec = decDeg * DEG, c = Math.cos(dec);
  return [c * Math.cos(ra), c * Math.sin(ra), Math.sin(dec)];
}

/** n = M·p for a column-major 3×3 (Float32Array(9)). */
export function mul(M, p, out = [0, 0, 0]) {
  const [x, y, z] = p;
  out[0] = M[0] * x + M[3] * y + M[6] * z;
  out[1] = M[1] * x + M[4] * y + M[7] * z;
  out[2] = M[2] * x + M[5] * y + M[8] * z;
  return out;
}

export function altAz(n) {
  const alt = Math.asin(Math.max(-1, Math.min(1, n[2]))) / DEG;
  let az = Math.atan2(n[1], n[0]) / DEG;
  if (az < 0) az += 360;
  return { alt, az };
}

const DIRS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
export function dirName(az) {
  return DIRS[Math.round(((az % 360) + 360) % 360 / 45) % 8];
}

// ---------------------------------------------------------------- sky state
export const BODIES = [
  { id: 'Sun', zh: '太阳', color: [1, 0.86, 0.62] },
  { id: 'Moon', zh: '月亮', color: [0.95, 0.93, 0.88] },
  { id: 'Mercury', zh: '水星', color: [0.85, 0.82, 0.78] },
  { id: 'Venus', zh: '金星', color: [1, 0.96, 0.84] },
  { id: 'Mars', zh: '火星', color: [1, 0.62, 0.42] },
  { id: 'Jupiter', zh: '木星', color: [0.98, 0.9, 0.78] },
  { id: 'Saturn', zh: '土星', color: [0.95, 0.85, 0.62] },
];

/** Rotation matrix EQJ (J2000 equatorial) → NEU horizontal, column-major Float32Array(9). */
export function skyMatrix(date, lat, lon, out = new Float32Array(9)) {
  const time = A.MakeTime(date);
  const R = A.Rotation_EQJ_HOR(time, new A.Observer(lat, lon, 0)).rot;
  // RotateVector maps e_j to rot[j]; astronomy-engine's HOR axes are (north, west, zenith).
  for (let j = 0; j < 3; j++) {
    out[j * 3] = R[j][0];
    out[j * 3 + 1] = -R[j][1];
    out[j * 3 + 2] = R[j][2];
  }
  return out;
}

export function moonPhaseName(angle) {
  const a = ((angle % 360) + 360) % 360;
  if (a < 11.25 || a >= 348.75) return '新月';
  if (a < 78.75) return '蛾眉月';
  if (a < 101.25) return '上弦月';
  if (a < 168.75) return '盈凸月';
  if (a < 191.25) return '满月';
  if (a < 258.75) return '亏凸月';
  if (a < 281.25) return '下弦月';
  return '残月';
}

/**
 * Everything the renderer and the fact cards need for one instant.
 * `bodies` carries horizontal unit vectors, so it is cheap to call per frame while scrubbing.
 */
export function skyState(date, lat, lon) {
  const time = A.MakeTime(date);
  const obs = new A.Observer(lat, lon, 0);
  const M = skyMatrix(date, lat, lon);
  const bodies = BODIES.map((b) => {
    const eq = A.Equator(A.Body[b.id], time, obs, false, true);
    const n = mul(M, radec(eq.ra * 15, eq.dec));
    const { alt, az } = altAz(n);
    let mag = 0;
    if (b.id === 'Sun') mag = -26.7;
    else {
      try { mag = A.Illumination(A.Body[b.id], time).mag; } catch { mag = 0; }
    }
    return { ...b, n, alt, az, mag, dist: eq.dist };
  });
  const phaseAngle = A.MoonPhase(time);
  const illum = A.Illumination(A.Body.Moon, time).phase_fraction;
  const sun = bodies[0];
  return {
    date, lat, lon, M, bodies,
    sun, moon: bodies[1],
    moonPhase: { angle: phaseAngle, illum, name: moonPhaseName(phaseAngle), waxing: phaseAngle < 180 },
    daylight: daylightState(sun.alt, sun.az),
  };
}

export function daylightState(alt, az) {
  const morning = az < 180;
  if (alt > 0) return { key: 'day', zh: '白天', veil: 1 };
  if (alt > -6) return { key: 'civil', zh: morning ? '黎明' : '黄昏', veil: 0.55 };
  if (alt > -12) return { key: 'nautical', zh: morning ? '拂晓' : '入夜', veil: 0.25 };
  if (alt > -18) return { key: 'astro', zh: morning ? '天将破晓' : '夜色渐深', veil: 0.08 };
  return { key: 'night', zh: '深夜', veil: 0 };
}

// ---------------------------------------------------------------- Chinese calendar
const LUNAR_DAYS = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'];
const ZODIAC = { 子: '鼠', 丑: '牛', 寅: '虎', 卯: '兔', 辰: '龙', 巳: '蛇', 午: '马', 未: '羊', 申: '猴', 酉: '鸡', 戌: '狗', 亥: '猪' };
let lunarFmt = null;

export function lunarDate(date, tz) {
  try {
    lunarFmt = lunarFmt?.tz === tz ? lunarFmt : {
      tz, f: new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { timeZone: tz, year: 'numeric', month: 'long', day: 'numeric' }),
    };
    const parts = lunarFmt.f.formatToParts(date);
    const month = parts.find((p) => p.type === 'month')?.value;
    const day = +parts.find((p) => p.type === 'day')?.value;
    const yearName = parts.find((p) => p.type === 'yearName')?.value || '';
    if (!month || !day || !/月$/.test(month)) return null;
    const animal = ZODIAC[yearName.slice(-1)] || '';
    return { yearName, animal, month, day, text: `农历${month}${LUNAR_DAYS[day - 1]}` };
  } catch {
    return null;
  }
}

const TERMS = ['立春', '雨水', '惊蛰', '春分', '清明', '谷雨', '立夏', '小满', '芒种', '夏至', '小暑', '大暑',
  '立秋', '处暑', '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至', '小寒', '大寒'];

/** Current solar term and whole days since it began (in the given zone's calendar days). */
export function solarTerm(date, tz) {
  const time = A.MakeTime(date);
  const elon = A.SunPosition(time).elon;
  const idx = Math.floor((((elon - 315) % 360) + 360) % 360 / 15);
  const startLon = (315 + idx * 15) % 360;
  let days = Math.floor((((elon - startLon) % 360) + 360) % 360 / 0.9856);
  try {
    const start = A.SearchSunLongitude(startLon, time.AddDays(-17), 18);
    if (start) {
      const a = zonedParts(start.date, tz), b = zonedParts(date, tz);
      days = Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
    }
  } catch { /* keep the estimate */ }
  return { name: TERMS[idx], days, elon };
}

// ---------------------------------------------------------------- misc
export function yearsBetween(a, b) {
  return (b.getTime() - a.getTime()) / YEAR_MS;
}

export function greatCircleKm(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG, p2 = lat2 * DEG, dp = p2 - p1, dl = (lon2 - lon1) * DEG;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

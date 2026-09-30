// What was true on the night: moon, lunar date, solar term, the star overhead, planets,
// how many stars were up, and the "light-year star" whose light left home the year you were born.
import { mul, dirName, lunarDate, solarTerm, zonedParts, yearsBetween } from './astro.js';
import { ICONS, escapeHtml, fmtNum } from './ui.js';

const AU_KM = 149597870.7;

export const STAR_NOTES = {
  Sirius: '全天最亮的恒星。冬夜南方天空里那颗蓝白色、闪得最厉害的星就是它。',
  Canopus: '全天第二亮的恒星。古人说看见它便会长寿，所以叫它老人星、寿星。',
  'Rigil Kentaurus': '离太阳系最近的恒星系统，光从那里出发，只要 4.3 年就能到达地球。',
  Arcturus: '北半球春夜最亮的星。顺着北斗斗柄的弧线向外延伸，就能找到这颗橙色的星。',
  Vega: '七夕传说里的织女。夏夜头顶最亮的星之一，隔着银河与牛郎星遥遥相望。',
  Altair: '七夕传说里的牛郎，古称河鼓二。两旁的两颗小星，被说成他挑着的一双儿女。',
  Deneb: '天鹅座的尾巴，也是银河里的“渡口”。它极其遥远，却仍亮得足以组成夏季大三角。',
  Capella: '御夫座最亮的星，冬夜高悬头顶。它其实是由两对恒星组成的四合星系统。',
  Rigel: '猎户座脚下的蓝白色超巨星，比太阳亮上万倍。',
  Procyon: '冬季大三角的一角，离我们只有 11 光年多一点。',
  Betelgeuse: '猎户座肩头的红超巨星。如果把它放在太阳的位置，它会吞没火星的轨道。',
  Aldebaran: '金牛座红色的“牛眼”，冬夜里跟在昴星团后面升起。',
  Antares: '天蝎的心脏，一颗火红的超巨星。古人叫它“大火”，“七月流火”说的就是它。',
  Spica: '处女座最亮的星，也是东方苍龙的“龙角”。',
  Pollux: '双子座两兄弟中更亮的一位，一颗离我们不远的橙色巨星。',
  Castor: '双子座的另一位兄弟，其实是由六颗恒星组成的家族。',
  Fomalhaut: '秋夜南方天空里唯一的亮星，孤零零地挂着，所以格外好认。',
  Regulus: '狮子座的心脏，几乎正好躺在太阳每年经过的黄道上。',
  Polaris: '几乎一动不动地守在正北方，整片星空都绕着它旋转。',
  Algol: '一颗会“眨眼”的星：每隔不到三天，它会暗下去几个小时，因为伴星从它面前经过。',
  Alcyone: '昴星团里最亮的一颗。昴星团是一群差不多同时诞生的年轻恒星。',
  Mimosa: '南十字座的一颗亮星，只有在南方低纬度的地方才看得到。',
  Acrux: '南十字座最亮的星，南半球的人用南十字来寻找正南方向。',
  Achernar: '波江座的“河的尽头”。它自转得非常快，被甩成了一个扁球。',
};
const DIPPER = new Set(['Dubhe', 'Merak', 'Phecda', 'Megrez', 'Alioth', 'Mizar', 'Alkaid']);

export const BODY_NOTES = {
  Moon: '',
  Sun: '',
  Mercury: '离太阳最近的行星，古称辰星，总是贴着地平线在晨昏时出现。',
  Venus: '除了日月，天上最亮的天体。清晨叫启明，黄昏叫长庚。',
  Mars: '红色的“荧惑”，古人觉得它行踪不定，令人迷惑。',
  Jupiter: '太阳系最大的行星，古称岁星，大约十二年绕天一周。',
  Saturn: '带着光环的“镇星”，大约二十九年才绕天一周。',
};

function starVec(catalog, i) {
  const p = catalog.stars.pos;
  return [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
}

export function momentYear(date, tz) {
  return zonedParts(date, tz).y;
}

/**
 * @param subject '你' for your own sky, 'TA' for someone else's.
 */
export function computeFacts(catalog, person, moment, sky, now = new Date()) {
  const { M } = sky;
  const n = [0, 0, 0];
  let visible = 0, zenith = null, zenAlt = -1;
  const pos = catalog.stars.pos, mag = catalog.stars.mag;
  for (let i = 0; i < catalog.stars.count; i++) {
    mul(M, [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], n);
    if (n[2] <= 0) continue;
    visible++;
    if (mag[i] <= 3 && catalog.names.has(i) && n[2] > zenAlt) { zenAlt = n[2]; zenith = i; }
  }
  const zenithInfo = zenith !== null ? { ...catalog.names.get(zenith), fromZenith: 90 - Math.asin(zenAlt) * 180 / Math.PI } : null;

  const planets = sky.bodies.filter((b) => !['Sun', 'Moon'].includes(b.id) && b.alt > 0)
    .sort((a, b) => a.mag - b.mag);

  const age = Math.max(0, yearsBetween(moment, now));
  const light = lightYearStar(catalog, age);
  const tz = person.city.tz;
  return {
    visible,
    zenith: zenithInfo,
    planets,
    moon: { ...sky.moonPhase, up: sky.moon.alt > 0, alt: sky.moon.alt, az: sky.moon.az, distKm: sky.moon.dist * AU_KM },
    sun: { alt: sky.sun.alt, az: sky.sun.az },
    daylight: sky.daylight,
    lunar: lunarDate(moment, tz),
    term: solarTerm(moment, tz),
    age, light,
    birthYear: momentYear(moment, tz),
  };
}

function lightYearStar(catalog, age) {
  let best = null, bestScore = Infinity;
  for (const info of catalog.names.values()) {
    if (!info.ly || info.mag > 4.3 || info.ly > 400) continue;
    const score = Math.abs(info.ly - age) + Math.max(0, info.mag - 1.5) * 0.35;
    if (score < bestScore) { bestScore = score; best = info; }
  }
  return best;
}

// ---------------------------------------------------------------- copy
const cnYear = (y) => `${y} 年`;

export function lightStarSentence(f, subject = '你') {
  const s = f.light;
  if (!s) return '';
  const nowYear = new Date().getFullYear();
  const dep = Math.round(nowYear - s.ly);
  const name = `<em>${escapeHtml(s.zh)}</em>`;
  if (f.age < 4) {
    return `今晚${subject}看到的每一颗星，光都出发在${subject}出生之前。离我们最近的南门二，光也要走 4.3 年。`;
  }
  const diff = s.ly - f.age;
  if (Math.abs(diff) < 1.2) {
    return `今晚抬头，${subject}看到的${name}的光，是在${subject}出生那年出发的——它走了 ${s.ly.toFixed(1)} 光年，刚好走完${subject}到今天的这一段路。`;
  }
  if (diff < 0) {
    return `今晚${subject}看到的${name}，光是在 ${cnYear(dep)}出发的，那年${subject} ${Math.max(1, Math.round(f.age - s.ly))} 岁。`;
  }
  return `今晚${subject}看到的${name}，光在 ${cnYear(dep)}就已出发，比${subject}出生还早 ${Math.round(diff)} 年。`;
}

export function factsPeek(f) {
  const moon = `<b>${f.moon.name}</b>`;
  const lunar = f.lunar ? ` · ${f.lunar.text}` : '';
  return `${moon}${lunar} · ${f.term.name} · ${fmtNum(f.visible)} 颗星`;
}

export function renderFacts(el, f, { subject = '你', person, slotHtml = '' } = {}) {
  const items = [];
  const moonDir = f.moon.up ? `挂在${dirName(f.moon.az)}方的天空` : '还在地平线以下';
  const phasePct = Math.round(f.moon.illum * 100);
  items.push({
    key: 'moon', glyph: `<canvas data-moon width="80" height="80"></canvas>`, title: '那晚的月亮',
    body: `一轮<em>${f.moon.name}</em>，${moonDir}。`,
    small: `${f.lunar ? `${f.lunar.yearName}${f.lunar.animal ? f.lunar.animal : ''}年 · ${f.lunar.text} · ` : ''}被照亮 ${phasePct}%`,
  });
  items.push({
    key: 'count', glyph: ICONS.count, title: '头顶的星星',
    body: `那一刻，地平线之上有 <em>${fmtNum(f.visible)}</em> 颗肉眼可见的恒星。`,
    small: f.daylight.key === 'night' ? '它们都在深夜里亮着。' : daylightNote(f, subject),
  });
  if (f.zenith) {
    items.push({
      key: 'zenith', glyph: ICONS.zenith, title: '正上方', target: { type: 'star', index: f.zenith.i },
      body: `离${subject}头顶最近的亮星，是${f.zenith.conZh ? f.zenith.conZh + '的' : ''}<em>${escapeHtml(f.zenith.zh)}</em>。`,
      small: `偏离天顶 ${f.zenith.fromZenith.toFixed(1)}°${f.zenith.ly ? ` · 距离地球 ${fmtLy(f.zenith.ly)}` : ''}`,
    });
  }
  items.push({
    key: 'planets', glyph: ICONS.planet, title: '行星',
    target: f.planets[0] ? { type: 'body', id: f.planets[0].id } : null,
    body: f.planets.length
      ? f.planets.map((p) => `<em>${p.zh}</em>在${dirName(p.az)}方`).join('，') + '。'
      : '那一刻，五颗亮行星都在地平线以下。',
    small: f.planets.length ? `${f.planets.length} 颗行星与${subject}同在一片夜空下` : '它们正在地球的另一侧照着别人。',
  });
  items.push({
    key: 'term', glyph: `<b>${f.term.name.slice(0, 1)}</b>`, title: '节气',
    body: f.term.days <= 0 ? `正是<em>${f.term.name}</em>这一天。` : `<em>${f.term.name}</em>后的第 ${f.term.days + 1} 天。`,
    small: `太阳黄经 ${f.term.elon.toFixed(1)}°`,
  });
  if (f.light) {
    items.push({
      key: 'light', glyph: ICONS.light, title: '光年之星', target: { type: 'star', index: f.light.i },
      body: lightStarSentence(f, subject),
      small: `${escapeHtml(f.light.zh)} · ${escapeHtml(f.light.conZh || '')} · 距离 ${fmtLy(f.light.ly)}`,
    });
  }

  el.innerHTML = items.map((it, k) => `
    <article class="fact" data-k="${k}">
      <div class="glyph">${it.glyph}</div>
      <div><h4>${it.title}</h4><p>${it.body}</p>${it.small ? `<small>${it.small}</small>` : ''}</div>
    </article>`).join('') + slotHtml + `
    <p class="facts-foot">${person?.unknownTime ? '出生时间未知，按当晚 22:00 绘制。<br>' : ''}恒星取自 HYG 星表，日月行星位置误差小于 1 角分。<br>点击星星，看看它的故事。</p>`;
  return items;
}

function daylightNote(f, subject) {
  const d = f.daylight;
  if (d.key === 'day') return `${subject}出生在白天，太阳在${dirName(f.sun.az)}方。星星都在，只是被阳光藏了起来。`;
  if (d.key === 'civil') return `那是${d.zh}时分，天边还留着一抹光，最亮的星已经出来了。`;
  return `${d.zh}，天色正一点点暗下来。`;
}

export function fmtLy(ly) {
  if (ly < 20) return `${ly.toFixed(1)} 光年`;
  return `${Math.round(ly)} 光年`;
}

/** Card text for a tapped star or body. */
export function describe(catalog, sel, sky, facts) {
  if (sel.type === 'star') {
    const info = catalog.names.get(sel.index);
    if (!info) return null;
    const nowYear = new Date().getFullYear();
    let light = '';
    if (info.ly) {
      const dep = Math.round(nowYear - info.ly);
      const rel = dep < facts.birthYear ? `，比你出生早 ${facts.birthYear - dep} 年` : dep === facts.birthYear ? '，正是你出生那年' : `，那年你 ${dep - facts.birthYear} 岁`;
      light = info.ly > 3000 ? '它远得难以测准，光在路上走了几千年。' : `今晚看到的这束光，出发于 <em>${dep < 0 ? `公元前 ${-dep}` : dep} 年</em>${dep > 0 && info.ly < 150 ? rel : ''}。`;
    }
    const note = STAR_NOTES[info.en] || (DIPPER.has(info.en) ? '北斗七星之一。斗柄东指，天下皆春；斗柄南指，天下皆夏。' : '');
    return {
      title: escapeHtml(info.zh), sub: info.en ? escapeHtml(info.en) : (info.alt ? escapeHtml(info.alt) : ''),
      meta: [info.conZh, `亮度 ${info.mag.toFixed(1)} 等`, info.ly ? `距离 ${fmtLy(info.ly)}` : ''].filter(Boolean).join(' · '),
      text: [note, light].filter(Boolean).join(''),
    };
  }
  const b = sky.bodies.find((x) => x.id === sel.id);
  if (!b) return null;
  const lightMin = (b.dist * AU_KM) / 299792.458 / 60;
  if (b.id === 'Moon') {
    return {
      title: '月亮', sub: sky.moonPhase.name,
      meta: `被照亮 ${Math.round(sky.moonPhase.illum * 100)}% · 距离 ${fmtNum(b.dist * AU_KM)} 公里`,
      text: `月光从月面出发，只要 ${(lightMin * 60).toFixed(1)} 秒就能落进你的眼睛。${facts.lunar ? `那天是${facts.lunar.text}。` : ''}`,
    };
  }
  if (b.id === 'Sun') {
    return {
      title: '太阳', sub: 'Sun', meta: `高度 ${b.alt.toFixed(1)}° · ${dirName(b.az)}方`,
      text: `阳光走了 ${Math.floor(lightMin)} 分 ${Math.round((lightMin % 1) * 60)} 秒才来到你身边。`,
    };
  }
  return {
    title: b.zh, sub: b.id, meta: `亮度 ${b.mag.toFixed(1)} 等 · 距离 ${b.dist.toFixed(2)} 天文单位`,
    text: `${BODY_NOTES[b.id] || ''}那一刻你看到的${b.zh}，是 <em>${lightMin < 60 ? `${Math.round(lightMin)} 分钟` : `${(lightMin / 60).toFixed(1)} 小时`}</em>前的它。`,
  };
}

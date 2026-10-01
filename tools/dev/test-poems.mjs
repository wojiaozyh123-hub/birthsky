import { poemForPerson, attribution, POEMS, PAIR_POEMS } from '../../src/js/poems.js';
const P = (date, time, name, region, lat, lon, tz) => ({ date, time, city: { name, region, lat, lon, tz } });
const people = [
  P('1998-07-14', '22:00', '杭州', '浙江', 30.29, 120.16, 'Asia/Shanghai'),
  P('2000-01-02', '06:10', '成都', '四川', 30.67, 104.07, 'Asia/Shanghai'),
  P('1995-12-20', '23:10', '北京', '北京', 39.91, 116.4, 'Asia/Shanghai'),
  P('1992-03-08', '21:00', '多伦多', '安大略 · 加拿大', 43.7, -79.4, 'America/Toronto'),
  P('2003-06-01', '01:30', '悉尼', '新南威尔士 · 澳大利亚', -33.87, 151.2, 'Australia/Sydney'),
  P('1988-10-05', '20:00', '深圳', '广东', 22.54, 114.06, 'Asia/Shanghai'),
  P('1999-02-11', '19:40', '哈尔滨', '黑龙江', 45.75, 126.65, 'Asia/Shanghai'),
  P('2001-08-20', '21:30', '丽江', '云南', 26.87, 100.23, 'Asia/Shanghai'),
];
for (const p of people) {
  const r = poemForPerson(p);
  console.log(`${p.date} ${p.city.name}${r.regional ? '（' + r.place + '）' : ''} → ${r.poem.id} ${r.poem.lines.join('')} ${attribution(r.poem)}`);
  console.log('   换一首:', [1, 2, 3].map((k) => poemForPerson(p, k).poem.lines.join('').slice(0, 14)).join(' | '));
}
const a = people[0], b = people[1];
for (const k of [0, 1, 2]) { const r = poemForPerson(a, k, { pair: true, partner: b }); console.log('pair', k, r.poem.id, r.poem.lines.join(''), attribution(r.poem)); }
console.log('no partner:', poemForPerson(a, 0, { pair: true }).poem.lines.join(''));
// distribution of defaults over many random people (balance check)
const counts = new Map();
for (let i = 0; i < 3000; i++) {
  const d = new Date(Date.UTC(1970 + (i * 7) % 55, (i * 5) % 12, 1 + (i * 3) % 28));
  const p = P(d.toISOString().slice(0, 10), `${String(18 + i % 6).padStart(2, '0')}:00`, ['北京', '上海', '广州', '杭州', '成都', '武汉', '西安', '南京'][i % 8], '', 31, 118, 'Asia/Shanghai');
  const id = poemForPerson(p).poem.id; counts.set(id, (counts.get(id) || 0) + 1);
}
const v = [...counts.values()].sort((x, y) => y - x);
console.log('distinct defaults over 3000 people:', counts.size, 'max share', v[0], 'min', v[v.length - 1]);

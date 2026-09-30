#!/usr/bin/env node
/**
 * build-cities.mjs — builds src/data/cities.json (world city list with
 * Simplified Chinese names, admin1 regions, coordinates and IANA time zones)
 * for the birth-city picker.
 *
 * DATA SOURCE / LICENSE
 *   GeoNames (https://www.geonames.org/), licensed CC BY 4.0
 *   (https://creativecommons.org/licenses/by/4.0/). The app must credit
 *   "GeoNames" wherever the city data is used. The generated JSON is a
 *   derived, filtered and transformed subset of the GeoNames dump.
 *
 * INPUTS (downloaded manually into .cache/geonames/, which is git-ignored)
 *   https://download.geonames.org/export/dump/cities15000.zip
 *   https://download.geonames.org/export/dump/alternateNamesV2.zip
 *   https://download.geonames.org/export/dump/admin1CodesASCII.txt
 *   https://download.geonames.org/export/dump/countryInfo.txt
 * OPTIONAL (strongly recommended — without them ~570 Chinese towns get no
 * Chinese name, e.g. 常熟/长治/宝安, because GeoNames only attaches the Chinese
 * name to the matching county/district feature, not to the populated place):
 *   https://download.geonames.org/export/dump/{CN,HK,MO,TW}.zip
 *
 *   mkdir -p .cache/geonames && cd .cache/geonames && \
 *     for f in cities15000.zip alternateNamesV2.zip admin1CodesASCII.txt countryInfo.txt \
 *              CN.zip HK.zip MO.zip TW.zip; do \
 *       curl -fLO "https://download.geonames.org/export/dump/$f"; done
 *
 * USAGE
 *   node tools/build-cities.mjs [--min-pop=100000] [--max-gz=225280] [--no-icu]
 *                               [--verbose] [--report-converted[=N]] [--dump-t2s=FILE]
 *
 *   --min-pop  population threshold for cities outside CN/HK/MO/TW (default 100000).
 *              If the gzipped output exceeds --max-gz bytes, the threshold is raised
 *              in 25k steps until it fits (reported in the summary).
 *   --no-icu   skip the macOS ICU Traditional->Simplified transform and use the
 *              built-in per-character fallback table (FALLBACK_T2S).
 *   --verbose  list the Chinese towns renamed after their county (玉山 -> 昆山).
 *   --report-converted  list big non-China cities whose name only exists in
 *              Traditional script (often Taiwan transliterations) for review.
 *   --dump-t2s regenerate the FALLBACK_T2S table (macOS only).
 *
 * Requires Node >= 22 and the `unzip` CLI (used to stream the zip archives).
 * On macOS, `osascript` (JavaScript for Automation) is used to run ICU's
 * "Hant-Hans" transform; elsewhere the built-in FALLBACK_T2S table is used
 * (same mapping, character by character; regenerate it after data updates).
 *
 * The (large) alternate-names file is streamed once and its Chinese/Han subset
 * (zh*, plus Han-script ja/ko/untagged names) is cached in
 * .cache/geonames/alternateNames-han-v2.tsv; delete that file to force
 * a re-scan (it is refreshed automatically when the zip is newer).
 *
 * OUTPUT (minified)
 *   { v: 1, tz: [ianaId...], cc: {ISO2: zhCountryName}, a1: [regionName...],
 *     c: [[zh, en, a1Idx, cc, lat, lon, tzIdx, pop], ...] }   // pop desc
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths & options
// ---------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache', 'geonames');
const OUT = path.join(ROOT, 'src', 'data', 'cities.json');

const FILES = {
  cities: path.join(CACHE, 'cities15000.zip'),
  alt: path.join(CACHE, 'alternateNamesV2.zip'),
  admin1: path.join(CACHE, 'admin1CodesASCII.txt'),
  country: path.join(CACHE, 'countryInfo.txt'),
  altCache: path.join(CACHE, 'alternateNames-han-v2.tsv'),
};
const COUNTRY_DUMPS = ['CN', 'HK', 'MO', 'TW'].map((cc) => ({ cc, file: path.join(CACHE, `${cc}.zip`) }));

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const MIN_POP = Number(args['min-pop'] ?? 100000);
const MAX_GZ = Number(args['max-gz'] ?? 220 * 1024);
const USE_ICU = !args['no-icu'];

const CHINA_CCS = new Set(['CN', 'HK', 'MO', 'TW']);
// countries whose native place names are (also) written in Han characters
const HANJA_CCS = new Set(['JP', 'KR', 'KP']);

// Popular overseas study / immigration destinations that must be present
// even when below the population threshold (only if they are in cities15000).
// Format: "Name|CC|admin1" (admin1 optional); most populous match wins.
// (Hanover NH and Stanford CA are below 15k people and absent from cities15000.)
const HAND_PICKED = [
  // Canada
  'Waterloo|CA|08', 'Kitchener|CA|08', 'Kingston|CA|08', 'Guelph|CA|08', 'Hamilton|CA|08',
  'London|CA|08', 'Windsor|CA|08', 'Peterborough|CA|08', 'St. Catharines|CA|08', 'Oakville|CA|08',
  'Markham|CA|08', 'Richmond Hill|CA|08', 'Victoria|CA|02', 'Burnaby|CA|02', 'Richmond|CA|02',
  'Kelowna|CA|02', 'Halifax|CA|07', 'Fredericton|CA|04', 'Saskatoon|CA|11', 'Regina|CA|11',
  'Sherbrooke|CA|10',
  // United States
  'Ithaca|US|NY', 'Ann Arbor|US|MI', 'Princeton|US|NJ', 'Palo Alto|US|CA', 'Berkeley|US|CA',
  'Irvine|US|CA', 'Davis|US|CA', 'Champaign|US|IL', 'Urbana|US|IL', 'Evanston|US|IL',
  'New Haven|US|CT', 'Durham|US|NC', 'Chapel Hill|US|NC', 'Hanover|US|NH', 'Cambridge|US|MA',
  'Somerville|US|MA', 'Medford|US|MA', 'Stanford|US|CA', 'Menlo Park|US|CA', 'Mountain View|US|CA',
  'Cupertino|US|CA', 'Santa Clara|US|CA', 'Sunnyvale|US|CA', 'San Mateo|US|CA', 'Pasadena|US|CA',
  'Santa Barbara|US|CA', 'Santa Cruz|US|CA', 'Riverside|US|CA', 'Arcadia|US|CA', 'Alhambra|US|CA',
  'West Lafayette|US|IN', 'Bloomington|US|IN', 'State College|US|PA', 'Madison|US|WI',
  'Boulder|US|CO', 'Ames|US|IA', 'Iowa City|US|IA', 'Lawrence|US|KS', 'College Station|US|TX',
  'Gainesville|US|FL', 'East Lansing|US|MI', 'Blacksburg|US|VA', 'Charlottesville|US|VA',
  'Athens|US|GA', 'Tempe|US|AZ', 'Corvallis|US|OR', 'Eugene|US|OR', 'Pullman|US|WA',
  'Bellevue|US|WA', 'Redmond|US|WA', 'Hoboken|US|NJ', 'New Brunswick|US|NJ', 'Newark|US|DE',
  'Troy|US|NY', 'Amherst|US|MA', 'Providence|US|RI', 'Honolulu|US|HI', 'Pittsburgh|US|PA',
  // United Kingdom & Ireland
  'Cambridge|GB|ENG', 'Oxford|GB|ENG', 'Saint Andrews|GB|SCT', 'Bath|GB|ENG', 'Coventry|GB|ENG',
  'Durham|GB|ENG', 'York|GB|ENG', 'Exeter|GB|ENG', 'Warwick|GB|ENG', 'Lancaster|GB|ENG',
  'Canterbury|GB|ENG', 'Loughborough|GB|ENG', 'Guildford|GB|ENG', 'Egham|GB|ENG',
  'Colchester|GB|ENG', 'Reading|GB|ENG', 'Southampton|GB|ENG', 'Brighton|GB|ENG',
  'Norwich|GB|ENG', 'Leicester|GB|ENG', 'Aberdeen|GB|SCT', 'Dundee|GB|SCT', 'Stirling|GB|SCT',
  'Swansea|GB|WLS', 'Cardiff|GB|WLS', 'Belfast|GB|NIR', 'Cork|IE', 'Galway|IE',
  // Continental Europe
  'Leuven|BE', 'Gent|BE', 'Delft|NL', 'Leiden|NL', 'Groningen|NL', 'Eindhoven|NL',
  'Wageningen|NL', 'Enschede|NL', 'Maastricht|NL', 'Utrecht|NL', 'Lausanne|CH', 'Geneva|CH',
  'Basel|CH', 'Zurich|CH', 'Heidelberg|DE', 'Göttingen|DE', 'Tübingen|DE', 'Aachen|DE',
  'Freiburg|DE', 'Karlsruhe|DE', 'Darmstadt|DE', 'Bonn|DE', 'Mannheim|DE', 'Uppsala|SE',
  'Lund|SE', 'Trondheim|NO', 'Århus|DK', 'Grenoble|FR', 'Bologna|IT', 'Padua|IT', 'Pisa|IT',
  // Oceania
  'Canberra|AU', 'Wollongong|AU', 'Newcastle|AU', 'Hobart|AU', 'Darwin|AU', 'Geelong|AU',
  'Townsville|AU', 'Gold Coast|AU', 'Dunedin|NZ', 'Hamilton|NZ', 'Christchurch|NZ',
  'Wellington|NZ', 'Palmerston North|NZ',
  // Asia
  'Tsukuba|JP', 'Daejeon|KR', 'George Town|MY', 'Johor Bahru|MY',
];

// Hand overrides for country names where the GeoNames pick is not the
// conventional Simplified Chinese (mainland) form.
const COUNTRY_ZH_OVERRIDES = {
  CN: '中国', HK: '中国香港', MO: '中国澳门', TW: '中国台湾',
  US: '美国', GB: '英国', KR: '韩国', KP: '朝鲜', RU: '俄罗斯',
  CD: '刚果（金）', CG: '刚果（布）', CI: '科特迪瓦', MK: '北马其顿', SZ: '斯威士兰',
  MR: '毛里塔尼亚', IM: '马恩岛',
};

// Curated city names (by geonameid) where GeoNames only offers a Taiwan/HK
// transliteration or an odd form; values are mainland-standard names.
// Run with --report-converted to list candidates for review.
const CITY_ZH_OVERRIDES = {
  // China: GeoNames county names that are outdated or mistyped
  1790587: '襄阳', // Xiangyang (county data still says 襄樊, renamed 2010)
  1795860: '韶山', // Shaoshan (照山)
  1816329: '璧山', // Bishan, Chongqing (壁山 / seat 璧城)
  2038283: '宾县', // Bin Xian, Heilongjiang
  2038118: '朝阳镇', // Chaoyang, Jilin (seat of Huinan county; no Chinese name in GeoNames)
  // Missing in GeoNames but common birthplaces / big cities
  5133273: '皇后区', // Queens
  5110266: '布朗克斯', // The Bronx
  5139568: '斯塔滕岛', // Staten Island
  6324729: '哈利法克斯', // Halifax NS
  5950268: '怡陶碧谷', // Etobicoke
  6087029: '尼平', // Nepean
  2639577: '雷丁', // Reading
  2638864: '圣安德鲁斯', // St Andrews
  1842485: '高阳', // Goyang
  1897000: '城南', // Seongnam
  1838716: '富川', // Bucheon
  1846898: '安养', // Anyang KR
  1622786: '望加锡', // Makassar
  1179400: '费萨拉巴德', // Faisalabad
  1267995: '坎普尔', // Kanpur
  // North America
  5391811: '圣迭戈', // San Diego (GeoNames: 聖地牙哥)
  5392171: '圣何塞', // San Jose CA (聖荷西)
  4544349: '俄克拉何马城', // Oklahoma City (奧克拉荷馬)
  5520993: '埃尔帕索', // El Paso (艾爾帕索)
  4299276: '路易斯维尔', // Louisville KY (路易維爾)
  5389489: '萨克拉门托', // Sacramento (沙加緬度)
  4791259: '弗吉尼亚海滩', // Virginia Beach (維珍尼亞海灘)
  5150529: '克利夫兰', // Cleveland OH (克里夫蘭)
  5454711: '阿尔伯克基', // Albuquerque (阿布奎基)
  5323810: '阿纳海姆', // Anaheim (安那罕)
  5350734: '弗里蒙特', // Fremont CA (費利蒙)
  5099836: '泽西城', // Jersey City (澤西)
  4752031: '夏洛茨维尔', // Charlottesville (夏律第鎮)
  5574991: '博尔德', // Boulder CO (波德)
  5780026: '普罗沃', // Provo (普若佛)
  4835797: '哈特福德', // Hartford (哈特福)
  5392423: '圣马特奥', // San Mateo (聖馬刁)
  5393052: '圣克鲁斯', // Santa Cruz CA (聖塔克魯茲)
  5380748: '帕洛阿尔托', // Palo Alto (帕羅奧圖)
  4929022: '阿默斯特', // Amherst MA (安默斯特)
  4464368: '达勒姆', // Durham NC (德罕)
  3598132: '危地马拉城', // Guatemala City (瓜地馬拉)
  3600949: '特古西加尔巴', // Tegucigalpa (德古斯加巴)
  3489854: '金斯敦', // Kingston, Jamaica (京斯敦)
  // UK / Oceania
  2650628: '杜伦', // Durham, England (達拉謨)
  2634725: '沃里克', // Warwick (瓦立克)
  2636910: '斯特灵', // Stirling (史特靈)
  2645425: '赫尔', // Kingston upon Hull (赫爾河畔京士頓)
  2655459: '布莱克浦', // Blackpool (黑潭)
  2193733: '奥克兰', // Auckland (奧克蘭都會區)
  2191562: '达尼丁', // Dunedin (但尼丁)
  2073124: '达尔文', // Darwin (達爾文港)
  2163355: '霍巴特', // Hobart (荷巴特)
  // Asia / Africa / Europe
  1651944: '万象', // Vientiane (永珍)
  1248991: '科伦坡', // Colombo (可倫坡)
  95446: '埃尔比勒', // Erbil (埃爾比勒省)
  616052: '埃里温', // Yerevan (葉里溫)
  709930: '第聂伯', // Dnipro (聶伯城)
  6295587: '巴淡', // Batam (巴淡島)
  1713022: '桑托斯将军城', // General Santos (三投斯將軍)
  299817: '塔尔苏斯', // Tarsus (大數)
  1565022: '土龙木', // Thủ Dầu Một (土龍木市社)
  2314302: '金沙萨', // Kinshasa (金夏沙)
  2332459: '拉各斯', // Lagos (拉哥斯)
  108410: '利雅得', // Riyadh (利雅德)
  909137: '卢萨卡', // Lusaka (路沙卡)
  53654: '摩加迪沙', // Mogadishu (摩加迪休)
  2530335: '丹吉尔', // Tangier (坦幾亞)
  202061: '基加利', // Kigali (吉佳利)
  360502: '卢克索', // Luxor (樂蜀)
  964420: '伊丽莎白港', // Gqeberha / Port Elizabeth (伊莉莎白港)
};

// Region (admin1) display names that GeoNames has no Chinese name for.
const A1_ZH_OVERRIDES = {
  'CA.10': '魁北克', 'AU.04': '昆士兰', 'AU.05': '南澳大利亚',
  'ES.56': '加泰罗尼亚', 'ES.59': '巴斯克', 'ES.52': '阿拉贡', 'ES.07': '巴利阿里群岛',
  'IT.09': '伦巴第', 'IT.05': '艾米利亚-罗马涅', 'IT.06': '弗留利-威尼斯朱利亚',
  'FR.76': '奥克西塔尼', 'FR.75': '新阿基坦',
  'HK.NYL': '元朗区', 'HK.NTW': '荃湾区', 'HK.NTP': '大埔区', 'HK.NSK': '西贡区',
  'HK.KSS': '深水埗区', 'HK.KWT': '黄大仙区',
  'RU.48': '莫斯科', 'RU.66': '圣彼得堡', 'RU.73': '鞑靼斯坦', 'RU.80': '乌德穆尔特', 'RU.91': '克拉斯诺亚尔斯克',
  'VN.79': '胡志明', 'VN.01': '河内', 'VN.31': '海防', 'VN.48': '岘港', 'VN.92': '芹苴',
  'MY.14': '吉隆坡', 'MY.04': '马六甲', 'AE.03': '迪拜', 'AE.06': '沙迦', 'TH.38': '暖武里',
  'DK.17': '首都大区', 'GR.ESYE31': '阿提卡', 'CZ.52': '布拉格', 'HU.05': '布达佩斯',
  'AT.09': '维也纳', 'SE.26': '斯德哥尔摩', 'NO.12': '奥斯陆', 'PL.78': '马佐夫舍',
  'RO.10': '布加勒斯特', 'UA.12': '基辅', 'GE.51': '第比利斯', 'LB.04': '贝鲁特',
  'KZ.02': '阿拉木图', 'KZ.05': '阿斯塔纳', 'UZ.13': '塔什干', 'MN.20': '乌兰巴托',
  'PH.NCR': '马尼拉大都会', 'ID.04': '雅加达', 'IN.07': '德里', 'KH.22': '金边',
  'BR.05': '巴伊亚', 'BR.23': '南里奥格兰德', 'CO.34': '波哥大', 'CU.02': '哈瓦那', 'CD.06': '金沙萨',
};

// IANA ids renamed in recent tzdata releases -> older link names that every
// browser's ICU knows (identical rules, so no behavioural change).
const TZ_COMPAT = {
  'Europe/Kyiv': 'Europe/Kiev',
  'America/Nuuk': 'America/Godthab',
  'Pacific/Kanton': 'Pacific/Enderbury',
};

// Japanese shinjitai (and Korean hanja variant) forms that appear in GeoNames
// names and that ICU's Hant-Hans transform leaves alone. None of these are used in
// Simplified Chinese, so mapping them is always safe.
const JP_TO_HANS = Object.fromEntries([
  '広广 沢泽 浜滨 県县 桜樱 栄荣 塩盐 関关 徳德 恵惠 豊丰 竜龙 鉄铁 済济 伝传 転转',
  '覚觉 蔵藏 仏佛 黒黑 亀龟 辺边 険险 駅驿 郷乡 帯带 歳岁 渋涩 焼烧 営营 児儿 巌岩',
  '峯峰 嶋岛 舘馆 淵渊 瀬濑 斎斋 斉齐 薗园 亜亚 円圆 応应 楽乐 気气 帰归 挙举 経经',
  '軽轻 芸艺 剣剑 権权 検检 験验 雑杂 歯齿 実实 釈释 従从 縦纵 処处 乗乘 浄净 畳叠',
  '譲让 図图 穂穗 専专 戦战 銭钱 繊纤 荘庄 巣巢 総总 増增 続续 対对 滝泷 単单 団团',
  '弾弹 遅迟 庁厅 聴听 鎮镇 稲稻 闘斗 読读 脳脑 廃废 拝拜 売卖 発发 髪发 払拂 変变',
  '舗铺 歩步 満满 黙默 薬药 訳译 様样 頼赖 覧览 両两 猟猎 緑绿 霊灵 齢龄 労劳 壌壤',
  // Korean hanja variant code points
  '尙尚 淸清 靑青 硏研 敎教 晩晚 呑吞',
].join(' ').split(' ').map((p) => [...p]));

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const HAN_ANY = /\p{Script=Han}/u;
const HAN_ONLY = /^[\p{Script=Han}·-]+$/u;
const log = (...a) => console.log(...a);

function need(file) {
  if (!fs.existsSync(file)) {
    console.error(`Missing ${path.relative(ROOT, file)} — see the download instructions in this script's header.`);
    process.exit(1);
  }
}

function stripDiacritics(s) {
  return s.normalize('NFD').replace(/\p{M}+/gu, '');
}

/** Normalise separator dots used in transliterations to U+00B7 and trim. */
function cleanHan(s) {
  return s.trim()
    .replace(/[・•‧∙⋅•．]/g, '·')
    .replace(/[‐‑–—－]/g, '-')
    .replace(/\s+/g, '')
    .replace(/(\p{Script=Han})々/gu, '$1$1') // Japanese iteration mark: 佐々木 -> 佐佐木
    .replace(/(?<=\p{Script=Han})[ヶケ](?=\p{Script=Han})/gu, ''); // 茅ヶ崎 -> 茅崎
}

function isValidHanName(s) {
  return s.length > 0 && HAN_ONLY.test(s) && HAN_ANY.test(s) && !/^[·-]|[·-]$/.test(s);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Strip exactly one suffix from `list` (longest first) if ≥ minRemain chars remain. */
function stripSuffix(name, list, minRemain = 2) {
  for (const suf of list) {
    if (name.endsWith(suf) && [...name].length - [...suf].length >= minRemain) {
      return name.slice(0, name.length - suf.length);
    }
  }
  return name;
}

const CN_A1_SUFFIXES = ['特别行政区', '维吾尔自治区', '壮族自治区', '回族自治区', '自治区', '省', '市'];
const INTL_A1_SUFFIXES = ['特别行政区', '自治共和国', '特别自治市', '特别市', '广域市', '自治区', '大区', '省', '州', '邦', '府', '都', '县', '郡', '市'];
// suffixes that only denote the administrative status of a city; used to
// collapse "首尔特别市"/"首尔", "东京都"/"东京", "纽约市"/"纽约" candidate pairs.
const CITY_STATUS_SUFFIXES = ['特别行政区', '特别自治市', '特别市', '广域市', '直辖市', '市', '都'];

// ---------------------------------------------------------------------------
// 1. Base tables
// ---------------------------------------------------------------------------

function readCities() {
  const txt = execFileSync('unzip', ['-p', FILES.cities, 'cities15000.txt'], { maxBuffer: 256 << 20 }).toString('utf8');
  const rows = [];
  for (const line of txt.split('\n')) {
    if (!line) continue;
    const f = line.split('\t');
    rows.push({
      id: Number(f[0]),
      name: f[1],
      ascii: f[2],
      lat: Number(f[4]),
      lon: Number(f[5]),
      fcode: f[7],
      cc: f[8],
      a1: f[10],
      pop: Number(f[14]) || 0,
      tz: f[17],
    });
  }
  return rows;
}

function readAdmin1() {
  const map = new Map(); // "CN.02" -> { name, ascii, id }
  for (const line of fs.readFileSync(FILES.admin1, 'utf8').split('\n')) {
    if (!line) continue;
    const [code, name, ascii, id] = line.split('\t');
    map.set(code, { name, ascii, id: Number(id) });
  }
  return map;
}

function readCountries() {
  const map = new Map(); // ISO -> { name, id }
  for (const line of fs.readFileSync(FILES.country, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split('\t');
    map.set(f[0], { name: f[4], id: Number(f[16]) });
  }
  return map;
}

// ---------------------------------------------------------------------------
// 2. Chinese alternate names (streamed from the 780 MB file, cached subset)
// ---------------------------------------------------------------------------

async function ensureAltCache() {
  const zipTime = fs.statSync(FILES.alt).mtimeMs;
  if (fs.existsSync(FILES.altCache) && fs.statSync(FILES.altCache).mtimeMs >= zipTime) return false;
  log('Scanning alternateNamesV2 (streaming, ~20-60 s)…');
  const tmp = `${FILES.altCache}.tmp`;
  const out = fs.createWriteStream(tmp);
  const child = spawn('unzip', ['-p', FILES.alt, 'alternateNamesV2.txt'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let total = 0;
  let kept = 0;
  let buf = [];
  for await (const line of rl) {
    total++;
    const t1 = line.indexOf('\t');
    const t2 = line.indexOf('\t', t1 + 1);
    const t3 = line.indexOf('\t', t2 + 1);
    const lang = line.slice(t2 + 1, t3);
    let keep = lang.startsWith('zh');
    if (!keep && (lang === '' || lang === 'ja' || lang === 'ko')) {
      const t4 = line.indexOf('\t', t3 + 1);
      keep = HAN_ANY.test(line.slice(t3 + 1, t4 < 0 ? undefined : t4));
    }
    if (keep) {
      kept++;
      buf.push(line);
      if (buf.length >= 5000) {
        if (!out.write(buf.join('\n') + '\n')) await new Promise((r) => out.once('drain', r));
        buf = [];
      }
    }
  }
  if (buf.length) out.write(buf.join('\n') + '\n');
  await new Promise((r) => out.end(r));
  const code = await new Promise((r) => (child.exitCode !== null ? r(child.exitCode) : child.on('close', r)));
  if (code !== 0) throw new Error(`unzip exited with ${code}`);
  fs.renameSync(tmp, FILES.altCache);
  log(`  scanned ${total.toLocaleString()} rows, cached ${kept.toLocaleString()} Chinese/Han rows`);
  return true;
}

/** Returns Map<geonameid, Array<{altId, lang, name, pref, short, colloq, hist, to}>> for ids in `wanted`. */
function readAltNames(wanted) {
  const byId = new Map();
  const txt = fs.readFileSync(FILES.altCache, 'utf8');
  for (const line of txt.split('\n')) {
    if (!line) continue;
    const f = line.split('\t');
    const gid = Number(f[1]);
    if (!wanted.has(gid)) continue;
    const rec = {
      altId: Number(f[0]),
      lang: f[2],
      name: cleanHan(f[3]),
      pref: f[4] === '1',
      short: f[5] === '1',
      colloq: f[6] === '1',
      hist: f[7] === '1' || !!f[9],
      to: f[9] || '',
    };
    let list = byId.get(gid);
    if (!list) byId.set(gid, (list = []));
    list.push(rec);
  }
  return byId;
}

const LANG_HANS = new Set(['zh-CN', 'zh-Hans', 'zh-SG', 'zh-MY']);
const LANG_HANT = new Set(['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant']);
const LANG_PRIMARY = new Set(['zh-CN', 'zh-Hans', 'zh-SG', 'zh']); // spec'd candidate languages

// ---------------------------------------------------------------------------
// 3. Traditional -> Simplified conversion
// ---------------------------------------------------------------------------

let USE_ICU_OK = false;

function icuAvailable() {
  if (!USE_ICU || process.platform !== 'darwin') return false;
  try {
    const out = execFileSync('osascript', ['-l', 'JavaScript', '-e',
      'ObjC.import("Foundation"); ObjC.unwrap($("臺灣").stringByApplyingTransformReverse("Hant-Hans", false))'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out === '台湾';
  } catch {
    return false;
  }
}

/** Batch-convert via macOS ICU (NSString Hant-Hans transform). */
function icuConvert(strings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-cities-'));
  const inF = path.join(dir, 'in.txt');
  const outF = path.join(dir, 'out.txt');
  const jsF = path.join(dir, 't.js');
  fs.writeFileSync(inF, strings.join('\n'), 'utf8');
  fs.writeFileSync(jsF, `ObjC.import('Foundation');
function run(argv) {
  var s = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null);
  var t = s.stringByApplyingTransformReverse('Hant-Hans', false);
  t.writeToFileAtomicallyEncodingError(argv[1], true, $.NSUTF8StringEncoding, null);
  return 'ok';
}`);
  execFileSync('osascript', ['-l', 'JavaScript', jsF, inF, outF], { stdio: ['ignore', 'pipe', 'inherit'] });
  const out = fs.readFileSync(outF, 'utf8').split('\n');
  fs.rmSync(dir, { recursive: true, force: true });
  if (out.length !== strings.length) throw new Error('ICU conversion changed the line count');
  return out;
}

// Fallback when ICU is unavailable (non-macOS or --no-icu): the ICU Hant-Hans
// mapping of every Traditional character that occurs in the current candidate
// names, as pairs (trad, simp). Regenerate on macOS with --dump-t2s=FILE.
const FALLBACK_T2S = new Map([
  '並并亞亚佈布來来倉仓倫伦傑杰兌兑兒儿內内兩两凱凯別别則则剛刚劍剑務务勞劳勢势區区卻却參参吳吴呂吕員员啟启喬乔國国圍围園园',
  '圖图堅坚堯尧場场塚冢塢坞壟垄壢坜壯壮奧奥婁娄孫孙學学宮宫實实寧宁寶宝將将專专屬属岡冈峴岘島岛峽峡崑昆崗岗崙仑嶺岭嶼屿帶带',
  '幾几庫库廈厦廣广張张徹彻恆恒愛爱慶庆懷怀戶户捨舍掛挂揚扬撣掸撫抚敘叙數数時时晉晋會会東东條条棗枣棟栋楊杨極极樂乐樓楼樹树',
  '橋桥橫横檳槟櫚榈欞棂欽钦歐欧歷历歸归沒没沖冲涼凉湊凑溝沟溫温滄沧滿满漢汉漣涟澤泽濟济濰潍濱滨瀋沈瀘泸瀝沥瀨濑灘滩灣湾烏乌',
  '無无煙烟熱热燒烧營营爛烂爾尔狹狭猶犹獅狮獨独瑪玛環环瓊琼瓏珑畢毕當当發发盤盘盧卢砲炮硤硖碼码磯矶禮礼積积窩窝節节篤笃約约',
  '紅红納纳紐纽紮扎紹绍絨绒統统綏绥綠绿維维綿绵緬缅縣县繩绳羅罗義义習习聖圣聯联聶聂肅肃脫脱臘腊臨临臺台與与興兴舊旧茲兹荊荆',
  '莊庄華华萊莱萬万葉叶蓋盖蓮莲蕪芜薩萨藍蓝蘇苏蘭兰衛卫裡里見见觀观託托訥讷設设詩诗誇夸誕诞語语調调諒谅諫谏諸诸諾诺謝谢謨谟',
  '謬谬豐丰貝贝貢贡貪贪貴贵買买費费賀贺賈贾賓宾賴赖賽赛贊赞車车軍军輋𪨶輔辅轄辖農农連连運运達达遠远遼辽邁迈邊边鄉乡鄒邹鄭郑',
  '鄲郸釧钏鈴铃銀银銅铜錢钱錦锦錫锡鎮镇鏡镜鐵铁長长門门開开間间関关關关陝陕陸陆陽阳隴陇離离雲云霧雾靂雳靈灵靜静韋韦韓韩頂顶',
  '順顺須须頓顿頗颇領领頭头額额顏颜飯饭飾饰館馆饒饶馬马駒驹驪骊魯鲁鮮鲜鳥鸟鳳凤鴨鸭鴻鸿鶯莺鶴鹤鷹鹰鹽盐麗丽麥麦黃黄齊齐齋斋',
  '龍龙龐庞龜龟',
].join('').match(/../gu).map((p) => [...p]));

const ICU_PROTECT = new Set(['乾', '阪', '氹']);

function makeConverter(allNames) {
  const uniq = [...new Set(allNames)];
  let mapped;
  if (USE_ICU_OK) {
    mapped = icuConvert(uniq);
    if (args['dump-t2s']) {
      // regenerate FALLBACK_T2S: per-character ICU mapping for every character in use
      const chars = [...new Set(uniq.flatMap((s) => [...s]))].filter((ch) => HAN_ANY.test(ch)).sort();
      const conv = icuConvert(chars);
      const pairs = chars.map((ch, i) => (conv[i] !== ch && [...conv[i]].length === 1 && !ICU_PROTECT.has(ch) ? ch + conv[i] : null)).filter(Boolean);
      fs.writeFileSync(args['dump-t2s'] === true ? 't2s.txt' : args['dump-t2s'], pairs.join(''));
      log(`  dumped ${pairs.length} T->S pairs`);
    }
  } else {
    mapped = uniq.map((s) => [...s].map((ch) => FALLBACK_T2S.get(ch) ?? ch).join(''));
  }
  const cache = new Map();
  uniq.forEach((src, i) => {
    let out = mapped[i];
    const a = [...src];
    let b = [...out];
    // ICU folds a few variants that are wrong in place names: 乾->干 (乾县, 乾安),
    // 阪->坂 (大阪), 氹->凼 (氹仔). Keep the original character there.
    if (a.length === b.length) b = b.map((ch, j) => (ICU_PROTECT.has(a[j]) ? a[j] : ch));
    out = b.map((ch) => JP_TO_HANS[ch] ?? ch).join('');
    cache.set(src, out);
  });
  return (s) => cache.get(s) ?? s;
}

// ---------------------------------------------------------------------------
// 4. Picking the best Simplified Chinese name
// ---------------------------------------------------------------------------

/**
 * kind: 'city' | 'admin1' | 'country'
 * allowHantOnly: accept names that only exist with zh-TW/HK/MO/Hant tags
 * allowJaKo: accept Japanese kanji / Korean hanja names (JP, KR, KP), converted
 * allowUntagged: accept untagged Han names (only sensible for CN/HK/MO/TW/JP/KR/KP)
 */
function pickZh(recs, toHans, opts) {
  return pickZhDetail(recs, toHans, opts)?.name ?? '';
}

function pickZhDetail(recs, toHans, { kind, allowHantOnly, allowJaKo = false, allowUntagged }) {
  if (!recs || !recs.length) return null;
  const tiers = [
    recs.filter((r) => LANG_PRIMARY.has(r.lang)),
    allowHantOnly ? recs.filter((r) => LANG_HANT.has(r.lang) || r.lang === 'zh-MY') : [],
    allowJaKo ? recs.filter((r) => r.lang === 'ja' || r.lang === 'ko') : [],
    allowUntagged ? recs.filter((r) => r.lang === '') : [],
    // last resort: names flagged historic only recently (e.g. 阿斯塔纳, flagged
    // historic for the 2019-2022 Nur-Sultan period although the city is Astana again)
    recs.filter((r) => LANG_PRIMARY.has(r.lang) && r.hist && Number(r.to.slice(0, 4)) >= 2010).map((r) => ({ ...r, hist: false })),
  ];
  for (const tier of tiers) {
    const good = tier.filter((r) => !r.hist && !r.colloq && isValidHanName(r.name));
    if (!good.length) continue;
    // merge by simplified form
    const cand = new Map();
    for (const r of good) {
      const simp = toHans(r.name);
      let c = cand.get(simp);
      if (!c) cand.set(simp, (c = { name: simp, explicit: false, pref: false, short: false, native: false, n: 0, minId: Infinity }));
      c.explicit ||= LANG_HANS.has(r.lang);
      c.pref ||= r.pref;
      c.short ||= r.short;
      c.native ||= simp === r.name;
      c.n++;
      c.minId = Math.min(c.minId, r.altId);
    }
    // count all zh variants (any script) as popularity evidence
    for (const r of recs) {
      if (r.hist || r.colloq || !r.lang.startsWith('zh') || !isValidHanName(r.name)) continue;
      const c = cand.get(toHans(r.name));
      if (c && !tier.includes(r)) c.n++;
    }
    // collapse "X市"/"X特别市"/"X都" when "X" itself is a candidate
    let list = [...cand.values()];
    const names = new Set(list.map((c) => c.name));
    list = list.filter((c) => !CITY_STATUS_SUFFIXES.some((suf) =>
      c.name.endsWith(suf) && [...c.name].length - [...suf].length >= 2 && names.has(c.name.slice(0, -suf.length)),
    ) || kind === 'country');
    list.sort(kind === 'city'
      ? (a, b) => (b.explicit - a.explicit) || (b.pref - a.pref) || (b.short - a.short)
        || (b.native - a.native) || (b.n - a.n) || (a.name.length - b.name.length) || (a.minId - b.minId)
      // admin units / countries: ignore "short" (加州, 全北…) and prefer the fuller, more attested name
      : (a, b) => (b.explicit - a.explicit) || (b.pref - a.pref) || (b.n - a.n)
        || (b.native - a.native) || (b.name.length - a.name.length) || (a.minId - b.minId));
    return { ...list[0], tier: tiers.indexOf(tier) };
  }
  return null;
}

function cityDisplayZh(name) {
  // 杭州市 -> 杭州, 仁川广域市 -> 仁川 (but 沙市 / 堺市 stay: 1 char would remain)
  return stripSuffix(name, ['特别自治市', '特别市', '广域市', '特级市', '市']);
}

// ---------------------------------------------------------------------------
// 4b. Fallback for Chinese towns without a Chinese alternate name: borrow it
//     from a same-named, nearby feature in the per-country dump (typically the
//     county/district, e.g. "Changshu" PPL  <-  "Changshu Shi" ADM3 = 常熟市).
// ---------------------------------------------------------------------------

const SUFFIX_WORDS = [
  'autonomous county', 'new town', 'subdistrict', 'zizhixian', 'zizhiqi', 'district', 'county',
  'jiedao', 'xiang', 'zhen', 'xian', 'city', 'town', 'shi', 'qu', 'qi',
];
const ZH_ADMIN_SUFFIXES = ['自治县', '自治旗', '街道', '新区', '市', '县', '区', '镇', '乡', '旗'];

/** "Chéngguān Qū" -> {base: 'chengguan', suffix: 'qu'}; "Mianzhu, Deyang, Sichuan" -> {base: 'mianzhu'} */
function splitSuffix(ascii) {
  const s = stripDiacritics(ascii).toLowerCase().split(',')[0].replace(/[’'`]/g, '').trim();
  for (const w of SUFFIX_WORDS) {
    if (s.endsWith(` ${w}`)) return { base: s.slice(0, -w.length - 1).replace(/[^a-z]/g, ''), suffix: w };
  }
  return { base: s.replace(/[^a-z]/g, ''), suffix: '' };
}

const MATCH_KM = { A: 60, P: 8 }; // max distance for an admin area / populated place
const CROSS_A1_KM = 15; // allow a different admin1 code only this close (border towns like Jiagedaqi)

async function scanCountryDumps(chinaCities) {
  const byBase = new Map();
  for (const c of chinaCities) {
    const { base } = splitSuffix(c.ascii || c.name);
    if (!base) continue;
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(c);
  }
  const found = [];
  for (const { cc, file } of COUNTRY_DUMPS) {
    if (!fs.existsSync(file)) { log(`  (optional ${cc}.zip not found — skipping)`); continue; }
    const child = spawn('unzip', ['-p', file, `${cc}.txt`], { stdio: ['ignore', 'pipe', 'inherit'] });
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of rl) {
      const f = line.split('\t');
      const fclass = f[6];
      if (fclass !== 'A' && fclass !== 'P') continue;
      const { base, suffix } = splitSuffix(f[2] || f[1]);
      const cands = byBase.get(base);
      if (!cands) continue;
      const lat = Number(f[4]);
      const lon = Number(f[5]);
      const id = Number(f[0]);
      for (const c of cands) {
        if (c.id === id || c.cc !== f[8]) continue;
        const d = haversineKm(c.lat, c.lon, lat, lon);
        if (c.cc === 'CN' && c.a1 !== f[10] && d > CROSS_A1_KM) continue;
        if (d <= MATCH_KM[fclass]) found.push({ cityId: c.id, id, fclass, fcode: f[7], suffix, d });
      }
    }
  }
  return found;
}

// English suffix word of a GeoNames name -> the Chinese suffix it stands for
const EN_TO_ZH_SUFFIX = {
  shi: '市', city: '市', xian: '县', county: '县', 'autonomous county': '自治县', zizhixian: '自治县',
  qu: '区', district: '区', zhen: '镇', town: '镇', xiang: '乡', jiedao: '街道', subdistrict: '街道',
  qi: '旗', zizhiqi: '自治旗',
};

/** Adapt a borrowed name to the city: "Changshu" <- 常熟市 gives 常熟, "Luohu District" <- 罗湖区 keeps 区. */
function adaptBorrowed(zh, m, citySuffix) {
  if (citySuffix) return zh;
  const suf = EN_TO_ZH_SUFFIX[m.suffix];
  if (suf) return stripSuffix(zh, [suf]);
  // unsuffixed admin area: only drop 市/县/区 (镇/乡 can be part of a name: 景德镇)
  return m.fclass === 'A' ? stripSuffix(zh, ['自治县', '市', '县', '区']) : zh;
}

/** All comparable forms of a name: 景德镇市 -> {景德镇市, 景德镇, 景德}. */
function nameForms(s) {
  const a = cityDisplayZh(s);
  return [s, a, stripSuffix(s, ZH_ADMIN_SUFFIXES), stripSuffix(a, ZH_ADMIN_SUFFIXES)];
}

function borrowZh(city, matches, alt, toHans, { countyOnly = false } = {}) {
  const citySuffix = splitSuffix(city.ascii || city.name).suffix;
  const ranked = matches
    .filter((m) => !countyOnly || m.fcode === 'ADM2' || m.fcode === 'ADM3')
    .map((m) => ({ ...m, zh: pickZh(alt.get(m.id), toHans, { kind: 'city', allowHantOnly: true, allowUntagged: true }) }))
    .filter((m) => m.zh)
    // admin areas first (their names are curated), nearest first
    .sort((a, b) => (a.fclass === 'A' ? 0 : 1) - (b.fclass === 'A' ? 0 : 1) || a.d / MATCH_KM[a.fclass] - b.d / MATCH_KM[b.fclass]);
  if (!ranked.length) return '';
  return adaptBorrowed(ranked[0].zh, ranked[0], citySuffix);
}

/** Every Chinese name (any variant) attested for the matched features, in comparable forms. */
function attestedForms(matches, alt, toHans) {
  const set = new Set();
  for (const m of matches) {
    for (const r of alt.get(m.id) || []) {
      if (r.lang === 'ja' || r.lang === 'ko' || !isValidHanName(r.name)) continue;
      for (const f of nameForms(toHans(r.name))) set.add(f);
    }
  }
  return set;
}

// ---------------------------------------------------------------------------
// 5. Build
// ---------------------------------------------------------------------------

function selectRows(cities, minPop) {
  const selected = new Map();
  const reason = new Map();
  for (const c of cities) {
    if (CHINA_CCS.has(c.cc)) { selected.set(c.id, c); reason.set(c.id, 'china'); }
    else if (c.pop >= minPop) { selected.set(c.id, c); reason.set(c.id, 'pop'); }
    else if (c.fcode === 'PPLC') { selected.set(c.id, c); reason.set(c.id, 'capital'); }
  }
  const missing = [];
  let added = 0;
  for (const spec of HAND_PICKED) {
    const [name, cc, a1] = spec.split('|');
    const key = stripDiacritics(name).toLowerCase();
    const matches = cities.filter((c) => c.cc === cc && (!a1 || c.a1 === a1)
      && (stripDiacritics(c.name).toLowerCase() === key || c.ascii.toLowerCase() === key));
    if (!matches.length) { missing.push(spec); continue; }
    const best = matches.sort((x, y) => y.pop - x.pop)[0];
    if (!selected.has(best.id)) { selected.set(best.id, best); reason.set(best.id, 'hand'); added++; }
  }
  return { selected, reason, missing, added };
}

async function main() {
  Object.values(FILES).filter((f) => f !== FILES.altCache).forEach(need);
  const t0 = Date.now();

  const cities = readCities();
  const admin1 = readAdmin1();
  const countries = readCountries();
  log(`cities15000: ${cities.length.toLocaleString()} rows`);

  // Superset of every row we might keep (lowest threshold), so the alternate
  // names are read once even if the size guard later raises the threshold.
  const superset = selectRows(cities, MIN_POP);
  const wanted = new Set(superset.selected.keys());
  for (const c of superset.selected.values()) {
    const a = admin1.get(`${c.cc}.${c.a1}`);
    if (a) wanted.add(a.id);
    const k = countries.get(c.cc);
    if (k) wanted.add(k.id);
  }

  const dumpMatches = await scanCountryDumps([...superset.selected.values()].filter((c) => CHINA_CCS.has(c.cc)));
  const matchesByCity = new Map();
  for (const m of dumpMatches) {
    wanted.add(m.id);
    if (!matchesByCity.has(m.cityId)) matchesByCity.set(m.cityId, []);
    matchesByCity.get(m.cityId).push(m);
  }

  await ensureAltCache();
  USE_ICU_OK = icuAvailable();
  log(`T->S converter: ${USE_ICU_OK ? 'macOS ICU (Hant-Hans)' : `built-in fallback table (${FALLBACK_T2S.size} chars)`}`);
  const alt = readAltNames(wanted);

  const allHan = [];
  for (const recs of alt.values()) for (const r of recs) if (isValidHanName(r.name)) allHan.push(r.name);
  const toHans = makeConverter(allHan);

  const a1Name = new Map(); // "CC.code" -> display
  const a1Display = (c) => {
    const key = `${c.cc}.${c.a1}`;
    if (a1Name.has(key)) return a1Name.get(key);
    const a = admin1.get(key);
    let name = '';
    if (A1_ZH_OVERRIDES[key]) name = A1_ZH_OVERRIDES[key];
    else if (a) {
      const jaKo = HANJA_CCS.has(c.cc);
      const zh = pickZh(alt.get(a.id), toHans, { kind: 'admin1', allowHantOnly: true, allowJaKo: jaKo, allowUntagged: CHINA_CCS.has(c.cc) || jaKo });
      if (zh) name = CHINA_CCS.has(c.cc) ? (c.cc === 'HK' || c.cc === 'MO' ? zh : stripSuffix(zh, CN_A1_SUFFIXES)) : stripSuffix(zh, INTL_A1_SUFFIXES);
      else name = a.name;
    }
    a1Name.set(key, name);
    return name;
  };

  const countryZh = (cc) => {
    if (COUNTRY_ZH_OVERRIDES[cc]) return COUNTRY_ZH_OVERRIDES[cc];
    const k = countries.get(cc);
    if (!k) return cc;
    return pickZh(alt.get(k.id), toHans, { kind: 'country', allowHantOnly: true, allowUntagged: false }) || k.name;
  };

  // --- per-row Chinese name (independent of threshold) ---
  const rowInfo = new Map();
  const zhSource = { own: 0, override: 0, borrowed: 0, admin1: 0, none: 0 };
  const renamed = [];
  for (const c of superset.selected.values()) {
    const china = CHINA_CCS.has(c.cc);
    const jaKo = HANJA_CCS.has(c.cc);
    const pick = pickZhDetail(alt.get(c.id), toHans, { kind: 'city', allowHantOnly: true, allowJaKo: jaKo, allowUntagged: china || jaKo });
    let zh = pick?.name ?? '';
    const converted = !!pick && !pick.native;
    let src = 'own';
    if (CITY_ZH_OVERRIDES[c.id]) { zh = CITY_ZH_OVERRIDES[c.id]; src = 'override'; }
    if (!zh && china) {
      zh = borrowZh(c, matchesByCity.get(c.id) || [], alt, toHans);
      src = 'borrowed';
    } else if (zh && c.cc === 'CN' && src === 'own' && c.fcode !== 'PPLC' && c.fcode !== 'PPLA') {
      // County seats are often named after the seat town (Kunshan -> 玉山, Jiangyin
      // -> 澄江) while the English name is the county's. When a same-named
      // county/prefecture (ADM2/ADM3) is nearby, use its name so 昆山 finds Kunshan.
      // Only when the seat name is not itself attested for any same-named
      // feature nearby (guards against stale/typo county names: 襄樊, 闽行…).
      const ms = matchesByCity.get(c.id) || [];
      const county = borrowZh(c, ms, alt, toHans, { countyOnly: true });
      const attested = county ? attestedForms(ms, alt, toHans) : null;
      if (county && !nameForms(zh).some((f) => attested.has(f))) {
        renamed.push(`${cityDisplayZh(zh)}->${cityDisplayZh(county)}(${c.name})`);
        zh = county;
      }
    }
    if (!zh && !china) {
      // city named like its region (Giza, Kuala Lumpur…): reuse the region's Chinese name
      const a = admin1.get(`${c.cc}.${c.a1}`);
      const disp = a1Display(c);
      if (a && HAN_ANY.test(disp) && splitSuffix(a.ascii).base === splitSuffix(c.ascii || c.name).base) zh = disp;
      src = 'admin1';
    }
    zh = cityDisplayZh(zh);
    zhSource[zh ? src : 'none']++;
    rowInfo.set(c.id, { zh, converted: converted && src === 'own' });
  }

  // tz validation
  const tzOk = new Map();
  const validTz = (tz) => {
    tz = TZ_COMPAT[tz] ?? tz;
    if (!tzOk.has(tz)) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); tzOk.set(tz, true); } catch { tzOk.set(tz, false); }
    }
    return tzOk.get(tz) ? tz : null;
  };

  function build(minPop) {
    const { selected, reason, missing, added } = selectRows(cities, minPop);
    let rows = [...selected.values()].sort((a, b) => b.pop - a.pop || a.id - b.id);

    const badTz = [];
    rows = rows.filter((c) => {
      const tz = validTz(c.tz);
      if (!tz) badTz.push(`${c.name} (${c.cc}) tz=${c.tz || '∅'}`);
      return !!tz;
    });

    // drop duplicates: same zh (or en when no zh) + cc + admin1 within 5 km
    const kept = [];
    const groups = new Map();
    const dups = [];
    for (const c of rows) {
      const zh = rowInfo.get(c.id).zh;
      const key = `${zh || `en:${c.name}`}|${c.cc}|${c.a1}`;
      const g = groups.get(key) || [];
      const near = g.find((k) => haversineKm(k.lat, k.lon, c.lat, c.lon) <= 5);
      if (near) { dups.push(`${c.name}/${zh} ≈ ${near.name}`); continue; }
      g.push(c);
      groups.set(key, g);
      kept.push(c);
    }

    const tzList = [];
    const tzIdx = new Map();
    const a1List = [];
    const a1Idx = new Map();
    const ccMap = {};
    const out = [];
    for (const c of kept) {
      const tz = validTz(c.tz);
      if (!tzIdx.has(tz)) { tzIdx.set(tz, tzList.length); tzList.push(tz); }
      const a1 = a1Display(c);
      let ai = -1;
      if (a1) {
        if (!a1Idx.has(a1)) { a1Idx.set(a1, a1List.length); a1List.push(a1); }
        ai = a1Idx.get(a1);
      }
      if (!(c.cc in ccMap)) ccMap[c.cc] = countryZh(c.cc);
      out.push([
        rowInfo.get(c.id).zh,
        c.name || c.ascii,
        ai,
        c.cc,
        Math.round(c.lat * 100) / 100,
        Math.round(c.lon * 100) / 100,
        tzIdx.get(tz),
        Math.round(c.pop / 1000) * 1000,
      ]);
    }
    const sortedCc = Object.fromEntries(Object.entries(ccMap).sort(([a], [b]) => a.localeCompare(b)));
    const json = JSON.stringify({ v: 1, tz: tzList, cc: sortedCc, a1: a1List, c: out });
    const gz = zlib.gzipSync(json, { level: 9 }).length;
    return { json, gz, out, kept, reason, missing, added, dups, badTz, tzList, a1List, ccMap: sortedCc };
  }

  let minPop = MIN_POP;
  let res = build(minPop);
  while (res.gz > MAX_GZ) {
    log(`  gzip ${res.gz} B > ${MAX_GZ} B at min-pop ${minPop}; raising threshold`);
    minPop += 25000;
    res = build(minPop);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, res.json);

  // ---------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------
  const { out, kept, reason } = res;
  const count = (fn) => out.filter(fn).length;
  const chinaRows = count((r) => CHINA_CCS.has(r[3]));
  log('');
  log('=== build-cities summary ===');
  log(`non-China population threshold : ${minPop.toLocaleString()}${minPop !== MIN_POP ? ` (raised from ${MIN_POP.toLocaleString()})` : ''}`);
  log(`cities total                   : ${out.length}`);
  for (const cc of ['CN', 'HK', 'MO', 'TW']) log(`  ${cc}                           : ${count((r) => r[3] === cc)}`);
  log(`  other countries              : ${out.length - chinaRows}  (${Object.keys(res.ccMap).length} country codes)`);
  log(`  kept as capital below thresh : ${kept.filter((c) => reason.get(c.id) === 'capital').length}`);
  log(`  hand-picked additions        : ${kept.filter((c) => reason.get(c.id) === 'hand').length}`);
  log(`  duplicates dropped           : ${res.dups.length}`);
  log(`  dropped for invalid tz       : ${res.badTz.length}${res.badTz.length ? ' — ' + res.badTz.join('; ') : ''}`);
  log(`time zones / admin1 names      : ${res.tzList.length} / ${res.a1List.length}`);
  log(`zh source (all candidates)     : own ${zhSource.own}, curated ${zhSource.override}, borrowed from county/district ${zhSource.borrowed}, from same-named region ${zhSource.admin1}, none ${zhSource.none}`);
  log(`renamed after county (CN)      : ${renamed.length}${args.verbose ? ' — ' + renamed.join(' ') : ' (use --verbose to list)'}`);
  log(`missing zh (CN/HK/MO/TW)       : ${count((r) => CHINA_CCS.has(r[3]) && !r[0])}`);
  log(`missing zh (others)            : ${count((r) => !CHINA_CCS.has(r[3]) && !r[0])}`);
  log(`hand-picked not in cities15000 : ${res.missing.join(', ') || '—'}`);
  log(`output                         : ${path.relative(ROOT, OUT)}  raw ${Buffer.byteLength(res.json).toLocaleString()} B (${(Buffer.byteLength(res.json) / 1024).toFixed(1)} KiB), gzip -9 ${res.gz.toLocaleString()} B (${(res.gz / 1024).toFixed(1)} KiB)`);
  log(`elapsed                        : ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const a1 = res.a1List;
  const fmt = (r) => `${(r[0] || '—').padEnd(8, '　')} ${r[1].padEnd(22)} ${(a1[r[2]] ?? '').padEnd(10, '　')} ${r[3]} ${res.ccMap[r[3]].padEnd(6, '　')} ${String(r[4]).padStart(7)} ${String(r[5]).padStart(8)}  ${res.tzList[r[6]].padEnd(22)} ${r[7].toLocaleString()}`;
  const spot = [
    ['Beijing', 'CN'], ['Shanghai', 'CN'], ['Hangzhou', 'CN'], ['Chaoyang', 'CN'], ['Hong Kong', 'HK'],
    ['Macau', 'MO'], ['Taipei', 'TW'], ['Toronto', 'CA'], ['Vancouver', 'CA'], ['Waterloo', 'CA'],
    ['New York City', 'US'], ['Los Angeles', 'US'], ['Ithaca', 'US'], ['London', 'GB'], ['London', 'CA'],
    ['Paris', 'FR'], ['Tokyo', 'JP'], ['Seoul', 'KR'], ['Sydney', 'AU'], ['Melbourne', 'AU'],
    ['Singapore', 'SG'], ['Kuala Lumpur', 'MY'], ['Dubai', 'AE'], ['San Antonio', 'US'], ['Saint Andrews', 'GB'],
  ];
  log('');
  log('--- spot check ---');
  for (const [en, cc] of spot) {
    const rows = out.filter((r) => r[1] === en && r[3] === cc);
    if (!rows.length) log(`  (missing) ${en} ${cc}`);
    for (const r of rows) log('  ' + fmt(r));
  }
  // deterministic "random" CN county-level seats (PPLA3)
  const ppla3 = kept.map((c, i) => [c, out[i]]).filter(([c]) => c.cc === 'CN' && c.fcode === 'PPLA3');
  let seed = 20260930;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  log('--- random CN county-level seats (PPLA3) ---');
  for (let i = 0; i < 8 && ppla3.length; i++) log('  ' + fmt(ppla3[Math.floor(rnd() * ppla3.length)][1]));
  if (args['report-converted']) {
    // Names that GeoNames only has in Traditional script are usually Taiwan/HK
    // transliterations (聖地牙哥 -> 圣地牙哥 instead of 圣迭戈); list the biggest
    // ones so they can be reviewed and added to CITY_ZH_OVERRIDES.
    log('--- non-China names converted from Traditional only (review for CITY_ZH_OVERRIDES) ---');
    const conv = kept.filter((c) => !CHINA_CCS.has(c.cc) && rowInfo.get(c.id).converted).slice(0, Number(args['report-converted']) || 150);
    log(conv.map((c) => `${c.id}:${rowInfo.get(c.id).zh}/${c.name}/${c.cc}`).join('  '));
  }
  const noZh = out.filter((r) => !r[0]).slice(0, 12);
  log('--- most populous rows without a Chinese name ---');
  for (const r of noZh) log('  ' + fmt(r));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

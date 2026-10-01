// business/config-for-web.json, baked in by tools/build.mjs (absent on the dev server)
// eslint-disable-next-line no-undef
const SITE = typeof __SITE_CONFIG__ !== 'undefined' ? __SITE_CONFIG__ : { sponsor: null, tip: null, analytics: null };

// Site configuration. Everything commercial is off by default — see docs/MONETIZATION.md and spec §10.
export const CONFIG = {
  brand: '你来的那晚',

  // Ad slots (spec §10.1). provider: 'none' | 'sponsor' | 'adsense'. With 'none', or a placement switched
  // off, slotHtml() returns '' and the layout keeps no gap.
  ads: {
    provider: SITE.sponsor ? 'sponsor' : 'none',
    // Exactly three placements, never over the live sky and never during intro / rewind / arrival / listen:
    //   night  inside the 那一夜 plate, after the last fact row, before the colophon (one row)
    //   pair   in the 两个人 result text, after the definition line (one row)
    //   keep   on the export result, under the save instructions (one text line; never in the image)
    placements: { night: true, pair: false, keep: false },
    // 'sponsor': a row sold directly (planetarium, camera, print shop…). image is optional (44×44, square).
    sponsor: { tag: '赞助', title: '', text: '', image: '', url: '', ...(SITE.sponsor || {}) },
    // 'adsense': supported but dormant (it does not serve in mainland China). Only in night and pair.
    adsense: { client: '', slot: '' },
  },

  // Page-view analytics (spec §10.2). provider: 'none' | 'baidu' | 'umami'. Off until a site ID is provided;
  // when on, copy.js appends T.about.analytics to the privacy paragraph.
  // business/config-for-web.json → analytics (tools/build.mjs turns it on only with a valid 32-hex 百度 id)
  analytics: SITE.analytics || {
    provider: 'none',
    baidu: { id: '' },                 // hm.baidu.com site id — works in mainland China
    umami: { src: '', websiteId: '' }, // self-hosted Umami
  },

  // 「遇见这一句的，还有 N 人」 (spec §10.4, poemstats.js). provider: 'none' | 'http'; url must be https.
  // Off until the counter service in server/README.md is deployed, e.g.
  //   poemStats: { provider: 'http', url: 'https://<访问域名>/poem' },
  poemStats: { provider: 'none', url: '' },

  // 印成明信片 (business/config-for-web.json is the source of truth; keep these in step with it). With no shopUrl
  // the order sheet asks the buyer to send the order code to `contact` (or the email when contact is empty).
  // eslint-disable-next-line no-undef
  print: { enabled: false, price: '19.9', shopUrl: '', contact: '', email: 'wojiaozyh123@gmail.com', ...(typeof __PRINT_CONFIG__ !== 'undefined' ? __PRINT_CONFIG__ : {}) },

  // 收款码 on the ground of the still sky (voluntary; never in exports, never tied to a feature). null = off.
  tip: SITE.tip,
};

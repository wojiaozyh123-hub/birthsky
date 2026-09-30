// Site configuration. Everything commercial is off by default — see docs/MONETIZATION.md.
export const CONFIG = {
  brand: '你来的那晚',
  brandEn: 'The Night You Arrived',

  // Sponsor / ad slot shown under the night's facts and under the 合盘 result.
  // provider: 'none' | 'sponsor' | 'adsense'
  ads: {
    provider: 'none',
    // provider 'sponsor': a native card you sell directly (brand, planetarium, print shop…)
    sponsor: { tag: '赞助', title: '', text: '', image: '', url: '' },
    // provider 'adsense' (only serves outside mainland China): fill in after approval
    adsense: { client: '', slot: '' },
  },

  // Page-view analytics. provider: 'none' | 'baidu' | 'umami'
  analytics: {
    provider: 'none',
    baidu: { id: '' },               // hm.baidu.com site id — works in mainland China
    umami: { src: '', websiteId: '' }, // self-hosted Umami
  },
};

// Line icons for the stage (owner's decision 2026-10-01: the bottom row and the toggles become icons; the words
// stay as aria-labels and show once under the icons on the first landing). 24 × 24, 1.5 stroke, currentColor.
const svg = (body) => `<svg class="ico" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICON = {
  // 聆听: a sound wave
  listen: svg('<path d="M4 10.5v3M7.5 8v8M11 5v14M14.5 8.5v7M18 10v4"/>'),
  // 留存: an arrow down into a tray
  keep: svg('<path d="M12 4v10.5M8 10.5l4 4 4-4"/><path d="M4.5 15v4.5h15V15"/>'),
  // 两个人: two overlapping circles
  pair: svg('<circle cx="9.25" cy="12" r="5.25"/><circle cx="14.75" cy="12" r="5.25"/>'),
  // 送一张: an envelope
  gift: svg('<rect x="3.75" y="6.25" width="16.5" height="11.5" rx="1"/><path d="M4.25 7l7.75 6 7.75-6"/>'),
  // 分享 / 发给 TA: a box with an arrow up
  share: svg('<path d="M12 14.5V4M8.25 7.75L12 4l3.75 3.75"/><path d="M8 11H5.5v8.5h13V11H16"/>'),
  // 再邀请一位: two circles and a plus
  again: svg('<circle cx="8.5" cy="13" r="4.5"/><circle cx="13" cy="13" r="4.5"/><path d="M19.5 3.75v5M17 6.25h5"/>'),
  // 有声 / 静音
  soundOn: svg('<path d="M4.5 9.5h3l4-3.5v12l-4-3.5h-3z"/><path d="M15 9.5a3.5 3.5 0 0 1 0 5M17.5 7a7 7 0 0 1 0 10"/>'),
  soundOff: svg('<path d="M4.5 9.5h3l4-3.5v12l-4-3.5h-3z"/><path d="M15.5 10l4 4M19.5 10l-4 4"/>'),
  // 体感: a phone turning
  gyro: svg('<rect x="8.25" y="4" width="7.5" height="13" rx="1.5"/><path d="M4.5 13.5a8 8 0 0 0 15 0"/><path d="M17.25 13.75l2.25-.25.5 2.25"/>'),
  // the ruler
  play: svg('<path d="M8.5 5.5v13l10-6.5z"/>'),
  pause: svg('<path d="M9 6v12M15 6v12"/>'),
  back: svg('<path d="M9 8H5V4"/><path d="M5.6 8A7.5 7.5 0 1 1 4.5 12"/>'),
  done: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  close: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
};

/** The one-character badge of the culture toggle (星官 → 官, 星座 → 座, 无连线 → 无). */
export const CULTURE_BADGE = { cn: '官', iau: '座', none: '无' };

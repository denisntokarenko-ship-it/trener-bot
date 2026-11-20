// Посилання на відео техніки (docs/spec/phase-1b.md, §9). Чиста функція без I/O: її викликають і сид (відмовляє
// на хибному посиланні), і екран вправи (не показує кнопку). Лише YouTube, лише канонічні форми.
export const VIDEO_URL_MAX = 200;

const YOUTUBE_ID = "[A-Za-z0-9_-]{11}";
const WATCH = new RegExp(`^https://www\\.youtube\\.com/watch\\?v=${YOUTUBE_ID}$`);
const SHORT = new RegExp(`^https://youtu\\.be/${YOUTUBE_ID}$`);

export function isVideoUrl(url: string | null | undefined): url is string {
  if (typeof url !== "string" || url.length > VIDEO_URL_MAX) return false;
  return WATCH.test(url) || SHORT.test(url);
}

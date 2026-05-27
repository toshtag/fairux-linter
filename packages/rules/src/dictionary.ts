import type { KeywordDictionary } from "@fairux/core";

/**
 * Keyword patterns for rule matching, in English and Japanese.
 *
 * Rules match these against `normalizedText` (already NFKC + lowercased), so English
 * patterns are lowercase and need no `i` flag. CRITICAL: never use the `g` or `y` flag —
 * those carry `lastIndex` state and make reused patterns miss matches. A unit test enforces this.
 */
export const dictionary: KeywordDictionary = {
  en: {
    accept: [/\baccept\b/, /\bagree\b/, /\ballow\b/, /\bgot it\b/, /\bi agree\b/, /\byes\b/],
    reject: [
      /\breject\b/,
      /\bdecline\b/,
      /\bdeny\b/,
      /\bdisagree\b/,
      /\bno thanks\b/,
      /\bmanage\b/,
      /\bcustomi[sz]e\b/,
      /\bpreferences\b/,
      /\boptions\b/,
      /\bopt out\b/,
      /\bopt-out\b/,
    ],
    marketing: [
      /\bmarketing\b/,
      /\bnewsletter\b/,
      /\boffers?\b/,
      /\bpromotions?\b/,
      /\bdeals\b/,
      /\bemail me\b/,
    ],
    thirdParty: [/\bthird[- ]?part/, /\bpartners?\b/, /\bshare\b.*\bdata\b/],
    terms: [/\bterms\b/, /\bconditions\b/],
    privacy: [/\bprivacy\b/, /\bpersonal data\b/],
    mildConsent: [
      /\bage\b/,
      /\b18\b/,
      /\bremember me\b/,
      /\bkeep me signed in\b/,
      /\bsave (my )?(details|info|card)\b/,
    ],
  },
  ja: {
    accept: [/同意(する|します)?/, /承認/, /許可/, /はい/, /受け取る/],
    reject: [
      /拒否/,
      /同意しない/,
      /いいえ/,
      /あとで/,
      /管理/,
      /設定/,
      /カスタマイズ/,
      /オプトアウト/,
      /選択/,
    ],
    marketing: [
      /マーケティング/,
      /メルマガ/,
      /ニュースレター/,
      /キャンペーン/,
      /お得な情報/,
      /広告/,
      /プロモーション/,
    ],
    thirdParty: [/第三者/, /パートナー/, /提携/, /共有/],
    terms: [/利用規約/, /規約/, /約款/],
    privacy: [/プライバシー/, /個人情報/],
    mildConsent: [/年齢/, /18歳/, /ログイン状態を保持/, /記憶/, /保存/],
  },
};

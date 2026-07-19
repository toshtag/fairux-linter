import type { PageContext, PageContextSignal } from "./types.js";

/**
 * Conservative, keyword-based page-context detection (en + ja). Matched against normalized
 * text, so it's intentionally fuzzy and low-stakes: it only *gates* which rules run. A miss
 * means a context-scoped rule stays quiet (a safe failure mode), never a false accusation.
 *
 * Lives in core (not an adapter) because it operates on already-normalized strings — browser-safe
 * and needed by every adapter (HTML, DOM, …). See ADR P3-T1 §8.
 *
 * Note: "privacy"/"tracking" concerns are folded into `consent` (the enum has no separate member).
 */
const KEYWORDS: Record<Exclude<PageContext, "unknown">, readonly string[]> = {
  pricing: [
    "pricing",
    "per month",
    "/month",
    "/mo",
    "plans",
    "price",
    "料金",
    "プラン",
    "価格",
    "月額",
  ],
  checkout: [
    "checkout",
    "place order",
    "pay now",
    "card number",
    "credit card",
    "billing address",
    "レジ",
    "購入手続き",
    "お支払い",
    "カート",
    "注文を確定",
  ],
  subscription: [
    "subscribe",
    "subscription",
    "free trial",
    "auto-renew",
    "automatically renew",
    "billing cycle",
    "定期購入",
    "自動更新",
    "無料体験",
    "サブスク",
    "継続課金",
  ],
  "account-settings": [
    "account settings",
    "manage subscription",
    "cancel subscription",
    "delete account",
    "close account",
    "アカウント設定",
    "退会",
    "解約",
    "契約内容",
  ],
  consent: [
    "cookie",
    "cookies",
    "consent",
    "accept all",
    "reject all",
    "privacy preferences",
    "tracking",
    "同意",
    "クッキー",
    "個人情報",
    "プライバシー設定",
  ],
  marketing: [
    "newsletter",
    "sign up for offers",
    "marketing email",
    "promotional email",
    "ニュースレター",
    "メルマガ",
    "お得な情報",
    "キャンペーン",
  ],
};

/**
 * @param bodyText  normalized text of the document root
 * @param titleText normalized `<title>` text (if any)
 */
export function detectPageContexts(
  bodyText: string,
  titleText: string | undefined,
): PageContextSignal[] {
  const title = titleText ?? "";
  const signals: PageContextSignal[] = [];

  for (const context of Object.keys(KEYWORDS) as Exclude<PageContext, "unknown">[]) {
    const words = KEYWORDS[context];
    if (words.some((w) => title.includes(w))) {
      signals.push({ context, confidence: "high" });
    } else if (words.some((w) => bodyText.includes(w))) {
      signals.push({ context, confidence: "medium" });
    }
  }

  if (signals.length === 0) signals.push({ context: "unknown", confidence: "low" });
  return signals;
}

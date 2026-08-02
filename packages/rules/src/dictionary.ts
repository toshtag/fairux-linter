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
    thirdParty: [/\bthird[- ]?part/, /\bpartners?\b/, /\bshare\b.{0,24}\bdata\b/],
    terms: [/\bterms\b/, /\bconditions\b/],
    privacy: [/\bprivacy\b/, /\bpersonal data\b/],
    mildConsent: [
      /\bage\b/,
      /\b18\b/,
      /\bremember me\b/,
      /\bkeep me signed in\b/,
      /\bsave (my )?(details|info|card)\b/,
    ],
    freeTrial: [
      /\bfree trial\b/,
      /\bstart (your )?free trial\b/,
      /\btry (it )?free\b/,
      /\bfree for \d+ days?\b/,
      /\b\d+[- ]day free trial\b/,
    ],
    renewal: [
      /\bauto[- ]?renew/,
      /\bautomatically renews?\b/,
      /\brenews? (at|on|automatically)\b/,
      /\bbilled? (monthly|annually|automatically)\b/,
      /\bbilling (starts|begins)\b/,
      /\bafter (the|your) (free )?trial\b/,
      /\bthen \$?\d/,
      /\bper month\b/,
      /\bcharged\b/,
    ],
    cancellation: [
      /\bcancel\b/,
      /\bcancel anytime\b/,
      /\bunsubscribe\b/,
      /\bcancellation\b/,
      /\bcancel your (subscription|plan|membership)\b/,
    ],
    // Signals the page is managing an EXISTING subscription/account (not a sign-up/marketing page).
    activeSubscription: [
      /\byour (subscription|plan|membership)\b/,
      /\bcurrent plan\b/,
      /\bmanage (subscription|plan|membership|billing)\b/,
      /\bbilling (settings|history|details)\b/,
      /\bnext (payment|billing|renewal)\b/,
      /\brenews on\b/,
      /\baccount settings\b/,
      /\byou are subscribed\b/,
    ],
    // A control that lets the user cancel/leave/manage — the thing whose ABSENCE we flag.
    cancelLink: [
      /\bcancel\b/,
      /\bunsubscribe\b/,
      /\bcancel (subscription|plan|membership|auto-renewal)\b/,
      /\bclose account\b/,
      /\bdelete account\b/,
      /\bmanage (subscription|plan|membership|billing)\b/,
      /\bend (subscription|membership)\b/,
    ],
    // A refusal contains the verb it refuses, so these run before an affirmative group is consulted.
    // The negation has to attach to the action: `Don't miss out — subscribe now` is a real subscribe
    // CTA, and a guard that only looked for "don't" would silence it.
    refusalOfAction: [
      /\b(do ?n'?t|do not|never) (subscribe|sign up|join|start|upgrade|accept|agree|allow|continue)\b/,
      /\bi (do ?n'?t|do not|wo ?n'?t|will not) (want|wish|need) to\b/,
      /\b(wo ?n'?t|will not) (subscribe|sign up|join|upgrade|accept|agree|allow)\b/,
      /^\s*no[,!.]?\s+i\b/,
      /^\s*(no thanks?|not now|not today|not interested)\b/,
    ],
    subscribeCta: [
      /\bsubscribe\b/,
      /\bstart (subscription|plan|membership)\b/,
      /\bget started\b/,
      /\bbuy now\b/,
      /\bjoin now\b/,
      /\bsign up\b/,
      /\bupgrade\b/,
    ],
    scarcity: [
      /\bonly \d+ (left|remaining|in stock)\b/,
      /\b\d+ (left|remaining) in stock\b/,
      /\balmost (gone|sold out)\b/,
      /\bselling (fast|out)\b/,
      /\blimited time\b/,
      /\btoday only\b/,
      /\bends (soon|today|in)\b/,
      /\b\d+ (people|others) (are )?(viewing|watching|looking)\b/,
      /\blast chance\b/,
      /\bwhile (stocks|supplies) last\b/,
    ],
    fees: [
      /\btax\b/,
      /\bvat\b/,
      /\bshipping\b/,
      /\bhandling\b/,
      /\bfees?\b/,
      /\btotal\b/,
      /\bincl\.? tax\b/,
      /\bexcl\.? tax\b/,
    ],
    close: [/\bclose\b/, /\bdismiss\b/, /\bno thanks\b/, /\bnot now\b/],
    // Countdown timers: explicit HH:MM:SS clocks, or "ends in <time>" urgency text.
    countdown: [
      /\b\d{1,2}:\d{2}:\d{2}\b/,
      /\b\d{1,2}:\d{2}\b\s*(left|remaining)/,
      /\bends? in\b/,
      /\b(offer|sale|deal) ends in\b/,
      /\b(hurry|ends) .{0,12}\b\d+ (hours?|minutes?|mins?|seconds?|secs?)\b/,
      /\bcountdown\b/,
    ],
    // Confirmshaming: a decline option worded to guilt-trip the user for opting out.
    confirmShame: [
      // `/\bno,? i (don'?t|do not|hate|prefer)\b/` was here, and it read the opening rather than the
      // object: "No, I don't need newsletters" is an ordinary decline and it fired. Removed rather
      // than replaced — every guilt clause it caught is caught by a pattern below that names what is
      // being given up, measured on the corpus and on this rule's fixtures.
      /\bi (don'?t|do not) want to (save|earn|win|get)\b/,
      /\bi (prefer|like|want) to pay (full|more)\b/,
      /\bi('ll| will| would rather)? ?(risk it|miss out|pass on)\b/,
      /\bno thanks,? i('| a)?m (fine|ok|good)\b/,
      // The clause the corpus recorded as a miss, and three of the same shape.
      //
      // Matched **without** an opening. The issue that found this described it as the "no thanks,"
      // opening defeating the patterns, and that reading is a red herring: the guilt is in the
      // object, not in how the sentence starts. A first draft here did gate on the opening plus the
      // verb after the pronoun — and flagged "No thanks, I don't need newsletters", "I am not
      // interested", and "I'd rather decide later", which are ordinary declines. What makes a
      // decline confirmshaming is being made to say you do not want the good thing, so every pattern
      // below reads through to the object and none of them cares what came before "I".
      /\bi (don'?t|do not) (like|enjoy) (saving|earning|winning|getting)\b/,
      /\bi (hate|dislike) (saving|earning|discounts?|deals?|coupons?|bargains?|money)\b/,
      /\b(i'?d|i would|i'?ll|i will) rather (pay|overpay|lose|waste)\b/,
      /\bi (prefer|like|enjoy) paying (full|more|the full)\b/,
      /\bi don'?t (care|want to save)\b/,
      /\bno,? i (like|enjoy) paying\b/,
    ],
  },
  ja: {
    accept: [
      /同意(する|します)?/,
      /承認/,
      /許可/,
      /はい/,
      // 受け取る needs an object. Bare, it made every receive-shaped control a consent accept: a
      // 「資料を受け取る」 download button on a page that merely mentions ニュースレター was reported
      // as an accept with no reject beside it (#188). English `accept` has no equivalent catch-all.
      /(お知らせ|メール|情報|通知|ニュースレター|メルマガ|配信|クーポン|特典).{0,4}受け取る/,
    ],
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
      // 結構です, which is at least as common in UI as いいえ and was absent — a form offering three
      // ways to decline was reported as offering none (#182).
      //
      // Two patterns rather than the bare word, because 結構です carries both readings: the decline
      // (*no thank you*) and the assent (*that will do*). They are separated by grammar, not by
      // guesswork — the assent takes 〜**で**結構です, so a leading or object-marked 結構です is the
      // refusal and 「この内容で結構です」 is not.
      /(^|[、。「\s])結構です/,
      /[はも]結構です/,
      // いりません, found the same way 結構です was — by writing a Japanese corpus case for a rule that
      // had none (#188). 「お得な情報はいりません」 is a decline, and the form offering it was reported
      // as offering none.
      //
      // 必要ありません and 不要 are deliberately **not** here. They carry a reassurance reading —
      // 「登録は必要ありません」 means registration is not required, not that the user is refusing —
      // and the two are not separable by grammar the way 結構です and 〜で結構です are.
      /いりません/,
      /要りません/,
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
    freeTrial: [/無料体験/, /無料トライアル/, /無料お試し/, /お試し無料/, /\d+日間無料/],
    renewal: [
      /自動(的に)?(更新|継続|課金)/,
      /更新されます/,
      /課金/,
      /体験(期間)?(終了|後)/,
      /(月額|年額)\s*\d/,
      /請求/,
    ],
    cancellation: [/解約/, /退会/, /キャンセル/, /いつでも解約/, /契約.{0,6}解除/],
    activeSubscription: [
      /ご利用中の(プラン|サブスク|契約)/,
      /現在のプラン/,
      /契約内容/,
      /次回(の)?(請求|支払い|更新)/,
      /アカウント設定/,
      /お支払い情報/,
    ],
    cancelLink: [/解約/, /退会/, /契約.{0,6}解除/, /プラン.{0,6}変更/, /アカウント.{0,6}削除/],
    // Japanese puts the negation at the end of the verb, so one pattern covers the whole family.
    // 「見逃さないよう登録する」 keeps working: the negation there attaches to 見逃す, not to 登録.
    refusalOfAction: [
      /(登録|購読|申(?:し)?込み?|加入|同意|承認|許可|受け取り?|アップグレード|変更)(は|も)?(し)?(ない|ません|たくない|たくありません|たくはない)/,
      /^(結構です|いいえ)/,
    ],
    subscribeCta: [
      /購読/,
      /登録/,
      /申し込む/,
      /申込/,
      /はじめる/,
      /始める/,
      /加入/,
      /アップグレード/,
    ],
    scarcity: [
      /残りわずか/,
      /残り\s*\d+/,
      /在庫わずか/,
      /本日限定/,
      /今だけ/,
      /まもなく(終了|完売)/,
      /売り切れ間近/,
      /お早めに/,
      /\d+人が(見て|閲覧)/,
      /期間限定/,
    ],
    fees: [/税込/, /税抜/, /送料/, /手数料/, /総額/, /消費税/, /込み/],
    close: [
      /閉じる/,
      /とじる/,
      /×/,
      /✕/,
      // English `close` has counted "not now" and "no thanks" as dismissals since the first version;
      // Japanese had only the literal ones, so a modal offering 「あとで」 was reported as having no way
      // out. Found by writing a near-miss page for a rule that had no negative case.
      /あとで/,
      /後で/,
      /(^|[、。「\s])結構です/,
      /いりません/,
    ],
    countdown: [
      /\d{1,2}:\d{2}:\d{2}/,
      /残り\s*\d+\s*(時間|分|秒)/,
      /(まもなく|あと).{0,8}(終了|締切)/,
      /(セール|キャンペーン).{0,6}終了まで/,
      /カウントダウン/,
    ],
    confirmShame: [
      // Was `/いいえ、?.*(いりません|必要ありません|興味はありません|したくありません)/`, which gated on
      // the opening and let `.*` stand in for the object — so "いいえ、ニュースレターには興味はありません"
      // fired, and it is an ordinary decline. This names the benefit instead, the way the three
      // patterns below it already do.
      /(お得|割引|特典)(な情報)?(に)?は?(いりません|不要|必要ありません|興味はありません)/,
      /(損|機会|お得).{0,8}(逃|失).{0,12}(構わない|かまわない|いい)/,
      /お得な情報は?(いりません|不要)/,
      /正規(料金|価格)で(支払|払)/,
    ],
  },
};

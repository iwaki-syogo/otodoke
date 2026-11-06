/**
 * The words of 「メールの自動転送の設定」: one copy for the Web guide (/guide/forwarding), the
 * Web settings page and the iOS app. Pure data, no React.
 *
 * The source of the sentences is docs/ux-redo/forwarding-guide.md in the planning folder
 * (2026-11-07); change a sentence there first. Never write 「転送するだけ」 (the owner's rule).
 *
 * Sources checked 2026-11-07:
 * - Gmail forwarding: https://support.google.com/mail/answer/10957?hl=ja
 * - Gmail filter: https://support.google.com/mail/answer/6579?hl=ja
 * - iCloud Mail forwarding: https://support.apple.com/ja-jp/guide/icloud/mm6b1a3960/icloud
 * - Outlook.com forwarding: https://support.microsoft.com/ja-jp/office/1ed4ee1e-74f8-4f53-a174-86b748ff6a0e
 *   and https://support.microsoft.com/ja-JP/Outlook/mail/turn-automatic-forwarding-on-or-off-in-outlook
 * - Yamato: https://faq.kuronekoyamato.co.jp/app/answers/detail/a_id/1361 (notification settings),
 *   .../a_id/235 (why mail does not arrive), .../a_id/7935 (domains),
 *   https://www.kuronekoyamato.co.jp/ytc/customer/redelivery/members/schedule_notice/
 * - Unconfirmed on screen: whether Outlook shows 「転送」 or 「転送と IMAP」 in Japanese; 「迷惑メールの
 *   フォルダは転送されないことがある」 is worded softly because no provider states it.
 */

/** The Gmail filter's search words. The same value as the constant in the settings page. */
export const GMAIL_FILTER = "{注文 発送 出荷 配達 お届け 配送 到着 荷物}";

export const FORWARDING_TITLE = "メールの自動転送の設定";
export const FORWARDING_LEAD = "設定は最初の 1 回だけです。あとは何もしなくても、荷物のメールが Otodoke に届きます。";
export const FORWARDING_LEAD_NOTE = "お使いのメールを選んでください。どれも 5 分ほどで終わります。";

export const BEFORE_YOU_START_HEADING = "始める前に";
export const BEFORE_YOU_START: string[] = [
  "Otodoke の設定の「メールの転送」で、あなた専用の転送先アドレスをコピーしておきます。",
  "アドレスは …@in.otodoke.app の形です。知らない人には教えないでください。",
];

export interface ForwardingStep {
  text: string;
  /** Shows a copy box under the step. */
  copy?: "gmailFilter";
}

export interface ForwardingGroup {
  heading?: string;
  steps: ForwardingStep[];
}

export interface ForwardingGuide {
  id: "gmail" | "icloud" | "outlook" | "other";
  /** The label on the chip that jumps to the section. */
  chip: string;
  title: string;
  /** Addresses this guide is for. */
  addresses?: string;
  /** How long it takes and where. */
  time?: string;
  link?: { label: string; href: string };
  linkNote?: string;
  /** A sentence shown above the steps (the guide with no steps). */
  intro?: string;
  /** Steps are numbered straight through all groups. */
  groups: ForwardingGroup[];
  notes: string[];
}

export const FORWARDING_GUIDES: ForwardingGuide[] = [
  {
    id: "gmail",
    chip: "Gmail",
    title: "Gmail",
    time: "5 分・パソコンのブラウザで（スマホの Gmail アプリでは設定できません）",
    link: { label: "転送の設定を開く", href: "https://mail.google.com/mail/u/0/#settings/fwdandpop" },
    linkNote: "Gmail を 2 つ以上使っている人は、開いた画面の右上で、荷物のメールが届くアカウントに切り替えます。",
    groups: [
      {
        heading: "転送先を登録する",
        steps: [
          { text: "パソコンのブラウザで Gmail を開き、右上の歯車 › 「すべての設定を表示」 › 「メール転送と POP/IMAP」を開きます。" },
          { text: "「転送先アドレスを追加」を押し、Otodoke のアドレスを貼り付けます。" },
          { text: "「次へ」 › 「続行」 › 「OK」の順に押します。本人確認を求められたら済ませて、もう一度アドレスを入れます。" },
          { text: "Gmail からの確認メールは Otodoke に届きます。少し待つと、Otodoke の設定の「メールの転送」に「承認ページを開く」ボタンが出るので、押して承認します。" },
          { text: "この画面の「転送」は「転送を無効にする」のままにします。全部のメールではなく、次のフィルタで荷物のメールだけを送ります。" },
        ],
      },
      {
        heading: "荷物のメールだけを送るフィルタを作る",
        steps: [
          { text: "Gmail の上の検索ボックスの右端にある「検索オプションを表示」を押します。" },
          { text: "「含む」に次の文字列を貼り付けます:", copy: "gmailFilter" },
          { text: "下の「フィルタを作成」を押します。" },
          { text: "「転送する」にチェックを入れ、横の欄で Otodoke のアドレスを選び、「フィルタを作成」を押します。" },
        ],
      },
    ],
    notes: [
      "転送するのは上の言葉を含むメールだけです。ただし、これらの言葉を含む私信（「到着したよ」など）も転送されます。買い物に関係しないメールは、本文を保存せずに捨てます。",
    ],
  },
  {
    id: "icloud",
    chip: "iCloud メール",
    title: "iCloud メール",
    addresses: "@icloud.com・@me.com・@mac.com",
    time: "3 分・ブラウザで",
    link: { label: "iCloud メールを開く", href: "https://www.icloud.com/mail/" },
    groups: [
      {
        steps: [
          { text: "ブラウザで iCloud メールを開き、Apple アカウントでサインインします。" },
          { text: "メールボックスの一覧の上にある「設定」ボタンを押し、「設定」を選びます。" },
          { text: "左の一覧で「メールの転送」を選びます。" },
          { text: "「メールの転送先」にチェックを入れ、欄に Otodoke のアドレスを貼り付けます。" },
          { text: "「転送後にメッセージを削除」にはチェックを入れません。入れると、iCloud にメールが残りません。" },
        ],
      },
    ],
    notes: ["iCloud はすべてのメールを転送します。買い物に関係しないメールは、本文を保存せずに捨てます。"],
  },
  {
    id: "outlook",
    chip: "Outlook",
    title: "Outlook",
    addresses: "@outlook.jp・@outlook.com・@hotmail.co.jp など",
    time: "3 分・ブラウザで",
    link: { label: "転送の設定を開く", href: "https://outlook.live.com/mail/0/options/mail/forwarding" },
    linkNote: "サインインしていないと Outlook の紹介ページが開きます。サインインしてから、もう一度このボタンを押してください。",
    groups: [
      {
        steps: [
          { text: "ブラウザで Outlook.com を開き、サインインします。" },
          { text: "右上の歯車「設定」 › 「メール」 › 「転送」を開きます。本人確認を求められたら済ませます。" },
          { text: "「転送を有効にする」をオンにし、Otodoke のアドレスを貼り付けます。" },
          { text: "「転送されたメッセージのコピーを保持する」が出ていたら、チェックを入れます。Outlook にもメールが残ります。" },
          { text: "「保存」を押します。" },
        ],
      },
    ],
    notes: [
      "Outlook はすべてのメールを転送します。買い物に関係しないメールは、本文を保存せずに捨てます。会社や学校のアカウントは、決まりで転送できないことがあります。",
    ],
  },
  {
    id: "other",
    chip: "そのほか",
    title: "そのほかのメール",
    intro: "お使いのメールの設定にある「自動転送」で、Otodoke のアドレスへ転送してください。",
    groups: [],
    notes: [],
  },
];

export const PITFALLS_HEADING = "届かない人が多い落とし穴（必ず確かめてください）";
export const PITFALLS_LEAD = "Otodoke は、あなたのメールボックスに届いたメールしか読めません。次のどれかに当てはまると、荷物が出ません。";

export interface ForwardingPitfall {
  title: string;
  body: string[];
  /** Shown after body[0] under stepsLabel; the rest of body follows the codes. */
  stepsLabel?: string;
  steps?: string[];
  /** A sentence ahead of the codes. */
  codesLead?: string;
  /** Domains to add on the receiving side. */
  codes?: string[];
  /** Sentences after the codes. */
  after?: string[];
  links?: { label: string; href: string }[];
}

export const FORWARDING_PITFALLS: ForwardingPitfall[] = [
  {
    title: "ヤマト運輸などのお届け予定メールを受け取っていない",
    body: ["ヤマト運輸の「お届け予定メール」は、クロネコメンバーズに登録した人にだけ届きます。いつ届くかは、このメールで分かることが多いです。"],
    stepsLabel: "確かめ方:",
    steps: [
      "クロネコメンバーズにログインします（未登録なら登録して、本人認証まで済ませます）。",
      "左上のメニュー › 「荷物に関する通知設定」を開きます。",
      "メールを「利用する」にして、「通知設定を保存する」を押します。LINE やアプリだけにしていると、メールが届きません。",
    ],
    codesLead: "迷惑メールの設定でドメインを指定して受け取っている人は、次の 3 つを受け取る側に足します:",
    codes: ["@kuronekoyamato.co.jp", "@ml.kuronekoyamato.co.jp", "@ml2.kuronekoyamato.co.jp"],
    after: ["佐川急便・日本郵便も、会員サービスでメールの通知を受け取る設定にしておくと、届く日が分かりやすくなります。"],
    links: [
      { label: "お届け予定通知（ヤマト運輸）", href: "https://www.kuronekoyamato.co.jp/ytc/customer/redelivery/members/schedule_notice/" },
      { label: "受け取るドメイン（ヤマト運輸のよくある質問）", href: "https://faq.kuronekoyamato.co.jp/app/answers/detail/a_id/7935" },
    ],
  },
  {
    title: "ショップの「発送のお知らせ」メールを止めている",
    body: [
      "ショップの会員ページの「メール配信設定」や「通知設定」で、注文確認・発送のお知らせ・お届けのお知らせのチェックを外していると、メールが届きません。",
      "確かめ方: 最近買った店のメールを、メールボックスで「発送」と検索します。見つからなければ、その店の会員ページでチェックを入れ直します。",
      "アプリの通知だけにしている店も、メールを受け取る設定にします。",
    ],
  },
  {
    title: "荷物のメールが迷惑メールに入っている",
    body: ["迷惑メールのフォルダに入ったメールは、転送されないことがあります。見つけたら「迷惑メールではない」にします。"],
  },
];

export const FORWARDING_CHECK_ACTION = "設定を開く";
export const FORWARDING_CHECK: { heading: string; lines: string[] } = {
  heading: "設定できたか確かめる",
  lines: [
    "次に買い物をしたら、Otodoke の一覧に荷物が出るか見てください。",
    "出ないときは、設定の「うまく届かないとき」を開いてください。",
  ],
};

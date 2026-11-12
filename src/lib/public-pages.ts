import { CONTACT_EMAIL } from "@/app/privacy/contact";
import { RESET_LOSES_MAIL } from "@/lib/mail-notices";

/** Public copy is kept here so it can be reviewed and replaced without editing page layouts. */
export type PublicSection = {
  title: string;
  paragraphs?: readonly string[];
  bullets?: readonly string[];
  links?: readonly { href: string; label: string }[];
  contact?: boolean;
};

export const PUBLIC_PAGE_TEXT = {
  home: "トップへ戻る",
  navigation: "利用に関する案内",
  links: [
    { href: "/terms", label: "利用規約" },
    { href: "/support", label: "サポート" },
    { href: "/privacy", label: "プライバシーポリシー" },
  ],
  terms: {
    title: "利用規約",
    lead: "Otodoke 運営は、Otodokeを次の条件で提供します。この規約では、Otodoke 運営を「運営者」、Otodokeをお使いになる方を「あなた」といいます。",
    sections: [
      {
        title: "1. サービスの内容",
        paragraphs: [
          "Otodokeは、注文や発送などのメールを読み取り、荷物の情報・お届け予定・買い物の支出を表示するサービスです。メールの自動転送や、あなたが入力した情報を使います。",
          "Otodokeは、商品の販売、運送、配達日時の変更、再配達の受付を行うサービスではありません。これらのお手続きは、お買い物先や運送会社で行ってください。",
        ],
      },
      {
        title: "2. アカウント",
        paragraphs: [
          "アカウントが必要な機能では、あなたが利用できるメールアドレスで登録してください。",
          "未成年の方は、保護者の同意を得て利用してください。",
          "パスワードと転送先アドレスは、あなたが適切に管理してください。ほかの人に使わせたり、公開したりしないでください。不正な利用に気付いたときは、運営者へご連絡ください。",
        ],
      },
      {
        title: "3. 料金",
        paragraphs: ["Otodokeは無料で利用できます。通信料や、お使いの端末・メールサービスなどにかかる費用は、あなたの負担となります。"],
      },
      {
        title: "4. 禁止事項",
        paragraphs: ["次の行為はしないでください。"],
        bullets: [
          "法令に違反する行為や、他人の権利を侵害する行為",
          "他人のアカウントや、利用する権限のないメール・情報を使う行為",
          "不正なアクセス、なりすまし、システムの制限を意図的に回避する行為",
          "大量の通信や迷惑メールなどで、サービスやほかの利用者に支障を与える行為",
          "サービスの情報を不正に取得し、第三者へ提供する行為",
        ],
      },
      {
        title: "5. メールと個人情報の扱い",
        paragraphs: [
          "運営者は、あなたのメールやアカウントなどの情報を、プライバシーポリシーに従って扱います。送信先、保存する情報、暗号化する範囲、保存期間、削除の方法は、同ポリシーをご確認ください。",
          "読み取りを許可しているときだけ、メールの判定と読み取りのために、メールの内容を Anthropic の Claude API へ送信します。設定の「あなたのメールの扱い」で「読み取りをやめる」を押すと、その後の読み取りを止められます。すでに読み取った荷物と結果は残ります。読み取り後の元メールは暗号化しますが、荷物の情報・根拠の抜粋・読み取り待ちのメールなど、暗号化しない情報もあります。",
          "メールの鍵がない状態で読み取りを終えたあなたのメールは、荷物の情報を残し、件名・差出人・本文は残しません。",
          "転送するメールは、あなたが利用する権限を持つものにしてください。必要のないメールまで送られないよう、お使いのメールサービスの転送設定をご確認ください。",
        ],
      },
      {
        title: "6. 読み取りとお届け予定",
        paragraphs: [
          "メールの読み取りや荷物のまとめ方には、誤りや情報の不足が生じることがあります。お届け予定日、時間帯、受け取り方法、金額、分類は目安です。正確さ、完全さ、最新であることを保証するものではありません。",
          "配達状況や必要なお手続きは、元のメール、お買い物先、運送会社の案内でもご確認ください。Otodokeの表示だけをもとに、重要な予定や支払いを決めないでください。",
        ],
      },
      {
        title: "7. 外部サービス",
        paragraphs: [
          "Otodokeは、メールの送受信、認証、データの保存、アプリの配信、Claude APIによる読み取りなどに外部サービスを使います。外部サービスの変更、停止、利用制限などにより、Otodokeの一部が利用できなくなることがあります。",
          "「追跡ページを開く」などのリンクでは、運送会社など外部のサイトへ移動します。照会のために伝票番号を渡すことがあります。移動先のサービスには、その提供者が定める条件とプライバシーポリシーが適用されます。",
        ],
      },
      {
        title: "8. 退会",
        paragraphs: [
          "あなたは、設定の「アカウントの削除」から退会できます。アカウントとOtodokeに保存された関連データは、プライバシーポリシーに記載した保存上の例外を除いて削除されます。削除したデータは元に戻せません。",
          "退会するときは、お使いのメールサービスでも自動転送を解除してください。退会だけでは、メールサービス側の転送設定は解除されません。",
        ],
      },
      {
        title: "9. パスワードとメールの鍵",
        paragraphs: ["パスワードを忘れて再設定すると、前に暗号化して保存したメールは開けなくなります。荷物の情報は残ります。現在のパスワードが分かる状態で変更する場合は、前のメールも引き続き開けます。"],
      },
      { title: "10. お問い合わせ", paragraphs: ["運営者: Otodoke 運営"], contact: true },
    ] satisfies readonly PublicSection[],
  },
  support: {
    title: "サポート",
    sections: [
      {
        title: "お問い合わせ",
        paragraphs: ["Otodoke 運営", "操作で困ったことや、あなたの情報の開示・訂正・削除などのお求めを受け付けます。"],
        contact: true,
      },
      {
        title: "メールの自動転送",
        paragraphs: ["設定は最初に一度。お使いのメールに合わせた手順をご案内します。"],
        links: [
          { href: "/guide/forwarding", label: "転送設定ガイド" },
          { href: "/app/settings/forwarding", label: "ログインして転送先を見る" },
        ],
      },
      {
        title: "荷物が出ないとき",
        paragraphs: ["注文・発送のメールが元の受信箱に届いているか、転送が有効かを確かめてください。読み取りの状態や、読まなかったメールは設定で確かめられます。"],
        links: [{ href: "/app/settings/trouble", label: "ログインして読み取りを確かめる" }],
      },
      {
        title: "サンプルで試す",
        paragraphs: ["実際のメールを使わずに試せます。設定の「サンプルで試す」から読み込めます。"],
        links: [{ href: "/app/settings/demo", label: "ログインしてサンプルを試す" }],
      },
      {
        title: "パスワードを忘れたとき",
        paragraphs: [RESET_LOSES_MAIL],
        links: [{ href: "/login/forgot", label: "パスワードを再設定する" }],
      },
      {
        title: "アカウントを削除する",
        paragraphs: ["設定の「アカウントの削除」から行えます。削除後は、お使いのメールの自動転送も解除してください。"],
        links: [{ href: "/app/settings/delete", label: "ログインして削除の画面を開く" }],
      },
    ] satisfies readonly PublicSection[],
  },
} as const;

/** The address is owned by the existing privacy-policy contact constant. */
export const PUBLIC_CONTACT_EMAIL = CONTACT_EMAIL;

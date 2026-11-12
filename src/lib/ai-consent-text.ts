/** The reading permission words shared with iOS. A wording change is made here first. */
export const AI_CONSENT_TEXT_VERSION = "v1";

export const AI_CONSENT_TEXT = {
  title: "メールの読み取り",
  body: "届いたメールは、Anthropic の Claude で読み取ります。メールの件名・差出人・本文を送り、荷物の情報を取り出します。",
  privacy: "プライバシーポリシー",
  allow: "許可する",
  decline: "許可しない",
  stop: "読み取りをやめる",
  start: "読み取りを許可する",
  retry: "もう一度読み込む",
  readFailed: "読み取りの許可を確認できませんでした。もう一度読み込んでください。",
  saveFailed: "読み取りの許可を保存できませんでした。もう一度お試しください。",
  sample: "サンプルで試す",
  manual: "手で登録する",
  waiting: "まだ読んでいないメールを読み取る",
  retainedResults: "すでに読み取った荷物と結果は残ります。設定の「サンプルで試す」にある「すべての荷物を消す」で消せます。",
  waitingRetention: "許可を待つメールは、届いてから 14 日で期限切れになります。期限を過ぎた件名・差出人・本文は、毎日の掃除で消します。許可しない場合や読み取りをやめた場合も、その期限までは残ります。許可した後も、読み取るまでは同じ期限です。",
} as const;

/**
 * A copy of the Web's words for the Web/iOS contract, from integrate/password-v1 (pinned at fd0e7d4),
 * with mail_busy from the fixed mail-limit source below:
 *  - LOGIN_MESSAGES of src/lib/login-errors.ts (every key, in order);
 *  - the password rule of src/lib/crypto/password-v1.ts (PASSWORD_RULE and passwordProblem's three answers).
 * The copy is here only while this branch's src/ does not have those files yet. ios-password-login.test.ts
 * compares it with the Web's own files (OTODOKE_AUTH_WEB_ROOT when explicitly set; otherwise this tree or
 * integrate/password-v1 through git) and fails when they differ. Not a test file (no tests here).
 */
export const COPY_SOURCE = { ref: "integrate/password-v1", pinned: "fd0e7d4" } as const;
export const MAIL_LIMIT_SOURCE = "7749afe3836dd18cab4ca76ba6f6c38e10098ac9";

export const LOGIN_MESSAGES_COPY: Record<string, string> = {
  credentials: "メールアドレスかパスワードが違います。",
  not_confirmed: "メールアドレスの確認がまだです。届いたメールのリンクを開いてください。",
  rate: "回数が多いため、しばらく時間をおいてから、もう一度お試しください。",
  mail_busy: "いま混み合っています。少し時間をおいて、もう一度お試しください。",
  captcha: "確認が切れました。もう一度お試しください。",
  network: "つながりませんでした。少し時間をおいて、もう一度お試しください。",
  other: "うまくいきませんでした。もう一度お試しください。",
  invalid_email: "メールアドレスの形式を確認してください。",
  email_not_ascii: "半角の英数字と記号だけのメールアドレスをお使いください。",
  not_configured: "いまは受け付けられません。少し時間をおいて、もう一度お試しください。",
  signup_exists_or_sent: "確認のメールを送りました。メールのリンクを開いてから、ログインしてください。",
  confirmation_sent: "確認のメールを送りました。",
  reset_sent: "再設定のメールを送りました。メールのリンクを開いてください。",
  confirmed: "メールアドレスを確認しました。パスワードでログインしてください。",
  signed_out: "ログインし直してください。",
  stale_session: "続けるには、もう一度ログインしてください。",
  reset_expired: "再設定の期限が切れました。もう一度、再設定のメールを送ってください。",
  same_secret: "いまと同じパスワードです。別のパスワードを決めてください。",
  secret_change_unknown: "パスワードを変えられたか確かめられませんでした。新しいパスワードでログインし直してください。入れないときは、前のパスワードでログインしてください。",
  secret_change_refused: "パスワードを変えられませんでした。もう一度お試しください。",
  secret_change_refused_key_new: "パスワードを変えられませんでした。同じ新しいパスワードで、もう一度お試しください。",
  key_in_use_changed: "ほかの画面で鍵が変わりました。ページを読み込み直してください。",
  key_wrap_changed: "ほかの画面でパスワードが変わりました。ページを読み込み直してください。",
  key_not_pending: "もう一度、最初からお試しください。",
  key_not_in_use: "ページを読み込み直してください。",
  key_challenge_failed: "鍵を確かめられませんでした。もう一度お試しください。",
  key_failed: "保存できませんでした。もう一度お試しください。",
  invalid_input: "うまくいきませんでした。ページを読み込み直してください。",
  wrong_password: "パスワードが違います。",
  wrong_current_password: "今のパスワードが違います。",
  no_key: "メールの鍵がまだありません。設定で作れます。",
  address_mismatch: "このアカウントでは、メールの鍵を作れませんでした。",
  key_not_opened: "このパスワードでは、メールの鍵を開けませんでした。",
  other_password_wrong: "このパスワードでも、メールの鍵を開けませんでした。",
  link_invalid: "このリンクは使えませんでした。確認が済んでいれば、ログインできます。",
  reset_link_invalid: "再設定のリンクは使えませんでした。もう一度、再設定のメールを送ってください。",
  link_limited: "ただいま混み合っています。少し時間をおいてから、もう一度メールのリンクを開いてください。",
  link_failed: "いまは確認できませんでした。少し時間をおいて、もう一度メールのリンクを開いてください。",
  link_incomplete: "リンクが不完全です。いちばん新しいメールのリンクを開いてください。",
};

export const PASSWORD_WORDS_COPY = {
  PASSWORD_RULE: "10 文字以上。同じ文字のくり返し、1234… や abcd… のような連番、password のようなよくある言葉と数字だけの組み合わせは使えません。",
  too_short: "10 文字以上にしてください",
  weak: "推測されやすいパスワードです。同じ文字のくり返し・連番・よくある言葉は避けてください",
  mismatch: "2 回の入力が違います",
} as const;

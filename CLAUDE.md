# Otodoke — project guide for coding agents

Built with Claude: Japan 2026 の提出作品。期間は 2026-11-02 12:30 〜 11-08 20:00 JST。
一文で言うと「どの店で買った荷物も、何がいつ届くか・いつ家にいればいいか・今月いくら使ったかが分かる荷物カレンダー」。メールの自動転送は最初に 1 回設定するだけで、あとは何もしない。
キャッチコピーは「荷物に、予定を合わせない。」（2026-11-05 本人決定）。画面・README・説明文に「転送するだけ」と書かない（メールを毎回転送すると読めて面倒に見えるため）。

## 守ること（ハッカソン規定由来）

- コードはすべて期間中の新規制作。既存プロジェクトのコードを持ち込まない（参照して書き直すのも避ける）
- このリポジトリは **公開**。個人情報・鍵・実メールを入れない
  - 実メールは `fixtures/raw/`（git-ignored）にだけ置く。匿名化した全件 `fixtures/anonymized/` も手元だけ（買い物の履歴なので公開しない）
  - コミットするのは選び抜いたデモ用の `fixtures/demo/` のみ
  - 匿名化 = 氏名・住所・電話・メールアドレス・注文番号・追跡番号を差し替える。品名・店名・金額の桁は残してよい
- 仕様書・計画メモはリポジトリの外に置く（規定）。ここに書くのは「作ったものの説明」と「開発ルール」だけ
- 持ち込んだデータ（匿名化した実メール）は README の「持ち込んだデータ」節に明記する

## プロダクトの原則

- Claude が担うのは「判断」: メールが注文・発送・配達・キャンセルに関係するか、どの項目がどの値か、同じ荷物か
- 抽出値には必ず `evidence`（元メールの該当行）と `confidence` を付ける。確信度が低いものは `needs_review` にして断定表示しない
- 追跡番号から運送会社を判定するのはルール（正規表現）で行い、Claude には任せない
- 画面からは常に元メールへ戻れる（作り話をさせない）
- 運送会社の追跡ページをスクレイピングしない。リンクを開くだけ

## 技術

- Next.js 16（App Router、`src/`）/ React 19 / TypeScript / Tailwind CSS v4 / npm
- Supabase（Postgres + Auth のメールアドレスとパスワード）、Resend（受信 webhook `email.received` と、確認・再設定のメールの送信）、Claude API、Vercel
- dev: `npm run dev`（port 3015）、lint: `npm run lint`、typecheck: `npm run typecheck`、test: `npm test`、build: `npm run build`
- Server Action のファイル（`"use server"`）からは async 関数と型だけを export する
- 確認と再設定のメールのリンクを開くと確認ボタンの画面（`/auth/continue`）が出て、押すと POST で検証する。メールのセキュリティ検査が GET でリンクを踏んでも使い切られないため
- Supabase Auth の設定とメール文面は `supabase/config.toml` と `supabase/templates/`。**`supabase config push` は確認なしで本番に適用される**（プレビューにならない）。実行前に本人の YES を取る
  - `config diff` は `auth.email.smtp.pass` などを masked として比べない。`config.toml` では `env(RESEND_SMTP_KEY)` の参照なので、手元にその環境変数が無いまま push すると本番の SMTP パスワードを空にしうる（確認・再設定のメールが全部止まる）。1 項目だけ変えるときはダッシュボードで変え、`config.toml` も同じ値にそろえる（2026-11-04、Redirect URLs はこの方法で変えた）
  - Redirect URLs は `https://otodoke.app/auth/confirm**`・dev のブランチ URL `https://otodoke-app-git-dev-syodgo-9062s-projects.vercel.app/auth/confirm**`・localhost 2 行だけ。Vercel のワイルドカード（`*-<team>.vercel.app`）は他人の Vercel の名前に一致しうるので使わない。dev 以外のブランチの Preview でログインするときは、その URL ちょうどを足す（`supabase-redirect-urls.test.ts` が固定）

## ログインとパスワード

本人の決定 2026-11-06。取り決めは password-v1 で、正本は `docs/crypto/password-v1.md` とテストベクタ `fixtures/crypto/password-v1.json`。iOS と合意済みなので、変えるときは iOS と同時に変える。

- ログインはメールアドレスとパスワード。初回は「アカウント作成」。ブラウザがパスワードから、ログイン用の authSecret と、メールの鍵を包む KEK を別々に作る。Supabase Auth に送るのは authSecret だけで、生のパスワード・KEK・開いた秘密鍵はサーバーに出さない
- 開いたメールの鍵は、そのタブのメモリにだけ置く。置き場所は `src/lib/crypto/tab-key.ts`。再読み込みや新しいタブでは、元メールを開くときにパスワードを入れ直す
- メールの鍵は、鍵がまだ無い人がパスワードでログインしたときと、再設定のあとに作る。作成と付け替えは、パスワードか再設定で入って 15 分以内のセッションだけ
- 今のパスワードが分かる変更では、同じ秘密鍵を包み直すので前のメールも開ける。再設定では新しい鍵を作るので、前のメールは開けない。画面・メール・文書で同じ文を使い、文の正本は `src/lib/mail-notices.ts` に置く
- Web は 8 桁コードとリンクのログインをやめた。**Supabase の OTP とマジックリンクのログインは、サーバー側では止めない**。iOS 2 本目が 8 桁コードでログインするので、iOS 3 本目が TestFlight に出るまで残す。だから `magic_link.html` はコードだけを載せる
- メールのリンク: 確認のメール `supabase/templates/confirmation.html` は `{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=email`、再設定のメール `recovery.html` は同じ形で `type=recovery`。テンプレートが `&token_hash=` を後ろに付けるので、`signUp` の `emailRedirectTo` と `resetPasswordForEmail` の `redirectTo` は `?` を含む `/auth/confirm?…` にする。Redirect URLs に一致しない URL を渡すと、Supabase は Site URL に置き換え、リンクが壊れる
- `/auth/confirm` は type で分ける。確認の email は `/login?confirmed=1` へ行き、そこでパスワードでログインし直したときに鍵を作る。再設定の recovery は `/reset-password` へ行く。行き先はコードの定数で、リンクの `next` は読まない
- **再設定の画面は `/reset-password` で、`/auth/` の外に置く**。`safeNextPath` が `/auth` の下を拒むため
- **Supabase のパスワードの強さの設定を上げない**。`minimum_password_length = 6` と `password_requirements = ""` のまま。authSecret は小文字の hex 64 文字なので、大文字や記号を必須にすると誰も登録もログインもできない。パスワードの強さは、ブラウザで生のパスワードに対して確かめる
- **Preview と本番は同じ Supabase**。project_ref は下の「外部サービス依存」。Preview でのアカウント作成・パスワードの変更・再設定は、本番のアカウントと鍵を変える。再設定は前の鍵を retire するので、前のメールは開けなくなる。試すアカウントに気をつける
- メールアドレスを変える画面は作らない。salt が変わり、同じパスワードから同じ値が作れなくなるため。ASCII 以外の文字を含むメールアドレスの登録は断る。Web と iOS で email_norm が割れないようにするため
- CAPTCHA は OFF のまま。`src/lib/turnstile.ts` の `CAPTCHA_ENFORCED = false`。Turnstile のトークンは `signUp`・`signInWithPassword`・`resetPasswordForEmail` に渡す

## ディレクトリ

- `src/app/` 画面と Route Handler（受信 webhook は `src/app/api/inbound/`）
- `src/lib/extract/` Claude によるメール判定・構造化（スキーマは zod）
- `src/lib/match/` 荷物への名寄せ、`src/lib/carriers/` 追跡番号→運送会社のルール
- `fixtures/demo/` 公開するデモ用メール・手で付けた正解（`expected.json`）・Claude の結果の保存（`extractions.json`）
- `fixtures/anonymized/` 匿名化した全件、`fixtures/raw/` 実メール（どちらも git-ignored）
- `scripts/eval.ts` 読み取り精度の測定（課金 API を呼ぶ。`--max-usd` で上限）
- `docs/` 期間中の作業記録（Claude をどう使ったか、評価セットの一致率の推移）

## 荷物のまとめ方と金額（`src/lib/match/`）

- 同じ荷物かどうかは `chooseParcel`、金額は `parcelTotal` が決める。Amazon は 1 通の注文メールに複数の注文番号を載せるので、金額は発送メールを優先する
- 定期便の案内など `other_purchase` は荷物を作らない。予定日を過ぎても届いた連絡がない荷物は「届いたか分からない荷物」に畳む
- 変更したら `npx tsx scripts/replay.ts`。保存済みの読み取り結果を実際のルールで通す（API は呼ばない。結果は git-ignored の `fixtures/raw/eval/`）

## メールのふるいと費用（`src/lib/screen.ts`）

- 店の許可リストにしない。文面だけで判定し、迷ったら通す（知らない店で買っても動くため）
- 1 段目は無料のルール。迷うものだけ 2 段目で Haiku に聞く。API が失敗したら残す
- 変更したら `npm run check:screen`（pre-commit で自動）。荷物のメールを 1 通でも落とすと止まる
- 本番の様子は `npm run report:screen`。利用者が「これは荷物」と押した差出人は次から読む
- 有料の呼び出しは `claim_claude_call` で 1 人 1 日・全体 1 日の上限を取ってから行う

## Claude Code の使い方（このリポジトリの hooks）

- `.claude/settings.json` の PreToolUse(Bash) `guard-git.sh`: force push、`fixtures/raw/` のコミット、gitleaks に引っかかるコミットを止める
- PostToolUse(Edit|Write) `lint-edited.sh`: 編集したファイルを eslint にかけ、エラーがあれば Claude に返す
- git の pre-commit（`.githooks/pre-commit`）も同じ検査をする。`npm install` 時の `prepare` で `core.hooksPath` を設定

## Human-input secrets

人が手で用意して貼る値（API キーなど）は `.env.local` にだけ置く。`.env.example` にキー名を列挙し、値は書かない。
新しい human-input の環境変数を足すときは `.env.example` にも足す。

## ブランチ運用（本人の決定 2026-11-02）

- 日々の作業は `dev` ブランチにコミットして push する（Vercel の Preview デプロイだけが動く）
- `main` への反映＝本番デプロイ。毎回、本人の YES を取ってからマージ・push する
- force push は禁止（hook で止める）

## 外部サービス依存

- Supabase: project_ref=`zvqaqdmlxghekasjqneq`, region=`ap-northeast-1`, org=iwaki-syogo's Org (Pro)。キーの取得は `npm run env:supabase`（値は画面に出さずローカル env に書く）
- Vercel: project=`otodoke-app`, team=`syodgo-9062s-projects`, production_url=https://otodoke.app（独自ドメイン。Vercel で取得）／ https://otodoke-app.vercel.app（GitHub 連携済み: main への push で本番デプロイ）
- Resend: 受信ドメイン=`in.otodoke.app`, 送信ドメイン=`otodoke.app`（どちらも検証済み、リージョン ap-northeast-1。DNS は Vercel）。プランと送受信の枠は公開 repo に書かない（枠を使い切らせる手引きになる）。手元の非公開メモにある
- Anthropic: Claude API（個人組織。キーは `.env.local` のみ）

# Otodoke — project guide for coding agents

## エージェント共通の要点

- 公開repo。秘密・実メール・個人情報を読んだりコミットしたりしない。仕様・計画・作業報告はrepo外。作ったものの説明と開発ルールだけをrepoへ置く。
- `parcels` のauthenticated UPDATE権限はiOSの直接更新にも必要。変更せず、本人・lease・世代・候補集合・更新版の検証を保つ。Swiftの変更はiOS担当へ渡す。
- DBの部分順序はU(Auth)→G(世代)→E(メール)→C(必要な許可行)→L(利用者の候補鍵/有料日の鍵)→R。不要な段は飛ばせるが逆順に初取得しない。受取mark/restoreは最新の共有契約どおりU/G/Eの後・Rの前でLを取る。
- 候補鍵はprivateな `public.lock_parcel_owner(p_user uuid)` だけから取る。同ownerのTx-local設定と利用者別Lを確保し、NULL・owner切替・owner不明を拒否する。固定キーへのfallbackは作らない。メールcoreは本人/run/lease確認後・snapshot/R前で呼ぶ。
- 130000のforward/downも同helperを使い、before/verify/downでABI・owner・ACLを確認する。戻し順は140000 → 130000 → 121000 → 120000 → 110000 → 100000 → 090000 → 181000 → 180000（120000・121000のdownは130000が残っていれば、120000のdownは121000も残っていれば、55000で止まる）。130000のdownは140000の有無を見ないので、130000を戻す前に `supabase/verify/20261113140000_cleared_mail_marks.rolled-back.sql` が OK であることを確かめる。所有者やgrantを自動で直して関門を通さない。
- Web undoはDBの受取証跡と現在のreceived_at/updated_atを照合し、restored/changed/failedを区別する。1通信200件と論理全件を分け、501件以上も分割処理する。証跡期限の正本はDB関数。
- verify出力は共有のファイル別形式で判定する。110000の判定は末尾。他列のOKで代用しない。SQLと形式・正常/異常自己試験を同じ変更にそろえ、自己試験と実Postgresを区別する。
- 並行作業中の全件vitestは1プロセスだけ、負荷20未満で実行する。実Postgresは自分の専用clusterだけを使い、停止・listener0・専用データ削除まで確認する。


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
- `/auth/confirm` は type で分ける。確認の email と signup は `/auth/confirmed` へ行き、magiclink は `/login?confirmed=1` へ行く。どれも確認だけで、鍵は作らない。鍵は、確認待ちの画面のログイン（タブに戻ったときに自分から試すものと「確認しました」）か `/login` でのログインの、最初の 1 回で作る。再設定の recovery は `/reset-password` へ行く。行き先はコードの定数で、リンクの `next` は読まない
- **再設定の画面は `/reset-password` で、`/auth/` の外に置く**。`safeNextPath` が `/auth` の下を拒むため
- **Supabase のパスワードの強さの設定を上げない**。`minimum_password_length = 6` と `password_requirements = ""` のまま。authSecret は小文字の hex 64 文字なので、大文字や記号を必須にすると誰も登録もログインもできない。パスワードの強さは、ブラウザで生のパスワードに対して確かめる
- **Preview と本番は同じ Supabase**。project_ref は下の「外部サービス依存」。Preview でのアカウント作成・パスワードの変更・再設定は、本番のアカウントと鍵を変える。再設定は前の鍵を retire するので、前のメールは開けなくなる。試すアカウントに気をつける
- メールアドレスを変える画面は作らない。salt が変わり、同じパスワードから同じ値が作れなくなるため。ASCII 以外の文字を含むメールアドレスの登録は断る。Web と iOS で email_norm が割れないようにするため
- CAPTCHA は本番で ON。2026-11-07 01:58 JST に、Supabase の Attack Protection で Turnstile を有効にした。コードは `src/lib/turnstile.ts` の `CAPTCHA_ENFORCED = true`
  - ON の直後に本番で試すのは、Web でトークンを送る 8 つの操作と、iOS のログイン 1 回。8 つは、ログイン・アカウント作成・確認メールの送り直し・再設定のメール・設定で鍵を作る・パスワードを変える・確認待ちの画面でタブに戻ったときに自分から試すログイン・確認待ちの画面の「確認しました」。後ろの 2 つは、どちらかが進むと確認待ちの画面が消えるので、新しい試験用アドレスを 2 つ使う。1 つめは、作成 → 送り直す → 別のタブで確認リンク → 元のタブに戻って、自動で最初の案内へ進む。2 つめは、作成 → 別の端末で確認リンク → 元のタブで「確認しました」を押して進む。続けて、ログイン → 鍵を作る → パスワードを変える → 再設定のメール、の順に回すと 1 回ずつ通せる
  - Supabase に入れた secret key と sitekey の組が違うと、トークン付きの押下もすべて断られる
  - 2026-11-07 の ON では、この順で通した。鍵は最初のログインで作られたので、設定の「鍵を作る」は押していない。確認待ちの画面の 2 つは、その時の本番 56f6368 には無かったので、この通しには入っていない
  - ON にすると、Turnstile に登録していないホストではログイン・作成・再設定が通らない。登録してあるのは otodoke.app・dev のブランチの URL・localhost。dev 以外のブランチの Preview も同じ Supabase なので通らない
  - ON にすると、トークンを送らないクライアントは新しいログイン・作成・再設定のメールが通らない。ログイン済みのセッションは続く
  - 戻すときは、まずダッシュボードの Authentication → Attack Protection で CAPTCHA を OFF にする。ウィジェットそのものが原因なら、そのあと `CAPTCHA_ENFORCED = false` の版を本番に出す。逆の順にすると、その間はトークンを送らない版が断られる
  - もう一度 ON にするのは、`CAPTCHA_ENFORCED = true` の版が本番に出て、本番でログイン・アカウント作成・再設定のメールが通るのを確かめてから
  - secret key は SMTP と同じ扱いで、ダッシュボードで変える。`supabase config push` はしない。`supabase/config.toml` の `[auth.captcha]` はコメントのままにしてある。本番の設定はダッシュボードにだけあり、ローカルでは secret が要らない
  - トークンを渡すのは `signUp`・`resend`・`resetPasswordForEmail`・`signInWithPassword`。`signInWithPassword` はログイン・鍵を作る・パスワードを変える・確認待ちの画面の自分から試すログイン・確認待ちの画面の「確認しました」の 5 つ。開く・ほかのパスワードで開く・`finishReset` は渡さない
  - iOS は TestFlight の 1.0 (2) 以降が、CAPTCHA の掛かる呼び出しすべてにトークンを送る。1.0 (1) は送らないが、もう使っていない。リポの `ios/` は古い版なので、送るかどうかの根拠にしない

## ディレクトリ

- `src/app/` 画面と Route Handler（受信 webhook は `src/app/api/inbound/`）
- `src/lib/extract/` Claude によるメール判定・構造化（スキーマは zod）
- `src/lib/match/` 荷物への名寄せ、`src/lib/carriers/` 追跡番号→運送会社のルール
- `fixtures/demo/` 公開するデモ用メール・手で付けた正解（`expected.json`）・Claude の結果の保存（`extractions.json`）
- `fixtures/anonymized/` 匿名化した全件、`fixtures/raw/` 実メール（どちらも git-ignored）
- `scripts/eval.ts` 読み取り精度の測定（課金 API を呼ぶ。`--max-usd` で上限）
- `docs/` 作ったものの説明: `email-field-map.md`（店・運送会社ごとのメールの書式。抽出プロンプトの下調べ）、`eval-log.md`（`npm run eval` の読み取り精度の記録）、`crypto/password-v1.md`（パスワードと鍵の取り決め）、`api/keys.md`（iOS 用の鍵の API）。Claude をどう使ったかは README の「Claude をどう使ったか」とコミットの履歴にある（計画・作業メモはリポジトリの外）

## 荷物のまとめ方と金額（`src/lib/match/`）

- 同じ荷物かどうかは `chooseParcel`、金額は `parcelTotal` が決める。Amazon は 1 通の注文メールに複数の注文番号を載せるので、金額は発送メールを優先する
- 定期便の案内など `other_purchase` は荷物を作らない。予定日を過ぎても届いた連絡がない荷物は「届いたか分からない荷物」に畳む
- 変更したら `npx tsx scripts/replay.ts`。保存済みの読み取り結果を実際のルールで通す（API は呼ばない。結果は git-ignored の `fixtures/raw/eval/`）

## 受け取り済み（`parcels.received_at`）

- `status = 'delivered'` は「配達完了（メールか手）」のまま。「本人が受け取ったと言った」は別に `received_at` で持つ（null = 言っていない）。一覧の「配達済み」の段は delivered で received_at が null のもの、「受け取り済み」のページ（`/app/delivered`）は received_at があって cancelled でないもの
- メールの処理（`pipeline.ts`・`match/`）は received_at を書かない。合流・統合（`receivedAfterMerge`）は、どちらかに入っていれば残す
- DB のトリガー `parcels_received_at`（本人のセッション＝ `current_user = 'authenticated'` が delivered にしたとき now() を入れ、delivered から他へ変わったら誰でも null にする）が、received_at を知らない古い iOS のスワイプを受ける。Web は status と received_at を同じ更新で明示して書く
- Web が「配達済み」（delivered で受け取っていない）を別の状態から書くときは、同じ書き込みで `received_at = '-infinity'` を送る（トリガーは null で保存し、自動で now() を入れない）。アプリの判定は有限の時刻だけを受け取り済みと読む（`isReceivedAt`）
- 配達済みのまま 14 日たつと「要確認」に入る（`needsCheck`）。自動では受け取り済みにしない。要確認の「まだ」（`dismissCheck`）と「受け取っていない」は `check_dismissed_at` を入れ、もう聞かない（delivered から外れるとトリガーが空にする）
- `STATUS_LABEL`（`format.ts`）とiOSの`Format.statusLabel`はdeliveredを「配達済み」とし、本人が受け取ったかはreceived_atで出し分ける。共有文言は実ソース同士の照合を維持する。

## メールのふるいと費用（`src/lib/screen.ts`）

- 店の許可リストにしない。文面だけで判定し、迷ったら通す（知らない店で買っても動くため）
- 1 段目は無料のルール。迷うものだけ 2 段目で Haiku に聞く。API が失敗したら残す
- 変更したら `npm run check:screen`（pre-commit で自動）。荷物のメールを 1 通でも落とすと止まる
- 本番の様子は `npm run report:screen`。利用者が「これは荷物」と押した差出人は次から読む
- 有料の呼び出しは `claim_claude_call` で 1 人 1 日・全体 1 日の上限を取ってから行う。コードからは `src/lib/claude-usage.ts` の `claimClaudeCall` を使う（Claude が止まっている（claude_unavailable）ときだけ `release()` で数を戻す。DB に `claim_claude_call_v2` が無い間は旧関数に戻る）

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
- Vercel: project=`otodoke-app`, team=`syodgo-9062s-projects`, production_url=https://otodoke.app（独自ドメイン。Vercel で取得。README・画面・説明文の本番 URL はこれにそろえる）。Vercel の既定の名前 `otodoke-app.vercel.app` は案内に使わない。GitHub 連携済み: main への push で本番デプロイ
- Resend: 受信ドメイン=`in.otodoke.app`, 送信ドメイン=`otodoke.app`（どちらも検証済み、リージョン ap-northeast-1。DNS は Vercel）。プランと送受信の枠は公開 repo に書かない（枠を使い切らせる手引きになる）。手元の非公開メモにある
- Anthropic: Claude API（個人組織。キーは `.env.local` のみ）

## メールの読み取りの許可

- 文と文の版の正本は `src/lib/ai-consent-text.ts`。Web と iOS でそろえる。本文の版が変わっただけでは自動で聞き直さない。
- 本人の選択は `ai_reading_consents`、書き込みは `set_ai_reading` RPC だけ。日時はサーバーが付ける。移行で既存利用者を許可済みにしない。
- 実メールは保存後、`src/lib/ai-consent.ts` の共通確認を通ってから Claude のふるいと抽出へ進む。未決定と拒否は `ai_consent_required`、確認不能は `ai_consent_unknown` で区別し、既存の `failed` 状態で未読として保持する。`unread.ts` の条件で後から読み直せる。
- 未決定者は `/app` で許可画面へ進む。welcome と転送設定は許可前に転送先アドレスを作成・表示しない。拒否後も手動登録とサンプルを使える。
- サンプルは作り物のメールと保存済みの抽出だけを使い、Claude API を呼ばない。専用のサンプル操作から戻った `/app?sample=1` は、未決定でも結果を見られる。同意を記録する操作ではない。
- 設定の「あなたのメールの扱い」から許可を取り消せる。既存の荷物と結果は残り、消したい人は既存の削除操作を使う。許可の保存成功直後、届いている許可待ちメールを既存の日次上限内で自動読取する。読取失敗でも許可は保持し、後から既存の「読み取る」で再試行できる。
- 同じ選択・文の版の再送では `decided_at` を保つ。自動読取は service role 専用の `claim_ai_reading_backlog` で同じ許可日時につき一度だけ開始し、失敗後も起動記録を戻さない。明示的な手動再試行はこの起動記録に制限されない。iOS は RPC が返した日時文字列を丸めず `after_consent` に渡す。
- 自動読取は費用の守りの `unread.ts` の timeout・1 通全体・request 全体の予算を使い、次の 1 通を終える余裕がある場合だけ開始する。この契約がない旧 SDK 構成では起動しない。費用の守りの SDK timeout / retry・owned lease・容量制限と合わせて統合する。
- iOS の同意と未読再開 API の契約は `docs/api/mail.md`。DB だけを当てても旧 Web の呼出は止まらないため、新しいガード版 Web と DB を続けて反映する。本番反映と DB 適用は別途承認の対象。

## DB 書込みのロック順

- `20261113110000_sample_generation` は費用ガードの090000と荷物保存時検査の100000に依存する。荷物経路は所有者のAuth行を先に確保し、世代行 → メール行 → advisory 62803 → 荷物/明細行の部分順序を守る。新しいRPCやtriggerでこの順を逆転させない。本人・lease・OCC・候補集合・保存結果の検査は維持する。
- sampleだけでなく実メールのcreate/update/ensure、本人の直接DML、全消去、退会cascadeも同じ順に参加する。退会は既存世代とメールをcascade前に取り、自動読取claim・費用claim v2/releaseもAuth親行を先取りする。DBロックは各短期RPCの中だけで保持し、外部API待ちへ持ち出さない。
- private coreの `_without_sample_fence` はAPI roleから直接実行しない。新しいservice処理も公開RPCの入口を通す。header無しの任意複数表/複数利用者DMLやTRUNCATEは保守操作としてwriter停止・drainを要する。
- 統合時は `tests/postgres/run-sample-lock-order.mjs` の自然競合と旧順序の陰性対照、`scripts/test-sample-generation.py`、`scripts/test-sample-generation-lifecycle.py` を使い捨てPGで確認する。前提・集計・後片付けは `tests/postgres/README.md`。検証終了は専用PGの停止・待ち受け0・専用データ削除まで。

## iOSの画面と共有文言

- WebとiOSの配達状態名は「配達済み」。本人の受取は有限のreceived_atで区別する。削除・パスワードAPIの契約はdocs/api/account.mdに合わせる。
- 削除・パスワード変更APIをWeb本番へ反映してから、それらを呼び出すiOS版を配布する。
- 読み取り許可は未回答者の通常画面より前面の小窓で求める。背景操作・VoiceOverで背面へ移れず、保存成功後に閉じる。手入力とサンプルは拒否後の通常画面から使え、設定で撤回・再許可できる。
- 許可はai_reading_consentsの本人行を読み、set_ai_reading(p_decision,p_text_version)で保存する。0行と取得失敗を区別し、文の版が変わっただけでは聞き直さない。
- iOSでも、読み取り許可が拒否・未確認の間は転送先アドレスを表示しない。
- 本文2文と期限の正本はsrc/lib/ai-consent-text.ts。iOSの独立定数と実際のTextを、Webの実段落と値・表示順・回数で照合する。コメントや文字列中のTextを表示と数えない。
- MailHandlingText.itemsの14項目はWebのliと全文・表示順を合わせる。SettingsWebTextのplainDropNoticeとdroppedLeadも実Webと照合し、文の変更で空振りする陰性対照を残さない。
- mail_busyをSHOWN_KEYSへ含め、実際のLoginTextとLOGIN_MESSAGESを照合する。未登録定数・対応するNative定数のない共有キー追加・一覧からの欠落・一字違いを同じcheckerで検出する。固定Web入力はGit blobと照合し、出典名だけを一致の証拠にしない。
- 許可の保存直後はRPCが返したdecided_at原文字列をafter_consentへ渡し、既存の日次上限内で一度だけ自動読取する。失敗後の手動再試行・既読の荷物と結果の保持を維持し、起動やforegroundから自動POSTを再送しない。
- 分類シートは保存確認後だけ閉じる。受取undoは今回書いた荷物と受取日時・更新版を照合し、保存0件でundoを付けない。例外の案内に件数を出さない。
- DEBUG計測もsheetを持つcontentの構造を安定させる。操作用の制御は非操作probeと区別して前景へ置き、呼出回数だけでなく次のUI状態を待つ。foreground試験は実際のbackgroundからの復帰で行う。

## iOSの本人境界と認証

- APIトークンはモデル作成時のstampを固定し、共通readerでSDK session取得の前後の世代と取得した本人IDを照合する。後から現在のstampを取り直して別人へ追従しない。Demoのload/clearも操作前・token取得後・API応答後に旧世代の反映を止める。同世代のページ離脱・正常完了・結果不明時の再読は保つ。
- 削除POST後の200/401は現行の本人だけを既存cleanupへ進める。SDKに別人がいれば旧応答で消さず、SDKが空になった場合は削除後の片付けを許容する。このnil許容を送信前のtoken取得へ流用しない。
- パスワード変更APIは使い捨てAuthで更新する。成功またはsecret_change_unknownの後は既存signOutで鍵・保存session・読み込んだ画面を片付ける。通常の拒否や送信前の接続失敗はsessionを保つ。
- signOutの遅い末尾は開始世代と進行中signInを照合し、新しい保存sessionや表示を消さない。元の世代の鍵・本文・作業・画面の先行消去は維持する。
- 鍵復旧の再認証は共有AuthClientを汚さず、前後のstamp・SDK本人・正規化emailを照合する。ログアウト・別人切替・画面離脱後の遅い成功を復旧へ使わず、取消をAPI送信前とlocal cache保存前にも反映する。

## XcodeとSimulatorの負荷管理

- xcodebuildと起動中Simulatorはそれぞれ同時に1本・1台まで。開始前に既存プロセスと端末を確認し、他担当の実行は止めない。-jobs 1 -parallel-testing-enabled NOを使い、終了後は自分のSimulatorをshutdownする。
## 許可待ちメールの保管

- `20261113120000_consent_waiting_storage` は110000までの変更と既存の毎日の掃除に依存する。許可待ちは既存の利用者別保管上限を使い、全体の未読保管枠から分ける。許可後の日次上限待ちも、元の待ちメールの期限と区分を保つ。
- 期限の正本は `public.ai_consent_waiting_retention()` の1か所。`emails.received_at` から `consent_waiting_until` を付け、再読取や許可の変更で延ばさない。拒否・取消の直後には消さず、この期限まで残す。
- 既存の `purge_old_screen_events()` の入口から期限切れを掃除する。結果なしはメール行を削除し、既に部分結果がある行は本文・件名・差出人を消して荷物と結果を残す。完了済みの読み取りは期限の対象外。既存行の再読取は、掃除で行がなくなった後に新着として保存し直さない。
- Webの「読み取る」も、admin処理の前に許可を確かめる。未回答・拒否は許可画面、確認不能は既存の再読込へ案内する。pipeline内の各メールの確認も維持する。

## 有料 claim と許可行のロック順

`20261113121000_claude_claim_consent` は120000のsetterと110000の所有者prefixに依存する。共通の部分順序は **U → G → E → C → L → R**。使わない段は飛ばせるが、後の段から前の段を初めて取りに戻らない。

| 段 | 対象 | 取得する経路 |
| --- | --- | --- |
| U | `auth.users` の本人行 | claim v1/v2、owned処理、許可変更、全消去、退会。退会以外は親の KEY SHARE を先に取得する |
| G | `sample_generations` の本人行 | claim v1/v2も `lock_sample_owner` を通る。owned処理・許可変更・全消去も同じ順 |
| E | `emails` の対象行 | owned claim・荷物保存・全消去・取消時の待ちメール処理。直接の claim は使わない |
| C | `ai_reading_consents` の本人行 | 有料 claim は FOR SHARE と granted の確認。setter・自動起動claimは更新ロック。C の後で新しい G/E を取得しない |
| L | 費用の62801、または荷物候補の62803 | 費用は C の後に日次ロック。荷物経路は C を使わず E の後に62803 |
| R | 各経路のデータ行 | 費用は日次カウンタ・ledger、荷物は荷物・品目の行 |

- v2の内部からv1を呼ぶ時点ではU/G/Cを既に取得済みとし、再取得で初取得の逆順を作らない。owned経路も既存U/G/Eの中で同じclaim入口を使う。
- 自動起動claimはU → C → journalで、Cの後にG/Eを取らない。返却はU → 62801 → ledger / counterのままとし、取消後の正当な返却に新しい許可を求めない。
- 退会はUを排他で取得して同じ利用者のclaim・返却を先に除外し、既存triggerでG/Eを先取りする。その後のC・費用行はFK cascadeで消え、cascade内部の表順は仮定しない。親の排他によって通常RPCとの循環経路を除く。
- 受信保管用の62802は別の枝でGの後・Eの前に取得し、Cを取らない。上表のL（費用/荷物）と同一視しない。
- claimと取消をDB内で直列化し、取消が先なら枠を取得せず許可待ちに残す。成功したclaimのcommitから外部API応答までDBロックを保持しない。サンプル・Gmail確認は有料claimを使わない。

### 許可待ちと一般未読の保管期限の区別

- 14日の期限は、許可待ちの履歴を示す `consent_waiting_until` がある未読メールに適用する。許可済みで届き、上限や失敗で待つメールには、許可待ちを経たり後から取り消したりしない限り、自動の保管期限は付かない。
- 設定・privacyの一般未読の説明は `src/lib/mail-notices.ts` の `UNREAD_MAIL_STORAGE_NOTICE` を共用する。期限を約束せず、許可待ちの期限だけを `AI_CONSENT_TEXT.waitingRetention` の別段落で表示する。
- 許可直後の自動読取は、旧error名でなく `consent_waiting_until` と元の `received_at`・期限で選ぶ。移行前の上限や停止のerrorは選択のために書き換えない。再試行の `created_at` を到着時刻として使わず、サンプル・確認メール・許可後の新着は含めない。手動読取は従来の未読集合を保つ。
- Webの元メール表示は `body_state=dropped` の理由も取得し、`error=ai_consent_wait_expired` の完全一致だけに `CONSENT_WAIT_EXPIRED_NOTICE` を使う。専用の鍵なし理由は記録されていないため、null・欠落・未知理由から過去のログインを断定せず「本文は保存していません」と表示する。理由の生文字列は表示しない。

## 全消去とメールの再読

- 実メールも、所有者を特定した入口で全消去の世代を固定する。受信本文の取得待ちや未読一覧の取得より前に固定し、同じ要求の途中で新世代を採用し直さない。全消去後に始めた新着・再読は新世代を使う。
- 再読はMessage-IDの有無によらず一覧の行idとcreated_atを渡す。指定行が消えていたら作り直さず、同じMessage-IDの別行にも乗り換えない。所有者・lease・保存版・世代のDB検査をすべて通す。
- 全消去による受信中止と確認できた場合だけ、webhookは成功応答で再送を止める。未知のDB障害を中止や空一覧に読み替えない。メールの所有者が分かる前に世代を推測しない。

## 引用を確認できない無関係判定

- 原文で裏付けられない `unrelated` を注文へ書き換えない。`relevance_unverified` のfailed/未読メールとして本文を残し、荷物と抽出行を作らない。引用を確認できる無関係判定の破棄は維持し、未読から再試行できる。
- 公開保存済み結果のoffline集計は `npx tsx scripts/check-public-demo-relevance.ts`。公開2集合と合成対照を分け、unrelatedの分母が0なら条件付き率は未測定として扱う。実メールや課金APIを使わない。

## 再設定の完了確認と期限

- `finishReset` はI1の本人一致と、所有者・challenge・現行active鍵・元wrapの照合を先に行う。完了済みの同じ要求は15分を過ぎても成功確認を返し、Auth secretや鍵を再更新しない。未完了の変更は引き続き15分以内のreset認証を要する。
- 再試行の時刻試験では、認証AMRを初回時刻に固定する。各呼出しで現在時刻へ更新すると期限切れを再現できない。間に届いたメールの開封と、別の本人/鍵/包み直し操作を成功扱いしない対照も確認する。

## DB適用主体とAuth行ロックの権限

- 110000のfresh適用は既存emails/RPCの標準ownerを適用主体にする。新wrapperと退避coreのownerを混在させず、既存private呼出しとdownの所有者契約を保つ。所有者や権限を自動で変更してgateを通さない。
- Auth行を直接ロックする5関数には、実効的なauth schema USAGE・SELECT(id)・少なくとも1列のUPDATEが要る。正当な列grant/継承も認め、API呼出し役へ広いAuth権限を付けない。初回は新規DEFINER=current_user、再適用は既存の実owner全件も確認する。
- beforeの構造検査だけで権限を保証しない。afterは既存helperの実DEFINER権限で0行FOR KEY SHAREを通し、保存する行を作らずに必要ACLを確かめる。SQLエラー・出力無し・false/null・FAILEDなら停止する。全ユーザーのRLS可視性とは別の検査として扱う。

## 利用者ごとの荷物候補ロック（P-1）

- 上の62803は利用者ごとの `(62803, hashtext(user_id::text))`。authenticatedの直接DMLはauth.uid()、owned mail RPCはロックしたemails.user_idを正本にする。本人の0行UPDATEも自分の鍵だけを取り、既存grantとRLSは維持する。hashは排他の識別にだけ使い、所有者・lease・候補・snapshotの照合はUUIDのまま。hash衝突は待ち時間だけを増やす。
- 最終110000まで揃えた通常の書込みは U(Auth行) → G(世代行) → E(必要なメール行) → L(利用者の候補鍵) → R(荷物/明細行)。100000単独はGの無い途中段階なので、その段階でwriterを再開しない。
- serviceの直接parcels/items DMLには単一利用者のscopeが必要。実メールpipelineはwithMailRun/mail_run_write、サンプルと適用付きcategorizeはbeginMailGenerationの同じ世代付きclientを最後まで使う。categorizeは有料処理より前にscopeを確定する。header/context無しは拒否し、全員共通の鍵へ戻さない。
- 一つのtransactionでownerを切り替えない。退会のprivate callbackだけが削除対象UUIDのcontextを作り、cascadeの再入では削除済み親行を取り直さない。任意headerを削除contextの根拠にしない。
- TRUNCATEは通常のtriggerで常に拒否する。writer停止/drainだけでは許可されない。複数利用者にまたがる保守は単一owner transactionへ分割するか、別途レビューした手順を用意する。
- 100000/110000の本体・before・verify・downは同じ版で取り込む。Auth callbackは共通名のCREATE OR REPLACE TRIGGERで切り替える。100000を最終的に戻してtriggerを削除するにはAuth tableowner/memberが必要で、適用時のTRIGGER権限とは分けて確認する。利用者分離の実PG対照はtests/postgres/run-parcel-user-locks.mjs。
- R2-2の共有入口はprivateな `public.lock_parcel_owner(p_user uuid) returns void`。U/G/Eは呼出し元で先取りし、helperは同ownerのTx設定と利用者別Lだけを確保する。NULLとowner切替は拒否、owner不明のstatementは従来どおり拒否。PUBLIC/anon/authenticated/service_roleへ直接EXECUTEを与えず、同ownerのDEFINER RPC/triggerから呼ぶ。
- 後続migrationもinlineの62803取得や固定鍵を足さず、同helperへ統一する。メールのhelperは本人/run/lease検査後・snapshot/R前に置く。後続downの復元coreにも同じ呼出しを保ち、helperを作る100000より先に依存側を戻す。before/verify/downはhelperのABI/owner/ACLと、pg_procに固定62803,0が無いことも確認する。

## 確認メールの送信拒否（2026-11-12 本人決定）

- 公開時は最小修正とし、signup/resend/resetのover_email_send_rate_limit・分類されない429・メール要求の500をmail_busy失敗へ返す。文の正本はLOGIN_MESSAGES.mail_busy。新規signupを確認待ちへ進めず、送信済み/未送信やaccount作成の有無を文で断定しない。通常sign-in・通信例外・他の5xxの分類は保つ。
- user_already_exists等の非送信の中立応答は維持する。公式Authが送信前に成功する状態と、送信拒否になる状態のI6差は公開時の既知制約として受け入れる。全状態へ同じ429を返すmockで隠さず、3入口の不存在/未確認/確認済みを分けて試験する。送信枠の消費/返却差も共通受付の将来設計で扱う。
- 認証やSMTPの設定は文の調整に伴って変更しない。文の正本と状態別の実際の応答を照合する。

## Webの受取証跡と取り消し（2026-11-12 レビューAの修正）

- `20261113130000_received_receipts` は110000・120000・121000の実適用履歴と関数を前提にする。衝突した旧番号120000のreceived_receiptsは使用しない。beforeとDDLは前提が足りなければ変更前に止まる。
- Webは受取前の画面のstatusを復元権限にしない。`mark_parcels_received` がDBの直前状態・保存後の版をprivateな `parcel_receipt_undos` に記録し、本人の今回の操作へ `receipt_id` を返す。undoはopaqueなID/tokenだけを送る。
- `restore_parcel_receipts` は本人・tokenに加え、現在の `parcels.received_at` と `updated_at` の両方を照合する。iOSと古いWebがjournalを変えず直接UPDATEした場合も、メールの配達完了を古いタブで消さない。空のメール補完も更新版を進める。結果は `restored / changed / failed` に分け、未回答を成功やchangedへ丸めない。
- 1回の通信の正本は `receipt.ts` のraw 200件。Actionはdedup・認証・DBより前、RPCは所有者/ロックより前に検査する。UIの論理総数に上限を設けず、受取とundoを200件ずつ逐次処理し、501/1,001件以上と端数を残さない。実SDK試験でIDがPOST本文へ入り、URLが8,192 bytes未満となる不等式を確かめる。
- journalは荷物/利用者のcascadeで消える。期限の正本は `public.parcel_receipt_retention()`。作成から24時間に固定し、受取の再送・undo・再送undoで延長しない。期限後のundoは変更しない。既存daily purgeへ期限切れの削除を合成し、許可待ちメールとscreen_eventsの掃除を保つ。正常に24時間毎の掃除が続く場合の物理残存は作成から48時間未満で、ジョブ停止中の物理削除は保証しない。
- 手動受取は課金しないのでCを使わず、U → G → E → L → R → journalの順。forwardの3入口とdownの復元coreはP-1の共有 `lock_parcel_owner` を使う。mark/restoreはU/G/E後・R前、mail coreは本人/run/lease確認後に呼ぶ。before/verify/downはhelperのABI/owner/ACLと固定キー不在を確認し、誤った戻し順は変更前に止める。authenticatedの既存 `parcels UPDATE` grantは変更しない。B-4の通信予算と、DBの利用者別ロックP-1は別の守り。
- 新Webの仮文は `UNDO_CHANGED_NOTICE` の「ほかで変更された荷物があります」。本人の決定までは仮置き。旧 `PARTLY_RESTORED_NOTICE` と `CANNOT_UNDO_NOTE` はiOSで使う値を維持する。Webの実装とTS parityの期待を同じ変更に含め、Swift/ios配下はiOS担当の版を保つ。iOSの三区分・新しい文・混在表示・Swift試験更新は別担当へ報告する。
- STATUS_LABEL.deliveredとiOSのFormat.statusLabelは「配達済み」で共有する。試験台本は `tests/postgres/run-received-receipts.mjs` と、受取/undoを追加した `run-sample-lock-order.mjs` の `--with-receipts`。専用Postgresでowner分離・固定キーの陰性・自然競合・戻し/再適用を測り、停止と削除まで確認する。
- DB試験台本のverify出力は、共有の `tests/postgres/run-cost-guards.mjs` のファイル別形式で判定する。110000 afterは末尾の判定列を読む。任意の列にあるOKでは代用せず、列数・必須真偽値・件数・動作試験結果も照合する。verifyのSELECTを変えたら共有形式と正常/異常の自己試験も同じ変更で合わせ、実Postgresの測定とは区別する。

## 自動読み取り内の再試行（R4-2）

- 許可直後の自動読取は、同じ要求の中で一度試したメールIDをbatch間で共有し、同じIDを再び有料処理へ送らない。failedを恒久的に対象外にはしない。本文を残すmodel refused / relevance_unverifiedも、その要求では1回だけ数え、後続の別メールへ進む。
- 対象のpageはsent_at昇順NULLS LAST/id昇順で取り、既試行だけのpageは末尾の生の時刻/idを境界として続きを探す。時刻の小数を丸めず、同時刻とNULLの境界もidで進む。短いpageを完了と仮定せず、空page・期限・上限・失敗を別々に扱う。未試行を処理した後のbatchは境界無しから探し、別要求の部分削除で後続を飛ばさない。
- 記録は要求内だけのもので、明示の手動読取や別の許可要求へ持ち越さない。許可のreceiptの一度だけのclaim、到着/保管期限のN2条件、要求開始時の世代、行id/created_atの照合、課金前の現在の許可検査を維持する。
- WebとiOSの許可後処理は共通runReadAfterConsentを使う。両方の手動入口は共通runReadWaitingMailの単発snapshotで、クライアント側に自動再POSTを足さない。DBに再試行状態やmigrationを追加しない。

## 削除と封印の結果確認（P-055・M-007）

- 無関係メールのdiscardedと、保存済みメールのscreened_outは、owned DELETEのerror無し・返却1行・対象ID一致を確認してから返す。dropイベントもその後だけ記録する。未確認の削除は失敗として上位へ返し、同じ自動要求へ再投入しない。保存済み行の明示再読では、既に消えた行を再作成しない。
- grounded unrelatedの削除失敗は既存catchがfailed保存を試す。screen分岐やDB拒否継続時はpending leaseが残ることがあるため、lease満了後の明示再試行を保つ。consent_waiting_until無しの一般failed原文に自動TTLを約束しない。明示再試行・全消去・退会が出口であり、許可待ち期限の掃除とは分ける。
- background封印の取得進捗は選択行数で判断し、書込み件数でEOFを推測しない。別workerの正当な封印/削除によるUPDATE0行は0sealed/0failed、未確認の返却は当該行failedとする。公開sealPlainBatchの返却shapeを維持し、内部の進捗値をAPI/nativeへ追加しない。
- 0行を一律失敗にしない。単一owned削除の成功確認と、元から対象無しのbulk掃除/同時処理済みは、操作ごとに達成条件を分ける。

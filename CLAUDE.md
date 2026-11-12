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
- `STATUS_LABEL`（`format.ts`）は iOS が写して照合テストで固定しているので、delivered の語は「届いた」のまま。Web の画面は `parcelStatusLabel` で出し分ける。iOS が追いつくとき（ビルド 14）に両方そろえて変える

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
- 設定の「あなたのメールの扱い」から許可を取り消せる。既存の荷物と結果は残り、消したい人は既存の削除操作を使う。許可の保存成功直後、届いている許可待ちメールを既存の日次上限内で自動読取する。読取失敗でも許可は保持し、後から既存の「読み取る」で再試行できる（2026-11-12 マスター決定）。
- 同じ選択・文の版の再送では `decided_at` を保つ。自動読取は service role 専用の `claim_ai_reading_backlog` で同じ許可日時につき一度だけ開始し、失敗後も起動記録を戻さない。明示的な手動再試行はこの起動記録に制限されない。iOS は RPC が返した日時文字列を丸めず `after_consent` に渡す。
- 自動読取は費用の守りの `unread.ts` の timeout・1 通全体・request 全体の予算を使い、次の 1 通を終える余裕がある場合だけ開始する。この契約がない旧 SDK 構成では起動しない。費用の守りの SDK timeout / retry・owned lease・容量制限と合わせて統合する。
- iOS の同意と未読再開 API の契約は `docs/api/mail.md`。DB だけを当てても旧 Web の呼出は止まらないため、新しいガード版 Web と DB を続けて反映する。本番反映と DB 適用は別途承認の対象。

## DB 書込みのロック順

- `20261113110000_sample_generation` は費用ガードの090000と荷物保存時検査の100000に依存する。荷物経路は所有者のAuth行を先に確保し、世代行 → メール行 → advisory 62803 → 荷物/明細行の部分順序を守る。新しいRPCやtriggerでこの順を逆転させない。本人・lease・OCC・候補集合・保存結果の検査は維持する。
- sampleだけでなく実メールのcreate/update/ensure、本人の直接DML、全消去、退会cascadeも同じ順に参加する。退会は既存世代とメールをcascade前に取り、自動読取claim・費用claim v2/releaseもAuth親行を先取りする。DBロックは各短期RPCの中だけで保持し、外部API待ちへ持ち出さない。
- private coreの `_without_sample_fence` はAPI roleから直接実行しない。新しいservice処理も公開RPCの入口を通す。header無しの任意複数表/複数利用者DMLやTRUNCATEは保守操作としてwriter停止・drainを要する。
- 統合時は `tests/postgres/run-sample-lock-order.mjs` の自然競合と旧順序の陰性対照、`scripts/test-sample-generation.py`、`scripts/test-sample-generation-lifecycle.py` を使い捨てPGで確認する。前提・集計・後片付けは `tests/postgres/README.md`。検証終了は専用PGの停止・待ち受け0・専用データ削除まで。

## 全消去とメールの再読

- 実メールも、所有者を特定した入口で全消去の世代を固定する。受信本文の取得待ちや未読一覧の取得より前に固定し、同じ要求の途中で新世代を採用し直さない。全消去後に始めた新着・再読は新世代を使う。
- 再読はMessage-IDの有無によらず一覧の行idとcreated_atを渡す。指定行が消えていたら作り直さず、同じMessage-IDの別行にも乗り換えない。所有者・lease・保存版・世代のDB検査をすべて通す。
- 全消去による受信中止と確認できた場合だけ、webhookは成功応答で再送を止める。未知のDB障害を中止や空一覧に読み替えない。メールの所有者が分かる前に世代を推測しない。

## 引用を確認できない無関係判定

- 原文で裏付けられない `unrelated` を注文へ書き換えない。`relevance_unverified` のfailed/未読メールとして本文を残し、荷物と抽出行を作らない。引用を確認できる無関係判定の破棄は維持し、未読から再試行できる。
- 公開保存済み結果のoffline集計は `npx tsx scripts/check-public-demo-relevance.ts`。公開2集合と合成対照を分け、unrelatedの分母が0なら条件付き率は未測定として扱う。実メールや課金APIを使わない。

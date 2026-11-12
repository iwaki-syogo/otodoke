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

## ビルド14の受け取り状態（2026-11-11）

- ビルド14では `STATUS_LABEL.delivered` とiOSの `Format.statusLabel` を「配達済み」にそろえた。上の受け取り済み節にある「iOSの照合のため届いたのまま」はビルド13までの説明。本人の受取は有限の `received_at` で出し分ける。
- マスターからの報告: `20261112100000_parcel_received_at.sql` は2026-11-11 23:23 JSTに本番へ適用され、verifyも成功。Webの受け取り済みはdevのPreviewへ反映された。Codexが本番DBへ適用・検証したという記録ではない。
- iOS用の削除・パスワード変更APIは `docs/api/account.md`。これらのAPIをWeb本番へ反映してから、呼び出すiOS版を配布する。

## AIによるメールの読み取り許可（2026-11-12 本人指定）

- ログイン後、転送先アドレスを見せる前に「メールの読み取り」を1回表示する。未選択の既存利用者も対象。拒否/未確認ではアドレスを出さず、手入力と作り物のサンプルは使えるようにする。
- 本文は「届いたメールは、Anthropic の Claude で読み取ります。」。許可/拒否と、アプリ内で開くプライバシーポリシーを用意し、設定の「あなたのメールの扱い」から撤回/再許可できるようにする。
- Webとの契約は `ai_reading_consents` の本人行を読み、`set_ai_reading(p_decision,p_text_version)` で `granted` / `declined` と `v1` を保存する。0行と取得失敗を区別し、文の版違いだけでは再質問しない。許可を押しただけで有料の読取を開始しない。

## AI読み取り許可の更新（2026-11-12 本人決定）

- 上の「許可を押しただけで読取を開始しない」は旧方針。許可を保存した直後は、それまでに届いて待っていたメールを1日の上限内で自動で読み取り、もう一度押す操作を要求しない。Web側の最新契約にそろえる。
- 読み取りをやめても、既に読み取った荷物と結果は残す。許可の取消とデータ削除は別で、消したい人は既存の削除操作を使う。
- 受け取りの例外の文は「元に戻せない荷物があります」「受け取り済みのままの荷物があります」。この2場面も件数を表示しない。
- 許可の自動読取は、`set_ai_reading` が返した `decided_at` を原文字列のまま `POST /api/mail/read-waiting` の `after_consent` に渡す。日時を再生成しない。Web/DBが同じ許可の二重実行を防ぎ、対象の続くバッチと日次上限を扱う。
- 読取失敗でも許可を取り消した扱いにしない。POSTを自動で再送せず、後から本人が「読み取る」を押すときは従来の空の本文を送る。通常の起動・foreground・許可の再確認から新しい自動読取を開始しない。

## ビルド14の分類保存とundo（2026-11-12 追加依頼）

- 分類の選択シートは、選択した値が `category_source=user` で保存できたと確認したときだけ成功として閉じる。競合・結果不明・再読失敗は、エラー文が空であることだけを成功としない。
- 受取のundoは、今回の操作が実際に書いた荷物だけを対象にし、現在の受取日時が今回書いた値と一致する行だけを戻す。保存0件ではundoを付けない。既存の更新版による上書き防止も維持する。

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

## Webの受取証跡と取り消し（2026-11-12 レビューAの修正）

- `20261113130000_received_receipts` は110000・120000・121000の実適用履歴と関数を前提にする。衝突した旧番号120000のreceived_receiptsは使用しない。beforeとDDLは前提が足りなければ変更前に止まる。
- Webは受取前の画面のstatusを復元権限にしない。`mark_parcels_received` がDBの直前状態・保存後の版をprivateな `parcel_receipt_undos` に記録し、本人の今回の操作へ `receipt_id` を返す。undoはopaqueなID/tokenだけを送る。
- `restore_parcel_receipts` は本人・tokenに加え、現在の `parcels.received_at` と `updated_at` の両方を照合する。iOSと古いWebがjournalを変えず直接UPDATEした場合も、メールの配達完了を古いタブで消さない。空のメール補完も更新版を進める。結果は `restored / changed / failed` に分け、未回答を成功やchangedへ丸めない。
- 1回の通信の正本は `receipt.ts` のraw 200件。Actionはdedup・認証・DBより前、RPCは所有者/ロックより前に検査する。UIの論理総数に上限を設けず、受取とundoを200件ずつ逐次処理し、501/1,001件以上と端数を残さない。実SDK試験でIDがPOST本文へ入り、URLが8,192 bytes未満となる不等式を確かめる。
- journalは荷物/利用者のcascadeで消える。期限の正本は `public.parcel_receipt_retention()`。作成から24時間に固定し、受取の再送・undo・再送undoで延長しない。期限後のundoは変更しない。既存daily purgeへ期限切れの削除を合成し、許可待ちメールとscreen_eventsの掃除を保つ。正常に24時間毎の掃除が続く場合の物理残存は作成から48時間未満で、ジョブ停止中の物理削除は保証しない。
- 手動受取は課金しないのでCを使わず、U → G → E → L → R → journalの順。`P1_OWNER_LOCK_SEAM` の3箇所はP-1担当の利用者別helperとの接続待ちで、接続前を公開可能とは扱わない。authenticatedの既存 `parcels UPDATE` grantは変更しない。B-4の通信予算と、DBの利用者別ロックP-1は別の守り。
- 新Webの仮文は `UNDO_CHANGED_NOTICE` の「ほかで変更された荷物があります」。本人の決定までは仮置き。旧 `PARTLY_RESTORED_NOTICE` と `CANNOT_UNDO_NOTE` はiOSで使う値を維持する。Webの実装とTS parityの期待を同じ変更に含め、Swift/ios配下はiOS担当の版を保つ。iOSの三区分・新しい文・混在表示・Swift試験更新は別担当へ報告する。
- STATUS_LABEL.deliveredはビルド14で「配達済み」へ更新済み。上の受取節にある「届いた」の保持説明は旧契約で、新しいWeb差分から戻さない。試験台本は `tests/postgres/run-received-receipts.mjs`、実Postgresの測定はまとめ役へ引き渡す。

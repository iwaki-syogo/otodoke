# Otodoke（おとどけ）

**荷物に、予定を合わせない。**

どの店で買った荷物も、何がいつ届くか、いつ家にいればいいか、今月いくら使ったかが 1 つの画面で分かる荷物カレンダーです。最初にメールの自動転送を 1 回設定すれば、あとは何もしなくていい。届いた注文・発送のメールを Claude が読み取り、コードのルールで荷物ごとにまとめます。

テーマは「あなたにしかない深さを。」です。作者が自分の 1 年分の注文・配送メール 341 通を読んで分かった、店や運送会社ごとの書き方の癖を、読み取りの規則の土台にしました（`docs/email-field-map.md`）。

- 本番: https://otodoke.app
- デモ動画: <!-- DEMO_VIDEO_URL --> （公開準備中）

> Built with Claude: Japan 2026（2026-11-02 〜 11-08）の提出作品です。コードはすべて期間中に新しく書きました。最初のコミットは 2026-11-02 17:19（日本時間）です。

## 課題

作者は Amazon、楽天、メーカーの直販など、いくつもの店で買い物をしています。自分のメールを数えると、注文と配送のメールは 1 年で 341 通ありました。

- 何を注文したか忘れる
- 発送されたのか、いつ届くのか分からない
- 置き配できない荷物の日を覚えていられず、不在票が溜まる
- 今月ネットでいくら使ったか分からない

店のアプリは店ごと、運送会社のアプリは運送会社ごとです。全部をまとめて見る場所がありません。

日本では年に約 50 億個の宅配便のうち、およそ 3.8 億個が再配達になっています。宅配便の取扱個数 50 億 3147 万個（[国土交通省](https://www.mlit.go.jp/report/press/jidosha04_hh_000341.html)、令和 6 年度）に、再配達率 約 7.6%（[国土交通省](https://www.mlit.go.jp/report/press/tokatsu01_hh_001025.html)、宅配に関わる大手 6 社、令和 8 年 4 月）を掛けた数です。受け取る側が「いつ家にいればいいか」を知らないことは、その一因です。

## 何が変わるか

- **家で待たなくていい。** 置き配できるかを文面から読み分け、家にいる必要のある日をカレンダーで赤く出します。メールに受け取り方法が書いていない荷物は、断定せず「念のため対面」と分けて出します
- **店のアプリを渡り歩かなくていい。** 店のメールと運送会社のメールを伝票番号でつなぎ、1 つの荷物として見せます。初めての店で買っても、そのまま読み取ります
- **使ったお金が分かる。** 今月の合計を、店ごと・分類ごと（食費・日用品など 7 種類）に出します
- **AI の言うことを確かめられる。** 読み取った値には、元メールの根拠の行が付きます。自信のない値は断定せず「要確認」にします

## 審査員の方へ：試し方（1 分）

実際のメールは要りません。

1. https://otodoke.app を開き、ログインの画面の「アカウントを作る」で、メールアドレスとパスワードを決めます。画面が「確認のメールを送りました」に変わります。届いた確認のメール（件名「Otodoke のメールアドレスの確認」）のリンクを別のタブで開いて「確認する」を押すと、元のタブが自動でログインし、最初の案内（/app/welcome）に着きます。そこで「あとで」を押します
   - 確認のメールは noreply@otodoke.app から送ります。届くまで 1〜2 分かかることがあります。見当たらないときは迷惑メールのフォルダも見てください
   - 進めないときは次を見てください
     - パスワードは 10 文字以上です。同じ文字のくり返し、1234… や abcd… のような連番、password のようなよくある言葉と数字だけの組み合わせは使えません（アカウントを作る画面にも同じ決まりが出ます）
     - 新規登録とログインでは、人かどうかの確認（Cloudflare Turnstile）が出ます。ボタンが「確認のチェックを押してください」になったら、チェックを押してください。押すと、そのまま進みます。「確認を読み込めませんでした」と出たら、ページを読み込み直すか、別のブラウザで試してください
     - 確認のメールが来ないときは、アカウントを作る画面で送ったあとに出る「メールを送り直す」を押します
     - 「回数が多いため、しばらく時間をおいてから、もう一度お試しください。」と出たら、少し待ってからやり直してください
     - それでも届かないときは support@otodoke.app へ書いてください
2. 「設定」タブの「サンプルで試す」で「サンプルのメールを読み込む」を押します。匿名化した実際のメール 17 通が、今日の日付に合わせて入ります（保存済みの読み取り結果を使うので、Claude API は呼びません）
3. 見てほしいところ
   - 「荷物」: 17 通が 6 つの荷物にまとまります。赤い 🤝 の印が、家にいる必要のある荷物です（サンプルでは 4 つ）。メールに対面での受け取りが書いてあったものは「対面受け取り」と出ます。「念のため対面」は、メールに受け取り方法が書いていないので、念のため家にいる必要がある扱いにした荷物です（サンプルの 4 つのうち 3 つ。Amazon はふだん置き配なので、この扱いにしません）
   - 荷物の詳細: 根拠の行が出るのは、メールに書いてあった荷物だけです。サンプルでは、状態が「不在・再配達」の荷物（ヤマト運輸から届いた 1 つ。店名は「送り主不明」と出ます）を開くと、受け取りの欄に「根拠: 「■受取ご希望場所：対面での配達を希望」」が出ます。「念のため対面」の荷物では、根拠の代わりに「メールに記載なし」と出ます。どの荷物も「元メールを見る」で、読み取りメモと元のメールを開けます（暗号化して保存したメールは、パスワードで開きます）
   - 「カレンダー」: 家にいる必要のある日が赤く出ます
   - 「支出」: 店・分類ごとの内訳と、月ごとの棒グラフ

## 仕組み

1. アカウントを作ってパスワードでログインすると、あなた専用の受信アドレスが出ます（パスワードは、保存するメールの暗号化にも使います。下の「あなたのメールの扱い」）
2. 自分のメール（Gmail / iCloud / Outlook など）で、そのアドレスへの自動転送を最初に 1 回だけ設定します。店ごとの設定はありません。やり方は[転送設定ガイド](https://otodoke.app/guide/forwarding)にあります
3. 届いたメールは Resend の webhook（署名を検証）で受け取り、広告を落としてから Claude が読みます。荷物へのまとめと運送会社の判定はコードです
4. 一覧・カレンダー・支出として表示します。画面からはいつでも元メールに戻れます（パスワードで開きます）

## Claude をどう使ったか

### アプリの中で：Claude には「判断」だけを任せる

- メールが注文・発送・配達・キャンセルのどれか、どの値が配達日か、「置き配指定可能」が定型の案内か本当の指定かを読み分けます
- 出力は zod のスキーマで固定し、値ごとに `evidence`（原文の行）と `confidence` を持たせます。根拠のない値は確信度を低くし、画面で断定しません
- 運送会社の判定と荷物の名寄せはコードとルールで書き、Claude には任せません。作り話が入る場所を減らすためです

**費用で続かなくならないように。** 届くメールを全部読ませると、使う人が増えるほど赤字になります。1 段目は無料のルール（店の許可リストは使わず、文面だけで判定。迷ったら通す）。迷うものだけ 2 段目で Haiku に聞き、残ったものを読みます。

**モデルは実測で選びました。** 手で正解を付けたデモ 17 通の結果です（`docs/eval-log.md`）。

| モデル | 項目の一致 | 17 通の費用 |
|---|---|---|
| Claude Opus 5.5 | 73/73 | $0.46 |
| Claude Sonnet 5.5 | 73/73 | $0.23 |
| Claude Haiku 5.5 | 73/73 | $0.02 |

Haiku は最初 71/73 でした。外れは時間帯の書式の違いで、これをコード側で直し、最新の測定（2026-11-06）は 73/73 です。匿名化した 341 通では種類の判定を確かめ（314/320）、既定を Haiku にしました。項目の一致を手で付けた正解と照らしたのは、この 17 通だけです。作者の 341 通を本番と同じ処理で読み込んだときの費用は、1 年分で約 0.4 ドルでした。デモボタンの結果は Opus 5.5 で事前に作って保存したもので、あとから人の手が入っています。商品の分類を 17 通すべてに手で付け、読み取りメモ 6 件を null や項目名の出ない日本語に書き直しました（読み取った値はこの時点では変えていません）。公開前の匿名化では、伝票番号 4 種類（7 件の読み取りの値と根拠の行）を架空の番号に替え、おすすめ商品について書いたメモ 1 件を消しました。

### 開発で：Claude Code を中心に、止める仕組みを先に置く

コードは Claude Code が書き、人は決めることと確かめることに回りました。

- **CLAUDE.md をリポジトリの約束にする。** コミットしてはいけないもの、Claude に任せないこと、本番設定の罠を書き、別のエージェント（Codex）も `AGENTS.md` から同じ文書を読みます
- **フックで止める。** `.claude/settings.json` の PreToolUse が force push・実メール（`fixtures/raw/`）のコミット・gitleaks に引っかかるコミットを止め、PostToolUse が編集したファイルを eslint にかけて結果を Claude に返します。`.githooks/pre-commit` は誰がコミットしても同じ検査をし、ふるい（`src/lib/screen.ts`）を変えると `npm run check:screen` を走らせます。荷物のメールを 1 通でも落とすとコミットできません
- **サブエージェントで分業する。** まとまった直しは、開発の進め方を決めた作者の自作スキル `/orchestrate`（開発用の道具で、Otodoke のコードには含まれません）で、計画 → 失敗するテスト → 実装 → レビュー・セキュリティ・QA → 直し、をサブエージェントに分け、作業用の worktree で進めてから `dev` にまとめました。コミットの `[TDD]` `[task-N]` `[SEC-…]` `[QA-…]` がその跡です。例: 「届いた荷物」の検索は、[失敗するテストを先に書き](https://github.com/iwaki-syogo/otodoke/commit/df36805a372e4b8c9af242d7f3244746777f24e9)、[実装し](https://github.com/iwaki-syogo/otodoke/commit/f40eb215185a7e0fd51247f7530bd5a598902f8c)、[レビューと Codex の指摘を直しました](https://github.com/iwaki-syogo/otodoke/commit/8a0aa63eb4aa80adcbdca71ad0201f5bf9c75773)
- **別の目でレビューする。** 実装したエージェントとは別のエージェントがレビューし、別の会社のモデル（Codex）にもレビューさせました（コミットの `[Codex-…]`）。メールの処理に手が入る変更は、本番の前に作者でない目のレビューを通しました
- **本番は人が決める。** `main` への反映＝本番デプロイなので、毎回人が承認してから進めました
- **画面で確かめる。** ブラウザを操作する MCP（作者の自作の Chrome 拡張）でスマホ幅（390px）の全画面を開き、ボタンの幅や行数を測り、支出の合計を DB の集計と突き合わせました。この拡張も開発用の道具で、Otodoke のコードには含まれません
- **実メールで通す。** 作者の 341 通を本番と同じ処理で読み、できた荷物 101 件のうち 46 件を別のエージェントが元メールと照合しました。誤りは 460 項目中 20 → 直したあと 440 項目中 10、状態・予定日・まとめ方の誤りは 0 になりました。名寄せや金額の規則を変えたら、API を呼ばない `scripts/replay.ts` で件数と合計の差を見ます
- **セッションを並べて動かす。** 締切の前日（2026-11-07）の未明は、Claude Code のセッション 7 つを、Web の画面・iOS アプリ・転送の説明・説明動画・デモ動画・本番前後の点検・統合のレビューに分けて同時に動かしました。もう 1 つのセッションがまとめ役になり、仕事を割り振り、分けた仕事どうしの継ぎ目（Web と iOS で食い違う文や設定項目など）を担当に照らし合わせさせて、直す先を決めました
- **モデルを役で使い分ける。** 実装は主に Sonnet のサブエージェントに任せ、レビューと設計の判断は主に Opus が受け持ちました。いくつものセッションの変更が `dev` にたまったところで、`main` に出す前にその全体を作者でないエージェントが観点を分けて（継ぎ目・本番でだけ壊れるもの・公開リポジトリとして）レビューし、そのあとの直しも作者でない目で判定し直しました
- **公開する物を読み直す。** 説明動画とデモ動画は、切り出したコマを文字認識で読み、個人情報や追跡番号が映っていないかを確かめました。デモの 17 通も見直し、匿名化を足しています（下の「持ち込んだデータ」）

## 安全への配慮

- **データ**: 全テーブルで RLS。メール本文・読み取り結果・品目は、ログインした利用者からは読むだけで、書くのはサーバーだけです（実際に書き込みを試し、拒否されることを確かめました）
- **保存したメール**: 読み取った後の件名・差出人・本文は、利用者のパスワードでしか開けない形で保存します（下の「あなたのメールの扱い」）
- **費用**: 有料の呼び出しの前に、DB の関数 `claim_claude_call` で 1 人 1 日と全体 1 日の枠を取ります。超えたメールは保存しておき、あとで読み直せます
- **広告メール**: 本文は保存せず、件名と差出人のドメインだけを 14 日残して、毎日まとめて消します。「これは荷物」で覚えた差出人は、設定の「外す」で外せます
- **運送会社**: 追跡ページをスクレイピングしません。押したときにリンクを開くだけです
- **ログイン**: メールアドレスとパスワード。パスワードはブラウザで 2 つに分け、ログイン用の値だけをサーバーに送ります。パスワードそのものは送りません。確認と再設定のメールのリンクは、開くと確認ボタンが出て、押したときに検証します（メールの検査がリンクを踏んでも使い切られない）。ほかのサイトから送られた確認は断ります。リンクの行き先はコードで決め、リンクの中の行き先は読みません。Web と iOS で同じ計算にするため、メールアドレスは ASCII の文字だけ受け付けます
- **退会**: 設定の「アカウントを削除」で、アカウントごと消せます。消した人の受信アドレスは、ほかの人に渡しません
- **確認と再設定のメール、ログイン**: Web の画面から送るメールとログインには、メールアドレスごと・接続ごとに回数の上限を置きます。メールのリンクの確認にも、接続ごとの上限を置きます。どの画面も、ほかのサイトの中に埋め込ませません（ボタンを押させる罠を防ぐ）
- **公開リポジトリ**: 実メールは置かず、デモの 17 通は匿名化済み。鍵は gitleaks で止めます

**まだできないこと**: Amazon の分割発送では、品目が最初の便の分だけになることがあります。メールが来ない注文は、手で登録する画面から入れます。

## あなたのメールの扱い

アプリの「設定」にも同じことを書いています。全体は [プライバシーポリシー](https://otodoke.app/privacy) にまとめています。

- 届いたメールは、読み取る数秒のあいだ、サーバーと Claude API が中身を扱います。Anthropic は API のデータを、既定では学習に使わず、30 日以内に消すと定めています（2026-11-06 に privacy.claude.com で確認）
- 読み取って買い物に関係ないと分かったメールは消します
- 読み取った後のメールの件名・差出人・本文は、あなたのパスワードでしか開けない形で保存します。パスワードそのものはサーバーに送らないので、運営者もデータベースからは読めません
- ただし、暗号化を始める前に読み取ったメールは、暗号化していません。設定で「暗号化する」を押すまで、運営者が読める形で残ります。パスワードでログインしていない場合は、11 月 14 日に件名・差出人・本文を消します。荷物は残ります
- 荷物の情報と読み取り結果、差出人のドメインは暗号化しません。荷物の情報は店・品名・金額・日付・注文番号・伝票番号、読み取り結果は根拠の行と読み取りメモです。根拠の行は本文の抜粋です。一覧・カレンダー・支出を出すのと、読み取った値を元の文で確かめるのと、同じメールを見分けるのに使うためです
- メールごとの識別子の Message-ID と、Gmail の転送の確認メールにある承認リンクも暗号化しません。同じメールを二度読まないためと、承認ページを出すためです
- 1 日の上限を超えた分など、読み取る前のメールは、読み取るまで暗号化せずに置いておきます。読み取ったら暗号化します
- Otodoke が暗号化を始めた後、パスワードでログインする前に読み取ったメールは、件名・差出人・本文を残しません。荷物の情報は残ります。サンプルのメール（匿名化して公開しているもの）は、パスワードでログインする前でも読めるまま入ります
- パスワードを忘れたときは、メールで再設定できます。パスワードを決め直すと、前に暗号化して保存したメールは開けなくなります。荷物は残ります。パスワードを変えるだけなら、前のメールもそのまま開けます
- 受信を受け持つ Resend にも、メールの写しが一定期間残ります
- 暗号化していない状態のメールは、データベースのバックアップにも最大 7 日間残ります。読み取る前のものと、暗号化する前のものです
- 広告など読まなかったメールは、件名と差出人のドメインだけを 14 日間残します。毎日まとめて消します。「これは荷物」と押したメールは、その差出人を覚えている間は残します。「外す」で外すと、ほかと同じく 14 日で消します。Gmail など多くの人が使うドメインは覚えません
- iOS アプリでは、パスワードで開いた鍵を、その端末のキーチェーンに Face ID 付きで保存できます。Touch ID の端末では Touch ID を使います。鍵は端末の外に出ず、iCloud などで同期もしません。ログアウトすると消え、アプリの設定で切ることもできます
- 運営者が正しいプログラムを動かしていることが前提です。コードはすべてこのリポジトリで公開しています

**仕組み。** パスワードはブラウザの中で、メールアドレスから作った salt で PBKDF2-SHA256 を 60 万回かけ、その結果を HKDF-SHA256 で 2 つに分けます。1 つはログイン用の値で、これだけを Supabase Auth にパスワードとして送ります。もう 1 つは秘密鍵を包む鍵で、ブラウザの外に出ません。最初にパスワードでログインしたとき、ブラウザが鍵の組（ECDH P-256）を作り、秘密鍵をこの鍵で AES-256-GCM で包んでから保存するので、サーバーにはパスワードも、包む鍵も、開いた秘密鍵も届きません。サーバーは公開鍵だけを持ち、メールを読み取った時点で件名・差出人・本文を 1 つの封筒（HKDF-SHA256 ＋ AES-256-GCM）にして、平文の列を同じ書き込みで空にします。登録のときは、データベースから読み戻した包みがパスワードで開き、公開鍵と対になっていることをブラウザで確かめてから鍵を使い始めます。元メールはブラウザで開き、文字だけを表示します（HTML は描画しません）。包んだ鍵と封筒は、ログイン中の本人の分だけをサーバーの処理（Server Action）から受け取ります。ブラウザ用のデータベースの鍵は配っていません。開いた鍵はそのタブのメモリにだけ置き、再読み込みや新しいタブでは、元メールを開くときにパスワードを入れ直します。パスワードを変えるときは、同じ秘密鍵を新しいパスワードで包み直すので、前のメールも開けます。再設定では前のパスワードが無いので、新しい鍵の組を作ります。iOS アプリも同じ計算でログインし、同じ鍵を開きます。取り決めは `docs/crypto/password-v1.md`、形式は `src/lib/crypto/` です。固定のテストベクトルは、パスワードから作る 2 つの値と包みが `fixtures/crypto/password-v1.json`、封筒が `fixtures/crypto/envelope-v1.json` です。

## 技術

- Next.js 16 / React 19 / TypeScript / Tailwind CSS v4
- Supabase（Postgres、ログインはメールアドレスとパスワード）
- Resend（受信 webhook と、確認・再設定のメールの送信）
- Claude API（Haiku 5.5 が既定。判定と構造化抽出）
- Vercel
- テスト: Vitest（API を呼ばない）
- iOS アプリ（`ios/`、SwiftUI、iOS 17 以降）: 同じアカウントで、パスワードでログインします。荷物・カレンダー・支出・設定の 4 つのタブがあり、荷物の詳細や、届いた荷物・キャンセルした荷物も見られます。暗号化したメールは端末で開き、文字だけを表示します。パスワードの変更や再設定、アカウントの削除などは、Safari で Web を開いて行います。TestFlight の内部テストで配っているので、審査員の方は入れられません

## 動かし方

審査は本番（https://otodoke.app）でどうぞ。上の「審査員の方へ」のとおりに進めてください。手元で動かすのは開発者向けです。

**手元で動かす。** 上から順に打てば動きます。自分の Supabase のプロジェクトが要ります。

1. Node.js は 22.12 以上（22・24・26）が要ります。vitest と supabase-js の条件によります（`package-lock.json` の engines）。作者は Node.js 26 で確かめています。
2. 依存を入れます。git の pre-commit も有効になります。

   ```bash
   npm install
   ```

3. Supabase CLI を入れます。`npm run env:supabase` もこの CLI を使います。

   ```bash
   brew install supabase/tap/supabase
   ```

4. Supabase にログインし、自分のプロジェクトにつなぎ、スキーマを適用します。

   ```bash
   supabase login
   supabase link --project-ref <自分のプロジェクトの ref>
   supabase db push
   ```

5. 環境変数を用意します。`.env.example` を `.env.local` に写して値を入れます。Supabase の 3 つの値（URL・anon キー・サーバー用キー）は、`link` のあとに `npm run env:supabase` を打つと `.env.local` に書き込まれます。このスクリプトは、つないだプロジェクトのキーを Supabase の CLI で取り、`.env.local` に書き、サーバー用キーが通るかを確かめます。値は画面に出しません。ほかのキーは空のまま残します。

   ```bash
   cp .env.example .env.local
   npm run env:supabase
   ```

6. 起動します。

   ```bash
   npm run dev   # http://localhost:3015
   ```

何が要るかは、試したいことで変わります。

- **サンプルのメールを試すだけ**なら、キーとして要るのは Supabase の 3 つの値だけです。サンプルは保存済みの読み取り結果を使うので、Claude と Resend のキーは要りません。ただし、アカウントを作ってログインするので、下の Auth の設定は要ります。
- **新規登録**には確認のメールが要ります。手元の Supabase にも、次の Auth の設定が要ります。値は `supabase/config.toml` と `supabase/templates/` にあります。`supabase config push` は本番を書き換える使い方になりやすいので勧めません。ダッシュボードの Authentication で入れてください。
  - 確認メールを有効にし、SMTP を設定します（`config.toml` は Resend の SMTP で、キーは `RESEND_SMTP_KEY` です）。
  - Site URL は `http://localhost:3015` にします。本番の値は写さないでください。
  - Redirect URLs に `http://localhost:3015/auth/confirm**` を入れます。
  - メールの文面を `supabase/templates/confirmation.html`（件名「Otodoke のメールアドレスの確認」）と `supabase/templates/recovery.html`（件名「Otodoke のパスワードの再設定」）に差し替えます。確認のリンクは `/auth/confirm` が `token_hash` を `verifyOtp` で検証するので、Supabase の既定の文面ではログインに進めません。
- **実際のメールの受信**には、Resend の受信の設定（受信ドメインと、`email.received` の webhook の送り先 `/api/inbound`）と、外から届く URL が要ります。`RESEND_API_KEY`、`RESEND_WEBHOOK_SECRET`、`INBOUND_DOMAIN` を入れます。読み取りには `ANTHROPIC_API_KEY` が要ります。

`npm test` は API を呼びません。`npm run eval` は Claude API を呼ぶので課金されます。`--max-usd` で上限を付けて流します。

## 持ち込んだデータ

`fixtures/demo/` のメール 17 通は、作者自身が受け取った実際の注文・配送メールから、氏名・住所・電話番号・メールアドレス・注文番号・追跡番号を差し替えたものです。2026-11-07 の匿名化では、さらに次を行いました。Message-ID を作り物に差し替え、送信時刻を分に丸め、Amazon の HTML メールにある「おすすめ商品」の欄を消し、追跡番号をチェックディジットの合わない値に替えました。イベント前から存在するデータの持ち込みとして、ここに明記します。コードはすべて期間中の新規制作です。

精度の評価には、同じ方法で匿名化した 341 通を手元で使っています。買い物の履歴そのものなので、公開するのは 17 通だけです。匿名化の手順は `scripts/anonymize.py`、結果の数字は `docs/eval-log.md` にあります。

## ライセンス

MIT

## Credits

- ロゴの文字は Poppins（SIL Open Font License 1.1）
- 説明動画（`public/guide/videos` の mp4 3 本）の声は AivisSpeech の「まお」（ACML 1.0）、曲は Mixkit（Mixkit Free License）です。動画の声と曲は MIT ライセンスの対象外です

## English overview

**Otodoke — stop planning your day around parcels.**
Demo video: <!-- DEMO_VIDEO_URL --> (coming soon)
Otodoke reads the order and shipping emails you already get from any Japanese online shop and turns them into one parcel calendar: what is coming and when, which days someone must be home (no 置き配), and how much you spent this month.
Set up mail forwarding once ([guide](https://otodoke.app/guide/forwarding)); nothing else is needed, even for shops you have never used.
Claude only makes judgments: it classifies each email and extracts fields, each with the source line as evidence and a confidence score. Unsure values are flagged, never asserted. Carrier detection and parcel matching are plain code.
Stored mail (subject, sender, body) is sealed in the server right after it is read, to a key only your password opens (ECDH P-256 + HKDF + AES-256-GCM). The browser turns the password into two values (PBKDF2-SHA256 salted with the address, then HKDF): a login secret, the only one sent to the server, and the key that wraps the private key, which never leaves the browser. The operator cannot read sealed mail from the database. Parcel data, the evidence lines (short excerpts of the body) and reading notes, sender domains, Message-IDs and Gmail's forwarding-approval links stay plaintext, and this is disclosed in the app. Mail waiting to be read stays unsealed until it is read; mail read before encryption started stays unsealed until you press 「暗号化する」 in settings. Unsealed mail stays in database backups for up to 7 days. Resend, which receives the mail, also keeps a copy for a while. The iOS app can keep the unlocked key in the device keychain behind Face ID / Touch ID; it never leaves the device, is not synced, and is removed on logout.
A free rule screen drops ads, Haiku checks only unclear mails, and daily caps are claimed in the database before every paid call. Haiku was chosen by measurement: it first matched 71/73 hand-labelled fields on the 17 demo mails (Opus 73/73), the misses were time-slot formats that the code now handles, and the latest run (2026-11-06) is 73/73 at about 1/20 of the cost. Mail types were also checked on all 341 of the author's anonymized mails (314/320). Reading those 341 mails (one year) with the production pipeline cost about $0.4.
The saved demo results were made with Opus 5.5 and then touched by hand: a category was set on all 17, and six reading notes were reworded in plain Japanese. For the public release, four tracking numbers (in 7 readings, value and evidence line) were swapped for made-up ones and one note about recommended products was removed.
Built with Claude Code during the event: CLAUDE.md as the repo contract, hooks that block force pushes, real-email commits and secrets, subagents for test-first work and review, Codex as a cross-reviewer, phone-width browser checks, and real-mail runs: the author's 341 mails went through the production pipeline, and an independent agent checked 46 of the 101 parcels against the original mails (errors 20/460 fields, 10/440 after fixes).
In the early hours of 2026-11-07, the day before the deadline, seven Claude Code sessions ran side by side (web UI, iOS app, forwarding guide, guide videos, demo video, pre- and post-release checks, integration review), and one more session coordinated them: it assigned the work, had the seams between the pieces cross-checked (for example, wording and settings that differed between web and iOS) and decided where each fix should go. Implementation went mostly to Sonnet subagents; review and design decisions stayed mostly with Opus. Once several sessions' work had piled up on `dev`, agents that had not written it reviewed the merged branch from separate angles (seams, production-only breakage, what a public repo must not contain) ahead of the release to `main`, and later fixes were re-checked by non-authors. Frames sampled from the guide and demo videos were read with OCR to check for personal data and tracking numbers, and the 17 demo mails were re-checked and further anonymized.
The voice (AivisSpeech, Mao, ACML 1.0) and music (Mixkit Free License) of the three guide videos in `public/guide/videos` are not covered by the MIT license.
Theme: 「あなたにしかない深さを。」 (the reading rules come from the author's own 341 order and shipping emails). First commit: 2026-11-02 17:19 JST. An iOS app (SwiftUI, iOS 17+, `ios/`) with the same password login and the four tabs is in internal TestFlight testing only.
Try it: create an account at https://otodoke.app with your email and a password (「アカウントを作る」), the page changes to 「確認のメールを送りました」; open the link in the confirmation mail (from noreply@otodoke.app; it can take a minute or two, so check the spam folder too) in another tab and press 「確認する」, and the first tab logs in by itself and lands on the first-run guide (/app/welcome); press 「あとで」, open 設定, and press 「サンプルのメールを読み込む」 (no real mail or API call needed). What to look at: the 17 mails become 6 parcels; a red mark shows the parcels that need someone at home; a parcel's detail shows the source line (evidence) only for parcels the mail itself spelled out, and 「メールに記載なし」 otherwise; the calendar shows the days you must be home in red; and the spending tab breaks the month down by shop and category.
If you get stuck: the password needs 10+ characters (no repeats, sequences like 1234, or common words); sign-up and login show a Cloudflare Turnstile check (tick it when the button asks; it then goes on by itself); 「メールを送り直す」 on the sign-up screen resends the confirmation; if you see 「回数が多いため、しばらく時間をおいてから、もう一度お試しください。」 wait a little and retry; and if the mail still does not arrive, write to support@otodoke.app.

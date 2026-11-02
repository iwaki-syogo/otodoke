# Otodoke — project guide for coding agents

Built with Claude: Japan 2026 の提出作品。期間は 2026-11-02 12:30 〜 11-08 20:00 JST。
一文で言うと「注文メールを転送するだけで、何がいつ届くか・いつ家にいればいいか・今月いくら使ったかが分かる荷物カレンダー」。

## 守ること（ハッカソン規定由来）

- コードはすべて期間中の新規制作。既存プロジェクトのコードを持ち込まない（参照して書き直すのも避ける）
- このリポジトリは **公開**。個人情報・鍵・実メールを入れない
  - 実メールは `fixtures/raw/`（git-ignored）にだけ置く。コミットするのは `fixtures/anonymized/` の匿名化版のみ
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
- Supabase（Postgres + Auth マジックリンク）、Resend（受信 webhook `email.received` と送信）、Claude API、Vercel
- dev: `npm run dev`（port 3015）、lint: `npm run lint`、typecheck: `npm run typecheck`、build: `npm run build`
- Server Action のファイル（`"use server"`）からは async 関数と型だけを export する

## ディレクトリ

- `src/app/` 画面と Route Handler（受信 webhook は `src/app/api/inbound/`）
- `src/lib/extract/` Claude によるメール判定・構造化（スキーマは zod）
- `src/lib/match/` 荷物への名寄せ、`src/lib/carriers/` 追跡番号→運送会社のルール
- `fixtures/anonymized/` 評価セット（匿名化メール + 期待値）、`fixtures/raw/` 実メール（git-ignored）
- `docs/` 期間中の作業記録（Claude をどう使ったか、評価セットの一致率の推移）

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
- Vercel: project=`otodoke-app`, team=`syodgo-9062s-projects`, production_url=https://otodoke.app（独自ドメイン。Vercel で取得、更新 $15/年）／ https://otodoke-app.vercel.app（GitHub 連携済み: main への push で本番デプロイ）
- Resend: 受信ドメイン=`in.otodoke.app`（予定。MX は Vercel DNS に置く）, 送信ドメイン=`otodoke.app`（予定）
- Anthropic: Claude API（個人組織。キーは `.env.local` のみ）

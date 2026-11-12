<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project guidance

Read `CLAUDE.md` at the repository root first. It is the source of truth for this
project's rules (hackathon constraints, what must never be committed, how Claude is
used in the product) and applies to every coding agent working here.


<!-- BEGIN:agent-pointer -->

## エージェント共通の要点

`CLAUDE.md` 冒頭の「エージェント共通の要点」と本文を読む。公開repoで秘密・実メールを扱わず、仕様・計画・報告はrepo外へ置く。iOS用のparcels UPDATE権限と本人/lease/世代/更新版の検証を保つ。

DBはU→G→E→C→L→Rの部分順序。候補鍵はprivateな `public.lock_parcel_owner(p_user uuid)` に統一し、owner不明を固定キーへ倒さない。mark/restoreはU/G/E後・R前、mail coreは本人/run/lease確認後に呼ぶ。130000のdownもhelperを保ち、130000 → 121000 → 120000 → 110000 → 100000 → 090000 → 181000 → 180000で戻す（120000・121000のdownは130000が残っていれば55000で止まる）。before/verifyはABI・owner・ACLを確認する。

undoはDB証跡と現在のreceived_at/updated_atで照合し、3結果を分ける。通信200件と論理全件を混同しない。verifyはファイル別の判定列を読み、自己試験と実SQL測定を区別する。全件vitestは負荷20未満で1プロセス、専用PGは停止・listener0・専用データ削除まで確認する。

<!-- END:agent-pointer -->

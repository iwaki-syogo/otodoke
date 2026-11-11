# 費用・受信量・処理の所有権の DB 試験

PostgreSQL 17 の `initdb`・`pg_ctl`・`psql` と Node.js を使う、外部サービスへの接続がない試験です。実行時に作る一時 DB だけを対象にします。接続 URL を受け取る引数はありません。

台本は自分で `LC_ALL=C` / `LANG=C` を設定します。日本語ロケールでも、エラー文（`permission denied` など）の判定が狂いません。

PostgreSQL 17 の実行ファイルを PATH に置き、リポジトリ直下で実行します。別の場所に置く場合は、`OTODOKE_PG_BINDIR` に実行ファイルのあるディレクトリを指定できます。

```sh
node tests/postgres/run-cost-guards.mjs --self-test
node tests/postgres/run-cost-guards.mjs
node tests/postgres/run-cost-guards.mjs --negative-control
```

`--self-test` は DB を起動しません。verdict が無い出力、FAILED、終了コード 0 の SQL エラー、異常終了、タイムアウトを試験台本が成功扱いしないことと、migration 選別の前後の境界を確かめます。

引数なしの実行は、`.vitest/pg/` の新しい一時ディレクトリにデータを作り、127.0.0.1 の専用ポート 65440 だけで待ち受けます。このポートが既に使われていたら開始しません。Unix ソケットも `.vitest/pg/` に置きます。終了時と SIGINT・SIGTERM 時は、そのデータディレクトリのサーバーを止め、待ち受けが無くなったことを確かめます。調査用のデータとログは git-ignored の `.vitest/pg/` に残します。

DB の準備では `bootstrap.sql` が Supabase の `auth.users`・`auth.uid()`・3 つのロールだけを作ります。アプリのテーブルと関数は、対象の `20261113090000_claude_call_global_lock.sql` より前の本物の migration をすべて順に適用します。統合後の枝に直し (C) の `20261112180000` があれば、それも対象より先に読み込みます。対象自身と後続の migration は準備から除外します。Homebrew の標準 PostgreSQL に同梱されない pg_cron を使う `20261106180000_screen_events_daily_purge.sql` だけは、対象外として明示的にスキップします。したがって、この試験で cron・Supabase Auth・PostgREST の実物が確認されたとは扱いません。

新 migration の before verify、2 回適用、verify を実行してから、次の挙動を確かめます。

- S1: 全体残り 1 枠、別利用者・同じ利用者、新規行・既存行、v1・v2・混在をそれぞれ 10 回。各回 4 要求を同時に動かし、成功がちょうど 1 件、全体合計が上限どおりかを確認します。
- S1: 個人上限 0 の新規行、個人上限到達時の拒否が全体枠を使わないこと。release と取得の競合、同じ claim の同時 release をそれぞれ 10 回確認します。
- I2: 個人・全体の件数と UTF-8 バイト数の同時上限、Claude 上限到達中の継続受信、繰り返した拒否でメール本文や通知行が増え続けないこと、読み取り完了後の受信再開、通知を本人だけが読んで消せることを確認します。
- I3: 作成から 181 秒相当でも有効な lease を奪えないこと、先行結果が残ること、失効後の回収、古い実行 ID による emails・extractions・parcels・parcel_items の変更と Claude 枠の取得拒否、現在の実行 ID の更新と枠取得、日時フィルタの UTC 表記を確認します。
- 既存の荷物統合が渡す `status` と `received_at` を gateway 経由で更新し、受け取り時刻の実保存値を確認します。未知の列を渡す変更は引き続き拒否されることも確認します。
- anon・authenticated によるサーバー用関数の実行拒否と、service_role による枠取得・通知更新を確認します。
- 最後に rollback を 2 回実行し、旧 release の verify、新 migration の再適用と verify を確認します。

並列試験は、各 worker が独立した共有 advisory lock の入口で待っていることを `pg_stat_activity` で確認してから、同時に解放します。さらにカウンタ書き込み前の試験用 trigger で 80ms 待たせ、旧版の「合計を読んでから加算する」隙間を広げます。修正版では日単位のロックの内側で待つので、この遅延が上限を破ることはありません。

`--negative-control` は一時 DB にだけ既存 migration から旧 v1・v2・release 関数を戻して、同じ試験を実行します。最初の競合試験が失敗し、終了コード 1 と `verdict=FAILED` を出すのが期待値です。作業ツリーのソースは変えません。

通常試験の成功条件は最後の `verdict=OK` と終了コード 0 の両方です。verify ファイルは最終行の第 1 列が `OK` であることまで確認します。SQL エラーや出力の欠落は成功扱いしません。

2026-11-12: この台本を作った環境では、指定された mmap 設定でも initdb の `shmget` が sandbox に拒否されました。実 PostgreSQL での SQL・並列挙動・rollback・停止処理と陰性対照は未実測です。構文検査と `--self-test` だけを実行済みです。実測は Claude 側で流します。

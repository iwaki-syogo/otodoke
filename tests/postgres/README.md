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

通常試験の成功条件は最後の `verdict=OK` と終了コード 0 の両方です。verify の出力は、共有の `run-cost-guards.mjs` に定義したファイル別の形式で確認します。110000 の after verify は第 8 列、それ以外は各ファイルの指定した判定列を読みます。列数、必須の真偽値、件数、動作試験の結果も照合し、別の列にある `OK` では代用しません。SQL エラーや出力の欠落は成功扱いしません。

2026-11-12: この台本を作った環境では、指定された mmap 設定でも initdb の `shmget` が sandbox に拒否されました。実 PostgreSQL での SQL・並列挙動・rollback・停止処理と陰性対照は未実測です。構文検査と `--self-test` だけを実行済みです。実測は Claude 側で流します。

## サンプル全消去と荷物 RPC のロック順

`run-sample-lock-order.mjs` は、別途用意した PostgreSQL 17 の使い捨てテスト cluster に、自分専用の新しい DB を作ります。接続先は `127.0.0.1` に固定し、`listen_addresses` も `127.0.0.1` であることを確認します。URL・host・既存 DB 名を渡す入口はありません。テスト専用ポートを `OTODOKE_SAMPLE_PG_PORT`、必要なら PostgreSQL の実行ファイルのディレクトリを `OTODOKE_PG_BINDIR` に設定して実行してください。cluster の `anon`・`authenticated`・`service_role` は準備側で作っておきます。この runner は cluster 全体のロールを変更しません。

```sh
node tests/postgres/run-sample-lock-order.mjs --self-test
node tests/postgres/run-sample-lock-order.mjs --external-test-server --controls-only
node tests/postgres/run-sample-lock-order.mjs --external-test-server
node tests/postgres/run-sample-lock-order.mjs --external-test-server --negative-control
```

`--self-test` は DB に接続せず、集計・SQLSTATE の分類・旧 RPC の取り出しを検査します。実際の子プロセスでも、終了コード 0 の SQL エラー・異常終了・タイムアウトが成功にならないことを確かめます。`--controls-only` は単独の実 query と消去後の挙動だけを試す smoke で、自然競合は未実行と明示します。

各実行の新 DB には `bootstrap.sql` の Auth substrate と、`20261113110000_sample_generation.sql` までの本物の migration を順番に適用します。cluster 共通ロールの作成と pg_cron 専用 migration だけを除外します。外部の Auth・PostgREST・cron・TypeScript pipeline を実行する試験ではありません。

通常実行は **360試行・1,440操作**です。各試行で、同一利用者の「全消去・発送の新規作成・発送への更新・配達完了への更新」を4つの独立した接続で同時に動かします。実メール扱いと sample generation header 付きの合成メールを交互に使うので、それぞれ180試行です。各種類360試行に増やす場合は次のように実行できます。

```sh
OTODOKE_SAMPLE_LOCK_ROUNDS=720 node tests/postgres/run-sample-lock-order.mjs --external-test-server
```

4 worker 全員が開始用の共有 gate で待っていることを `pg_stat_activity` で確認してから解放します。実 RPC が取ったロックの保持期間を観測するため、RPC 後の commit だけを30ms遅らせます。本番ロックを別の順序で先取する処理は、通常試験にはありません。開始 gate とは別に、worker 同士が実際の production lock で待つ状態も観測します。同じ cluster の別 DB で動く runner の activity は集計に含めません。

各試行は4つすべての応答を回収し、全消去の完了、対象利用者の荷物・メールの復活0、別利用者の荷物・世代の不変を確認して初めて完了数に加えます。先に実 RPC の単独 control を5件実行し、さらに全消去後の旧 lease 拒否6件と、実 `store_mail_run` による新着受信2件・新しい荷物の作成2件を確認します。これらの control は自然競合の1,440操作とは別集計です。

`SUMMARY` は `ok`・候補の `retry`・消去済み lease/generation の限定的な拒否・`40P01`・他 SQL エラー・タイムアウト・結果欠落を区別します。`42501` は lease 所有権喪失の文、`55000` は sample の世代喪失の文を持つ場合だけ、メール側の既知の拒否と認めます。権限不足や syntax error を同じ拒否として扱いません。タイムアウトや結果未着は成功試行数に加えず、未完了数と失敗種別を残して失敗します。通常試験は指定試行数・4倍の終端応答・実ロックの競合観測がそろい、`40P01` と他の異常が0で、最後に `verdict=OK` と終了コード0が出ることが成功条件です。

`--negative-control` はソースを書き換えず、専用 DB にだけ元の `100000` の create/update/ensure 本体を戻します。全消去側は実 `lock_sample_owner` で owner/auth 行→generation の前段を取り、旧 writer が実 `62803` を保持したままその generation 行を待つことを `pg_locks`・`pg_blocking_pids` で確認してから、実 `clear_all_parcels` を進めます。cascade 対策の前段を飛ばしたり、無関係なロックで別の deadlock を作ったりしません。3経路それぞれで SQLSTATE `40P01` が1件、残る1接続が正常完了し、他の異常が0であることを確認します。この mode の終了コード0／`verdict=OK` は、旧順序の異常を検出できたという意味です。修正版の正常性を示す自然競合試験とは分けて報告します。

`SUMMARY` の `target_sha256` は実際に DB へ適用した `110000` の内容、陰性対照の `negative_source_sha256` は差し戻した `100000` の内容を示します。試験後のファイルを読み直した hash ではありません。

継承した `PG*` 環境変数は除外し、パスワード・service 設定は新しい scratch の存在しない専用ファイルに向けます。終了・割り込み時に閉じるのは自分の `psql` 接続だけです。外部テスト cluster は停止せず、専用 DB と `.vitest/pg/sample-lock-*/summary.json` を調査用に残します。cluster・データ・ログの最終削除は準備側が行ってください。既存の `run-parcel-conflicts.mjs` の単一列結果の `row_to_json` 修正は変更していません。

## 許可待ちメールの個人枠と期限

`run-consent-waiting-storage.mjs` は、新しい専用 PostgreSQL 17 cluster を `127.0.0.1:65442` に作る台本です。既存プロセスの停止や外部 DB への接続はしません。基点 `18031c4` の実 migration を `110000` まで順に読み、`120000` の before・二度適用・verify・挙動・rollback 二度・前の関数本体の完全一致・再適用を検査します。

```sh
node tests/postgres/run-consent-waiting-storage.mjs --self-test
node tests/postgres/run-consent-waiting-storage.mjs --baseline
node tests/postgres/run-consent-waiting-storage.mjs
node tests/postgres/run-consent-waiting-storage.mjs --negative-control
```

`--baseline` は `120000` を入れず、`--negative-control` は `120000` を入れた後に保存した旧 storage core だけを専用 DB 内へ戻します。どちらも、全体の枠が 1 通のとき、同じ未回答者の 2 通目が受信できる試験で、終了コード 1・`verdict=FAILED` になるのが期待値です。同じ回帰試験を通常版では通します。ソースやほかの worktree は書き換えません。

通常版は未回答・拒否の個人通数/UTF-8 容量上限、許可済みの全体上限、拒否通知の 1 人 1 行、到着時刻と期限の不変、取り消し時の既存メールへの期限付与、期限切れ takeover と古い snapshot、抽出結果がある行の本文だけの消去と再送防止、読み取り中の lease の保持、既存の screen_events 掃除の継続を確認します。掃除・全消去・新着受信・取り消しの同時操作も流し、SQL エラー・deadlock・タイムアウトを成功扱いしません。

期限定数の正本は `public.ai_consent_waiting_retention()` だけです。既存の `emails.received_at` は最初の受信日時のままで、再読取で変わる `created_at` を保管期限に使いません。許可を変えても、読み取り前は最初の期限を保ちます。結果をすでに保存した行は、外部キーの参照を保つため `dropped`・`discarded` の本文を持たない行として残します。期限で物理削除された行に同じ provider 配信が来れば、新しい受信として扱う境界があります。古い再読取 snapshot は、アプリの再読取 fence と DB の expected-created-at の両方で止めます。

Auth は `bootstrap.sql`、cron は既存の domain/purge 関数本体と小さなローカル schedule 表で近似します。schedule が既定の毎日であることは before/verify で検査しますが、pg_cron 自体・本物の Auth・PostgREST は実測しません。台本の終了・失敗・割り込み時は、専用サーバーの停止、待ち受け 0、専用データの削除までが後処理です。

2026-11-12: この Codex 環境は、既存台本で mmap 設定を付けても `initdb` の `shmget` が sandbox に拒否されることが確認済みです。再試行や別経路での回避は行わず、今回は構文検査と `--self-test`、静的契約の RED/GREEN/陰性対照だけを実行しました。上の PostgreSQL 挙動・並列競合・migration/rollback・SQL 陰性対照は、実行できるローカル環境での確認が残っています。

## 有料呼び出しごとの許可確認

`run-claude-claim-consent.mjs` は `127.0.0.1:65443` の新しい専用 cluster に、本物の migration を `120000` まで適用してから、`121000` の before・二度適用・verify・挙動・rollback 二度・前の関数本体の完全一致・再適用を検査します。Auth と cron の近似、継承した接続設定の除去は上の許可待ち台本と同じです。

```sh
node tests/postgres/run-claude-claim-consent.mjs --self-test
node tests/postgres/run-claude-claim-consent.mjs --baseline
node tests/postgres/run-claude-claim-consent.mjs
node tests/postgres/run-claude-claim-consent.mjs --negative-control
node tests/postgres/run-claude-claim-consent.mjs --negative-lock
```

`--baseline` は `121000` を入れず、`--negative-control` は専用 DB の許可検査 helper だけを空にします。どちらも未回答者の最初の claim を拒否する同じ試験で終了コード 1・`verdict=FAILED` が期待値です。`--negative-lock` は判定を保ったまま `FOR SHARE` だけを外します。通常の取り消しとの競合だけでは、先に取る世代 G が直列化し、C のロックが無くても通り得ます。そのため、台本には C だけを `FOR UPDATE` で保持し、その後 U/G を取らない観測用接続を別に置き、claim が実際の consent 行で待つことを `pg_blocking_pids` で確かめる試験があります。ロックを外した版は、この観測試験で終了コード 1・`verdict=FAILED` になります。

通常版は、未回答・拒否の standalone v1/v2 と owned v1/v2 の全入口で counter/ledger が増えないこと、既存の個人/全体の上限、取り消した後の一度だけの release、helper/private core の実行権限、null 引数・権限障害・本物の SQL 障害を専用の許可拒否と区別することを確認します。SQL の確認不能を未回答扱いにはしません。取り消しと claim、全消去・backlog と owned claim、退会と standalone/owned claim の並列操作も流し、成功した claim の数と課金回数が一致すること、退会しても全体の使用量が失われないことを検査します。

ロックは standalone U→G→C→有料日の advisory、owned U→G→E→C→有料日の advisory です。v2 の保存済み core が public v1 を呼ぶときは U/G/C の再入です。release は従来の U→有料日の advisory のまま、許可を要求しません。取り消しと claim の順を同じ短い DB transaction で決め、成功した claim の commit 後に始まる外部 HTTP の間までロックを持ち出しません。

台本は終了・失敗・割り込み時に専用 PG を止め、待ち受け 0 を確かめて専用データを削除します。2026-11-12 の Codex 環境では、既知の `shmget` 拒否を再試行・回避せず、構文検査・`--self-test` とソース契約試験だけを実行しました。実 SQL・並列操作・rollback と SQL 陰性対照は未実行です。

## 受取の証跡と取り消し（130000）

```sh
node tests/postgres/run-received-receipts.mjs --self-test
node tests/postgres/run-received-receipts.mjs
node tests/postgres/run-received-receipts.mjs --negative-control
```

通常・陰性対照は専用 `127.0.0.1:65444` に Postgres 17 の使い捨て cluster を作ります。接続文字列や外部 cluster を指定する入口はありません。今回より前の実 migration を版順に適用し（pg_cronのスケジュールだけ明示skip）、before → 130000を2回適用 → verify → 動作確認 → downを2回 → 110000 verify → 再適用 verifyを実行します。既存parcel表のSupabase基盤grantだけをbootstrapで再現し、新journal/RPCの権限は実migrationのまま確認します。

beforeと本体は110000・120000・121000の実適用履歴と関数を前提にします。台本は各migrationが実際に適用成功した後だけ履歴を記録し、前提を1本ずつ欠落させた場合の無変更拒否も確認します。

動作確認は、別transactionのメール前後・空patchから証拠保存前のundo、本人/receipt_id/版の照合、二重undo、G待機中のjournal置換、501/1,001件の全件分割、過大なraw要求のlock前拒否、保存破棄時の巻き戻し、24時間固定の期限と再送による非延長・期限後の無変更拒否・既存daily purgeによる物理削除と先行の許可待ち掃除の継続、RLS/ACL/search_path、全消去/退会と5workerの自然競合です。`OTODOKE_RECEIPT_PG_ROUNDS` は2〜100、既定10回。実ロック待機を観測し、予期しないSQLSTATE・deadlock・timeout・結果欠落を成功に数えません。`now()`が1transactionで進むと仮定しません。

陰性対照は、旧client statusによる実PATCHと、本物の旧private mail coreの空patchを使い、配達完了が発送済みに戻る要件違反を検出した場合だけ成功します。このmodeの `verdict=OK` は、旧経路の不具合を検出できた意味です。

このrunnerは、自分のclusterの停止 → listener 0 → 作成した専用データ/ログの削除に成功した後に、最終 `verdict=OK` を出します。既存ポートのプロセスは停止しません。中断やエラー時も同じ後片付けを通ります。先の調査用ログ保持型のrunnerとは終了条件が異なります。

作成環境では実Postgresを起動せず、`node --check` と `--self-test` だけを実行しています。自己試験は結果パーサー・SQLSTATE判定・PG環境分離・子プロセス異常を確認するもので、実DDL・時間差・並列・停止/削除を実測した証拠ではありません。実測はまとめ役が行い、統合SHAと出力を記録します。

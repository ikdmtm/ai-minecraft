# T02: 実走記録と再開時の証拠

対象は gameplay-only runtime。方針・基本操作・手順学習・記憶スキーマを変えず、実走条件と実行結果を記録する。

## 起動と保存先

```sh
npm run start:gameplay
```

このコマンドは記録用の親プロセスを起動し、従来の `jevMain.ts` を子プロセスで実行する。モデルや資格情報は従来どおり `.env` から引き継ぐ。記録のための新しい外部サービスやLLM呼出しはない。

実行ごとに `data/gameplay-runs/<run_id>/` が作られる。`GAMEPLAY_RUN_DIR` で親ディレクトリを変更できる。

| ファイル | 内容 |
| --- | --- |
| `manifest.json` | コードSHAと未コミット変更の有無、要求したモデル/接続設定、実際のprovider/model・ゲームversion・world ID・experience session ID、seedの出所、開始/終了、終了理由、件数 |
| `events.jsonl` | stdout/stderrから受け取ったJSONイベント。全行にrun_id、単調増加sequence、received_at、streamを付加。非JSON行もprocess_outputとして保存 |
| `memory-start.sqlite` | 実行開始前のDBの控え。元DBが存在する場合のみ。SQLite backupを用い、コミット済みWALを含める |
| `knowledge-start.json` | 開始時の知識exportの控え。存在する場合のみ。SHA-256とversionをmanifestへ記録 |

開始時の記憶DBとknowledge exportはユーザーのローカル保存物であり、Gitへアップロードしない。データには過去の経験も含まれるので、フォルダーを公開する前に内容を確認する。フォルダー/ファイルの作成モードは700/600。

`dev:gameplay` と `jevMain.ts` の直接起動は記録ラッパーを通さない開発用経路のまま。正式な実走比較には `start:gameplay` を使う。

## 記録を正確に読む

- `requested` は要求した設定。`effective_policy` と `runtime` は子プロセスが実際に初期化した情報。初期化前に失敗した場合は後者がないまま残る。
- `seed` は `GAMEPLAY_SEED` の明示ラベル、またはローカル接続時のserver.propertiesから取得。空欄/リモートで不明ならnull。**level.dat照合はしていないためverified=false**であり、設定値を実ワールドのseedだと断定しない。
- `code.dirty=true` の実走は、そのSHAだけでは完全再現できない。差分のハッシュは保存するが、未コミット/未追跡ソースの自動収集はしない。
- `memory-start.sqlite` は比較・調査用の控え。実走は従来のDB_PATHを使い続け、経験を蓄積する。開始時の控えを元DBへ自動復元しない。別プロセスによる同時書込みを禁止/監視する機能ではない。
- 受信順sequenceは複数ストリームを統合した順序であり、stdout/stderrのOSレベルでの厳密な発生順序を保証するものではない。元イベントのtsも残す。

## 停止とクラッシュ

親プロセスはSIGINT/SIGTERMをゲーム子プロセスへ転送し、後処理を待つ。10秒で終了しなければ子プロセスグループを強制停止し、forced_after_signalとして記録する。子の終了コード/シグナルと、ゲーム自身が報告したshutdown理由を別々に記録する。

`clean_shutdown` は終了処理が整合して完了した意味であり、Hardcoreの生存成功を意味しない。死亡後の正常な終了処理ではreason=death、clean_shutdown=trueになり得る。

子プロセスが異常終了しても親が動いていれば終了結果を保存する。親ごとSIGKILLされた場合、OS停止、ストレージ障害では最終記録を保証できない。**manifestがpreparing/runningのままなら「まだ実行中、または終了記録のない中断」であり、成功と扱わない。** 明示的な最終checkpointと約2秒ごとのcheckpointで、直前までの条件とイベントを残す。書込み失敗を検知した場合は記録のない実走を続けず、ゲーム子を停止させる。

再開時は新しいrun_idを発行する。元DBとworld markerを残す限り、既存の世界/経験は既存runtimeの規則で再利用される。過去のmanifestやログを上書きしない。自動的なワールド巻戻しや、同じ操作列の再現はこのタスクの対象外。

## 証拠・待機・失敗の区別

`task_started` は操作/knowledge query/offset/procedure ID/name/evidence IDsを記録する。
`operation_evidence` はSQLiteに保存した証拠ID・experience session ID・元world/version/dimension・操作・成功/失敗/割込み・効果確認・前後の変化を記録する。これらをrun_idとtask_idで検索できる。RUN_PROCEDUREの内部操作も同じtask_idの下へ出る。LLMの遅延/失敗とSafety割込みは既存イベントをそのまま統合する。

stateの `intentional_wait` は既存runtimeが「実行中の待機」としているかを示す。manifestの `intentional_wait_samples` はその**観測サンプル数**であり、待機秒数ではない。`no_progress_events` は明示的な無進捗アラートの件数。これらを混同して待機そのものを失敗扱いしない。重複するgame_eventでは無進捗件数を増やさない。

## 秘密情報

環境変数全体は保存しない。ログ中のcredential系キー、既知の秘密環境変数値（平文・URLエンコード・JSONエスケープ）、Bearer値を伏せる。任意の文章に埋め込まれた未知の秘密を完全に検出する保証ではない。元DBやknowledge snapshotは意味を変えずコピーするため、ログの伏せ字処理の対象ではない。

## 検証とこの作業の区切り

- T01の最終head `f5c9d3c` のrun `35430757373`は両job成功を確認。PR #1を `73379eb38de74bdac8eff5c4d57bc56b4e860d75` で取り込み、これをT02の基準とした。
- 作業ブランチ: `feat/t02-run-recording`。
- 新規テスト: `src/gameplay/runRecorder.test.ts`。一時DBと短いfixture子プロセスのみを使用し、LLM呼出しやユーザーのMinecraftワールドは使用しない。
- テスト範囲: 独立run ID、未終了状態、DBなし、WAL backup、壊れたDB、知識/seedの出所、秘密伏せ字、イベント相関、待機/無進捗、異常終了、分割UTF-8/末尾改行なし、起動失敗、シグナル転送、出力失敗。
- この文書の作成時点では実装済み・CI結果未確認。対応PRの**最新headのCI**に実際の検証結果を記録する。文書の存在だけで検証済みとしない。
- 今回は自律Hardcore実走、モデルの賢さ、世界変更時の経験転用を評価しない。次の単独タスクはT03a（CRAFT/USEの実サーバー検証）。新しい記録形式を使ったLLM実走比較はT07で行う。

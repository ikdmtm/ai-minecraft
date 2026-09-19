# Minecraft 自律エージェント：設計契約・タスク・再開地点

更新日: 2026-09-19 / 対象: gameplay-only runtime

この文書は作業の再開地点を管理する。実装の説明は [GAMEPLAY_AUTONOMY.md](GAMEPLAY_AUTONOMY.md) を参照する。チャットの終了やツールの失敗を、コード変更の消失・完了・未着手の証拠にしない。再開時は必ず Git とテスト結果を確認する。

## 1. ユーザーと合意した設計

- AI_Rei が Minecraft Java Edition / Hardcore の世界で、自分で目標と方法を考えて生活する。長期生存が目的だが、永久に隠れることだけを最適化しない。
- 人間が与えるのはゲーム仕様、観測、基本操作のインターフェース、実行上の制約。狩猟・調理・建築などの攻略手順や順番を固定しない。
- 「今は生存に不要」という人間側の判断で、装飾・工作などの合法な操作を禁止しない。利用条件と結果を提示し、選択はエージェントに任せる。
- 仕様はバージョンを明示して参照可能にする。すべてを毎回プロンプトに詰め込まず、必要な情報を検索できるようにする。不明な仕様を推測値で埋めて既知扱いしない。
- 経験を保存し、成功した操作列をエージェント自身が再利用可能な手順にできるようにする。外部記憶・手順の再利用とモデルの重み学習は区別する。
- ワールドを跨いでも同じ AI の経験を保持する。再起動や死亡のたびに初学者へ戻さない。ただし前の世界の座標を新しい世界の現在地図として使わない。
- 配信、TTS、アバター、旧 production pipeline は今回の改修対象外。実行中ワールドのリセットや保存データ削除を、テストの都合で行わない。

## 2. 設計の責務境界

| 層 | 責務 | 持たせない責務 |
| --- | --- | --- |
| ゲーム仕様 | アイテム・ブロック・エンティティ・レシピ・ウィンドウ等の事実と出典バージョン | 「最初に木を切れ」などの攻略方針 |
| 観測 / World Model | 現在の身体、見える対象、空間、スロット、観測時刻。未ロードと空気を区別 | 見ていない対象の存在や到達可能性の断定 |
| Planner / Executive | 自分の目標、必要な情報の検索、操作の組合せ、結果に応じた再計画 | 操作アダプターの内部への無制限なコード注入 |
| 基本操作アダプター | 移動、見る、壊す、置く、攻撃、装備、使う、操作、開閉、移送、クラフト、待機 | 不足素材の自動調達、調理手順の自動選択、家の固定テンプレート強制 |
| 記憶 / 手順 | 観測・実行証拠・仮説・再利用手順の保持、検索、検証状態の更新 | 一度の失敗から永久禁止を作る、過去の座標を無条件に転用する |
| 安全・実行制約 | 即応すべき危険への割込み、無効操作・身体衝突・古いウィンドウ等の拒否 | 一般的な行動優先順位や日課の固定 |

基本操作に対する API アダプターは必要だが、行動の目的ごとにコードを増やす設計には戻さない。アダプターが未対応のゲーム機構まで自動で実行できる、とも主張しない。

### 記憶の扱い

1. **現在の作業状態**: 現在の目標、進行中操作、開いているウィンドウ。世界変更時に破棄・再観測する。
2. **世界固有の観測**: 世界ID・必要に応じたディメンション・時刻・確度を持つ。前の世界の記録は履歴として保持し、新世界のナビゲーションから除外する。
3. **経験の証拠**: 操作、前後状態、成功・失敗・割込み、バージョン、元の世界を保存する。モデルの解釈と実際の観測を混ぜない。
4. **転用可能な手順・教訓**: 証拠に紐付ける。座標・entity ID・window ID は現在世界で再解決する。環境差や反証で再評価し、必要なら改訂・降格する。

過去の出来事を覚えていることと、同じ資源・建物が今も存在することは別。履歴の保存と、毎回取り出す作業記憶の量も分離する。

## 3. T00で確認した基準点（履歴）

- 実装の基準コミット: [`68c6a0478893072a76d5c84083e1b0b1fe60f23c`](https://github.com/ikdmtm/ai-minecraft/commit/68c6a0478893072a76d5c84083e1b0b1fe60f23c)
- 作業対象ブランチ: `revive/gameplay-first-jev`
- 確認した CI: [run 35428912575](https://github.com/ikdmtm/ai-minecraft/actions/runs/35428912575)、job `105859752118`
- CI は親 `820f59e7284e8fda3caa4caa8928026520d23079` 上で移行パッチを適用し、検証後の変更を `68c6a04` として push した。`68c6a04` に対する通常の独立した CI run が確認できた、という意味ではない。

ログで確認できた結果:

| 検証 | 結果 | 証明する範囲 |
| --- | --- | --- |
| `npm run lint` / `npm run build` | 成功 | 当該検証時点の型整合性・コンパイル |
| `npm test` | 42 suites / 567 tests 成功 | 旧機能も含むリポジトリ全体の既存自動テスト |
| `python3 scripts/test-export-knowledge.py` | 4 tests 成功 | 仕様エクスポートの既存テスト |
| Minecraft 1.21.4 disposable-world smoke | `REAL_SERVER_SMOKE_PASSED` | 用意した fixture での place/open/transfer/process-output/close/equip/break/move/pickup |
| LLM による初日からの自律 Hardcore プレイ | この監査では証拠未確認 | 上記の成功を自律生存の成功に読み替えない |

現在のコードと文書には、基本操作の構造化インターフェース、仕様検索、SQLite 永続化、実行証拠からの手順保存・再生がある。手順は candidate/verified を区別している。これらを未実装として一から書き直さない。

実装文書に記載された制限: JEV 経路は choice-only の互換経路で、自由な操作引数・手順保存/再生の全面対応ではない。vanilla JAR の知識 export は custom datapack を含まない。包括的な長期記憶整理と、自律的な長期生存は未検証。

### T00で見つかったCIの問題とT01の対応

基準コミットの `.github/workflows/gameplay-ci.yml` は一回限りのパッチ適用と自動 commit/push を実行する構成だった。一方、その run の最後に `scripts/.autonomy-update` は削除されていたため、次の通常 push では適用ステップが失敗する見込みだった。

T01ではこの処理を検証専用CIへ置換した。[PR #1](https://github.com/ikdmtm/ai-minecraft/pull/1) の最終head `f5c9d3c` のrun `35430757373`も両job成功を確認し、T02着手時に `73379eb38de74bdac8eff5c4d57bc56b4e860d75` で取り込み済み。

## 4. 作業単位と完了条件

原則 **1回の実装作業 = 1タスク = 1つの検証可能な成果**。目安は1～3個の実装ファイルと関連テスト。範囲を超える場合は追加実装を始める前に分割する。関連しない問題は発見内容だけを残し、同じタスクへ取り込まない。

ステータス:

- `TODO`: 未着手。
- `READY`: 前提が揃い、次に取り掛かれる。
- `IN_PROGRESS`: この作業単位だけを変更中。
- `IMPLEMENTED`: コードはあるが必須検証が残る。
- `VERIFIED`: 明記した検証範囲で完了。実走検証が未完なら別途記す。
- `BLOCKED`: 必要な前提・証拠がない。理由と再開条件を明記する。

| ID | 作業単位 | 状態 | 依存 | 完了の証拠 |
| --- | --- | --- | --- | --- |
| T00 | 現状監査・設計契約・タスク分割 | VERIFIED（文書・監査のみ） | なし | この文書、固定した基準SHA、読んだCIログ |
| T01 | 一回限りの移行CIを通常の検証専用CIへ置換 | VERIFIED・取り込み済み | T00 | run 35430600966 / 35430757373、merge 73379eb |
| T02 | 自律実走の記録・停止・再開の形式を固定 | IMPLEMENTED（PR #2の最新CIを確認） | T01 | [T02記録](T02_RUN_RECORDING.md)、runRecorder.test.ts、対応PRのCI |
| T03 | 基本操作の未検証箇所を1操作ずつ検証 | T03a/T03b VERIFIED / T03c READY | T01 | 対象操作の失敗再現・修正・回帰テスト |
| T04 | ワールド変更・再起動での記憶分離を検証 | TODO | T01 | 同seed別world、再起動、dimension等の検証結果 |
| T05 | LLM自身による手順保存と別環境再利用を検証 | TODO | T02・T03・T04 | 保存元証拠、再bind、再実行結果、失敗時更新 |
| T06 | 記憶の関連検索と整理を小さく追加 | TODO | T04 | 原記録保持、検索上限、反証・要約のテスト |
| T07 | 自律プレイを段階的に評価 | TODO | T02。T05/T06は比較条件として記録 | 固定条件の実走レポート。未達も結果として残す |

T03～T06は一括実装しない。以下の子タスクを独立した作業単位にする。既存テストで条件を満たす箇所は、その証拠を記録して終了し、不要な書換えをしない。

### T01: 検証専用CI

変更対象は基本的に `.github/workflows/gameplay-ci.yml` と作業記録だけ。

パッチ復元、ソース改変、git commit/push、contents:write を撤去し、通常の checkout → install → typecheck/build → unit/export tests → 必要な adapter smoke にする。開発ブランチ/PR/手動実行のどこで走るかを明示する。fixture は一時ディレクトリを使い、LLM の有料呼出し・ユーザーの既存ワールド変更は行わない。

完了条件: 通常のソースチェックアウトだけで実行できる。少なくとも新しい1コミットで成功を確認する。GitHubの権限設定変更やbranch protection変更はこのタスクに含めない。

T01の実装・検証記録:

- CI実装head: `95a33e2b8c4ce56f4bc8248bd76742ade6bf2296`。基準baseは `68c6a0478893072a76d5c84083e1b0b1fe60f23c`。
- [run 35430600966](https://github.com/ikdmtm/ai-minecraft/actions/runs/35430600966) はPR更新で起動。実際のcheckoutはPR検証用merge `9fe7e10cd160402eb5f422cc9652a0b622bfd0de`。パッチ復元や自動publishは行っていない。
- `verify` / job `105864347772`: 型チェック、ビルド、42 suites / 567 tests、export 4 tests、追跡済みソース差分なしの確認がすべて成功。
- `adapter-smoke` / job `105864499961`: Minecraft 1.21.4の使い捨てワールドでの既存adapter smoke、診断artifact保存、追跡済みソース差分なしの確認がすべて成功。
- `contents: read`、`persist-credentials: false`。秘密のLLMキーは渡さない。ソース自動commit/push・パッチ適用・contents:writeを撤去した。
- 起動条件は `revive/gameplay-first-jev` へのpushと同ブランチ向けpull_request、およびworkflow_dispatch。手動起動にはworkflowがデフォルトブランチにも存在する前提があり、今回は手動起動やbaseへのpushは未検証。デフォルトブランチ・権限設定は変更していない。
- 同じevent/refの古い実行をキャンセルするconcurrencyを設定。通常検証10分、smoke job10分、smokeコマンド240秒の上限。既存テストの内容や依存バージョンは変更しない。
- ローカルのYAML検査でも、GitHub blob `d21fb2fb7d66b680e81135b47a7b0ec509fc8345` との一致、起動条件、読取り権限、パッチ・publish処理なし、差分検査を確認。
- 最初の試行 `f5eb155` はrunner.tempをjob-level envで参照したため実行前に失敗。step-levelへ修正した上記headで両jobの成功を確認した。
- 既存依存関係のnpm audit警告（18件、うちhigh 8件）とActionsの非推奨警告は記録のみ。T01では依存更新や既存テストの緩和を行わない。

### T02: 実走の再現情報

実走ごとに commit SHA、world ID、seed、ゲーム/知識データのversion、model/provider、記憶DBの試験用コピー識別子、開始/終了、終了理由を記録する。APIキーや秘密は保存しない。既存の運用DBを初期化しない。

操作要求/結果/割込み/観測変化、knowledge lookup、手順保存・再生、LLM失敗・遅延を同じ run ID へ結びつける。既存ログの必要項目をまず棚卸しし、欠落のみ追加する。

完了条件: 停止/クラッシュしても、そのrunがどのコード・世界・経験で動いたか復元できる。意図的WAITと不具合による無進捗をレポートで区別できる。

実装範囲・保存先・制限・テストは [T02_RUN_RECORDING.md](T02_RUN_RECORDING.md) に記録。seedの取得不能、dirty checkout、親ごとの強制停止は明示的に不明/不完全と扱う。CI結果は [PR #2](https://github.com/ikdmtm/ai-minecraft/pull/2) の最新headとrunで確認する。

### T03: 操作アダプターの検証（1回1操作群）

- T03a: CRAFT/USE の実サーバーテスト。所持数だけでなく実際の出力・満腹度等を確認する。

T03a VERIFIED (PR #3, CI run 35434889504): the disposable Minecraft 1.21.4 server verified inventory crafting output/ingredient deltas, a crafting-table-required wooden_pickaxe recipe, and USE of selected cooked_chicken. Observed hunger changed 14 -> 20 and the consumed stack decreased by one. The smoke emitted REAL_SERVER_CRAFT_PASSED, REAL_SERVER_USE_PASSED, and the full REAL_SERVER_SMOKE_PASSED marker. Typecheck/build/regression/export checks also passed.

During T03a, the real server exposed one adapter bug: CRAFT searched for a crafting table with canSeeBlock inside findBlock's scan predicate, which could dereference an incomplete scan candidate. The fix keeps the scan predicate to block identity/distance and passes the concrete nearby table to recipesFor/craft. The following two failures were fixture synchronization issues, not adapter changes: insufficient Hunger strength and asserting inventory consumption before the server inventory update arrived. The final fixture uses a strong bounded Hunger effect and waits for both hunger increase and item decrement.

No gameplay strategy, memory, learning, or planner behavior was changed.
- T03b: 対象entity/INTERACT/装備の検証。攻撃の成功を撃破成功と同一視しない。

T03b VERIFIED (PR #4, CI run 35436573563): disposable Minecraft 1.21.4 server verified EQUIP by observing the selected held item, ATTACK by observing entityHurt while the target pig remained present, and INTERACT_ENTITY by equipping a saddle and observing the target pig's metadata change. The smoke emitted REAL_SERVER_EQUIP_PASSED, REAL_SERVER_ATTACK_PASSED, REAL_SERVER_INTERACT_ENTITY_PASSED, and the full REAL_SERVER_SMOKE_PASSED marker.

The first T03b smoke failure was a fixture-selection bug: it selected extreme pigs from all loaded entities and could bind a naturally present distant pig. The fixture now resolves the pigs nearest the exact summon positions and asserts reachability before executing the adapter operation. No runtime adapter, gameplay strategy, memory, learning, or planner behavior required changes in T03b.
- T03c: TRANSFER/OPEN/CLOSE/WAIT の境界条件。古いwindow、満杯、条件timeout、割込み後の後続処理を確認する。

すべてを一度に修正せず、まず1件を再現してテスト化する。ゲームの攻略方針は変更しない。未対応インターフェースを既存アダプターへ追加する場合も独立タスクにする。

### T04: 記憶のライフサイクル（1回1境界）

- T04a: 同じ世界の再起動では位置記憶を再利用し、同seedの新規世界では旧座標をlive targetへ流さない。別dimension/別serverも取り違えない。
- T04b: global経験・手順と元の証拠が、終了・再起動・world変更を通じて保持される。旧worldの履歴を消さず、現在の事実としては使わない。
- T04c: 失敗、割込み、無変化、再観測を区別する。単に記憶座標へ到着しただけで資源の存在を再確認した扱いにしない。

既存の永続化・world ID・検証テストを読み、追加が必要な境界だけ扱う。保存と想起の適切さは別々に検証する。

### T05: 学習手順の再利用（1回1段階）

- T05a: モデルが実際の証拠IDを使って SAVE_PROCEDURE を選べることを、模擬応答テストと限定実走で分けて評価する。単なる保存APIの成功を自発的学習と呼ばない。
- T05b: worldが変わった際の相対位置・対象entity・window・inventory再bindを検証する。手順に相容れないversion/dimensionは拒否し、理由を返す。
- T05c: 候補→検証済み→反証後の再評価/改訂を扱う。失敗率だけで永久封印しない。以前の失敗と根拠は履歴に残す。

受入基準に使う作業例はテストfixtureであって、runtimeへ攻略手順を埋め込むものではない。

### T06: 記憶検索・整理（1回1機能）

- T06a: 最近の記録だけでなく、現在の問題に関連する過去の証拠・失敗・手順を限られた量で取り出す。元world/versionと証拠参照を失わない。
- T06b: 重複経験の要約と教訓候補の保存。要約はモデルの解釈として原記録と区別し、反証で更新できるようにする。整理失敗で原記録を削除しない。

長い整理処理がゲーム操作・安全割込みを止めないようにする。人格・実況の演出をこのタスクへ混ぜない。

### T07: 実走評価（1回1runまたは1レポート）

まず最大1ゲーム日程度の短い基準runを記録し、最初に詰まる箇所を特定する。LLM使用環境がある場合のみ実行し、未実行を成功扱いしない。条件を固定した後に別seed/新worldで比較し、最後に複数日の継続へ延ばす。

指標例: 生存期間、食料獲得/消費、移動と帰路、意味のある状態変化、無効操作と反復、意図的WAIT、手順保存/再利用、過去の失敗を踏まえた行動変更、モデル呼出し量。試験結果を見て評価基準を調整してよいが、攻略順序を固定する成功条件は置かない。

記憶あり/なしの比較は別の試験DBで行い、本来のAIの経験を消さない。

## 5. 各タスクのチェックポイント

各作業は着手前に対象ID・変更範囲・検証を宣言し、終了時に次を残す。

```text
Task ID:
Base SHA / work branch:
Status:
Changed files:
Observed result:
Tests actually run / evidence:
Tests not run / reason:
Remaining blocker:
Next single task:
```

外部CIへ処理を投げた場合も、成功runのhead SHAと生成コミットを追跡する。途中で会話が切れても、未確認の実行を「完了」や「何も実行されなかった」と断定しない。

## 6. 現在のチェックポイント

```text
Task ID: T02
Base SHA: 73379eb38de74bdac8eff5c4d57bc56b4e860d75 (PR #1 integrated)
Work branch: feat/t02-run-recording / PR #2
Status: IMPLEMENTED; consult PR #2 for the exact latest-head CI result before integration.
Changed files: src/gameplay/runRecorder.ts, src/gameplay/runRecorder.test.ts, src/gameplay/taskExecutor.ts, package.json, docs/T02_RUN_RECORDING.md, docs/GAMEPLAY_TASKS.md
Observed result: Run manifest/JSONL journal and pre-run SQLite/knowledge snapshots are implemented. Operation evidence and task requests are correlated. Gameplay policy and memory semantics are unchanged.
Tests actually run / evidence: T01 final run 35430757373 was checked before merging PR #1. New T02 CI is recorded on PR #2; do not treat a pending or superseded run as verification of the latest head.
Tests not run: Autonomous Hardcore play; behavior learning/cross-world evaluation. New tests use fixture child processes and temporary SQLite only.
Remaining blocker: Verify the final T02 CI and review/integrate PR #2. Unknown seed and dirty source limitations remain explicit.
Next single task: T03c only (real-server TRANSFER / OPEN / CLOSE / WAIT boundary verification). Do not combine with T04/T05/T06.
```

## 7. 再開時の最小手順

この文書と `GAMEPLAY_AUTONOMY.md` / `T02_RUN_RECORDING.md` を読み、PR #2・作業ブランチの最新SHA・対応CI・取り込み状況を確認する。T01は取り込み済みなので再実装しない。T02が検証済みなら記録を更新してT03aへ進む。停止前の会話に出てきた古いファイル内容を、そのまま現行コードへ貼り戻さない。

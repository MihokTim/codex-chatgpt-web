# Orca 1.4.215 修復・検証記録（2026-09-28）

## 現時点の結論

Codex CLIの実効バージョンを公式 `codex update` で **0.153.4 → 0.157.1** に更新した。Orca専用homeを使用したGPT-6 Sol/Luna各1回の最小実応答は、指定マーカーの完全一致と `turn.completed`、exit code 0を確認した。旧モデルへの置換やカタログへの架空追加はしていない。

Orca本体の旧Chat複数行分割と構造化worker受付raceは根因を特定し、バックアップ付きの限定asarパッチを準備した。**Orca本体は未適用・未再起動**。コーディネーターが並列担当回収後に適用・再起動し、構造化workerの実受入を確認する。GUI操作は行っておらずWindowsロック状態も推測していない。

## 根因と証拠

### GPT-6 Sol/Lunaの欠落

| 比較対象 | 実効CLI | 同じ標準/Orca homeのmodel/list |
|---|---|---|
| 更新前のOrca起動先 `Programs/OpenAI/Codex/bin/codex.exe` | 0.153.4 | `gpt-6-astra`、`gpt-5.6-sol/luna`は存在、`gpt-6-sol/luna`は欠落 |
| Codex Desktopの実効exe `OpenAI/Codex/bin/faa963e871dd422c/codex.exe` | 0.158.0-alpha.2.1 | `gpt-6-sol/luna`が存在 |
| 公式npm配布を隔離展開した安定版 | 0.157.1 | `gpt-6-sol/luna`が存在 |
| 公式更新後のOrca起動先 | 0.157.1 | `gpt-6-sol/luna`が存在 |

両homeのmodel/provider設定は比較した範囲で一致し、providerは既定OpenAI、独自 `model_catalog_json` はない。Orcaのcacheは旧CLIが返した一覧と整合していた。旧端末に記録された `gpt-6-sol not supported when using Codex with a ChatGPT account` は0.153.4での実応答であり、現行CLIの利用資格まで否定する証拠にはならない。

旧branch b12b10ceの9/23調査は実IDを5.6と記録していたが、これだけを現在の6系IDの不存在の根拠にはできない。初期中間報告の「架空slug」は訂正した。[公式changelog](https://learn.chatgpt.com/docs/changelog) は9/22の提供開始、0.156.1/0.157.0のcatalog追加を記載し、今回の新旧CLI比較とも整合する。

更新後、Orca専用homeで各モデルを明示した `exec --ephemeral --json --sandbox read-only` を実行し、ツールを使わない短い固定文字列だけを依頼した。Solは `ORCA_SOL_OK`、Lunaは `ORCA_LUNA_OK` を返し、両方exit 0・turn.completed・errors空。実モデルの追加試行はこの2回だけ。要求IDとサーバーの成功応答は確認したが、非公開の内部モデル実装まで独立認証したという意味ではない。

### 構造化workerの受付未確定

更新後にコーディネーターが正式 `worker-start` でAstra/highを起動しても同じ障害を再現した。対象はTask `task_ff2c6f038ef7`、Dispatch `ctx_89aa80474793`、session `f65727a2-4d68-451c-94a5-2e88ff9d08c2`。

- Provider rolloutの `session_meta` はCLI **0.157.1** / `originator=orca_desktop` / `model_provider=openai`。
- 実際に `task_started` が記録され、**464ms後に `turn_aborted: interrupted`**。
- Orca journalには1件のsubmission、その後 `unknown / provider_closed_before_acknowledgement`。
- session leaseには `exit-observed` と `the last surface holding this session released it`。
- `worker-show` は `start_unknown / dispatch_input` と `exactWorker=true, observation.exited`。`worker-read` はsession未attachの `transcript_required`。

`out/main/index.js` の `Xkn` は `host.send` が返す非同期 `pending` を即座に `operation_unknown` としてthrowする。その後worker-startのcatchが `CFn` を呼び、保持を解放してsessionをcloseする。実際には開始済みのturnを、この失敗処理が中断していた。

修復は既存の `host.waitForSendSettlement(sessionId, clientMessageId)` を使い、**同じsubmissionの確定を待つだけで再送しない**。acceptedを確認してから開始成功とする。timeout/unknown/観測エラーはunknownのまま保持し、この状態を理由に勝手にsessionをcloseしない。明示的な拒否は拒否のまま扱う。認証・承認・停止判定を変更しない。

worker側からの正式worker-startは `consumer_fenced` で拒否されたため、コーディネーターのhandleを偽装したり別Runで権限を広げたりせず、親に起動を依頼した。対象のsettlement/cleanupも親が担当する。

### 旧Chatの複数行分割

旧Chatの `Aw` は複数行をCR入りbracketed pasteとして送っていた。一方、通常のWindows Codexターミナルはalt-enter改行を使う。既存のWindows/WSL/SSH判定関数を再利用し、ローカルWindowsのCodex composerだけへalt-enter設定を渡す。通常送信と添付付き送信の本文が対象。単一行、他agent、SSH、WSL、remote runtime、対象不明の場合は従来経路を保持する。

実Windows ConPTY + 旧0.153.4/new0.157.1 + localhostの固定Responsesサーバーで、日本語3行の旧方式が2メッセージに分割され、修復方式は**改行を保持した全文1通**になることを確認した。これは実入力プロトコルの回帰試験であり、Orca画面からの実操作受入試験ではない。

新CLIの隔離homeではデフォルトdaemonのUnix socketパス長制限が出たため、エラーが示す正式 `--no-daemon` で同じ隔離試験を実行した。認証情報はコピーしておらず、本試験に実推論は使っていない。最初の集計器はevent_msgだけを読んで0件と誤判定したため、実rolloutのresponse_itemへ修正し、元の失敗記録も残した。

### PATHと親子引継ぎ

現在のユーザーPATHにはOrcaのbinが存在する。今回、サンドボックス内では同じexeを「見つからない」と報告し、親ディレクトリ一覧でAccess deniedが出た。通常の承認経路で昇格すると同じ絶対パスが実行できるため、PATH欠落と実行権限拒否を分けた。ACL・実行ポリシー・sandbox設定を手作業で緩めていない。

`scripts/orca-cli.ps1` は明示ORCA_CLI_COMMAND / dev指定を尊重し、それ以外のWindowsインストールでは既知の絶対パスを正規化して実行する。選んだexeが失敗しても別buildへ自動的に切り替えない。実 `status --json` のok=trueを確認済み。新しい子のTask specにはこの絶対パスと通常の承認経路、Task/Dispatch両IDによる完了報告を含める。送信accepted、モデル要求、実turn開始、完了通知、親ACK、resource解放は別々に確認する。

## 変更ファイルと検証

- `scripts/orca-diagnose.py`: 秘密値を除いたhome/provider/catalog比較とapp-server model/list。`--exe`で世代を明示比較。
- `scripts/orca-stage-codex.py`: 公式npm安定版をSHA-512 integrity照合して隔離展開。archive traversal/linkを拒否。
- `scripts/orca-update-cli.py`: 正式更新前のexeバックアップ、release target記録、更新後version/hashと旧release残存を保存。既存agentの終了命令は発行しない。
- `scripts/orca-repair.cjs`: Orca 1.4.215限定asar stage/apply/rollback。anchorが一意でない版・未知の版・想定外の変更・稼働中Orcaへの適用を拒否。
- `scripts/orca-input-smoke.cjs`: 認証なしloopback mockを使う実ConPTY試験。新しいoutput先を要求。
- `scripts/orca-cli.ps1`: PATHに依存しない正式CLI呼出し。
- `tests/orca-repair.test.cjs`: 実bundle/asar照合、Windows分岐、ESC/CRLF、日本語、同一送信IDのpending→accepted/rejected/unknown/error、unknown時の保持を検証。

**回帰6件すべて合格**、renderer/mainのJavaScript構文確認合格。Windowsで `@electron/asar.extractFile` がOSネイティブ区切りを要求する点を実ファイル一覧照合で確認し、`path.normalize` を使用した。

更新の副作用として、更新前から稼働するCodex agentの一部toolは新helperとの `--windows-sandbox-private-desktop` 引数不一致を報告した。既存作業を停止したとは扱わず、通常のrequire_escalated承認経路で担当作業を継続し、コーディネーターへ通知した。新しいCLI processでのmodel/list・実応答は正常。旧agentは作業回収後の正常な再起動が必要。

## 配備する具体的成果物

ローカル成果物root: `output/repair-20260928/orca`。秘密を含み得るsession journalやdispatch preambleのraw evidenceはこのローカルoutputのみ。公開・commit・pushは行っていない。

**最新の配備対象は `combined-patch/manifest.json`**。先に生成した `legacy-patch` は途中の旧Chat単独候補なので配備しない。

- 原本asar SHA-256: `07ac05d90379ccca8d9505c89a09666965068d1b51c8f44cae68a8f34116c045`
- 修復asar SHA-256: `9530e6f65959c75326ed4286dec8f877d739f6cef9d1f67c02672a2622064c68`
- 4889メンバー中、変更は `out/main/index.js` と `out/renderer/assets/OnboardingInlineCommandTerminal-CEt11EKH.js` の2件だけ。
- その他のpacked memberの内容とunpacked/link metadataは不変。対象memberのASAR integrityも再計算し、第三者asarライブラリで抽出照合済み。

```powershell
$env:ORCA_REPAIR_STAGE = Join-Path (Get-Location) 'output\repair-20260928\orca\combined-patch'
node --test tests\orca-repair.test.cjs
# 全Orcaプロセスの正常終了をコーディネーターが確認した後だけ実施
node scripts\orca-repair.cjs apply output\repair-20260928\orca\combined-patch\manifest.json
# 必要な場合の原本復旧。これも停止状態と現行hash一致が必要
node scripts\orca-repair.cjs rollback output\repair-20260928\orca\combined-patch\manifest.json
```

## 配備後の受入結果（13:06 JST追補）

稼働Orcaを正式メニューで正常終了し、対象2memberのパッチを適用した。
再起動後の構造化workerは `ready / input_accepted / turnStart=observed` になり、
指定ファイルを読み取って正しいCLI版を回答した。`worker_done` 成功通知のACKと
`worker-release` の `released / closed_agent_terminal / transcript captured` も確認した。
起動要求の受付だけを成功扱いにしていない。日本語複数行は実ConPTYの修正前後試験で
分割2件から正確な1件への改善を確認済み。旧Chat画面そのものの最終入力受入は別工程。

通常起動後のOrcaの実モデルcatalogにも `gpt-6-sol` と `gpt-6-luna` が現れた。
更新後CLIの各モデル実応答成功と、Orcaが実際に読み込むモデル一覧の両方を照合した。

正常終了後もterminal daemonとCrashpadは残る。デスクトップ本体・rendererの停止を
実行パスと引数で検証し、これら常駐補助プロセスを強制終了せずにパッチを配置する。
プロセス情報が取得できない場合は安全側で配置を拒否する。判定の回帰試験は7件成功。

### Windowsの起動経路とデータ仮想化

MSIX版Codexから直接起動したOrcaは、同じAppData表記でもパッケージの古い仮想化データを
読み込む場合があった。データベースを復元・上書きせず、そのOrcaを正常終了し、
Windows Explorer経由でインストール済みOrca.exeを通常起動すると元のプロジェクトとRunが戻った。
再起動の前後で必ず `repo list` のIDと `orchestration run-show` のRun IDを照合する。
異なれば新しいRunやリポジトリを作って埋め合わせない。再起動後のcoordinatorは正式な
`run-use` で同じRunへ再結合する。認証情報のコピーや仮想化設定の変更は行っていない。

## 当初の受入計画（上記結果と照合）

1. コーディネーターが他担当と自身の実行を安全に回収し、Orcaの正常終了、上記パッチ適用、再起動を行う。workerは中断権限を行使していない。
2. 新runtimeのモデル一覧でGPT-6 Sol/Luna、構造化workerでAstra/highの `ready → 応答 → worker_done → cleanup` を実証する。旧pending probeを無条件再送しない。
3. 必要なら最後にWindowsの現在ロック状態を一度確認し、旧Chat画面から日本語複数行を送る実受入をまとめて行う。ロック中は開始しない。
4. 旧起動済みagentのhelper互換問題を正常な再起動で解消し、親への完了通知・ACK・resource解放を別々に確認する。

上記計画のうち、本体パッチ配置・再起動・構造化子の完了回収は追補のとおり成立した。

## 再起動担当への追補（親からの最終依頼）

- **正常終了CLIは広告されていない**。同梱CLIのhelpには `open` / `serve` / `status` はあるが、デスクトップ全体の `quit` / `stop` はない。`terminal close --all` はworkspaceのターミナルを破棄する操作なのでアプリ終了の代用にしない。
- インストール済みmainにはrenderer IPC `app:restart` があり、事前cleanup後に `app.relaunch()` と `app.quit()` を行う。これは即時再起動であり、パッチ適用のための停止区間を作る公開CLI/APIではない。未公開IPCを外部から注入して終了を迂回しない。
- アプリのtray正常終了ハンドラー `XHr` は `Q.isQuitting=true; app.quit()` を呼ぶ。必要な場合は最後にWindowsロックを一度確認し、正式なtray Quitを利用する。ウィンドウを閉じることと全プロセスの正常終了は区別する。
- 現在の全workspace概況は `orca worktree ps --limit 1000 --json` で取得できた。読み取り結果を `worktree-process-inventory.json` に保存した。`result.worktrees` の `liveTerminalCount` / `status` / `lastOutputAt` と `truncated` を確認し、各 `worktreeId` について `orca terminal list --worktree id:<完全なworktreeId> --json`、必要なら `terminal show/read` でユーザーの他作業を識別する。PTY存在やworking表示だけでagentの確実な生存・停止を断定しない。
- supervised workerは別に `orca orchestration worker-list --include-remote --json` をRunごとに確認する。coordinatorが対象Dispatchの終了証拠に基づいて正式abandon/releaseを行う。別ユーザー作業・別Runを一括停止しない。
- 読み取り専用のElectron fuse照合では `EnableEmbeddedAsarIntegrityValidation` は無効（wire値48）。これを変更していない。asar修復のためのOrca.exe書換えは不要と判断した。最終的な起動受入は配備後に行う。

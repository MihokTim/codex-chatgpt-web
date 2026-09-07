# Native CodexとWeb Proの分離

通常のCodexは従来のnative homeを使用する。Web統合は既定で
`~/.codex-chatgpt-web/codex-home` を使用し、config、catalog cache、sessionを分ける。
bridgeの状態領域は従来の `CODEX_CHATGPT_WEB_HOME`（既定 `~/.codex-chatgpt-web`）。
汎用 `CODEX_HOME` はWeb統合先に採用しない。Web専用の明示指定は
`CODEX_WEB_GPT_CODEX_HOME`。既定native home、ambient native home、旧journalのnative targetとの
衝突は、既存ancestorのrealpathを解決して拒否する。symlink / Windows junctionも対象。

## Setupとupgrade

通常のsetupが、次の設定をrouteと同じjournal・補償writeで管理する。

```toml
model = "chatgpt-web/pro"
model_reasoning_effort = "ultra"

[agents]
default_subagent_model = "chatgpt-web/extra-high"
```

既存値はbaselineとして保存し、disconnect / uninstallで復元する。設定後のmodel変更を
route置換オプションで無条件に上書きしない。再setupはidempotent。
`default_subagent_reasoning_effort` は追加しない。既に全child effort固定がある場合は、
利用者による解消を求めて停止する。sandboxやdelegation推奨promptは新規生成しない。
既存のユーザー所有のdeveloper instructionsやsandboxは勝手に削除しない。

旧journalが別homeを指す場合は、preflightで復元可能性と移行先を検証し、installで
nativeのbridge-owned設定を復元してWeb homeへ移す。native config/cache、両journal、Web側の
config/cache/auth/AGENTSとlegacy catalogをsnapshotし、hash付きbackupを残す。
途中失敗はこれらを復元する。auth/AGENTSは初回移行時のみローカルコピーする。
移行先に何か残っている場合や、nativeに非管理のWeb model/instructionsが残る場合は拒否する。
既存task履歴は移動しない。

Launcherはversion番号が同じでも旧home / profile未管理journalをupgrade対象とする。
既存のsetup transactionがpreflight、runtime停止、setup、起動確認、失敗時rollbackを担当する。
checkpointには旧native config/cacheとWeb auth/AGENTSも含める。
macOS service定義にもWeb homeを保存し、restart後も同じhomeを参照する。
Terminalで既存サービスを更新する場合は通常setupの `--restart-service` を使用する。

通常setup以外で設定だけを整える正式な配布CLI入口は `isolation ensure`。
このコマンドはサービス停止・再起動を行わないため、Launcher/サービスを停止してから使う。
旧source migration scriptはこの同じinstall実装への薄い互換入口にした。

## Routingと起動

model未指定childはWeb経由のSol xHigh (`chatgpt-web/extra-high`)。
難しいsubtaskでは `model="chatgpt-web/pro", reasoning_effort="ultra"` を明示できる。
親子model選択、precedence、session continuationはCodex標準機構に任せ、独自routerを作らない。
他のWeb modelを明示する判断余地も残す。native Solへのdefault routingではない。
Pro compaction時の既存 `browserEffortOverride="xhigh"` は変更しない。

配布runtimeのコマンドでWeb専用Codexを起動する。

```text
codex-chatgpt-web codex --executable <Codex CLI executable> -- [Codex arguments]
codex-chatgpt-web codex --desktop --executable <Codex Desktop executable>
```

Desktopには別 `CODEX_ELECTRON_USER_DATA_PATH` と `--user-data-dir` を渡す。
Windowsでは実際のDesktop executable（Store版ならpackage内の `app/ChatGPT.exe`）を指定する。
`CODEX_WEB_GPT_NATIVE_HOME` はこの起動入口が元のnative homeをchild/hookへ伝えるために使う。
以前のsource-only Windows starterはこの配布CLIへ統合した。

実行中native Codexの強制終了はしない。移行後は通常Codexを完全に終了して再起動する。
起動中processが古いcatalogをcacheへ書き戻す可能性があるため、終了後に必要ならcacheを再生成する。
設定移行成功と実行中processの反映完了は区別する。

## 検証

unit testはfresh setup、legacy migration、partial target、junction、非管理Web設定、競合、
fault injection、service/home伝播を検証する。Launcher testは同一version upgradeとcheckpoint復元を検証する。
配布smokeはrelocate済みCLIからfresh / legacyの両方へ `isolation ensure` を2回実行する。
これらは既存 `verify` に含まれる。CIにはCodex CLI 0.153.4を導入し、loopback subagent smokeも必須にした。
ローカルでは `CODEX_EXECUTABLE` またはPATHの `codex` を使用する。

Web smokeはroot、default child、explicit Pro childの全HTTP requestを検証し、両childのfollow-upを含む。
実サービス用probeもsession内の全turn_contextを照合する。
native probeはroot model/effortをCLI引数で強制せず、実設定とcatalog cacheにWeb指定がないことを検査する。
実アカウントを使うprobeや意図的なcontext消費によるcompactionはCIに含めない。

# Native CodexとWeb Proの分離

通常のCodexは従来の `~/.codex` を使用する。Codex Web GPTの既定の統合先は
`~/.codex-chatgpt-web/codex-home`。設定、model catalog cache、session stateを分け、
WebのCompatibility V1とdepth設定を通常のnative Codexへ適用しない。
明示的な `CODEX_HOME` 指定は従来どおり優先する。

CLIのnamed profileは設定を重ねられるが、現在のDesktopには同じ選択入口がなく、
同一homeのcache共有も避けるため、別homeを使用する。Desktopでは既存の
`CODEX_ELECTRON_USER_DATA_PATH` と `--user-data-dir` も分ける。

## 既存Web Pro環境の移行

`bun run scripts/migrate-isolated-codex-home.ts <native-CODEX_HOME>` を使用する。
対象journalを検証し、backupを保存し、既存のuninstall/install機構でnative設定を復元して
Web専用homeへ統合する。既存Web homeの上書きや移行済み処理の再実行は拒否する。
Windowsでは配置したruntimeとlauncherを再起動する。通常のCodexも既存processが旧設定を
保持している場合は再起動する。既存のWeb task履歴は移動しない。

認証ファイルとAGENTS.mdは初期移行時にローカルで複製する。以後は各homeで管理する。
秘密値を出力・登録しない。通常のnative plugin、custom agent、認証、AGENTSへWeb専用規定を追加しない。

Web Proの設定は以下とする。

```toml
model = "chatgpt-web/pro"
model_reasoning_effort = "ultra"

[agents]
default_subagent_model = "chatgpt-web/extra-high"
```

`default_subagent_reasoning_effort` は設定しない。model省略のchildはWeb extra-highへ進み、
modelを明示した場合はnative Codexのoverride処理を使う。
難しいsubtaskでは `model="chatgpt-web/pro", reasoning_effort="ultra"` を明示して昇格できる。
通常childはWeb経由のSol xHighであり、native `gpt-5.6-sol` への転送ではない。
必要に応じて他のWeb modeも選べる。Webの物理modeはroute名で決まり、HTTP上のreasoning表現と
一致しない場合がある。rootからの無条件Pro継承や、全childへのxHigh固定は行わない。

Proのretained compactionは既存の `browserEffortOverride="xhigh"` を維持する。
rootのWeb Pro routeとcompactionのWeb Sol xHigh処理を混同しない。

## 起動と検証

Windows Desktopは `scripts/start-web-codex.ps1`、CLIは同スクリプトの `-Cli` を使用する。
通常のCodexは従来どおり起動する。Web側で使いたい追加pluginやskillはWeb homeで設定する。

- `bun test tests/isolated-codex-home.test.ts tests/codex-integration.test.ts`
- `node --test launcher/tests/profile.test.cjs launcher/tests/runtime-host.test.cjs`
- `bun run scripts/smoke-codex-subagents.ts --v1 --web-defaults <codex-executable>`
- `bun run scripts/probe-isolated-routing.ts native <codex-executable> <native-home> <private-output-dir>`
- `bun run scripts/probe-isolated-routing.ts web <codex-executable> <web-home> <private-output-dir>`

最後の2つは実アカウントで短い応答を生成する。nativeは親1・子1、WebはPro親1・既定子1・明示Pro子1。
fixtureによるcontract検証と実サービスprobeを区別し、生成したraw logはGitへ登録しない。
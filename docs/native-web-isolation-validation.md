# Native / Web分離の検証記録

2026-09-07、Windows、Codex CLI 0.153.4、Codex Web GPT 5.0.4のローカル修正版。

## 実適用

- 通常の `~/.codex/config.toml` は既存journalから復元。Web base URL、Compatibility V1のfeature固定、depth指定、Web Interrupt hookを除去した。
- Webの統合先は `~/.codex-chatgpt-web/codex-home`。rootは `chatgpt-web/pro / ultra`、子の既定modelは `chatgpt-web/extra-high`。
- 子のreasoning全体を固定する設定は置いていない。model選択、effort解決、spawn処理はnative Codexを使用する。
- 既存設定・cache・launcher/runtimeのpreimageはWeb homeの兄弟にある `backups` へhash付きで保存した。ローカルruntime manifestも検証した。
- Web launcherは再起動済み。専用Desktopは別user-dataで起動し、Web home内のDesktop state作成を確認した。
- 通常Codexのfresh catalogではWeb rowがなく、Astra/Sol/Terraの公式metadataはV2。nativeのmedium probeの実行surfaceはV1であり、V2への強制設定は追加していない。

## 実サービスprobe

各probeはread-onlyで、ファイル・shell・追加app操作を依頼せず、短い定型応答だけを生成した。
実行終了後のsession metadata、spawn引数、child完了応答を `verify-routing-probe.ts` で照合した。

| 対象 | model / effort | 結果 |
|---|---|---|
| native root | gpt-6-astra / medium | 完了 |
| native child（model・effort省略） | gpt-6-astra / medium | 完了、rootが応答受領 |
| Web root | chatgpt-web/pro / ultra | 完了 |
| Web default child（model・effort省略） | chatgpt-web/extra-high / xhigh | 完了、rootが応答受領 |
| Web escalation child（明示指定） | chatgpt-web/pro / ultra | 完了、rootが応答受領 |

Web回答はMarkdownのunderscore escapeを含み、初期probeの文字列判定だけが不一致になった。
判定を修正し、同じ保存済み実行記録を再検証した。Proを再実行して成功を取り直してはいない。

## 回帰検証

- config integration、migration、Web model mapping、browser compaction recovery: 63件pass。
- launcher profile / runtime host: 48件pass。
- retained compactionのPro→xHighを直接assertする2ケース: pass。
- 実Codexバイナリ＋loopback fixtureのV1 default child／明示Pro昇格／nested child／follow-up: pass。
- TypeScript型検査、PowerShell構文、`git diff --check`: pass。

retained-compactionファイル全体の実行はWindows上で停止したため、その実行を回収し、
変更に関係する2ケースを限定して検証した。全suite通過とはしていない。
Pro compactionの実装は変更せず、実サービスで意図的にcontextを埋めるprobeは実施していない。

## 反映上の残件

この作業を実行中の既存native Desktop/app-serverは旧routingとcatalogをメモリーに保持しており、
native homeへWeb混在cacheを再作成することを観測した。この会話終了後に通常Codexを完全に終了し、
再起動して新設定を読み込む必要がある。必要なら終了中に生成cacheの `~/.codex/models_cache.json` を
除去してfresh catalogを取得する。既存の実行中タスクを途中で停止する変更は行っていない。
Web用Desktopの起動入口は `scripts/start-web-codex.ps1`。通常のnative Codexは従来の入口を使用する。
既存task履歴の他homeへの移動、公開、push、release/tagは行っていない。
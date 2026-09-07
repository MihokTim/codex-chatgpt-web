# 独立レビュー対応記録

対象: `6744c037ff5e8b4d74848e9b336ee76f4c2283e4` に対する独立レビュー。
2026-09-07、Windows上のsource修正と検証。過去の実適用・実サービスprobe記録は書き換えていない。

## 判断と修正

| 指摘 | 判断・対応 |
|---|---|
| fresh setupにWeb root/default childがない | 採用。通常integrationのjournalに3設定のownershipを追加。restore、再setup、競合を検証 |
| legacy journalと新homeが衝突し通常upgradeできない | 採用。preflight/installに移行を統合。同一versionでもlauncher upgrade対象にし、既存checkpointを拡張 |
| ambient CODEX_HOMEでnativeへ書ける | 採用。Web専用variableと共有realpath resolverへ変更。既定・ambient native・旧journal targetとの衝突を拒否 |
| service/hook/launcherでhomeがずれる | 採用。専用homeを伝播。Web Codex client起動時は元native homeも明示的に引き継ぐ |
| source-only migration/Windows starter | 採用。migrationをruntime sourceへ移し配布CLIに含める。Windows starterは配布CLIのcross-platform起動入口へ統合 |
| delegation推奨prompt・elevated sandboxを追加する | 採用。新規profile生成から削除。既存の非管理設定は勝手に削除しない |
| first requestしかmodelを確認しない | 採用。Web smokeは全HTTP requestを検査。default childとexplicit Pro childのfollow-upも実行。live verifierも全turn_contextを検査 |
| partial target・rollback・path alias | 採用。非empty targetを拒否し、両homeのcache/auth等をsnapshot。fault後の復元と再実行、junctionを検証 |
| nativeの非管理Web model/instructions | 無条件削除は採用せず、移行前に検出して停止する |
| 実行中native processの自動終了 | 不採用。利用中taskを壊さず、既存のrestart-required表示・手順で扱う |
| 全ケースの実アカウントcompactionを必須CIにする | 不採用。既存compaction回帰とoffline Codex lifecycleを使う。実アカウント使用やcontext大量消費はCIに含めない |

root/child route解決の独自frameworkは追加していない。既存の
`model`、`agents.default_subagent_model`、`spawn_agent` のoverrideを使用する。
Pro compactionのproduction sourceは変更していない。

## 検証結果

- integration、home lifecycle、CLI、environment、DEV profile: 121件pass（最終追加分を含む）。
- launcher profile/runtime host: 51件pass。
- Web model mapping: 15件pass。
- model catalog、browser compaction recovery: 21件pass。
- retained Pro compactionの関連2ケース: pass。
- Codex CLI 0.153.4 + loopback Web lifecycle: rootの5 request、default childの6 request、explicit Pro childの2 requestを全件検証。
- 配布runtime buildとrelocation smoke: fresh / legacy migration、再実行、native設定不変、Web client環境handoffを検証。
- runtime / launcher TypeScript、git diff --check: pass。

通常verifyにWeb lifecycle smokeを追加し、CIは公開npmのCodex CLI 0.153.4を使用する。
配布smokeのhome lifecycleも既存verifyから実行される。

## 検証範囲と反映の境界

この修正では実アカウントのPro turnや意図的なcompactionを再実行していない。
macOS LaunchAgentは生成する定義の検証であり、実macOS上のrestart試験ではない。
Launcherの認証browserを含むGUI upgrade全体は実行せず、runtime実物のCLIとlauncher transactionの回帰で確認した。
全suite / 全OSのCI完了とはしていない。

稼働中のローカルlauncher/runtime、既存Web config、native processは差し替えていない。
このsourceを配布・適用する際は新しいlauncher/runtimeを使用し、既存Codex processを再起動する。
旧手動migrationが追加した非管理のdeveloper instructionsやsandboxが既存Web homeに残っている場合、
新しいsetupはそれをユーザー所有値として保持するため、必要に応じて別途内容を確認して取り除く。

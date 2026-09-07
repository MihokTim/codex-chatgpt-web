# Desktop切替調査と再起動不具合修正（2026-09-07）

対象はDesktop 26.901.6511.0と、実プロセスが利用するCodex CLI 0.153.4。
設定の混入を防ぐ同一ウィンドウ切替を調査した。通常設定を共有構成へ戻す変更はしていない。

## 調査結果

- 公式Advanced Configurationはnamed profileをCLIの`--profile`による設定layerとして説明する。Desktopのmodel選択とprofile適用の連動は確認できなかった。
- 稼働app-serverの実行ファイルから生成したThreadStartParamsはmodelProviderとconfigを受け取る。新規taskへ専用設定を渡す下層機構は存在する。
- 同じ実行ファイルのTurnStartParamsにはmodel/effort変更があるが、provider、任意config、default_subagent_model変更の項目はない。
- Desktop配布ASARにはthread/settings/update呼出しと未対応時のfallbackがある。一方、生成された現行APIにはその更新要求型がなく、任意config切替の証拠にはならない。
- Desktop model一覧・task開始処理から、Web slug選択に応じたprofile/child既定値切替は確認できなかった。全経路不存在の証明とはしない。
- bridgeのCompatibility V1モードはnative catalog行にもv1を設定し、configのmulti_agent_v2も無効化する。従来の一覧を復元するだけではnative semanticsを維持できない。
- model metadataにはmultiAgentVersionがあるが、root modelごとにdefault childを設定する項目は生成Model型にない。

同一ウィンドウでの実現可能性を否定するものではない。しかし既存Desktopの設定だけで元の全要件を満たす経路は未確認。クライアント側のtask設定切替実装などが必要となる見込みであり、独自routingを追加しない条件では現行の別起動が単純。CLIだけならnamed profileは候補だがDesktopの操作問題を解決しない。

公式資料: https://learn.chatgpt.com/docs/config-file/config-advanced

## 再起動不具合

ユーザー報告時、Web homeのmodel/effortはgpt-6-astra/mediumになっていた。変更主体は未確定。Web Desktopプロセスは窓なしで残存していた。
startWebCodexのread-only readinessが設定復元用の厳格なprofile ownership検査を再利用し、model変更だけで起動を拒否していた。

inspectCodexIntegrationのactive route確認ではprofile ownershipを除外する。route、hook、Compatibility V1の検証は継続し、install/uninstallでは完全なprofile競合検査を維持する。ユーザーのmodel選択を無条件に上書きする処理は追加しない。

実環境は変更前configをprivate backupに保存し、合意済みWeb root pro/ultraへ復旧。Web窓の再表示をprocessのMainWindowHandleで確認した。UI内の表示を自動操作で確認したものではない。

検証: 関連55テスト、267 assertions、TypeScript検査、git diff --check。回帰テストはmodel/effort変更後のreadiness、install/uninstallの競合保護、route改変の拒否を検証。

> これは更新前のCLIを対象とした調査記録です。更新後のGPT-6を含む判断と実装は [6.0.0更新レビュー](v6-upgrade-review-2026-09-23.md) を参照してください。

# Codexネイティブ Sol / Luna追加の影響調査

調査日: 2026-09-23 JST。対象: codex-chatgpt-web 5.0.8、Codex Desktop同梱CLI `0.155.0-alpha.16`。

## 結論

Codexの実カタログに追加されたネイティブ行は `gpt-5.6-sol` と `gpt-5.6-luna`。通常のモデル一覧には既に表示されるが、Compatibility V1の `spawn_agent` が広告する明示的なモデル候補は優先順位順の5枠に制限されるため、従来設定では新2モデルが候補から外れていた。

Owner指定の5モデルを次の実IDへ対応させ、すべて利用可能なときだけこの順で5枠を予約する。

| Ownerの呼称 | 実際のモデルID | 意味 |
| --- | --- | --- |
| WebProAstra | `chatgpt-web/pro` | ブラウザーのLatest系列Pro。固定Astra IDではない |
| WebProSol | `chatgpt-web/light` | ブラウザーのGPT-5.6 Sol Pro経路 |
| nativeAstra | `gpt-6-astra` | CodexネイティブAstra |
| native6sol | `gpt-5.6-sol` | CodexネイティブSol |
| native6luna | `gpt-5.6-luna` | CodexネイティブLuna |

`native6sol` / `native6luna` はOwnerの呼称であり、ローカル実測のslugは `gpt-6-sol` / `gpt-6-luna` ではない。この区別をテストと受入smokeにも固定した。

## ローカル実測

同梱CLIの `debug models --bundled` で確認した主要属性は次のとおり。

| モデル | 通常表示 | API対応 | 元priority | multi-agent | reasoning |
| --- | --- | --- | ---: | --- | --- |
| `gpt-6-astra` | list | true | 1 | v2 | low〜ultra |
| `gpt-5.6-sol` | list | true | 6 | v2 | low〜ultra |
| `gpt-5.6-luna` | list | true | 8 | v1 | low〜max |

3モデルとも `context_window=272000`、`max_context_window=872000`。最大値の存在は、すべての実行で自動的に最大コンテキストが有効になることを意味しない。

修正前に実Codexが広告した5枠は `gpt-6-astra`、`chatgpt-web/light`、`chatgpt-web/high`、`chatgpt-web/extra-high`、`chatgpt-web/pro`。Sol / Lunaのネイティブ行は通常一覧に残っていても、明示的な子モデル候補には入らなかった。

## ソース変更

優先枠の定義と適用条件は `src/subagent-model-roster.ts` の純粋関数へ分離した。Compatibility V1かつ指定5モデルすべてが `visibility=list`・`supported_in_api=true` のときだけ、表の順でpriority 0〜4を割り当てる。その他の候補行は表示可能なままpriority 5以降へ送る。

対象モデルの欠落、段階提供、Pro非対応、Nativeプロトコルでは元のpriorityを維持する。変更するネイティブ属性はpriorityだけで、モデルID、reasoning、ツール能力、コンテキスト値は保持する。

ネイティブの通常リクエストと圧縮リクエストは既存のpassthroughで3モデルをそのまま転送できる。Webモデルのバックエンド名とCodexネイティブの選択肢は別の経路なので、一括置換は行わない。

## 検証範囲

- rosterの順序、入力非破壊、再適用時の同一性、欠落・非表示・API非対応時のフォールバックを単体検証する。
- 実Codexカタログを読み、修正後の5枠がOwner指定の実ID順になることをsmokeで確認する。
- 5モデルそれぞれについて、実Codex CLIとローカル模擬Responsesサーバーで子・孫タスク、reasoning指定、結果回収を確認する。
- core / launcherの全体テストとTypeScript、launcher production buildを実行する。Windowsでシンボリックリンクfixture自体を作れない `EPERM` はコード失敗と分けて記録する。

このライフサイクルsmokeはモデル選択・プロトコル伝播の検証であり、各モデルへの本番生成リクエスト、品質・速度・使用量の比較、アカウントごとの実通信受入は含まない。

## 運用反映

通常のモデル一覧から他モデルは削除しない。変更はカタログ生成時のCompatibility V1優先順位に限定される。mainへの統合だけでは稼働中の5.0.8ランタイムは差し替わらず、実運用へ反映するには統合後ソースからのランタイム更新と再起動が別途必要になる。

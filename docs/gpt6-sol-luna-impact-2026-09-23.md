# GPT-6 Sol / Luna追加の影響調査

調査日: 2026-09-23 JST。対象: codex-chatgpt-web 5.0.8。

## 結論

新しいネイティブモデル `gpt-6-sol` と `gpt-6-luna` は、稼働環境の通常モデル一覧に既に含まれている。一方、Compatibility V1のサブエージェント向けモデル指定候補は優先順位順の5枠に制限され、従来のWebモデルが枠を占めて新2モデルが掲載されない。

Ownerが指定した次の5モデルを優先するソース修正を行った。通常のモデル一覧から他のモデルを削除せず、稼働サービスへのインストール・差し替え・再起動も実施していない。

| Ownerの呼称 | 実際のモデルID | 意味 |
| --- | --- | --- |
| WebProAstra | `chatgpt-web/pro` | ブラウザーのLatest系列のPro。固定AstraモデルIDの保証ではない |
| WebProSol | `chatgpt-web/light` | ブラウザーのSol Pro。既存のGPT-5.6 Sol Pro経路を維持 |
| nativeAstra | `gpt-6-astra` | CodexネイティブAstra |
| native6sol | `gpt-6-sol` | 今回追加されたCodexネイティブSol |
| native6luna | `gpt-6-luna` | 今回追加されたCodexネイティブLuna |

## 公式情報とローカル実測の区別

[公式更新履歴](https://learn.chatgpt.com/docs/changelog)は2026-09-22にGPT-6 Sol / Lunaの提供開始、2026-09-23にCLI 0.156.1のモデル選択肢追加を記載している。[公式モデル案内](https://learn.chatgpt.com/docs/models)では、Solは複雑なコーディング、Lunaは範囲の明確な反復作業向けとされる。新2モデルの提供先はWorkとCodexで、Chatとは区別されている。

この端末で稼働中のDesktopバックエンドを直接調べると、Codexは `0.155.0-alpha.16`、Desktopパッケージは `26.917.6896.0` だった。PATH上の別のCodexは `0.153.4` であり、今回の受入検証には稼働中と同じ `0.155.0-alpha.16` 実行ファイルを使用した。公開CLIの最新版を端末の導入済みバージョンと混同していない。

設定はCompatibility V1、Automatic、Pro・Extra High有効、Bigger Context有効。保存済みの既定モデルは `chatgpt-web/pro` だった。設定値は変更していない。

## 確認した影響

修正前の5枠は、`gpt-6-astra`、`chatgpt-web/light`、`chatgpt-web/high`、`chatgpt-web/extra-high`、`chatgpt-web/pro`。新2モデルは通常一覧に存在しても、この候補集合には入っていなかった。

ネイティブの通常リクエストと圧縮リクエストは、既存の転送処理で新モデルIDをそのまま扱える。Web側のモデル識別子をGPT-6へ一括置換する必要はなく、それを行うと別系列の指定を混同する。

実測カタログではAstra / Solのreasoningは `low, medium, high, xhigh, max, ultra`。Lunaは `low, medium, high, xhigh, max` で、`ultra` を広告していない。3モデルの `context_window` は272,000、`max_context_window` は872,000で、最大値が自動的に有効になっているという意味ではない。

## ソース変更

優先枠の定義と適用条件は `src/subagent-model-roster.ts` の純粋関数へ分離した。Compatibility V1かつ指定5モデルすべてが一覧表示・API対応の条件を満たす場合だけ、表の順で優先順位0〜4を割り当てる。その他の対象行は優先順位5以降に置く。`src/model-catalog.ts` は完成したカタログにこのポリシーを適用するだけとし、通常のモデル行・表示可否は保持する。

Nativeプロトコル、旧カタログ、段階提供中で対象モデルが欠ける場合、Pro非対応、手動モードでは従来の処理を維持する。変更対象のネイティブ行はpriorityのみで、reasoning、ツール能力、コンテキスト値、モデルIDは保持する。既存のCompatibility V1によるプロトコル指定は継続する。

`tests/subagent-model-roster.test.ts` に新5枠、入力非破壊、再適用時の同一性、欠落・非表示・API非対応モデル、Nativeモードの単体検証を集約した。`tests/model-catalog.test.ts` はカタログ結合とPro非対応時の回帰に限定し、`tests/native-passthrough.test.ts` ではGPT-6の3モデルについて通常・圧縮リクエストの転送を検証した。

`scripts/smoke-codex-catalog.ts` と `scripts/smoke-codex-subagents.ts` は取得済みカタログを入力できるようにし、子モデルIDを指定して検証できるようにした。既定のネイティブ子モデルも固定の旧Solからカタログ上の優先候補へ変更した。

## 検証結果

| 検証 | 結果 | 範囲 |
| --- | --- | --- |
| 問題再現 | 修正前に新5枠の回帰テストが失敗 | 実際の旧候補集合との不一致を確認 |
| 関連7ファイル | 72成功、0失敗 | 優先枠ポリシー、カタログ、転送、公開モデル、ブラウザー系列選択 |
| TypeScript | 成功 | ソース・テスト・検証スクリプト |
| 全コアテスト | 既知のWindowsシンボリックリンクfixture 2件を除いて成功 | 失敗2件はいずれもfixture作成時の `EPERM` |
| 稼働版Codexのカタログ読込み | 成功 | 修正後5モデルの順序・公開メタデータ |
| 稼働版Codexの5モデル別ライフサイクル | 5モデルすべて成功 | ツール宣言、子・孫生成、モデル・reasoning指定、追加指示、結果回収 |

全体テストの2失敗は、`codex-integration.test.ts` のシンボリックリンク用fixture作成がWindowsの `EPERM` で拒否されたもの。該当テストとホスト権限は変更していない。これは既存の `docs/fork-integration.md` にも記載された環境制約であり、全体テスト合格とは扱わない。

ライフサイクル検証は実際のCodex実行ファイルとローカルの模擬Responsesサーバーを使用した。5モデルへの実際の生成リクエスト、アカウントごとの実通信受入、性能・速度・消費量比較、本番画面での確認は含まない。

証跡はGit管理外の `output/gpt6-update-20260923/` に保存した。取得カタログは `catalog-before.json`、全体テストは `core-tests.log`、モデル別ログは `lifecycle-*.log`。`output/subagent-*-v1-proof.json` と `output/subagent-*-v1-declarations.json` にライフサイクルと実際の宣言を保存している。

## 運用反映

この変更はソース上のカタログ生成ポリシーである。稼働中の5.0.8ランタイムへ反映するには、統合後のソースからランタイムをビルドして差し替え、サービスを再起動する必要がある。

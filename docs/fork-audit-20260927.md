# フォーク調査・GitHub同期記録（2026-09-27）

## 完了した同期

修正版 `6.1.1-fork.7` に対応するソース、テスト、説明文書は、コミット `bcea6063c3ac61e456565fbf58dbbda24a12d954` として GitHub に反映済み。`git ls-remote` で `origin/main` と `origin/codex/model-controls-repair` の双方がこのコミットを指すことを確認した。この記録の追加前の同期状態であり、本記録自身を含むコミットとは区別する。

- 同期先: https://github.com/MihokTim/codex-chatgpt-web
- 同期対象: 28ファイル、889行追加、94行削除。
- リリースタグは作成していない。
- 当該コミットの Actions 実行一覧、check-runs、combined status には実行結果がなかった。CI成功とは扱わない。Actions は enabled だったが、実行記録がない理由は未確認。
- `src/adapters/chatgpt-web/model-selection.ts` は変更表示が残っていたが、作業ファイルと HEAD のバイト列が完全一致した。内容差分は確認されていない。ファイルの破棄や書き戻しはしていない。

以前のデプロイ検証は `output/completion-repair-20260927/verification.md` と同ディレクトリの記録を参照。このフォーク調査ではアプリを再デプロイしておらず、稼働中の状態を再検証したとも扱わない。

## 調査範囲と限界

収集スナップショットは `2026-09-27T02:57:13.032353+00:00`。一次収集では直接フォーク925件、ブランチ1,535件を取得し、ブランチ先頭SHAが `upstream/main` の履歴にないリポジトリ216件を抽出した。

REST の network/forks count は当初941、GraphQL の直接フォーク数は収集中に925から926へ変化した。941件すべてを調べたという意味ではない。SHAが異なるだけでは独自機能の存在や有用性は確定しない。未統合コミットには、同等パッチ、古い試作、説明文書、マージ記録が含まれ得る。

一次資料は `output/fork-audit-20260927/` の `forks-all.json`、`candidates.json`、`fork-page-*.json`。これらはローカル調査資料であり、この文書をGitHubで読む環境に必ず存在するとは限らない。

取得済みの Evanlau1798 と Nolane-x について、Git履歴・差分統計・機能文書を読んだ。追加候補の一括取得、その後の追加読み取りはツール実行前に拒否されたため、下記は**採用前の評価**である。機能実装の全面的なコードレビュー、移植、動作検証を完了したものはない。

## 有力候補

| 候補 | 確認した内容 | 判断 |
| --- | --- | --- |
| Evanlau1798/codex-chatgpt-web | ローカル Chat Completions API の詳細仕様、ランチャー設定、利用制限・状態保護などのコミット履歴 | 外部エージェント接続用として優先調査。現在の修正版へ丸ごとマージしない。 |
| Nolane-x/codexweb | Council 4.1 README、Mission Control、永続チャット、実行状態・操作履歴の設計、関連コミット履歴 | 複数チャットの統括用として有望。既存Codexブリッジへの小規模追加とは扱わず、独立した移植・併用評価が必要。 |
| trukhinyuri/codex-superpower | 統合モデル一覧、CLIProxyAPI、診断、更新・再起動関連のブランチ情報 | モデル接続と診断は調査価値あり。Windows適合性と外部プロキシ依存を確認する。 |
| kocourekwork-sudo/codex-chatgpt-web | Claude gateway、ストリーミング、ブラウザレーン分離のブランチ情報 | 連携方向と対応プロトコルを最初に確認する。CodexとClaudeの双方向委譲が完成済みとは判断できない。 |
| notKleja/codex-chatgpt-web | brief-only Web subagent turns のブランチ情報 | 調査用サブエージェントの入力削減候補。継承すべき指示、作業環境、必要文脈の欠落を検証する。 |
| f0909172434/codex-chatgpt-web | 更新ダウンロードの割合・プログレスバー、proxy/mirror のブランチ情報 | 割合表示だけを小さく移植できるなら実用候補。ミラー追加とは別に評価し、更新元とハッシュ検証を維持する。 |
| GordeyTsy/codex-chatgpt-web | 大きなメッセージのautolink・履歴走査関連のブランチ情報 | 長文入力への効果が再現できれば有用。現在の6.1.1とfork.7への適合性は未確認。 |
| omarcosr/codex-chatgpt-web | broker response-frame settlement の独立ブランチ情報 | 新機能ではなく信頼性候補。mainには検証ステップをコメントアウトする変更があり、main全体を採用しない。 |

上の後半6件は主に収集済みのブランチ名・コミット見出しによる候補抽出であり、実装を読んで品質を確認したという意味ではない。

## 詳しく確認した機能文書

### Evanlau1798: ローカルAPIからWebモデルを使う

参照: `fa514a4630e322c9dd50ac2345956b2b64918821` の `docs/chat-completions.md`。

- ソース: https://github.com/Evanlau1798/codex-chatgpt-web/blob/fa514a4630e322c9dd50ac2345956b2b64918821/docs/chat-completions.md
- 初期状態は無効。ランチャーで有効化し、専用のローカルAPIキーを発行する設計。
- `GET /v1/models` と `POST /v1/chat/completions` を公開し、テキストと関数呼び出しの限定的な互換性を提供する。
- loopback限定、管理・Native2の権限分離、入力サイズ・応答キューの上限、キャンセル・レート制限への対応が仕様に含まれる。
- 文書中の外部クライアント例は pi。オフラインのpi試験と、サインイン済みChatGPTへの実推論試験を明確に区別している。
- 画像・音声・ファイル・一部の生成パラメータなどは未対応。公式APIと同等の機能、利用枠、課金、トークン計測を提供するものではない。

外部オーケストレーターがChat Completions形式を受け入れる場合の接続候補にはなる。ただし、特定の外部アプリとの互換性や、CodexとClaudeが互いに仕事を委譲する機能は、この文書だけでは証明されない。文書自身もWindowsでの検証と既存経路の回帰確認を必要としている。

`upstream/main` との先端比較では691ファイル、92,135行追加、29,665行削除が表示された。これは共通祖先からの純粋な機能差分数ではない。規模が大きく、API部分だけでも現在のアカウント状態、キャンセル、ツール結果検証との統合設計が必要。

### Nolane-x: Council 4.1

参照: `4dfd85b25f9f2dbb7bdfadf4ea70b1d276acc0be` の `README.md`。

- ソース: https://github.com/Nolane-x/codexweb/blob/4dfd85b25f9f2dbb7bdfadf4ea70b1d276acc0be/README.md
- Mission Controlにチャット、エージェント、作業、メモリ、実行、接続、診断などをまとめる設計。
- 永続的なChatGPT会話を担当者として管理し、別の会話に作業・批評・再開を依頼する。
- 実行状態、送信開始の有無、再試行の可否、キャンセル、操作記録を一つの実行管理層で扱う。
- 送信が始まった後の不確かな処理は、自動再送せず未確定として扱う方針。
- READMEにはWindows/macOS/Linux検証済みという作者の記載があるが、この調査でその試験を再実行・確認したわけではない。

これはChatGPT会話同士を管理する独立色の強いアプリで、CodexとClaudeを同じ権限モデルで自由に往復させる実装が確認できたわけではない。Bun 1.3.14を前提にした文書で、現在のこのリポジトリのBun 1.4.0や6.1.1構成との互換性は未検証。

## 追加候補の参照先

| リポジトリ | ブランチ | 収集した先頭SHA |
| --- | --- | --- |
| trukhinyuri/codex-superpower | main | `cdef3dca611b621a81f2674c9a44600c7927ad50` |
| kocourekwork-sudo/codex-chatgpt-web | fix/claude-gateway-streaming-stability | `e6d566ae3b8d82ddf17f3fc92aff4271df17aaef` |
| notKleja/codex-chatgpt-web | feat/brief-only-research-context | `c3dcadf1712b025400a2d1bea6484247c9356d5a` |
| f0909172434/codex-chatgpt-web | fix/updater-proxy-and-mirror-support | `68127df3ae60094dc68a1828bd2dedb928e8dcf9` |
| GordeyTsy/codex-chatgpt-web | main | `01f744ed17932403dec3538b48cb41edbfb145d0` |
| omarcosr/codex-chatgpt-web | fix/native-broker-response-frame | `cbed4a53aad4df131426c85fc555f575efc86edc` |
| 159753a52/codex-chatgpt-web | feat/task-queue-loop | `6e40a25ec7b453e21a893f89c360594fc9773acb` |
| ioio101/codex-chatgpt-web | grok-local-compaction | `913f8281ed255745fa3811e066544e159e19c218` |
| elmakus/codex-chatgpt-web | design/cliproxyapi-native-aggregator | `e53218bbceb3b46e27a277aef647dccdb53ae473` |
| learninto/codex-chatgpt-web | main | `3b8f02f23cadec504b8915f1f7e4b9e39d9b91e1` |

task queueは既存の再開・完了判定と衝突しないこと、ローカル圧縮は外部送信先・文脈喪失・追加費用、構造化relayは現在のNative2との役割重複を確認する。`design/` のaggregatorは、ブランチ名と見出しの段階では設計資料の候補であり、完成した接続機能として数えない。

## 採用判断と残作業

独自機能のソースへの組み込み、テスト、アプリへのデプロイは未実施。価値が高そうな機能と、そのまま採用できる機能を区別する。

小さく導入する候補は更新進捗表示と長文処理の改善。機能拡張として優先調査する候補はローカルAPIとClaude gateway。Councilは独立した統括アプリとしての評価対象とする。既存のfork.7の送信所有権、完了判定、キャンセル、認証、更新元の保証を維持できることを採用条件とする。

残作業は、候補コードと共通祖先・現在のソースの比較、既存機能との重複確認、ライセンス確認、必要な差分だけの移植、対象を絞った回帰試験。実モデル検証が必要な場合はユーザー指定のGPT-5.6 Proを使う。GPT-6 Proでの追加検証は行っていない。

追加調査中の実際のツールエラーは次のとおり。

> リクエストの安全性を確認できなかったため、このツールの呼び出しは OpenAI によってブロックされました。

拒否された処理は実行されていない。詳細な理由は返されておらず、ファイル欠落、GitHub認証切れ、ユーザー権限不足とは断定しない。拒否された読み取りや取得を別経路で再実行していない。

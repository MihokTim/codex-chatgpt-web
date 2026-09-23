# 6.0.0更新・独自修正レビュー

調査・実装日: 2026-09-23 JST。旧main `1f125ea`、上流 `v6.0.0 = 212ceef2acac9d6ee0f3c9037abfaf4ad8ff9827`。
前タスクが残したmergeを継続し、上流の履歴とフォークの履歴を両方保持した。フォークの作り直しやforce-pushは不要。

## 今回の導入エラー

公式6.0.0ランチャーは通常の `~/.codex/config.toml` を統合先とする。一方、前回導入したフォークのjournalは
`~/.codex-chatgpt-web/codex-home/config.toml` を指していた。公式版への上書きで独自のhome分離実装が失われ、
`Codex integration journal belongs to ... not the active config ...` と正しく拒否された。
更新ログは公式6.0.0への入れ替えを示し、journalとWeb設定は残存していた。通常のNative設定は
`gpt-6-astra / high` のままで、Web routeを強制的に通常設定へ移す必要はない。

journalのpathだけの書き換え、journal削除、ログインプロファイル削除は復旧方法にしない。
上流6.0.0へhome分離を統合し、ランチャーとruntimeを同じ候補から更新する。
再発防止として、fork-metadataを同梱するランチャーは上流の新規releaseを通知するが、その公式installerへの直接上書きを止める。
独自修正を統合した候補を使用する旨を日本語で案内する。公式配布版のupdate挙動は変更しない。

## 更新内容の根拠

- [作者の6.0.0 release](https://github.com/miuuyy/codex-chatgpt-web/releases/tag/v6.0.0): モデル名とEffortを分離、Pro使用量のローカル推計、各ターン新規会話・通常会話保存の任意設定、Linux ARM64、memento圧縮、hook・起動・ブラウザー・Markdown修正。
- [作者の#637コメント](https://github.com/miuuyy/codex-chatgpt-web/issues/637#issuecomment-5786801438): GPT-5.6 Sol／ProとGPT-6 Proの系列選択を6.0で実装したと明言。独自の新規モデル名を追加し続ける理由はなくなった。
- [作者の#619コメント](https://github.com/miuuyy/codex-chatgpt-web/issues/619#issuecomment-5788141899): responses/mementoとnative rolloutによる環境復旧。全継続失敗が直ったとは述べず、元の長期タスクで再試験を求めている。
- [#640](https://github.com/miuuyy/codex-chatgpt-web/issues/640) はhook変更検出、[#639](https://github.com/miuuyy/codex-chatgpt-web/issues/639) はturn_id不一致の未解決報告。今回のhome不一致と同一原因ではない。
- [OpenAI公式changelog](https://learn.chatgpt.com/docs/changelog): 9/22にGPT-6 Sol／LunaをCodex・Workへ段階提供、CLI 0.156.1はカタログへ追加。ChatのSol／Lunaバックエンド名まで一括変更してはいけない。

このPCのCodexは公式更新確認で `26.917.62051 / build 10789 / prod / up_to_date`。
実行中の同梱CLIは `0.155.0-alpha.16.3` で、カタログに `gpt-6-sol` と `gpt-6-luna` が存在する。
公開安定CLI 0.156.1とDesktop同梱CLIは別配布物であり、番号を同一視しない。
公開changelogでDesktopの当該buildの全変更点は確認できなかったため、そこは断定しない。

## 修正ごとの判断

| 修正・対象 | 判断 | 6.0での扱い・理由 |
| --- | --- | --- |
| NativeとWebのconfig/cache/session分離、専用起動 | 維持 | 上流に相当機能なし。今回の復旧に必要。通常のNative設定を汚さない |
| `1f125ea` 旧Pro/ultra選択の移行 | 永続的な移行互換として維持 | このPCでは移行済みで再実行されない。他の旧環境や復元後の再移行に必要。完全一致する選択だけを移し、hash付き退避・変更検出・rollbackを保つ |
| 同一versionでも旧homeをupgradeする判定、setup checkpoint | 維持 | version番号だけでは独自機能の導入状態を判別できない |
| Webモデルの新規表示名、effort grouping | 上流へ置換 | GPT-5.6 Sol Instant／Sol／Pro、GPT-6 Proを使用。新規Proはmax |
| `light`をSol Proへ流用 | 新規用途は終了、互換だけ維持 | 新規は`chatgpt-web/gpt-5.6-pro`。保存済みlightタスクはSol Pro/ultraのまま、非表示legacy行に残す。Instantへ戻すと既存タスクの意味が変わる |
| 系列選択・送信前検証 | 上流方式と統合 | named routeは上流の系列・実モデル説明検証を使い、独自のfocus復旧、範囲検証、送信前composer復元、非再試行エラーを維持。legacy経路の系列検証も保持 |
| 使用量計測 | 上流採用 | 確認したモデル情報を選択時に受け渡す。opt-in設定は自動で有効にしない |
| Pro圧縮のmax→xhigh | named routeでは廃止 | GPT-6 Proを選んだのに圧縮だけGPT-5.6へ変わるのを防ぐ。従来の非固定Pro経路の互換処理に限定 |
| DEVのMedium固定 | 廃止し上流へ置換 | 独立したInstant経路が復活したため、Proを避けるための代替Mediumは不要 |
| 5モデルの優先枠 | 実装更新して維持 | Web GPT-6 Pro、Web GPT-5.6 Pro、native Astra、native GPT-6 Sol、native GPT-6 Luna。旧nativeしかない時は各5.6へfallback。ID・能力は偽装しない |
| family別会話・再送cache分離 | 維持・拡張 | 新しいmodelFamilyも会話key／圧縮継続scopeへ含める。片方の答えを別系列へ再利用しない |
| helper間の系列／effort／multipart伝播 | 維持・拡張 | 新しいpinned-model-family capabilityを追加。古いhelperが新しい固定系列を無視して送信しない |
| 回答を送信済みuser IDへ結びつける修正 | 維持 | ACKや古いassistantの再描画を今回の回答にしない独自チェックは上流と別 |
| 思考失敗の一度だけの復旧 | 維持 | 完了済みtool結果を正本で確認し、再実行しない。サービス側の思考失敗自体を直すものではない |
| terminal errorの再接続再生 | 維持 | observerの再接続でモデルを再送しない。HTTP切断と物理実行の終了を分離 |
| 同一pageの再接続予算共有 | 維持 | viewportとDOM観測で上限を二重消費しない |
| 圧縮後の環境・grouped preamble・権限検証 | 維持して上流memento対応を統合 | current/source native turnを確認し、cacheから権限を補わない |
| 日付切替のcwdなし環境更新 | 両実装を共通policyへ統合 | 上流のcalendar-only fragmentと独自のworkspace_roots付きrefreshを受け付ける。calendar更新は正本がdangerFullAccessの場合のみ |
| Codexアプリのcreate/send配達 | 維持して上流構文認識を採用 | HTTP入口でnative destinationの正本照合を継続。上流のsend認識だけではcreate対応と正本改変拒否の代替にならない |
| tool境界での圧縮・保持会話の失敗復旧 | 維持 | 未回収toolを再実行せず、必要時だけ正本からfresh summaryへ。新規会話設定も上流と統合 |
| 6分割Bigger Context | 上流採用を継続 | 1/2/6部の通信。総contextは従来の3倍のまま。利用者の有効設定を保持 |
| HTTP符号化前後の受入上限 | 維持 | 128/256 MiBの独自境界と実byte試験。最大メモリの保証とは異なる |
| 障害記録・512件復旧容量表示 | 維持 | 作者のbroker診断と補完関係。外部recorderを今回自動導入しない |
| optional Desktop history guard | ソースのみ維持 | 対応する外部MCP版・hashを限定。Desktop更新だけを根拠に未知版へ再適用しない |
| build input hash・fork identity・rollback | 維持 | 同じversion表示でも公式版／独自版を識別し、入力変更を検出する |
| 旧DEPLOY_REAL_ENV.ps1のnode PATH・tray終了対策 | 導入作業用、製品runtimeには不採用 | 一回限りの配布物は記録として保存。今回の更新でも実行環境を固定し、正式なランチャーAPIで終了する |

### 5モデル

| 順位 | ID | 用途 |
| --- | --- | --- |
| 0 | `chatgpt-web/gpt-6-pro` | WebProAstra、系列を送信前に検証 |
| 1 | `chatgpt-web/gpt-5.6-pro` | WebProSol |
| 2 | `gpt-6-astra` | nativeAstra |
| 3 | `gpt-6-sol` | native6sol |
| 4 | `gpt-6-luna` | native6luna |

通常のモデル選択から他のnativeモデルは削除しない。5枠予約はCompatibility V1のみ。
通常Nativeアプリの設定と、Web専用homeを使うCodexの設定は独立する。

## 検証と残る範囲

現行同梱CLIからのカタログsmokeで上記5枠を実測。5モデルそれぞれの親・子・孫・follow-upを
実Codex CLIとloopbackの模擬Responsesで確認した。既存Web defaultsのsmokeも確認する。
これはモデルサービスへの実生成、料金、速度、実アカウントでの5並列の証明ではない。

core/launcher型検査、version同期、依存audit、renderer build、モデル・権限・復旧・移行回帰、
配布runtimeとランチャー候補を検証する。Windows symlink fixtureのEPERMはOSの権限制約として別記し、
未実行を合格に数えない。最終実行件数と導入結果は導入記録に記載する。

画面のクリックは復旧に必須ではなく、設定照会・ビルド・導入・setup・doctorをAPI/CLIで行う。
nativeアプリ終了、ログインのやり直し、OS権限変更を復旧の前提にしない。

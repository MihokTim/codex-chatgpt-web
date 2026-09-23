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
| optional Desktop history guard | 対応版を限定して維持、再適用不要 | 導入済み0.1.4のserver/helperのhash照合とsourceAligned確認が成功。Desktop更新だけを根拠に未知版へ再適用しない |
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
実Codex CLIとloopbackの模擬Responsesで確認した。既存Web defaultsのsmokeも成功した。
これはモデルサービスへの実生成、料金、速度、実アカウントでの5並列の証明ではない。

ソース `23d4e053822c000476802e22bd731f9617a075e8` をclean状態でビルドした。
core/launcher型検査、version同期、依存audit、renderer build、配布runtimeのrelocation／home移行、
隔離したWindows packaged launcherの起動・runtime配置は成功した。

| 試験 | 最終結果 |
| --- | --- |
| core全79ファイル | 1,081成功、2skip、2失敗（計1,085） |
| launcher全試験 | 335成功、4skip、1失敗（計340） |
| 残る失敗3件 | すべてWindows symlink fixture作成時のEPERM。製品処理に到達できず、合格には数えない |
| Codexカタログ | 同梱CLI 0.155.0-alpha.16.3で優先5枠を確認 |
| 子・孫タスク | 5モデルのCompatibility V1起動・結果回収・follow-up、旧Web defaultsが成功（模擬Responses） |
| runtime/launcher配布smoke | 成功。バージョン6.0.0、packaged/runtimeVerifiedともtrue |

全体の `verify` はsymlink権限により完全成功とはいえない。skipは外部MCP fixture・外部サービス・OS固有項目。
実アカウントでの生成や長期圧縮の再現は今回の自動試験の範囲外。導入済みhistory guardのcheckは成功し、
再適用はしていない。incident recorderの既存停止状態（running=false）も維持した。

画面のクリックは復旧に必須ではなく、設定照会・ビルド・導入・setup・doctorをAPI/CLIで行う。
nativeアプリ終了、ログインのやり直し、OS権限変更を復旧の前提にしない。

## このPCへの導入結果

2026-09-23 20:58 JSTまでに、統合版6.0.0のNSIS installerで更新し、既存設定の自動upgradeが成功した。
通常のNativeアプリは終了させず、ブリッジだけを正式なランチャーAPIで正常終了・再起動した。

- 配布ソース: `23d4e053822c000476802e22bd731f9617a075e8`（clean build）。
- fork build: `mihoktim-6.0.0-upstream-212ceef-20260923`。
- runtime bundle: `45921e6b8a3f4a89a5d7ea7e23a1512ffe81607e71ce40cb5e81ecd60c2ab725`。
- installer SHA-256: `d32831436a40b2a004d0d5d2ca2868d51dd6cb2e4c9a8bc10766e747aabee02f`。
- `/healthz`: 6.0.0、full、accepting_turns=true、HTTP/browserのactive turn=0。
- 実Codex CLIからブリッジ経由でモデル一覧取得がHTTP 200。上記5モデルの優先順も一致。
- ランチャー: coreSetupComplete、codexCatalogVerified、mcpSetupCompleteすべてtrue。codexRestartRequired=false。
- 既存ChatGPT認証を保持し、ブラウザー状態ready。MCP確認APIで`Codex Native2`の利用可能性を確認、全10項目ok。
- journalのconfigPathは引き続きWeb専用home。通常の`~/.codex/config.toml`は導入前後でSHA-256一致。
- Bigger Context=true、fresh conversation=false、saved chats=false、Compatibility V1を保持。
- 復旧のための実モデル生成やPro推論は実施していない。上記MCP確認はモデルへの依頼送信ではない。

ローカル配布物と実行記録は `C:\Users\MihokTim\dev\codex-chatgpt-web-deploy\23d4e05-v6-20260923`。
同ディレクトリの`rollback-20260923-205205`に更新前のアプリ、core home、browser認証を含むuser data、
native config/cache/authを退避した。バックアップには秘密情報が含まれるためGitへ追加しない。
Windows installerはローカルで作成・導入したものであり、GitHub Releaseへの公開はしていない。

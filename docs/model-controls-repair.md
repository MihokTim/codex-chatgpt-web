# モデルメニューと共有ヘルパーのキャンセル修正

対象ビルド：6.1.0-fork.5。調査日：2026-09-26。

## 確認した障害

16:14:52 JSTの診断では、選択確認の直前と失敗時の両方でモデルメニューが
`aria-expanded=true / data-state=open` だった。旧実装はEscapeを一度送って250ms待ち、
閉じたことを確認せずラベルを保存していた。その結果を「選択したeffortが保持されていない」
というエラーにまとめていた。Escapeを一度無視する場合と閉じる処理が650ms遅れる場合を
実DOMの回帰テストに追加し、修正前の失敗を確認した。

5.6の選択は13:22、15:53、15:59に送信前に失敗していた。実アカウントのモデルメニューでは、
simple viewのradio行は矩形を持ち可視と判定されても、親の`inert`によって操作不能だった。
旧実装はモデル一覧を開くclickの反映を確認せずradio操作へ進んでいた。
新実装はadvancedへの遷移を確認し、同じURLでsimpleのままの場合に限ってprimary pointerdownを
一度試し、要求familyのchecked状態を再検証する。過去の失敗ログには元例外がないため、
すべての5.6失敗を同一原因だったと断定するものではない。

実機の追試で5.6の選択が一度失敗したため、family操作のタイムアウトも同じdocumentの
メニューを一度だけ開き直して回復する対象に追加した。認証・頻度制限は先に独立して検査し、
family不一致・欠落が確認された場合、URL/documentが変わった場合、二回目の失敗は停止する。
エラーには固定の操作段階を記録し、元のページ本文やPlaywrightの詳細ログは通知に出さない。

16:27:36 JSTには別タスクの圧縮キャンセルに続き、共有Nodeヘルパーが
`DOMException [AbortError]: ChatGPT external progress wait aborted`で終了した。
スタックは`waitForChange → waitForTurnDomOrExternalProgress → waitForNewAssistantTurn`。
直後に修正作業中の別ターンもaccepted状態から失敗した。
`withBrowserTurnAbort`が中止済みsignalを見て早期returnし、すでに生成されていたPromiseの
rejectを未処理にしていた。Nodeのstrict rejection設定を使う独立プロセステストで
同じスタックと異常終了を再現した。

## 修正

メニューの終了は最大5秒・最大3回のEscapeで確認する。最初の操作が反映されなければ
所有controlにフォーカスしたEscapeを使用する。URLとdocumentのtimeOriginを確認し、
閉じた状態が100ms維持された後でラベルを読む。モデル切替、effort選択後、送信前検証後の
終了に同じ処理を用いる。閉じないメニュー、選択値の変化、異なるfamily、範囲異常は
引き続き送信前に停止する。

キャンセルのラッパーは中止済みであっても入力Promiseの成功・失敗双方を監視する。
キャンセル通知と操作の終了でlistenerを解放する。全体のunhandled rejectionを握り潰す
ハンドラーや、作業を無条件に再送する処理は追加していない。

## 検証と配備

`tests/browser-abort-isolation.test.ts`はNode子プロセスのstrictモードで、中止済み、
DOM待機開始中の中止、遅れてrejectするDOM操作、external progressなしを検証する。
各ケースで別ターンのprogressが継続できることを確認する。
`tests/effort-focus.test.ts`と`tests/composer-surface.test.ts`は開閉遅延、無反応、
inertのradio行、両Pro familyと誤選択拒否を扱う。
`tests/model-family-recovery.test.ts`では、初回だけ操作不能なモデル切替を再現し、
再選択が一回だけで、本文を維持し、送信回数がゼロであることを確認する。

実アカウントのコントロール確認、全体検証、ビルド、配備の結果は
`output/model-controls-repair-20260926/`に保存する。
候補ビルドの検証と、稼働中プロセスへの反映は別々に記録する。
共有ヘルパー・daemonの再起動は稼働中タスクを巻き込むため、active ownerが残る状態では
配備を完了扱いにしない。

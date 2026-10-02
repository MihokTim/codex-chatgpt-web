# WindowsでのUTF-8診断

`scripts/orca-diagnose.py`は、読込対象のTOML・JSONをBOMの有無にかかわらずUTF-8として扱い、診断結果をUTF-8 JSONに保存します。日本語やU+FFFD（置換文字）が含まれる場合も、文字を削除・置換せず保存します。不正なUTF-8バイトはエラーとして記録します。

## PowerShellでfixtureを読む

Windows PowerShell 5.1では、BOMなしUTF-8ファイルを`Get-Content`の既定動作で読むと、環境の既定文字コードによって文字化けや行数の誤認が起こります。診断用fixtureを読む場合は文字コードを明示してください。

```powershell
$fixturePath = Join-Path (Get-Location) 'output\web-native-isolation-20260928-2322\fixture.txt'
$fixtureText = Get-Content -LiteralPath $fixturePath -Raw -Encoding UTF8
$fixtureLines = @(Get-Content -LiteralPath $fixturePath -Encoding UTF8).Count
```

2026-09-29の合成fixture検証では、Windows PowerShell `5.1.26100.9444`、既定コードページ932で、40バイト・4行のUTF-8テキストが既定読込では3行になりました。`-Encoding UTF8`では4行となり、日本語・U+FFFDを含む内容が完全一致しました。PowerShell 7の`pwsh`は今回のPATHでは見つからず、7での実行検証はしていません。プロファイルやシステムのコードページを変更する必要はありません。

## 保存JSONとコンソールJSON

保存先は従来どおり`--output`で指定します。`--exe`は比較対象の明示指定であり、別の実行ファイルやhomeへの自動切替は行いません。

標準出力の要約JSONは`ensure_ascii=True`で生成します。例えばU+FFFDはJSON上の`\ufffd`として出力され、JSONパーサーで元の文字に戻ります。CP932へリダイレクトしてもエンコードに失敗しません。保存JSONは`ensure_ascii=False`と明示的なUTF-8で書くため、元の文字がそのまま残ります。この標準出力形式は従来のASCIIエスケープ形式を明示したものです。

CP932の標準出力に`print(chr(0xfffd))`を直接出すと、Pythonの`UnicodeEncodeError`になります。これはローカルの文字コード変換失敗です。OpenAI側の安全性拒否や認証・推論の成功を示す証拠にはなりません。

## 部分失敗の読み方

既存のフラグ、正常時の主要JSON項目、アプリサーバー失敗時に結果を保存する動作を維持します。独立した読込失敗は次の追加項目で明示し、残りの診断結果を保存します。

| 保存JSONの項目 | 意味 |
| --- | --- |
| `homes[].config_error` | TOMLの読込・UTF-8デコード・構文・構造のエラー |
| `homes[].cache_error` | モデルキャッシュJSONの読込・デコード・構造のエラー |
| `homes[].app_server_error` | 従来からあるアプリサーバーの起動・RPCエラー |
| `orca_catalog_error` | 存在する任意カタログが読み込めない、または壊れている |

任意カタログが存在しない場合は`orca_catalog: []`です。存在するが壊れている場合は空配列に加えて`orca_catalog_error`が付くため、正常な空結果と区別できます。設定が壊れていても同じhomeのキャッシュ検査と、明示された同じhomeに対する既存のapp-serverプローブを試行します。

従来どおり、部分失敗がJSONに記録されてもプロセス終了コードが0になる場合があります。診断成功の判定には各エラー項目も確認してください。必須実行ファイルの欠落や保存先への書込失敗などを成功として扱う変更はしていません。

RPCタイムアウトには待機していたメソッド名を記録し、stdoutのEOF・UTF-8デコード失敗も待機側に通知します。入力の壊れたパイプが元のRPCエラーを覆い隠すことを防ぎ、後片付けではこの診断が作ったプローブだけを終了します。`--version`の出力も明示的にUTF-8で読みます。

## 合成データだけの回帰テスト

```powershell
python -B tests/orca-diagnose.test.py -v
```

Python 3.11以降の標準ライブラリだけで実行できます。実際のCodex/Orca実行ファイルは起動せず、一時ディレクトリの設定・キャッシュ・カタログと偽のサブプロセスを使います。実設定、認証情報、セッション、推論にはアクセスしません。

テストはBOM付きTOML/JSON、日本語とU+FFFD、不正UTF-8、構文・構造破損の隔離、任意カタログ欠落、既存の秘匿化、RPCタイムアウト/EOF/デコード失敗/後片付けを検証します。さらに実際のPython子プロセスをCP932標準出力で動かし、要約JSONとUTF-8保存内容の一致を確認します。Windows PowerShellが利用できるWindowsでは、UTF-8明示読込とCP932既定読込の違いも非機密fixtureで検証します。

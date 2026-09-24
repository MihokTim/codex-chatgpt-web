import type { Language } from "./types";

const en = {
  title: "Updates", installed: "Installed build", release: "Latest published release",
  published: "Published", integrated: "Integrated upstream revision", source: "Upstream source",
  checking: "Checking…", check: "Check now", unknown: "Not checked", current: "Matches the published version",
  newer: "New release available", installedNewer: "Installed version is newer than the published release",
  sourceCurrent: "No unmerged upstream changes", sourceAhead: "unmerged commits",
  sourceChanged: "Upstream history differs; review the comparison", checked: "Last checked",
  lastSuccess: "Last successful check", notes: "Release notes", compare: "View source changes",
  explanation: "Published packages and source changes are checked separately. A change on main is not necessarily released.",
  fork: "Official binaries cannot overwrite this fork. Review and build upstream changes before installing a new fork package.",
  schedule: "Checks at startup and every 6 hours. Check now works without restarting the launcher.",
  failed: "Some information could not be refreshed. Previously fetched values may be out of date.",
  checkError: "Update check failed", disabled: "Automatic updates are disabled in this environment.",
  actionError: "Could not open the update page", notice: "Upstream changes", errorNotice: "Update check failed",
};
const ja: typeof en = {
  title: "更新情報", installed: "インストール済みビルド", release: "最新の公開リリース",
  published: "公開日時", integrated: "取り込み済みの上流リビジョン", source: "上流ソース",
  checking: "確認中…", check: "今すぐ確認", unknown: "未確認", current: "公開版と同じバージョンです",
  newer: "新しい公開版があります", installedNewer: "インストール済みの方が新しいバージョンです",
  sourceCurrent: "未取り込みの上流変更はありません", sourceAhead: "件の未取り込みコミット",
  sourceChanged: "上流の履歴が異なります。差分を確認してください", checked: "最終確認",
  lastSuccess: "前回の確認成功", notes: "リリースノート", compare: "ソースの差分を見る",
  explanation: "公開パッケージとソースの変更を分けて確認します。main の変更が配信版に含まれるとは限りません。",
  fork: "公式バイナリでこのフォークを上書きしません。上流の変更を確認・取り込みし、フォーク版をビルドして更新します。",
  schedule: "起動時と6時間ごとに確認します。再起動せず「今すぐ確認」も使えます。",
  failed: "一部の情報を更新できませんでした。表示中の取得済み情報は古い可能性があります。",
  checkError: "更新確認に失敗しました", disabled: "この環境では自動更新が無効です。",
  actionError: "更新ページを開けませんでした", notice: "上流の変更があります", errorNotice: "更新確認に失敗",
};

// New fork-specific copy is maintained in English and Japanese; other locales use English.
export const updateCopyFor = (language: Language) => language === "ja" ? ja : en;

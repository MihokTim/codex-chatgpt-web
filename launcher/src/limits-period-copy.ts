import type { Language } from "./types";

const en = {
  title: "GPT-6 Pro counting period", mode: "Count from", off: "Do not show a custom period",
  since: "A specific date and time", weekly: "A weekday and time, every week",
  start: "Start date and time", weekday: "Weekday", time: "Time", save: "Save period", saving: "Saving…", saved: "Period saved",
  note: "This is a manually chosen counting period, not ChatGPT's detected reset time. Only messages retained on this device in the last 7 days are counted.",
  timezone: "Computer timezone: {zone}. Weekly schedules follow this timezone.",
  from: "Counting from", through: "Through", next: "Next weekly start", available: "Available history starts",
  count: "GPT-6 Pro messages", lowerBound: "At least {count}",
  partial: "The beginning of this period predates retained history or tracking setup. Earlier messages cannot be recovered; this is a lower bound.",
  unknown: "Pro messages with an unidentified model in this period: {count} (excluded from the GPT-6 Pro count).",
  invalidDate: "Choose a valid date and time that is not in the future.",
  future: "The saved start time is in the future. Check your computer clock or change the start time.",
};
type Copy = typeof en;
const ja: Copy = {
  title: "GPT-6 Proの集計期間", mode: "集計の起点", off: "指定期間のカウントを表示しない",
  since: "指定した日時から", weekly: "毎週、指定した曜日・時刻から",
  start: "開始日時", weekday: "曜日", time: "時刻", save: "集計期間を保存", saving: "保存中…", saved: "集計期間を保存しました",
  note: "手動で指定する集計期間です。ChatGPTの実際のリセット日時を取得する機能ではありません。この端末に保存されている直近7日分の送信履歴が対象です。",
  timezone: "PCのタイムゾーン: {zone}。毎週の起点はこのタイムゾーンに従います。",
  from: "今回の集計開始", through: "集計時点", next: "次回の集計開始", available: "利用できる履歴の開始",
  count: "GPT-6 Proの送信数", lowerBound: "少なくとも{count}件",
  partial: "指定した開始日時が、履歴の保存範囲または記録開始より前です。過去の履歴は復元できないため、確認できた分のみを表示しています。",
  unknown: "この期間のモデルを特定できないPro送信: {count}件（GPT-6 Proの件数には含めていません）。",
  invalidDate: "現在以前の、有効な開始日時を指定してください。",
  future: "保存された開始日時が現在より先です。PCの時計または開始日時を確認してください。",
};
const zhCN: Copy = {
  title: "GPT-6 Pro 统计时段", mode: "统计起点", off: "不显示自定义时段",
  since: "指定日期和时间起", weekly: "每周指定星期和时间起",
  start: "开始日期和时间", weekday: "星期", time: "时间", save: "保存时段", saving: "保存中…", saved: "时段已保存",
  note: "这是手动选择的统计时段，并非自动检测的 ChatGPT 重置时间。仅统计此设备保留的最近 7 天发送记录。",
  timezone: "电脑时区：{zone}。每周起点遵循此时区。",
  from: "本次统计开始", through: "统计截至", next: "下次每周起点", available: "可用记录开始",
  count: "GPT-6 Pro 发送数", lowerBound: "至少 {count} 条",
  partial: "所选开始时间早于保留记录或启用跟踪的时间。更早的记录无法恢复，此数值仅为下限。",
  unknown: "本时段内型号不明的 Pro 发送：{count} 条（不计入 GPT-6 Pro）。",
  invalidDate: "请选择有效且不晚于当前时间的开始时间。", future: "保存的开始时间在未来。请检查电脑时钟或修改开始时间。",
};
const zhTW: Copy = {
  title: "GPT-6 Pro 統計時段", mode: "統計起點", off: "不顯示自訂時段",
  since: "指定日期和時間起", weekly: "每週指定星期和時間起",
  start: "開始日期和時間", weekday: "星期", time: "時間", save: "儲存時段", saving: "儲存中…", saved: "時段已儲存",
  note: "這是手動選擇的統計時段，並非自動偵測的 ChatGPT 重設時間。僅統計此裝置保留的最近 7 天傳送紀錄。",
  timezone: "電腦時區：{zone}。每週起點遵循此時區。",
  from: "本次統計開始", through: "統計截至", next: "下次每週起點", available: "可用紀錄開始",
  count: "GPT-6 Pro 傳送數", lowerBound: "至少 {count} 則",
  partial: "所選開始時間早於保留紀錄或啟用追蹤的時間。更早的紀錄無法復原，此數值僅為下限。",
  unknown: "本時段內型號不明的 Pro 傳送：{count} 則（不計入 GPT-6 Pro）。",
  invalidDate: "請選擇有效且不晚於目前時間的開始時間。", future: "儲存的開始時間在未來。請檢查電腦時鐘或修改開始時間。",
};
const ko: Copy = {
  title: "GPT-6 Pro 집계 기간", mode: "집계 시작", off: "사용자 지정 기간 숨기기",
  since: "지정한 날짜와 시각부터", weekly: "매주 지정한 요일과 시각부터",
  start: "시작 날짜와 시각", weekday: "요일", time: "시각", save: "기간 저장", saving: "저장 중…", saved: "기간을 저장했습니다",
  note: "직접 정하는 집계 기간이며 ChatGPT의 실제 초기화 시각을 감지하는 기능이 아닙니다. 이 기기에 보관된 최근 7일의 전송 기록만 집계합니다.",
  timezone: "컴퓨터 시간대: {zone}. 주간 시작은 이 시간대를 따릅니다.",
  from: "이번 집계 시작", through: "집계 시점", next: "다음 주간 시작", available: "이용 가능한 기록 시작",
  count: "GPT-6 Pro 전송 수", lowerBound: "최소 {count}개",
  partial: "선택한 시작이 보관 범위 또는 기록 시작보다 이전입니다. 더 오래된 기록은 복구할 수 없으며 확인된 최소 수만 표시합니다.",
  unknown: "이 기간에 모델을 확인할 수 없는 Pro 전송: {count}개 (GPT-6 Pro 집계에서 제외).",
  invalidDate: "현재보다 늦지 않은 유효한 시작 날짜와 시각을 선택하세요.", future: "저장된 시작 시각이 미래입니다. 컴퓨터 시계나 시작 시각을 확인하세요.",
};
const copies: Record<Language, Copy> = { en, ja, "zh-CN": zhCN, "zh-TW": zhTW, ko };
export const limitsPeriodCopyFor = (language: Language) => copies[language];

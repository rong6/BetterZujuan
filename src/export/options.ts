/**
 * 导出选项。
 *
 * 默认值取向：**最保守、最不容易出错**。
 * 例如默认 `as-is`：完全不重排、不动 DOM，纯靠打印样式净化，
 * 因此不存在「clone 触发图片重新请求」这类风险。
 */

/** 试卷内容的四种组织方式。 */
export type ExportMode =
  /** 保持原样：题目下紧跟答案（零 DOM 变更，最稳） */
  | 'as-is'
  /** 仅试题：答案全部去掉 */
  | 'questions-only'
  /** 试题 + 答案移至文末 */
  | 'answers-at-end'
  /** 仅答案 */
  | 'answers-only';

export type PaperSize = 'A4' | 'A3';
export type Orientation = 'portrait' | 'landscape';

export interface PrintJobOptions {
  readonly mode: ExportMode;
  readonly paperSize: PaperSize;
  readonly orientation: Orientation;
  /** 页边距（mm） */
  readonly marginMm: number;
  /** 自定义字体族（空则沿用站点字体） */
  readonly fontFamily?: string | undefined;
  /** 自定义字号（pt） */
  readonly fontSizePt?: number | undefined;
}

export const DEFAULT_PRINT_OPTIONS: PrintJobOptions = {
  mode: 'as-is',
  paperSize: 'A4',
  orientation: 'portrait',
  marginMm: 12,
};

/** 该模式是否需要离屏 clone 重排（否则可走「零 DOM 变更」的安全路径）。 */
export function requiresClone(mode: ExportMode): boolean {
  return mode !== 'as-is';
}

export const EXPORT_MODE_LABELS: Readonly<Record<ExportMode, string>> = {
  'as-is': '保持原样（题目下紧跟答案）',
  'questions-only': '仅试题',
  'answers-at-end': '试题 + 答案移至文末',
  'answers-only': '仅答案与解析',
};

/**
 * 分段控件用的短标签。
 * 四个分段并排时空间有限，长标签会被截断成「试题 + …」，因此单独给一套短文案；
 * 完整说明仍通过 title 提示展示（见 `EXPORT_MODE_LABELS`）。
 */
export const EXPORT_MODE_SHORT_LABELS: Readonly<Record<ExportMode, string>> = {
  'as-is': '原样',
  'questions-only': '仅试题',
  'answers-at-end': '答案置末',
  'answers-only': '仅答案',
};

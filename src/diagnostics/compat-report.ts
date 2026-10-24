/**
 * 页面兼容性诊断。
 *
 * 站点 DOM 会持续变化，所以「出问题时能自己说清哪里断了」是核心能力：
 * 这里输出选择器命中情况、页面指纹与失败原因，**仅在本地生成，不上传任何内容**。
 */

import { SELECTORS, resolveAll, resolveOne, type SelectionReport } from '../adapters/selectors';
import type { PaperModel } from '../adapters/types';

export interface CompatibilityReport {
  readonly generatedAt: string;
  readonly url: string;
  readonly pageTitle: string;
  /** 关键选择器的命中表 */
  readonly selectors: readonly SelectionReport[];
  readonly counts: {
    readonly sections: number;
    readonly questions: number;
    readonly answerBlocks: number;
    readonly answerImages: number;
    readonly hasGlobalToggle: boolean;
  };
  /** 采集失败时的原因 */
  readonly reason?: string;
}

function safeReportFromSelectors(doc: Document): SelectionReport[] {
  const reports: SelectionReport[] = [];
  const singles: (keyof typeof SELECTORS)[] = [
    'article',
    'main',
    'examList',
    'sectionItem',
    'titleText',
    'titleBlock',
    'titleInfoList',
    'questionWrapper',
    'questionStem',
    'questionOpt',
    'answerBlock',
    'globalToggleWrap',
    'globalToggleInput',
    'globalToggleLabel',
    'buttonContainer',
    'sidebar',
    'groupPaperRoot',
    'groupTitle',
  ];
  for (const key of singles) reports.push(resolveOne(doc, key).report);

  const multiples: (keyof typeof SELECTORS)[] = [
    'sectionTitle',
    'questionListItem',
    'questionItem',
    'groupQuestionItem',
    'groupQuestionType',
    'groupQuestionTypeTitle',
  ];
  for (const key of multiples) reports.push(resolveAll(doc, key).report);

  return reports;
}

export interface BuildReportOptions {
  readonly doc: Document;
  readonly model?: PaperModel | undefined;
  readonly reason?: string | undefined;
}

export function buildCompatibilityReport(options: BuildReportOptions): CompatibilityReport {
  const { doc, model, reason } = options;
  const selectorReports = model?.selectionReports?.length
    ? [...model.selectionReports]
    : safeReportFromSelectors(doc);

  return {
    generatedAt: new Date().toISOString(),
    url: doc.location?.href ?? '',
    pageTitle: doc.title ?? '',
    selectors: selectorReports,
    counts: {
      sections: model?.sections.length ?? 0,
      questions: model ? model.sections.reduce((n, s) => n + s.questions.length, 0) : 0,
      answerBlocks: doc.querySelectorAll('.item.answer').length,
      answerImages: doc.querySelectorAll('.item.answer img').length,
      hasGlobalToggle: doc.querySelector('#isshowAnswer') !== null,
    },
    ...(reason ? { reason } : {}),
  };
}

/** 人类可读的诊断摘要，用于面板展示。 */
export function summarizeCompatibilityReport(report: CompatibilityReport): string {
  const lines: string[] = [];
  lines.push(`页面：${report.pageTitle || '(无标题)'}`);
  lines.push(`地址：${report.url}`);
  lines.push(
    `采集：题型分区 ${report.counts.sections} 个，题目 ${report.counts.questions} 道，` +
      `答案块 ${report.counts.answerBlocks} 个，答案图 ${report.counts.answerImages} 张，` +
      `全局答案开关 ${report.counts.hasGlobalToggle ? '存在' : '不存在'}`,
  );
  if (report.reason) lines.push(`失败原因：${report.reason}`);

  lines.push('');
  lines.push('选择器命中情况：');
  for (const s of report.selectors) {
    const used = s.used ?? '（全部未命中）';
    const mark = s.used ? '✓' : '✗';
    lines.push(`  ${mark} ${s.key} × ${s.found} ← ${used}`);
  }
  return lines.join('\n');
}

/** 触发下载诊断 JSON（仅本地）。 */
export function downloadCompatibilityReport(report: CompatibilityReport): void {
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `better-zujuan-diagnostics-${Date.now()}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

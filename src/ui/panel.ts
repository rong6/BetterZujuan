/**
 * 侧边面板（自绘，不引入 UI 库）。
 *
 * 用 Shadow DOM 隔离样式：组卷网有大量全局选择器，注入裸 DOM 很容易被站点样式带偏。
 *
 * 视觉取向：配色取自扩展图标的深海军蓝（#142c52）；
 * 用细分隔线与扁平分区组织信息，而不是把每块内容都套成一个圆角卡片；
 * 主操作只保留一个（展开答案 / 导出 PDF），其余降级为次要样式。
 *
 * 信息层级按用户实际操作顺序：
 *   页面识别结果 → 展开答案 → 导出设置 → 诊断（折叠收纳）
 */

import type { CollectResult } from '@/adapters/types';
import type { AnswerLoadProgress } from '@/answers/loader';
import {
  DEFAULT_PRINT_OPTIONS,
  EXPORT_MODE_LABELS,
  EXPORT_MODE_SHORT_LABELS,
  type ExportMode,
  type Orientation,
  type PaperSize,
  type PrintJobOptions,
} from '@/export/options';
import {
  downloadCompatibilityReport,
  summarizeCompatibilityReport,
  type CompatibilityReport,
} from '@/diagnostics/compat-report';
import { BZ_ICON_DATA_URL } from './icon';

export interface PanelOptions {
  readonly adapterLabel: string;
  readonly getCollect: () => CollectResult;
  readonly refresh: () => CollectResult;
  readonly buildReport: (reason?: string) => CompatibilityReport;
  readonly onPrint?: ((options: PrintJobOptions) => void) | undefined;
  readonly onLoadAnswers?:
    | ((onProgress: (progress: AnswerLoadProgress) => void) => Promise<string>)
    | undefined;
  readonly onDocx?: ((options: PrintJobOptions) => Promise<string>) | undefined;
}

export interface PanelHandle {
  toggle(): void;
  show(): void;
  hide(): void;
  /** 重新渲染「已识别试卷」区块（外部重新采集后调用）。 */
  refresh(): void;
}

const HOST_ID = 'better-zujuan-panel-host';

const PANEL_CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }

.bz-panel {
  --navy: #142c52;
  --navy-hover: #1d3d6d;
  --navy-weak: #eef2f8;
  --navy-line: #d3dced;
  --ink: #16181d;
  --ink-2: #4a5464;
  --ink-3: #8a94a6;
  --line: #e8ecf2;
  --surface: #f7f9fc;
  --ok: #1f8a4c;
  --ok-weak: #ecf8f0;
  --warn: #8a5200;
  --warn-weak: #fff6e6;
  --danger: #c0362c;
  --danger-weak: #fdeeec;
  --r: 6px;

  /* 浮动面板：像系统窗口一样可拖动、可缩放，而不是钉死的侧边栏 */
  position: fixed; left: 0; top: 0;
  width: 400px; height: 640px;
  min-width: 320px; min-height: 320px;
  max-width: 100vw; max-height: 100vh;
  display: none; flex-direction: column;
  background: #fff; color: var(--ink);
  z-index: 2147483000;
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 16px 48px rgba(20, 44, 82, .22), 0 2px 8px rgba(20, 44, 82, .10);
  font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* ---------- 头部 ---------- */
.bz-head {
  flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
  padding: 13px 15px; border-bottom: 1px solid var(--line);
  cursor: grab; user-select: none; touch-action: none;
}
.bz-head.is-dragging { cursor: grabbing; }
.bz-head img { width: 26px; height: 26px; border-radius: 6px; display: block; flex: 0 0 auto; }
.bz-head-txt { flex: 1 1 auto; min-width: 0; }
.bz-brand { font-size: 14px; font-weight: 650; color: var(--navy); letter-spacing: .1px; }
.bz-kind { font-size: 11.5px; color: var(--ink-3); }
.bz-x {
  flex: 0 0 auto; width: 26px; height: 26px; padding: 0;
  border: none; border-radius: 5px; background: transparent;
  color: var(--ink-3); cursor: pointer; display: grid; place-items: center;
}
.bz-x:hover { background: var(--surface); color: var(--ink); }

/* ---------- 主体 ---------- */
.bz-body { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; }
.bz-body::-webkit-scrollbar { width: 9px; }
.bz-body::-webkit-scrollbar-thumb { background: #dde3ec; border-radius: 5px; border: 2px solid #fff; }
.bz-body::-webkit-scrollbar-thumb:hover { background: #c8d1de; }

.bz-sec { padding: 14px 15px; border-bottom: 1px solid var(--line); }
.bz-sec:last-child { border-bottom: none; }
.bz-sec-h {
  display: flex; align-items: center; gap: 7px; margin-bottom: 11px;
  font-size: 12px; font-weight: 600; color: var(--ink-2); letter-spacing: .3px;
}
.bz-sec-h svg { flex: 0 0 auto; color: var(--ink-3); }

/* 状态条：左侧一道竖线，比大圆角卡片更克制 */
.bz-state { display: flex; gap: 10px; }
.bz-state-rail { flex: 0 0 auto; width: 3px; border-radius: 2px; background: var(--ink-3); }
.bz-state.is-ok .bz-state-rail { background: var(--ok); }
.bz-state.is-err .bz-state-rail { background: var(--danger); }
.bz-state-main { flex: 1 1 auto; min-width: 0; }
.bz-state-title { font-weight: 600; font-size: 12.5px; }
.bz-state.is-ok .bz-state-title { color: var(--ok); }
.bz-state.is-err .bz-state-title { color: var(--danger); }
.bz-state-name { color: var(--ink); font-size: 12.5px; margin-top: 2px; word-break: break-word; }
.bz-state-meta { color: var(--ink-3); font-size: 11.5px; margin-top: 2px; }

/* ---------- 按钮 ---------- */
.bz-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 34px; padding: 0 13px;
  border: 1px solid var(--navy-line); border-radius: var(--r);
  background: #fff; color: var(--navy); cursor: pointer;
  font: 500 12.5px/1 inherit; white-space: nowrap;
}
.bz-btn:hover:not([disabled]) { background: var(--navy-weak); border-color: var(--navy); }
.bz-btn[disabled] { opacity: .45; cursor: not-allowed; }
.bz-btn.is-solid { background: var(--navy); border-color: var(--navy); color: #fff; }
.bz-btn.is-solid:hover:not([disabled]) { background: var(--navy-hover); border-color: var(--navy-hover); }
.bz-btn.is-block { width: 100%; }
.bz-row { display: flex; gap: 8px; }
.bz-row > .bz-btn { flex: 1 1 0; }

/* ---------- 分段控件 ---------- */
.bz-lab { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.bz-lab-t { flex: 0 0 auto; width: 56px; font-size: 12px; color: var(--ink-2); }
.bz-seg {
  flex: 1 1 auto; min-width: 0; display: flex;
  border: 1px solid var(--navy-line); border-radius: var(--r);
  overflow: hidden; background: #fff;
}
.bz-seg > button {
  flex: 1 1 0; min-width: 0; height: 30px; padding: 0 4px;
  border: none; border-right: 1px solid var(--navy-line);
  background: transparent; color: var(--ink-2);
  font: 500 12px/1 inherit; cursor: pointer; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
.bz-seg > button:last-child { border-right: none; }
.bz-seg > button:hover { background: var(--navy-weak); color: var(--navy); }
.bz-seg > button[aria-pressed="true"] { background: var(--navy); color: #fff; }

/* ---------- 复选 ---------- */

/* ---------- 进度与提示 ---------- */
.bz-prog { display: none; margin-top: 11px; }
.bz-prog.is-on { display: block; }
.bz-prog-txt { display: flex; justify-content: space-between; font-size: 11.5px; color: var(--ink-3); margin-bottom: 5px; }
.bz-track { height: 4px; border-radius: 2px; background: var(--surface); overflow: hidden; }
.bz-track > i { display: block; height: 100%; width: 0; background: var(--navy); transition: width .18s linear; }

.bz-note {
  margin-top: 11px; padding: 8px 10px; border-radius: var(--r);
  background: var(--surface); border: 1px solid var(--line);
  font-size: 12px; color: var(--ink-2); white-space: pre-wrap; word-break: break-word;
}
.bz-note:empty { display: none; }
.bz-note.is-ok { background: var(--ok-weak); border-color: #cbe9d7; color: #17663a; }
.bz-note.is-warn { background: var(--warn-weak); border-color: #f2ddb4; color: var(--warn); }
.bz-note.is-err { background: var(--danger-weak); border-color: #f4cdc8; color: #992c24; }

/* ---------- 诊断 ---------- */
.bz-fold { border-top: 1px solid var(--line); }
.bz-fold > summary {
  display: flex; align-items: center; gap: 7px;
  padding: 12px 15px; cursor: pointer; user-select: none;
  font-size: 12px; font-weight: 600; color: var(--ink-2); letter-spacing: .3px;
  list-style: none;
}
.bz-fold > summary::-webkit-details-marker { display: none; }
.bz-fold > summary > span:first-child svg { transition: transform .15s ease; }
.bz-fold[open] > summary > span:first-child svg { transform: rotate(90deg); }
.bz-fold > summary > span { display: inline-flex; }
.bz-fold-body { padding: 0 15px 14px; }
.bz-diag { display: flex; flex-wrap: wrap; gap: 7px; }
.bz-diag .bz-btn { height: 30px; padding: 0 10px; font-size: 12px; }
.bz-pre {
  margin: 10px 0 0; padding: 9px 10px; max-height: 240px; overflow: auto;
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--r);
  font: 11.5px/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--ink-2); white-space: pre-wrap; word-break: break-all;
}
.bz-pre:empty { display: none; }
.bz-foot { color: var(--ink-3); font-size: 11px; margin-top: 9px; }

/* 右下角缩放手柄 */
.bz-grip {
  position: absolute; right: 0; bottom: 0; width: 18px; height: 18px;
  cursor: nwse-resize; touch-action: none;
  background: linear-gradient(135deg, transparent 46%, var(--navy-line) 46%, var(--navy-line) 58%, transparent 58%,
              transparent 68%, var(--navy-line) 68%, var(--navy-line) 80%, transparent 80%);
}
.bz-panel { position: fixed; }
`;

const ICON = {
  layers:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/></svg>',
  exportIcon:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>',
  download:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>',
  doc:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  chevron:
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  wrench:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0 5 5l-9.4 9.4a2.1 2.1 0 0 1-3-3z"/></svg>',
} as const;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 用一个 inline-flex 的 span 承载 SVG，便于与文字并排对齐。 */
function icon(markup: string): HTMLSpanElement {
  const span = el('span');
  span.style.display = 'inline-flex';
  span.innerHTML = markup;
  return span;
}

function sectionHead(markup: string, title: string): HTMLDivElement {
  const head = el('div', 'bz-sec-h');
  head.append(icon(markup), document.createTextNode(title));
  return head;
}

/** 分段控件：比下拉框更直观，也更像「被设计过」的界面。 */
function segmented<T extends string>(
  entries: readonly (readonly [T, string])[],
  initial: T,
): { root: HTMLDivElement; value: () => T } {
  const root = el('div', 'bz-seg');
  const buttons = entries.map(([value, label]) => {
    const button = el('button');
    button.type = 'button';
    button.textContent = label;
    button.title = label;
    button.setAttribute('aria-pressed', String(value === initial));
    button.addEventListener('click', () => {
      for (const other of buttons) other.setAttribute('aria-pressed', String(other === button));
    });
    root.appendChild(button);
    return button;
  });

  return {
    root,
    value: () => {
      const index = buttons.findIndex((b) => b.getAttribute('aria-pressed') === 'true');
      return entries[index]?.[0] ?? initial;
    },
  };
}

function labelled(labelText: string, control: HTMLElement): HTMLDivElement {
  const row = el('div', 'bz-lab');
  row.append(el('span', 'bz-lab-t', labelText), control);
  return row;
}

export function mountPanel(options: PanelOptions): PanelHandle {
  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });

  const style = el('style');
  style.textContent = PANEL_CSS;

  const panel = el('div', 'bz-panel');
  panel.style.display = 'none';

  // ---------- 头部 ----------
  const head = el('div', 'bz-head');
  const logo = el('img');
  logo.src = BZ_ICON_DATA_URL;
  logo.alt = 'Better Zujuan';
  const headTxt = el('div', 'bz-head-txt');
  headTxt.append(el('div', 'bz-brand', 'Better Zujuan'), el('div', 'bz-kind', options.adapterLabel));
  const closeBtn = el('button', 'bz-x');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '关闭面板');
  closeBtn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  closeBtn.addEventListener('click', () => handle.hide());
  head.append(logo, headTxt, closeBtn);

  const body = el('div', 'bz-body');

  // ---------- 1. 页面识别 ----------
  const secState = el('div', 'bz-sec');
  const state = el('div', 'bz-state');
  const rail = el('div', 'bz-state-rail');
  const stateMain = el('div', 'bz-state-main');
  state.append(rail, stateMain);
  secState.appendChild(state);

  // ---------- 2. 答案与解析 ----------
  const secAnswer = el('div', 'bz-sec');
  secAnswer.appendChild(sectionHead(ICON.layers, '答案与解析'));
  const loadBtn = el('button', 'bz-btn is-solid is-block');
  loadBtn.type = 'button';
  loadBtn.append(icon(ICON.download), document.createTextNode('展开全部答案与解析'));
  const progress = el('div', 'bz-prog');
  const progressTxt = el('div', 'bz-prog-txt');
  const progressCount = el('span');
  const progressPct = el('span');
  progressTxt.append(progressCount, progressPct);
  const progressTrack = el('div', 'bz-track');
  const progressFill = el('i');
  progressTrack.appendChild(progressFill);
  progress.append(progressTxt, progressTrack);
  const answerNote = el('div', 'bz-note');
  secAnswer.append(loadBtn, progress, answerNote);

  // ---------- 3. 导出 ----------
  const secExport = el('div', 'bz-sec');
  secExport.appendChild(sectionHead(ICON.exportIcon, '导出'));

  const modeSeg = segmented<ExportMode>(
    (Object.keys(EXPORT_MODE_SHORT_LABELS) as ExportMode[]).map(
      (mode) => [mode, EXPORT_MODE_SHORT_LABELS[mode]] as const,
    ),
    DEFAULT_PRINT_OPTIONS.mode,
  );
  // 短标签 + 完整说明的悬停提示
  Array.from(modeSeg.root.querySelectorAll('button')).forEach((button, index) => {
    const mode = (Object.keys(EXPORT_MODE_SHORT_LABELS) as ExportMode[])[index];
    if (mode) button.title = EXPORT_MODE_LABELS[mode];
  });
  const sizeSeg = segmented<PaperSize>(
    [
      ['A4', 'A4'],
      ['A3', 'A3'],
    ],
    DEFAULT_PRINT_OPTIONS.paperSize,
  );
  const orientSeg = segmented<Orientation>(
    [
      ['portrait', '纵向'],
      ['landscape', '横向'],
    ],
    DEFAULT_PRINT_OPTIONS.orientation,
  );

  const exportRow = el('div', 'bz-row');
  exportRow.style.marginTop = '14px';
  const printBtn = el('button', 'bz-btn is-solid');
  printBtn.type = 'button';
  printBtn.textContent = '导出 PDF';
  const docxBtn = el('button', 'bz-btn');
  docxBtn.type = 'button';
  docxBtn.append(icon(ICON.doc), document.createTextNode('导出 DOCX'));
  exportRow.append(printBtn, docxBtn);

  const exportNote = el('div', 'bz-note');
  secExport.append(
    labelled('内容组织', modeSeg.root),
    labelled('纸张', sizeSeg.root),
    labelled('方向', orientSeg.root),
    exportRow,
    exportNote,
  );

  // ---------- 4. 诊断 ----------
  const fold = el('details', 'bz-fold');
  const summary = el('summary');
  summary.append(icon(ICON.chevron), icon(ICON.wrench), document.createTextNode('页面诊断'));
  const foldBody = el('div', 'bz-fold-body');
  const diagRow = el('div', 'bz-diag');
  const compatBtn = el('button', 'bz-btn');
  compatBtn.type = 'button';
  compatBtn.textContent = '检查兼容性';
  const refreshBtn = el('button', 'bz-btn');
  refreshBtn.type = 'button';
  refreshBtn.textContent = '重新采集';
  const downloadBtn = el('button', 'bz-btn');
  downloadBtn.type = 'button';
  downloadBtn.textContent = '下载诊断 JSON';
  diagRow.append(compatBtn, refreshBtn, downloadBtn);
  const diagPre = el('pre', 'bz-pre');
  foldBody.append(diagRow, diagPre, el('div', 'bz-foot', '诊断信息仅在本机生成，不会上传。'));
  fold.append(summary, foldBody);

  const grip = el('div', 'bz-grip');
  grip.title = '拖动可调整大小';

  body.append(secState, secAnswer, secExport, fold);
  panel.append(head, body, grip);
  shadow.append(style, panel);
  document.body.appendChild(host);

  // ---------- 渲染 ----------
  let lastReport: CompatibilityReport | null = null;

  function renderState(): void {
    const collect = options.getCollect();
    if (collect.ok) {
      const questions = collect.model.sections.reduce((n, s) => n + s.questions.length, 0);
      state.className = 'bz-state is-ok';
      stateMain.replaceChildren(
        el('div', 'bz-state-title', '已识别试卷'),
        el('div', 'bz-state-name', collect.model.title),
        el('div', 'bz-state-meta', `${questions} 道题 · ${collect.model.sections.length} 个题型分区`),
      );
      loadBtn.disabled = false;
      printBtn.disabled = false;
      docxBtn.disabled = false;
    } else {
      state.className = 'bz-state is-err';
      stateMain.replaceChildren(
        el('div', 'bz-state-title', '采集失败'),
        el('div', 'bz-state-name', collect.reason),
      );
      loadBtn.disabled = true;
      printBtn.disabled = true;
      docxBtn.disabled = true;
    }
  }

  function setNote(node: HTMLElement, text: string, tone?: 'ok' | 'warn' | 'err'): void {
    node.textContent = text;
    node.className = 'bz-note' + (tone ? ` is-${tone}` : '');
  }

  function readOptions(): PrintJobOptions {
    return {
      ...DEFAULT_PRINT_OPTIONS,
      mode: modeSeg.value(),
      paperSize: sizeSeg.value(),
      orientation: orientSeg.value(),
    };
  }

  // ---------- 事件 ----------
  loadBtn.addEventListener('click', async () => {
    if (!options.onLoadAnswers) {
      setNote(answerNote, '答案加载流程未接入。', 'err');
      return;
    }
    loadBtn.disabled = true;
    loadBtn.textContent = '正在展开…';
    progress.classList.add('is-on');
    progressFill.style.width = '0%';
    progressCount.textContent = '0 / 0 题';
    progressPct.textContent = '0%';
    setNote(answerNote, '');

    try {
      const summaryText = await options.onLoadAnswers((p: AnswerLoadProgress) => {
        const total = p.total || 1;
        const pct = Math.round((p.completed / total) * 100);
        progressFill.style.width = `${pct}%`;
        progressCount.textContent = `${p.completed} / ${p.total} 题`;
        progressPct.textContent = `${pct}%`;
      });
      setNote(answerNote, summaryText, /全部 \d+ 道/.test(summaryText) ? 'ok' : 'warn');
    } catch (error) {
      setNote(answerNote, `加载失败：${error instanceof Error ? error.message : String(error)}`, 'err');
    } finally {
      loadBtn.disabled = false;
      // 文案保持不变：按钮语义始终是「展开全部答案」，已加载状态由下方提示承担
      loadBtn.replaceChildren(icon(ICON.download), document.createTextNode('展开全部答案与解析'));
      progress.classList.remove('is-on');
    }
  });

  printBtn.addEventListener('click', () => {
    if (!options.onPrint) {
      setNote(exportNote, '打印流程未接入。', 'err');
      return;
    }
    try {
      options.onPrint(readOptions());
      setNote(exportNote, '已发起打印：在浏览器打印窗口中选择「另存为 PDF」即可。', 'ok');
    } catch (error) {
      setNote(exportNote, `打印失败：${error instanceof Error ? error.message : String(error)}`, 'err');
    }
  });

  docxBtn.addEventListener('click', async () => {
    if (!options.onDocx) {
      setNote(exportNote, 'DOCX 导出流程未接入。', 'err');
      return;
    }
    docxBtn.disabled = true;
    const original = docxBtn.innerHTML;
    docxBtn.textContent = '生成中…';
    setNote(exportNote, '');
    try {
      const message = await options.onDocx(readOptions());
      setNote(exportNote, message, /失败|未能/.test(message) ? 'warn' : 'ok');
    } catch (error) {
      setNote(exportNote, `DOCX 导出失败：${error instanceof Error ? error.message : String(error)}`, 'err');
    } finally {
      docxBtn.disabled = false;
      docxBtn.innerHTML = original;
    }
  });

  compatBtn.addEventListener('click', () => {
    lastReport = options.buildReport();
    diagPre.textContent = summarizeCompatibilityReport(lastReport);
    fold.open = true;
  });

  refreshBtn.addEventListener('click', () => {
    options.refresh();
    renderState();
    lastReport = null;
    diagPre.textContent = '已重新采集。';
  });

  downloadBtn.addEventListener('click', () => {
    const report = lastReport ?? options.buildReport();
    lastReport = report;
    downloadCompatibilityReport(report);
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && panel.style.display !== 'none') handle.hide();
  };
  document.addEventListener('keydown', onKeyDown);

  // ---------- 窗口行为：拖动与缩放 ----------
  const MARGIN = 20;
  let placed = false;

  /** 首次显示时放到右侧，并保证完全落在视口内。 */
  function placeInitially(): void {
    if (placed) return;
    placed = true;
    const rect = panel.getBoundingClientRect();
    const width = rect.width || 400;
    const height = rect.height || 640;
    panel.style.left = `${Math.max(MARGIN, window.innerWidth - width - MARGIN)}px`;
    panel.style.top = `${Math.max(MARGIN, Math.min(56, window.innerHeight - height - MARGIN))}px`;
  }

  /** 把窗口限制在视口内（至少留出一部分可抓取区域）。 */
  function clampPosition(): void {
    const rect = panel.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - 48);
    panel.style.left = `${Math.min(Math.max(0, rect.left), maxLeft)}px`;
    panel.style.top = `${Math.min(Math.max(0, rect.top), maxTop)}px`;
  }

  function startPointerDrag(
    event: PointerEvent,
    onMove: (dx: number, dy: number) => void,
  ): void {
    const startX = event.clientX;
    const startY = event.clientY;
    const target = event.currentTarget as HTMLElement;
    // 捕获指针能让拖动更跟手，但合成事件 / 部分环境下会抛 NotFoundError，
    // 一旦抛出就会跳过后续的监听器注册，表现为「完全拖不动」。
    try {
      target.setPointerCapture?.(event.pointerId);
    } catch {
      /* 忽略：退化为普通的 document 监听即可 */
    }

    const move = (e: PointerEvent): void => onMove(e.clientX - startX, e.clientY - startY);
    const finish = (): void => {
      try {
        target.releasePointerCapture?.(event.pointerId);
      } catch {
        /* 忽略 */
      }
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', finish);
      head.classList.remove('is-dragging');
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', finish);
  }

  head.addEventListener('pointerdown', (event) => {
    // 头部按钮（关闭）不参与拖动
    if ((event.target as Element).closest('button')) return;
    if (event.button !== 0) return;
    event.preventDefault();
    head.classList.add('is-dragging');
    const rect = panel.getBoundingClientRect();
    startPointerDrag(event, (dx, dy) => {
      panel.style.left = `${rect.left + dx}px`;
      panel.style.top = `${rect.top + dy}px`;
    });
  });

  grip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = panel.getBoundingClientRect();
    startPointerDrag(event, (dx, dy) => {
      const width = Math.min(Math.max(320, rect.width + dx), window.innerWidth - 8);
      const height = Math.min(Math.max(320, rect.height + dy), window.innerHeight - 8);
      panel.style.width = `${width}px`;
      panel.style.height = `${height}px`;
    });
  });

  // 视口变化时把窗口拉回可视范围
  window.addEventListener('resize', () => {
    if (panel.style.display !== 'none') clampPosition();
  });

  const handle: PanelHandle = {
    show() {
      panel.style.display = 'flex';
      placeInitially();
      clampPosition();
      renderState();
    },
    hide() {
      panel.style.display = 'none';
    },
    toggle() {
      if (panel.style.display === 'none') handle.show();
      else handle.hide();
    },
    refresh() {
      renderState();
    },
  };

  renderState();
  return handle;
}

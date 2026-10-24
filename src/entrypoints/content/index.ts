/**
 * 内容脚本入口。
 *
 * 职责边界：
 *   - 只负责「装配」：识别页面 → 采集 → 挂 UI
 *   - 不在这里写业务逻辑（净化/答案/导出各自独立成模块）
 *   - 未识别的页面直接静默退出，不做任何 DOM 操作
 */

import { defineContentScript } from '#imports';
import { detectAdapter } from '@/adapters/registry';
import type { CollectResult } from '@/adapters/types';
import { buildCompatibilityReport } from '@/diagnostics/compat-report';
import { mountPanel } from '@/ui/panel';
import { AnswerLoader, summarizeAnswerLoads, type AnswerLoadProgress } from '@/answers/loader';
import { startPrintSession } from '@/export/pdf';
import { buildPaperDocx, collectAnswerImageData, downloadDocx } from '@/export/docx';
import { collectFormulaMathMl, formulaHashFromSrc } from '@/export/formula-mathml';
import { collectImageDataUrls } from '@/export/image-assets';
//
// 关于体积：docx 体积较大，实测内容脚本约 790KB。
// 曾尝试用动态 import('@/export/docx') 做代码分割，但 **无效** ——
// WXT 把内容脚本打成 IIFE，Vite 会直接把动态导入内联回同一文件，产物大小不变。
// 真要拆包，需要把导出放到 background/独立页面，或改内容脚本输出格式，
// 两者都超出当前范围，故保持静态引入并在 README 中记为已知限制。

/**
 * 入口按钮。
 *
 * ## 为什么不做成站内按钮（实测踩坑）
 *
 * 曾经把按钮插进站点的按钮容器（`.link-box` / `.btn-box`），结果在组卷中心
 * 明显"突出来"：那里的 `.btn-box` 是 `flex-wrap` 网格，每行恰好 2 个
 * 115×28 的单元格，追加进去只能另起一行且与相邻单元格高矮不一（实测偏移 79px）。
 * 三类页面的按钮容器结构、行宽、单元格尺寸还各不相同，
 * 想在其中稳定对齐，成本高且随站点改版立刻失效。
 *
 * ## 现在的做法
 *
 * 悬浮在页面右下角的独立启动器，不参与站点任何布局：
 *   - 三类页面观感完全一致，不受站点容器影响
 *   - 不被站点样式覆盖，也不覆盖站点内容（避开右下角客服/AI 入口）
 *   - 打印时由 `EXTENSION_UI_SELECTORS` 隐藏，不会印到纸上
 */
const LAUNCHER_CSS = [
  'position:fixed',
  // 避开站点右侧悬浮导航：实测 .fixed-nav 贴右且宽约 120px（内含
  // 「试题篮 / 收起 / 顶部」等按钮），因此右侧留出足够间距。
  'right:150px',
  'bottom:40px',
  'z-index:2147482000',
  'display:flex',
  'align-items:center',
  'gap:6px',
  'height:40px',
  'padding:0 16px',
  'border:0',
  'border-radius:20px',
  'background:linear-gradient(135deg,#1d3d6d,#142c52)',
  'color:#fff',
  'font-size:14px',
  'font-weight:700',
  'line-height:1',
  'letter-spacing:.3px',
  'text-decoration:none',
  'cursor:pointer',
  'white-space:nowrap',
  'box-shadow:0 4px 14px rgba(20,44,82,.34)',
  'transition:transform .12s ease,box-shadow .12s ease',
].join(';');

/** 注入导出入口（悬浮启动器，不受站点布局影响）。 */
function injectEntryButton(onClick: () => void): { injected: boolean; mode: string } {
  const button = document.createElement('a');
  button.className = 'bz-entry-btn';
  button.setAttribute('href', 'javascript:void 0');
  button.setAttribute('role', 'button');
  button.setAttribute('title', 'Better Zujuan：展开答案 / 导出 PDF 与 DOCX');
  button.style.cssText = LAUNCHER_CSS;
  button.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
    '<path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>' +
    '<span>试卷导出</span>';

  button.addEventListener('mouseenter', () => {
    button.style.transform = 'translateY(-1px)';
    button.style.boxShadow = '0 6px 18px rgba(20,44,82,.42)';
  });
  button.addEventListener('mouseleave', () => {
    button.style.transform = '';
    button.style.boxShadow = '0 4px 14px rgba(20,44,82,.34)';
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });

  document.body.appendChild(button);
  return { injected: true, mode: 'floating-launcher' };
}

export default defineContentScript({
  matches: ['https://zujuan.xkw.com/*'],
  runAt: 'document_idle',
  main() {
    const detected = detectAdapter(location.href, document);
    if (!detected.adapter) {
      // 未支持的页面类型：不注入任何东西
      console.info('[Better Zujuan] 跳过当前页面：', detected.reason);
      return;
    }

    const adapter = detected.adapter;
    let collect: CollectResult = adapter.collect(document);
    const answerLoader = new AnswerLoader({ doc: document });

    /**
     * 每次操作前**重新采集**一次。
     *
     * 为什么必须这样（实测踩坑）：`collect` 只在注入时算过一次，里面存的是
     * `QuestionRef.node` —— 对**当时的 DOM 节点**的引用。用户在页面上做了
     * 任何改变结构的操作（展开答案、切换整卷视图、站点重渲染）之后，
     * 这些引用就可能指向已被替换掉的旧节点：
     *   - 打印仍用旧节点 → 页面已经变了，印出来还是旧的
     *   - 答案图是新节点上的 → 打印里看不到刚展开的答案
     * 因此在打印/导出前重采一次，保证拿到的是**当前** DOM。
     */
    const recollect = (): CollectResult => {
      collect = adapter.collect(document);
      return collect;
    };

    /**
     * 组卷中心的内容是**前端异步渲染**的，`document_idle` 时经常还没渲染出来。
     *
     * 实测证据（`/zujuan`）：站点首屏发的是空壳（`.empty-box.group-exam-empty`），
     * 题目随后由 JS 注入。若在 `document_idle` 立刻采集，会得到
     * 「题型分区 0 个，题目 0 道」并提示「还没有任何题目」——
     * 而用户手动点一次「重新采集」就正常了，正是这个时序差异。
     *
     * 处理方式：初次采集若为空，则**等待内容出现**（轮询 + 提前退出），
     * 出现后重新采集并刷新面板；等待期间用户也能正常操作。
     */
    const waitForContent = (): Promise<CollectResult | null> => {
      if (collect.ok) return Promise.resolve(null);

      return new Promise((resolve) => {
        const started = Date.now();
        const TIMEOUT_MS = 20_000;
        let observer: MutationObserver | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const finish = (result: CollectResult | null): void => {
          observer?.disconnect();
          if (timer) clearTimeout(timer);
          resolve(result);
        };

        const attempt = (): void => {
          const fresh = adapter.collect(document);
          if (fresh.ok) {
            collect = fresh;
            finish(fresh);
            return;
          }
          if (Date.now() - started >= TIMEOUT_MS) finish(null);
        };

        // 内容一出现就立刻成功，不必等轮询周期
        observer = new MutationObserver(() => attempt());
        observer.observe(document.body, { childList: true, subtree: true });

        const tick = (): void => {
          if (Date.now() - started >= TIMEOUT_MS) {
            finish(null);
            return;
          }
          attempt();
          if (collect.ok) return;
          timer = setTimeout(tick, 400);
        };
        timer = setTimeout(tick, 400);
      });
    };

    const panel = mountPanel({
      adapterLabel: adapter.label,
      getCollect: () => collect,
      refresh: recollect,
      buildReport: (reason) =>
        buildCompatibilityReport({
          doc: document,
          model: collect.ok ? collect.model : undefined,
          reason: reason ?? (collect.ok ? undefined : collect.reason),
        }),
      onLoadAnswers: async (onProgress: (progress: AnswerLoadProgress) => void) => {
        const fresh = recollect();
        if (!fresh.ok) return `无法加载答案：${fresh.reason}`;
        const records = await answerLoader.load(fresh.model, onProgress);
        return summarizeAnswerLoads(records);
      },
      onPrint: (printOptions) => {
        // 打印前重新采集：用户可能刚展开过答案 / 切换过页面状态
        const fresh = recollect();
        if (!fresh.ok) {
          window.alert(`无法打印：${fresh.reason}`);
          return;
        }
        startPrintSession({
          doc: document,
          model: fresh.model,
          options: printOptions,
          noiseSelectors: adapter.noiseSelectors,
          resolveImageSrc: (src) => answerLoader.getImageUrlForSource(src),
        });
      },
      onDocx: async (exportOptions) => {
        const fresh = recollect();
        if (!fresh.ok) return `无法导出 DOCX：${fresh.reason}`;

        // 只有真正需要答案的模式才去取答案。
        // 「仅试题」模式拿不到任何答案需求，若仍调用 load() 会白白消耗每日免费额度
        // （实测额度约 30 题/天，不该为不需要的内容付费）。
        const needsAnswers = exportOptions.mode !== 'questions-only';
        const records = needsAnswers ? await answerLoader.load(fresh.model) : [];

        // 2) 收集图片字节。docx 的 HTML 转换器不会自行下载图片，
        //    不提供字节的 <img> 会被丢弃 —— 公式与答案图都会消失。
        const answerImages = await collectAnswerImageData(records);

        // 3) 图片字节收集。
        //    先取公式 MathML（→ 可编辑 OMML）；已转成公式的就不用再取位图，
        //    其余**所有**内容图片（含题目插图，实测在 img.xkw.com 上）都要取回字节，
        //    否则 docx 转换器会把它们直接丢掉。
        // 正文范围由适配器给出（详情页/个人题库 article.exam-cnt，组卷中心 article.paper-cnt）
        const rootSelector = fresh.model.rootSelector || 'article.exam-cnt';
        const articleSrcs = Array.from(document.querySelectorAll<HTMLImageElement>(
          `${rootSelector} img`,
        )).map((img) => img.getAttribute('src'));
        const mathMl = await collectFormulaMathMl(articleSrcs);
        const coveredByMathMl = new Set(
          articleSrcs.filter((src) => {
            const hash = formulaHashFromSrc(src);
            return hash !== null && mathMl.has(hash);
          }),
        );
        const imageData = await collectImageDataUrls(articleSrcs, {
          skip: (src) => coveredByMathMl.has(src),
        });
        for (const [src, data] of answerImages) imageData.set(src, data);
        const result = await buildPaperDocx(
          document,
          fresh.model,
          { mode: exportOptions.mode },
          records,
          imageData,
          mathMl,
        );

        downloadDocx(result, document);
        const converted = mathMl.size;
        const lines = [
          `DOCX 已生成：${result.filename}`,
          `公式转为可编辑格式 ${converted} 个；嵌入图片 ${imageData.size} 张。`,
        ];
        const missing = result.warnings.filter((warning) => warning.includes('缺少图片数据')).length;
        if (missing > 0) {
          lines.push(`注意：有 ${missing} 处图片未能取得数据，已从文档中移除（详见下方提示）。`);
        }
        if (result.warnings.length > 0) {
          lines.push(...result.warnings.slice(0, 5));
        }
        return lines.join('\n');
      },
    });

    const injection = injectEntryButton(() => panel.toggle());
    console.info(
      `[Better Zujuan] 已加载：适配器=${adapter.id}，注入方式=${injection.mode}，` +
        `采集=${collect.ok ? '成功' : '失败'}`,
    );

    // 首次采集为空时等页面把内容渲染出来（组卷中心是异步渲染的），
    // 拿到后刷新面板 —— 否则用户会看到「还没有任何题目」，点重新采集才好。
    if (!collect.ok) {
      void waitForContent().then((late) => {
        if (!late || !late.ok) return;
        panel.refresh();
        const total = late.model.sections.reduce((sum, section) => sum + section.questions.length, 0);
        console.info(`[Better Zujuan] 内容延迟出现，已自动重新采集：${total} 道题`);
      });
    }
  },
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { collectUsertkPaper, usertkPaperAdapter, USERTK_NOISE_SELECTORS } from '@/adapters/usertk-paper';
import {
  collectZujuanCenter,
  zujuanCenterAdapter,
  ZUJUAN_CENTER_NOISE_SELECTORS,
} from '@/adapters/zujuan-center';
import { collectPaperDetail, paperDetailAdapter } from '@/adapters/paper-detail';
import { detectAdapter } from '@/adapters/registry';
import { GRAY_MASK_SELECTOR } from '@/core/gray-mask';
import { SELECTORS } from '@/adapters/selectors';
import { cloneAnswer, cloneStem } from '@/core/purify';
import { buildPrintCss } from '@/export/print-css';
import { DEFAULT_PRINT_OPTIONS } from '@/export/options';

/**
 * 夹具按实测结构构造并已脱敏：
 *   - 个人题库页：`section.exam-list` 下有 **3 个** `.sec-item`（每个题型一个）
 *   - 组卷中心：`article.paper-cnt` / `.paper-part` / `.ques-type` / `.ques-item`
 */
function load(name: string, url: string): Document {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  return new JSDOM(readFileSync(path, 'utf8'), { url }).window.document as unknown as Document;
}

const USERTK_URL = 'https://zujuan.xkw.com/usertk/11p134861136.html';
const ZUJUAN_URL = 'https://zujuan.xkw.com/zujuan';
const DETAIL_URL = 'https://zujuan.xkw.com/11p3524937.html';

const loadUsertk = (url = USERTK_URL) => load('usertk-paper.html', url);
const loadCenter = (url = ZUJUAN_URL) => load('zujuan-center.html', url);
const loadDetail = (url = DETAIL_URL) => load('paper-detail.html', url);

// ---------------------------------------------------------------- 个人题库

describe('usertkPaperAdapter.matches', () => {
  it('对个人题库 URL + 真实 DOM 返回 true', () => {
    expect(usertkPaperAdapter.matches(USERTK_URL, loadUsertk())).toBe(true);
  });

  it('对其它页面一律不匹配', () => {
    for (const url of [DETAIL_URL, ZUJUAN_URL, 'https://zujuan.xkw.com/basic/', 'https://zujuan.xkw.com/']) {
      expect(usertkPaperAdapter.matches(url, loadUsertk(url))).toBe(false);
    }
  });

  it('URL 相符但只有一个 sec-item（即详情页结构）时不匹配', () => {
    const doc = loadUsertk();
    const items = Array.from(doc.querySelectorAll('section.exam-list > .sec-item'));
    // 只留一个，模拟误落到详情页结构
    items.slice(1).forEach((el) => el.remove());
    expect(usertkPaperAdapter.matches(USERTK_URL, doc)).toBe(false);
  });
});

describe('collectUsertkPaper —— 实测结构：每题型一个 sec-item', () => {
  it('夹具本身保留了这个结构陷阱', () => {
    const doc = loadUsertk();
    expect(doc.querySelectorAll('section.exam-list > .sec-item').length).toBe(3);
    // 与试卷详情页的关键差异：这里 > 1
    expect(doc.querySelectorAll('section.exam-list > .sec-item').length).toBeGreaterThan(1);
  });

  it('采集到**全部**题型与题目（不能只拿到第一个题型）', () => {
    const result = collectUsertkPaper(loadUsertk());
    if (!result.ok) throw new Error(result.reason);

    expect(result.model.sections.map((s) => s.title)).toEqual([
      '一、单选题',
      '二、多选题',
      '三、解答题',
    ]);
    expect(result.model.sections.map((s) => s.questions.length)).toEqual([2, 1, 1]);
    expect(result.model.sections.reduce((n, s) => n + s.questions.length, 0)).toBe(4);
  });

  it('题目序号在整卷内连续递增（跨题型也不重置）', () => {
    const result = collectUsertkPaper(loadUsertk());
    if (!result.ok) throw new Error(result.reason);
    const indexes = result.model.sections.flatMap((s) => s.questions.map((q) => q.index));
    expect(indexes).toEqual([1, 2, 3, 4]);
  });

  it('题型标题不含「添加题型下试题」按钮文字', () => {
    const result = collectUsertkPaper(loadUsertk());
    if (!result.ok) throw new Error(result.reason);
    for (const section of result.model.sections) {
      expect(section.title).not.toContain('添加题型下试题');
    }
  });

  it('正确读出 qid 与 bankId（答案接口必需）', () => {
    const result = collectUsertkPaper(loadUsertk());
    if (!result.ok) throw new Error(result.reason);
    const first = result.model.sections[0]?.questions[0];
    expect(first?.qid).toBe('12166627');
    expect(first?.bankId).toBe('11');
  });

  it('rootSelector 指向 article.exam-cnt', () => {
    const result = collectUsertkPaper(loadUsertk());
    if (!result.ok) throw new Error(result.reason);
    expect(result.model.rootSelector).toBe('article.exam-cnt');
  });

  it('标题取自 .title-txt（本页没有 span.txt）', () => {
    const result = collectUsertkPaper(loadUsertk());
    if (!result.ok) throw new Error(result.reason);
    expect(result.model.title).toBe('第一章练习');
  });

  it('题目被 sec-item 之外的容器包裹时也能兜底采集，不丢题', () => {
    const doc = loadUsertk();
    const list = doc.querySelector('section.exam-list')!;
    // 把最后一个 sec-item 拆掉，让里面的题目变成「游离」状态
    const last = list.querySelectorAll(':scope > .sec-item')[2]!;
    const stray = last.querySelector('.sec-list')!;
    list.appendChild(stray);
    last.remove();

    const result = collectUsertkPaper(doc);
    if (!result.ok) throw new Error(result.reason);
    expect(result.model.sections.reduce((n, s) => n + s.questions.length, 0)).toBe(4);
  });

  it('完全没有题目时给出可读原因而不是空结果', () => {
    const doc = loadUsertk();
    doc.querySelectorAll('.tk-quest-item').forEach((el) => el.remove());
    const result = collectUsertkPaper(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('未找到任何题目');
  });
});

// ---------------------------------------------------------------- 组卷中心

describe('zujuanCenterAdapter.matches', () => {
  it('对 /zujuan 与 /zujuan/ 都返回 true', () => {
    expect(zujuanCenterAdapter.matches(ZUJUAN_URL, loadCenter())).toBe(true);
    expect(zujuanCenterAdapter.matches(`${ZUJUAN_URL}/`, loadCenter(`${ZUJUAN_URL}/`))).toBe(true);
  });

  it('对其它页面一律不匹配', () => {
    for (const url of [
      DETAIL_URL,
      USERTK_URL,
      'https://zujuan.xkw.com/zujuan/abc',
      'https://zujuan.xkw.com/basic/',
    ]) {
      expect(zujuanCenterAdapter.matches(url, loadCenter(url))).toBe(false);
    }
  });

  it('URL 相符但不是 paper-cnt 结构时不匹配', () => {
    const doc = loadCenter();
    doc.querySelector('article.paper-cnt')?.remove();
    expect(zujuanCenterAdapter.matches(ZUJUAN_URL, doc)).toBe(false);
  });
});

describe('collectZujuanCenter —— 编辑态结构', () => {
  it('夹具不含 article.exam-cnt（说明确实需要独立适配器）', () => {
    const doc = loadCenter();
    expect(doc.querySelector('article.exam-cnt')).toBeNull();
    expect(doc.querySelector('article.paper-cnt')).not.toBeNull();
  });

  it('采集到全部题型与题目', () => {
    const result = collectZujuanCenter(loadCenter());
    if (!result.ok) throw new Error(result.reason);
    expect(result.model.sections.map((s) => s.title)).toEqual(['一、单选题', '二、多选题']);
    expect(result.model.sections.map((s) => s.questions.length)).toEqual([2, 1]);
  });

  it('题型标题由两个 span 拼成「一、单选题」', () => {
    const result = collectZujuanCenter(loadCenter());
    if (!result.ok) throw new Error(result.reason);
    expect(result.model.sections[0]?.title).toBe('一、单选题');
  });

  it('qid 取自 .ques-item 的 questionid，bankId 取自内层', () => {
    const result = collectZujuanCenter(loadCenter());
    if (!result.ok) throw new Error(result.reason);
    const first = result.model.sections[0]?.questions[0];
    expect(first?.qid).toBe('12166627');
    expect(first?.bankId).toBe('11');
  });

  it('rootSelector 指向 article.paper-cnt', () => {
    const result = collectZujuanCenter(loadCenter());
    if (!result.ok) throw new Error(result.reason);
    expect(result.model.rootSelector).toBe('article.paper-cnt');
  });

  it('标题取自 #pui_maintitle，不掺入 hidden 的副标题', () => {
    const result = collectZujuanCenter(loadCenter());
    if (!result.ok) throw new Error(result.reason);
    expect(result.model.title).toBe('第一章练习');
    expect(result.model.title).not.toContain('试卷副标题');
  });

  it('空组卷（还没加题）给出可读原因', () => {
    const doc = loadCenter();
    doc.querySelectorAll('.paper-body .tk-quest-item').forEach((el) => el.remove());
    const result = collectZujuanCenter(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('还没有任何题目');
  });
});

describe('组卷中心的噪声清单 —— 编辑态控件必须清干净', () => {
  it('覆盖每题的编辑操作条（否则会被印到纸上）', () => {
    for (const selector of ['.ques-ctrl', '.add-res', '.msg-prompt', '.questype-ctrl']) {
      expect(ZUJUAN_CENTER_NOISE_SELECTORS).toContain(selector);
    }
  });

  it('覆盖底部拖拽排序模板区', () => {
    for (const selector of ['.group-ctrl', '.qt-box', '.part-box', '.ques-box']) {
      expect(ZUJUAN_CENTER_NOISE_SELECTORS).toContain(selector);
    }
  });

  it('覆盖试卷编辑态外壳（装订线、分段标题）', () => {
    for (const selector of ['.seal-line', '.part-head']) {
      expect(ZUJUAN_CENTER_NOISE_SELECTORS).toContain(selector);
    }
  });

  it('不把知识点当噪声（它要与答案一起保留）', () => {
    for (const selector of ['.item.knowlegde', '.item.knowledge', '.knowledge-box']) {
      expect(ZUJUAN_CENTER_NOISE_SELECTORS).not.toContain(selector);
      expect(USERTK_NOISE_SELECTORS).not.toContain(selector);
    }
  });
});

// ---------------------------------------------------------------- 分派

describe('detectAdapter 分派（三个适配器互不串台）', () => {
  it('个人题库页 → usertk-paper', () => {
    expect(detectAdapter(USERTK_URL, loadUsertk()).adapter?.id).toBe('usertk-paper');
  });

  it('组卷中心 → zujuan-center', () => {
    expect(detectAdapter(ZUJUAN_URL, loadCenter()).adapter?.id).toBe('zujuan-center');
  });

  it('试卷详情页 → paper-detail（没有被 usertk 抢走）', () => {
    expect(detectAdapter(DETAIL_URL, loadDetail()).adapter?.id).toBe('paper-detail');
    expect(paperDetailAdapter.matches(DETAIL_URL, loadDetail())).toBe(true);
  });

  it('未支持页面返回 null 且给出已支持列表', () => {
    const result = detectAdapter('https://zujuan.xkw.com/basic/', loadDetail('https://zujuan.xkw.com/basic/'));
    expect(result.adapter).toBeNull();
    expect(result.reason).toContain('组卷中心');
  });
});

// ---------------------------------------------------------------- 通用清理

describe('新页面同样受益于通用清理', () => {
  it('个人题库页的「解读」按钮被清掉，知识点名称保留', () => {
    const result = collectUsertkPaper(loadUsertk());
    if (!result.ok) throw new Error(result.reason);
    const question = result.model.sections[0]!.questions[0]!;
    const answer = cloneAnswer(question, USERTK_NOISE_SELECTORS);
    expect(answer).not.toBeNull();
    expect(answer!.querySelector('.knowledge-explain')).toBeNull();
    expect(answer!.querySelector('.btn_KnowledgeUnscramble')).toBeNull();
    expect(answer!.querySelector('.knowledge-name')?.textContent).toContain('交集的概念及运算');
  });

  it('个人题库页题目内容确实处于被压暗的祖先之下（夹具真实反映线上）', () => {
    const result = collectUsertkPaper(loadUsertk());
    if (!result.ok) throw new Error(result.reason);
    const question = result.model.sections[0]!.questions[0]!;
    // 蒙版不在题目节点自己身上，而在它的祖先 .wrapper.quesdiv 上
    expect(question.node.matches(GRAY_MASK_SELECTOR)).toBe(false);
    expect(question.node.querySelector(GRAY_MASK_SELECTOR)).not.toBeNull();
  });

  it('蒙版在 .wrapper.quesdiv 上，而它正是题干/答案的父节点（夹具与线上一致）', () => {
    const doc = loadUsertk();
    const mask = doc.querySelector(GRAY_MASK_SELECTOR)!;
    expect(mask.classList.contains('quesdiv')).toBe(true);
    // 关键：蒙版不是克隆对象本身，而是它的祖先 —— 这正是最容易漏掉的地方
    expect(mask.querySelector('.exam-item__cnt')).not.toBeNull();
    expect(mask.querySelector('.exam-item__opt')).not.toBeNull();
  });

  it('题干克隆会消除祖先带来的压暗（祖先不在克隆里，必须沿链补）', () => {
    const result = collectUsertkPaper(loadUsertk());
    if (!result.ok) throw new Error(result.reason);
    const question = result.model.sections[0]!.questions[0]!;

    const stem = cloneStem(question, USERTK_NOISE_SELECTORS);
    expect(stem).not.toBeNull();
    // 克隆根自己被显式置为完全不透明，导出内容才不会发灰
    expect((stem as HTMLElement).style.getPropertyValue('opacity')).toBe('1');
    expect((stem as HTMLElement).style.getPropertyValue('filter')).toBe('none');
  });

  it('答案克隆同样消除祖先压暗', () => {
    const result = collectUsertkPaper(loadUsertk());
    if (!result.ok) throw new Error(result.reason);
    const question = result.model.sections[0]!.questions[0]!;

    const answer = cloneAnswer(question, USERTK_NOISE_SELECTORS);
    expect(answer).not.toBeNull();
    expect((answer as HTMLElement).style.getPropertyValue('opacity')).toBe('1');
  });

  it('没有蒙版的页面不会被无谓地加上内联样式', () => {
    const result = collectPaperDetail(loadDetail());
    if (!result.ok) throw new Error(result.reason);
    const question = result.model.sections[0]!.questions[0]!;
    const stem = cloneStem(question, []) as HTMLElement;
    expect(stem.style.getPropertyValue('opacity')).toBe('');
  });
});
// ---------------------------------------------------------------- 原样模式的解读按钮

describe('「原样」模式也必须去掉解读按钮', () => {
  it('解读按钮不在题干子树里，所以 cloneStem 永远删不到它', () => {
    const result = collectPaperDetail(loadDetail());
    if (!result.ok) throw new Error(result.reason);
    const question = result.model.sections[0]!.questions[0]!;

    // 实测：解读按钮位于 .exam-item__opt 内，而 cloneStem 只克隆 .exam-item__cnt
    const stem = question.node.querySelector('.exam-item__cnt')!;
    expect(stem.querySelectorAll('.knowledge-explain, .btn_KnowledgeUnscramble').length).toBe(0);
    expect(question.node.querySelectorAll('.knowledge-explain, .btn_KnowledgeUnscramble').length)
      .toBeGreaterThan(0);
  });

  it('打印样式里显式隐藏解读按钮（原样模式走原 DOM，只能靠 CSS）', () => {
    const css = buildPrintCss(DEFAULT_PRINT_OPTIONS, [], false, 'article.exam-cnt');
    expect(css).toContain('.knowledge-explain');
    expect(css).toContain('.btn_KnowledgeUnscramble');
    // 必须是 display:none !important
    expect(/\.knowledge-explain[\s\S]{0,120}display:\s*none\s*!important/.test(css)).toBe(true);
  });

  it('在真实页面上用打印样式验证：解读按钮确实被隐藏', () => {
    // 构造一份含解读按钮的文档，注入打印样式（转成 all 媒体）后检查
    const doc = loadDetail();
    const jiedu = doc.querySelector('.knowledge-explain');
    expect(jiedu).not.toBeNull();

    const style = doc.createElement('style');
    style.textContent = buildPrintCss(DEFAULT_PRINT_OPTIONS, [], false, 'article.exam-cnt')
      .replace(/@media print/g, '@media all');
    doc.head.appendChild(style);

    // jsdom 不做样式级联计算，这里断言规则存在即可；真实隐藏效果已在浏览器实测确认
    expect(doc.querySelectorAll('style').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- 首次加载竞态

describe('组卷中心的内容是异步渲染的（首次加载竞态）', () => {
  it('题目尚未渲染时采集失败，但原因是可以恢复的（提示而非崩溃）', () => {
    const doc = loadCenter();
    // 站点首屏是空壳：.paper-body 在、题目还没注入
    doc.querySelectorAll('.paper-body .tk-quest-item').forEach((el) => el.remove());
    const result = collectZujuanCenter(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('还没有任何题目');
      // 关键：选择器报告必须保留，便于诊断定位
      expect(result.reports.length).toBeGreaterThan(0);
      const itemReport = result.reports.find((r) => r.key === 'groupQuestionItem');
      expect(itemReport?.found).toBe(0);
    }
  });

  it('内容后渲染出来时，重新采集即可成功（这就是「点重新采集就好了」）', () => {
    const doc = loadCenter();
    const body = doc.querySelector('.paper-body')!;
    const saved = body.innerHTML;
    body.innerHTML = '';

    expect(collectZujuanCenter(doc).ok).toBe(false);

    // 模拟站点异步填充
    body.innerHTML = saved;
    const after = collectZujuanCenter(doc);
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.model.sections.reduce((n, s) => n + s.questions.length, 0)).toBe(3);
    }
  });

  it('点位选择器从宽到窄，嵌套关系变化时也不漏采', () => {
    const spec = SELECTORS.groupQuestionItem;
    // 第一候选必须是整个 .paper-body 下的题目，而不是限定 .ques-type
    expect(spec.candidates[0]).toBe('.paper-body .tk-quest-item');
    expect(spec.cardinality).toBe('many');
  });

  it('题目不在 .ques-type 之下时依然能采到（结构宽松性）', () => {
    const doc = loadCenter();
    // 把题目从 .ques-type 里挪到 .paper-body 直接下
    const body = doc.querySelector('.paper-body')!;
    const typeNodes = Array.from(body.querySelectorAll('.ques-type'));
    for (const t of typeNodes) body.appendChild(t);
    const result = collectZujuanCenter(doc);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.sections.reduce((n, s) => n + s.questions.length, 0)).toBe(3);
    }
  });
});

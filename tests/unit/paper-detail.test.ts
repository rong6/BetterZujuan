import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it } from 'vitest';
import { collectPaperDetail, paperDetailAdapter, PAPER_DETAIL_NOISE_SELECTORS } from '@/adapters/paper-detail';
import { resolveAll, resolveOne } from '@/adapters/selectors';

/**
 * 夹具取自真实试卷页（已脱敏），保留了几个关键的「坑」：
 *   - `section.exam-list` 只有 1 个 `.sec-item`，题型靠重复的 `h4.sec-title` 切分
 *   - `section.exam-analyze` 里另有 3 个同名的 `.sec-item`（实测碰撞）
 *   - 每个 `.sec-list` 恰好 1 道题
 */
const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/paper-detail.html', import.meta.url));
const FIXTURE_URL = 'https://zujuan.xkw.com/11p3524937.html';
const fixtureHtml = readFileSync(FIXTURE_PATH, 'utf8');

function loadFixture(url = FIXTURE_URL): Document {
  return new JSDOM(fixtureHtml, { url }).window.document as unknown as Document;
}

const EXPECTED_QIDS = ['35628232', '35917246', '35917247', '35502932'];

describe('夹具本身的真实性（防止夹具悄悄失效）', () => {
  it('保留了 .sec-item 类名碰撞：exam-analyze 里也有 .sec-item', () => {
    const doc = loadFixture();
    expect(doc.querySelectorAll('.sec-item').length).toBe(4);
    expect(doc.querySelectorAll('section.exam-list > .sec-item').length).toBe(1);
    expect(doc.querySelectorAll('section.exam-analyze .sec-item').length).toBe(3);
  });

  it('不含真实令牌/用户信息', () => {
    // 断言用「结构特征」而不是具体的账号值 ——
    // 把真实 userId/账号写进断言，等于把它一起提交进仓库（比泄漏夹具更糟）。
    // 1) 不能出现任何 JWT 形态的令牌
    expect(fixtureHtml).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    // 2) 答案链接上的令牌必须全部是占位符
    const tokens = fixtureHtml.match(/enVqdWFu=[^&"']*/g) ?? [];
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((token) => token === 'enVqdWFu=SANITIZED_TOKEN')).toBe(true);
    // 3) 题目签名 key 不能是 32 位以上的十六进制串（真实值形态）
    expect(fixtureHtml).not.toMatch(/\bk="[0-9a-f]{32,}"/i);
    // 4) 不能出现站点 cookie 明文
    expect(fixtureHtml).not.toMatch(/\b(user_token|SESS1ON|UT1)=[A-Za-z0-9%+/=_-]{8,}/);
  });
});

describe('paperDetailAdapter.matches', () => {
  it('对试卷详情页 URL + 真实 DOM 返回 true', () => {
    expect(paperDetailAdapter.matches(FIXTURE_URL, loadFixture())).toBe(true);
  });

  it('URL 不符时不匹配（如组卷中心、个人题库）', () => {
    for (const url of [
      'https://zujuan.xkw.com/zujuan/',
      'https://zujuan.xkw.com/basic/',
      'https://zujuan.xkw.com/usertk/zsd27925',
      'https://zujuan.xkw.com/gzsx/shijuan/jdcs/t3',
    ]) {
      expect(paperDetailAdapter.matches(url, loadFixture(url))).toBe(false);
    }
  });

  it('URL 相符但 DOM 不是试卷页时不匹配（双判定，避免站点路由变化时误注入）', () => {
    const doc = loadFixture();
    doc.querySelector('article.exam-cnt')?.remove();
    expect(paperDetailAdapter.matches(FIXTURE_URL, doc)).toBe(false);
  });
});

describe('collectPaperDetail —— 按题型标题分组', () => {
  let doc: Document;
  beforeEach(() => {
    doc = loadFixture();
  });

  it('切出两个题型分区，标题与题数都正确', () => {
    const result = collectPaperDetail(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.model.sections.map((s) => s.title)).toEqual(['一、单选题', '二、多选题']);
    expect(result.model.sections.map((s) => s.questions.length)).toEqual([2, 2]);
    expect(result.model.sections.reduce((n, s) => n + s.questions.length, 0)).toBe(4);
  });

  it('不会被试卷分析里的同名 .sec-item 污染（关键回归）', () => {
    const result = collectPaperDetail(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 只有 2 个分区；若选择器写成裸 `.sec-item`，这里会多出分析区块的分区
    expect(result.model.sections).toHaveLength(2);
  });

  it('题目身份（qid/bankId/index）按顺序正确', () => {
    const result = collectPaperDetail(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const questions = result.model.sections.flatMap((s) => s.questions);
    expect(questions.map((q) => q.qid)).toEqual(EXPECTED_QIDS);
    expect(questions.every((q) => q.bankId === '11')).toBe(true);
    // questionindex 从 0 开始，对外暴露为 1 开始
    expect(questions.map((q) => q.index)).toEqual([1, 2, 3, 4]);
  });

  it('questionindex 属性不可靠（实测整卷全为 0），序号一律取文档顺序', () => {
    // 这是一个实测坑：不能相信 [questionindex] 作为全局序号。
    const rawIndexes = Array.from(doc.querySelectorAll('.tk-quest-item')).map((n) =>
      n.getAttribute('questionindex'),
    );
    expect(rawIndexes).toHaveLength(4);
    expect(new Set(rawIndexes).size).toBe(1);

    const result = collectPaperDetail(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const indexes = result.model.sections.flatMap((s) => s.questions).map((q) => q.index);
    expect(indexes).toEqual([1, 2, 3, 4]);
  });

  it('提取标题与元信息', () => {
    const result = collectPaperDetail(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.model.title).toContain('江苏苏州市西安交通大学苏州附属中学');
    expect(result.model.meta).toContain('江苏');
    expect(result.model.meta).toContain('高一');
    expect(result.model.url).toBe(FIXTURE_URL);
  });

  it('记录选择题的实际命中项，便于诊断', () => {
    const result = collectPaperDetail(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const sectionReport = result.model.selectionReports.find((r) => r.key === 'sectionItem');
    expect(sectionReport?.used).toBe('section.exam-list > .sec-item');
    expect(sectionReport?.found).toBe(1);

    const questionReport = result.model.selectionReports.find((r) => r.key === 'questionItem');
    expect(questionReport?.used).toBe('.tk-quest-item.quesroot');
    expect(questionReport?.found).toBe(4);
  });
});

describe('collectPaperDetail —— 兜底：绝不丢题', () => {
  it('分组结构失效时，仍然把所有题目收进一个无名分区', () => {
    const doc = loadFixture();
    // 把 sec-list 提到 article 直下，破坏「题型标题 + sec-list」的分组前提
    const article = doc.querySelector('article.exam-cnt');
    const lists = Array.from(doc.querySelectorAll('section.exam-list .sec-list'));
    expect(lists).toHaveLength(4);
    for (const list of lists) article?.appendChild(list);

    const result = collectPaperDetail(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const questions = result.model.sections.flatMap((s) => s.questions);
    expect(questions).toHaveLength(4);
    expect(questions.map((q) => q.qid)).toEqual(EXPECTED_QIDS);
  });

  it('题目节点全部缺少身份信息时，明确失败而不是返回空试卷', () => {
    const doc = loadFixture();
    for (const node of Array.from(doc.querySelectorAll('.tk-quest-item'))) {
      node.removeAttribute('questionid');
    }
    for (const wrapper of Array.from(doc.querySelectorAll('.wrapper.quesdiv'))) {
      wrapper.removeAttribute('id');
    }

    const result = collectPaperDetail(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('questionid');
  });

  it('没有题目时明确失败并说明原因', () => {
    const doc = loadFixture();
    for (const node of Array.from(doc.querySelectorAll('.tk-quest-item'))) node.remove();

    const result = collectPaperDetail(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('.tk-quest-item');
  });

  it('没有正文容器时明确失败并说明原因', () => {
    const doc = loadFixture();
    doc.querySelector('article.exam-cnt')?.remove();

    const result = collectPaperDetail(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('article.exam-cnt');
  });
});

describe('采集只读，不改动页面', () => {
  it('采集前后 DOM 序列化完全一致', () => {
    const doc = loadFixture();
    const before = doc.documentElement.outerHTML;
    collectPaperDetail(doc);
    expect(doc.documentElement.outerHTML).toBe(before);
  });
});

describe('选择器回退', () => {
  it('buttonContainer 优先命中 .tools .link-box', () => {
    const doc = loadFixture();
    const resolved = resolveOne(doc, 'buttonContainer');
    expect(resolved.report.used).toBe('.tools .link-box');
    expect(resolved.value).not.toBeNull();
  });

  it('.tools 不存在时回退到 .other-info .link-box', () => {
    const doc = loadFixture();
    for (const tools of Array.from(doc.querySelectorAll('.tools'))) {
      tools.classList.remove('tools');
    }
    const resolved = resolveOne(doc, 'buttonContainer');
    // 候选顺序：.tools .link-box → .other-info .link-box → .link-box → …
    // 去掉 .tools 后命中第二档（个人题库页正是这种结构）
    expect(resolved.report.used).toBe('.other-info .link-box');
    expect(resolved.value).not.toBeNull();
  });

  it('.other-info 也不存在时才回退到裸 .link-box', () => {
    const doc = loadFixture();
    for (const sel of ['.tools', '.other-info']) {
      for (const el of Array.from(doc.querySelectorAll(sel))) el.classList.remove(sel.slice(1));
    }
    const resolved = resolveOne(doc, 'buttonContainer');
    expect(resolved.report.used).toBe('.link-box');
    expect(resolved.value).not.toBeNull();
  });

  it('answerBlock 命中 .exam-item__opt 下的 .item.answer', () => {
    const doc = loadFixture();
    const resolved = resolveOne(doc, 'answerBlock');
    expect(resolved.report.used).toBe('.exam-item__opt .item.answer');
  });

  it('sectionTitle 按文档顺序返回 2 个题型标题', () => {
    const doc = loadFixture();
    const { values, report } = resolveAll<HTMLElement>(doc, 'sectionTitle');
    expect(report.used).toBe('h4.sec-title');
    expect(values.map((v) => v.querySelector('span')?.textContent?.trim())).toEqual([
      '一、单选题',
      '二、多选题',
    ]);
  });

  it('未命中时如实报告 attempted 列表，而不是抛异常', () => {
    const doc = loadFixture();
    // 夹具头部另有一个 .other-info，需一并清除才能真正造出「未命中」场景
    for (const node of Array.from(doc.querySelectorAll('aside.other-info, .other-info'))) {
      node.remove();
    }
    const resolved = resolveOne(doc, 'sidebar');
    expect(resolved.value).toBeNull();
    expect(resolved.report.used).toBeNull();
    expect(resolved.report.attempted.length).toBeGreaterThan(0);
  });
});

describe('噪声清单', () => {
  it('覆盖实测中需要隐藏的框架、侧栏与试卷分析', () => {
    for (const required of [
      'header.page-header',
      '.fixed-nav',
      '.bread-nav',
      '.footer',
      'aside.other-info',
      'section.exam-analyze',
      '.ques-additional',
      '.exam-item__info',
    ]) {
      expect(PAPER_DETAIL_NOISE_SELECTORS).toContain(required);
    }
  });

  it('每条噪声选择器都能在夹具上正常求值（不会因选择器非法而中断）', () => {
    const doc = loadFixture();
    for (const selector of PAPER_DETAIL_NOISE_SELECTORS) {
      expect(() => doc.querySelectorAll(selector)).not.toThrow();
    }
  });

  it('知识点**不在**噪声清单里：它要与答案一起保留', () => {
    const doc = loadFixture();
    expect(doc.querySelectorAll('.item.knowlegde').length).toBeGreaterThan(0);
    for (const selector of ['.item.knowlegde', '.item.knowledge', '.knowledge-box']) {
      expect(PAPER_DETAIL_NOISE_SELECTORS).not.toContain(selector);
    }
  });
});

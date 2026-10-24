// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { collectPaperDetail } from '@/adapters/paper-detail';
import { buildPaperDocx } from '@/export/docx';
import {
  collectFormulaMathMl,
  decodeMmlBase64,
  formulaHashFromSrc,
  mmlUrlForHash,
} from '@/export/formula-mathml';

// jsdom 环境下 import.meta.url 是 http:// 而非 file://，因此用 cwd 定位夹具目录
const fixturesDir = resolve(process.cwd(), 'tests', 'fixtures');
const fixtureHtml = readFileSync(resolve(fixturesDir, 'paper-detail.html'), 'utf8');
const mmlDir = `${resolve(fixturesDir, 'formula-mml')}/`;

const pngDir = `${resolve(fixturesDir, 'formula-png')}/`;

/** Real formula PNGs as data URLs, keyed by the exact <img src> the page uses. */
function loadRealFormulaImages(): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of readdirSync(pngDir).filter((name) => name.endsWith('.png'))) {
    const hash = file.replace(/\.png$/, '');
    const base64 = readFileSync(`${pngDir}${file}`).toString('base64');
    map.set(`https://staticzujuan.xkw.com/quesimg/Upload/formula/${hash}.png`, `data:image/png;base64,${base64}`);
  }
  return map;
}

/** A genuinely valid 1x1 PNG, used as a stand-in for a validated answer image. */
const ANSWER_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/** Build imageData for the fixture's answer images, keyed by their current src. */
function answerImageDataForFixture(doc: Document): Map<string, string> {
  const map = new Map<string, string>();
  for (const img of Array.from(doc.querySelectorAll<HTMLImageElement>('.item.answer img'))) {
    const src = img.getAttribute('src');
    if (src) map.set(src, ANSWER_PNG_DATA_URL);
  }
  return map;
}

/**
 * Supply bytes for every formula the fixture references.
 * Uses one real PNG as a stand-in so the test never hits the network.
 */
function allFormulaImageData(doc: Document): Map<string, string> {
  const real = loadRealFormulaImages();
  const standIn = [...real.values()][0];
  if (!standIn) throw new Error('缺少公式 PNG 夹具');
  const map = new Map<string, string>();
  for (const img of Array.from(doc.querySelectorAll<HTMLImageElement>('img'))) {
    const src = img.getAttribute('src');
    if (src && formulaHashFromSrc(src)) map.set(src, real.get(src) ?? standIn);
  }
  return map;
}

/** Load the real captured .mml samples (base64 of genuine site MathML). */
function loadRealMathMl(): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of readdirSync(mmlDir).filter((name) => name.endsWith('.mml'))) {
    const hash = file.replace(/\.mml$/, '');
    const decoded = decodeMmlBase64(readFileSync(`${mmlDir}${file}`, 'utf8'));
    if (decoded) map.set(hash, decoded);
  }
  return map;
}

function loadFixture() {
  const dom = new JSDOM(fixtureHtml, { url: 'https://zujuan.xkw.com/11p3524937.html' });
  const doc = dom.window.document as unknown as Document;
  const collected = collectPaperDetail(doc);
  if (!collected.ok) throw new Error(collected.reason);
  return { doc, model: collected.model };
}

async function readDocumentXml(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // A .docx is a ZIP; verify that structure rather than trusting the library blindly.
  const files = unzipSync(bytes);
  const xml = files['word/document.xml'];
  if (!xml) throw new Error('docx 内缺少 word/document.xml');
  return strFromU8(xml);
}

describe('formula-mathml', () => {
  it('从公式图片 URL 中提取 hash（png/svg/mml 都支持）', () => {
    const hash = '0371ee50d839798126e465309675ce59';
    expect(formulaHashFromSrc(`https://staticzujuan.xkw.com/quesimg/Upload/formula/${hash}.png`)).toBe(hash);
    expect(formulaHashFromSrc(`https://staticzujuan.xkw.com/quesimg/Upload/formula/${hash}.svg`)).toBe(hash);
    expect(formulaHashFromSrc(`//staticzujuan.xkw.com/quesimg/Upload/formula/${hash}.png?x=1`)).toBe(hash);
  });

  it('非公式图片一律返回 null（避免误替换普通插图）', () => {
    for (const src of [
      'https://imzujuan.xkw.com/getAnswerAndParse/1/11/k?width=1240',
      'https://staticzujuan.xkw.com/quesimg/Upload/other/abc.png',
      'https://example.com/quesimg/Upload/formula/0371ee50d839798126e465309675ce59.png',
      '',
      null,
      undefined,
    ]) {
      expect(formulaHashFromSrc(src)).toBeNull();
    }
  });

  it('按实测模板拼出 .mml 地址', () => {
    expect(mmlUrlForHash('abc123')).toBe('https://staticzujuan.xkw.com/quesimg/Upload/formula/abc123.mml');
  });

  it('解码真实 .mml 样本，且按 UTF-8 正确处理数学符号', () => {
    const map = loadRealMathMl();
    expect(map.size).toBeGreaterThanOrEqual(5);

    // mfenced 样本（集合表示法）
    expect(map.get('0371ee50d839798126e465309675ce59')).toContain('<mfenced');
    // msup 样本，且含 ∀ 与全角逗号 —— 这验证了必须用 TextDecoder('utf-8')
    const logic = map.get('0916ae902a404282d34a5fcbf159a517');
    expect(logic).toContain('∀');
    expect(logic).toContain('<msup>');
    expect(logic).toContain('，');
  });

  it('拒绝空内容与非 MathML 内容', () => {
    expect(decodeMmlBase64('')).toBeNull();
    expect(decodeMmlBase64('   ')).toBeNull();
    expect(decodeMmlBase64('not-base64-@@@')).toBeNull();
    // 合法 base64 但不是 MathML
    expect(decodeMmlBase64(Buffer.from('<div>hi</div>', 'utf8').toString('base64'))).toBeNull();
  });

  it('按 hash 去重，同一公式出现多次只请求一次', async () => {
    const hash = '0371ee50d839798126e465309675ce59';
    const src = `https://staticzujuan.xkw.com/quesimg/Upload/formula/${hash}.png`;
    const fetchImpl = vi.fn(async () =>
      new Response(readFileSync(`${mmlDir}${hash}.mml`, 'utf8'), { status: 200 }),
    );
    const result = await collectFormulaMathMl([src, src, src, null, 'not-a-formula'], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.get(hash)).toContain('<math');
  });

  it('单个公式获取失败不影响其它公式，也不抛异常', async () => {
    const good = '0371ee50d839798126e465309675ce59';
    const bad = 'ffffffffffffffffffffffffffffffff';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes(bad)) throw new Error('offline');
      return new Response(readFileSync(`${mmlDir}${good}.mml`, 'utf8'), { status: 200 });
    });
    const result = await collectFormulaMathMl(
      [
        `https://staticzujuan.xkw.com/quesimg/Upload/formula/${good}.png`,
        `https://staticzujuan.xkw.com/quesimg/Upload/formula/${bad}.png`,
      ],
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.has(good)).toBe(true);
    expect(result.has(bad)).toBe(false);
  });

  it('没有公式时不发任何请求', async () => {
    const fetchImpl = vi.fn();
    const result = await collectFormulaMathMl(['https://imzujuan.xkw.com/x'], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('buildPaperDocx —— 真实试卷夹具端到端', () => {
  it('产出合法 docx（ZIP）并包含标题与表格', async () => {
    const { doc, model } = loadFixture();
    const result = await buildPaperDocx(
      doc, model,
      { mode: 'questions-only' },
      [],
      loadRealFormulaImages(),
    );

    expect(result.filename.endsWith('.docx')).toBe(true);
    expect(result.blob.size).toBeGreaterThan(1000);

    const xml = await readDocumentXml(result.blob);
    expect(xml).toContain('苏州');
    expect(xml).toContain('<w:tbl>');            // 选项表格是真实 DOCX 表格
    expect(xml).toContain('一、单选题');
  });

  it('用真实 MathML 把公式转成可编辑 OMML，而不是位图', async () => {
    const { doc, model } = loadFixture();
    const mathMl = loadRealMathMl();
    const result = await buildPaperDocx(
      doc,
      model,
      { mode: 'questions-only' },
      [],
      allFormulaImageData(doc),
      mathMl,
    );

    const xml = await readDocumentXml(result.blob);
    // OMML 数学节点：这是「公式可编辑」的硬证据，而不是塞一张位图
    expect(xml).toContain('m:oMath');
    // mfenced → OMML 定界符
    expect(xml).toContain('<m:d>');
    // msup → OMML 上标
    expect(xml).toContain('<m:sSup>');
    // ∀ 等符号在 XML 中应以 UTF-8 原样保留
    expect(xml).toContain('∀');
    // 图片全部提供了字节，因此不应有任何「缺少图片数据」告警
    expect(result.warnings.filter((w) => w.includes('缺少图片数据'))).toHaveLength(0);
  });

  it('拿不到 MathML 时保留位图，不产出空公式', async () => {
    const { doc, model } = loadFixture();
    const result = await buildPaperDocx(
      doc,
      model,
      { mode: 'questions-only' },
      [],
      allFormulaImageData(doc), // 提供全部图片字节
      new Map(),                // 刻意不提供 MathML
    );

    const xml = await readDocumentXml(result.blob);
    expect(xml).not.toContain('m:oMath');
    expect(xml).toContain('<w:drawing>'); // 公式以位图保留，没有丢公式
    expect(result.warnings.filter((w) => w.includes('缺少图片数据'))).toHaveLength(0);
  });

  it('知识点与答案始终在一起（答案置末时一起搬走）', async () => {
    const { doc, model } = loadFixture();
    const result = await buildPaperDocx(
      doc, model,
      { mode: 'answers-at-end' },
      [],
      answerImageDataForFixture(doc),
    );
    const xml = await readDocumentXml(result.blob);
    const texts = Array.from(xml.matchAll(/<w:t[^>]*>([^<]{1,80})<\/w:t>/g), (m) => (m[1] ?? '').trim()).filter(Boolean);

    const headingAt = texts.findIndex((t) => t.includes('答案与解析'));
    const knowledgeAt = texts.findIndex((t) => t.includes('【知识点】') || t.includes('知识点'));

    expect(headingAt).toBeGreaterThan(-1);
    // 关键：知识点必须出现在「答案与解析」之后（即与答案同处文末），
    // 而不是留在题目那边
    if (knowledgeAt > -1) {
      expect(knowledgeAt).toBeGreaterThan(headingAt);
    }
  });


  it('answers-only 模式不含题干，含答案图', async () => {
    const { doc, model } = loadFixture();
    const result = await buildPaperDocx(
      doc, model,
      { mode: 'answers-only' },
      [],
      answerImageDataForFixture(doc),
    );
    const xml = await readDocumentXml(result.blob);
    expect(xml).not.toContain('一、单选题');
    expect(xml).toContain('<w:drawing>');
    expect(result.warnings.filter((w) => w.includes('缺少图片数据'))).toHaveLength(0);
  });

  it('文件名对非法字符做净化', async () => {
    const { doc, model } = buildBadTitleFixture();
    const result = await buildPaperDocx(doc, model, {
      mode: 'questions-only',
    }, [], loadRealFormulaImages());
    expect(result.filename).not.toMatch(/[\\/:*?"<>|]/);
    expect(result.filename.endsWith('.docx')).toBe(true);
  });

  it('未提供图片字节时，必须逐条告警，绝不静默丢图', async () => {
    const { doc, model } = loadFixture();
    const result = await buildPaperDocx(
      doc, model,
      { mode: 'questions-only' },
      [],
      new Map(), // 什么图片都不给
    );

    const missing = result.warnings.filter((w) => w.includes('缺少图片数据'));
    // 夹具里有大量公式；一张都拿不到时应当逐条上报，而不是安静地消失
    expect(missing.length).toBeGreaterThan(10);
    // 告警要带题号，便于定位是哪一题
    expect(missing.some((w) => /第 \d+ 题题干/.test(w))).toBe(true);
    const xml = await readDocumentXml(result.blob);
    expect(xml).not.toContain('<w:drawing>');
  });

  it('MathML 解析失败时保留位图而不是静默丢公式', async () => {
    const { doc, model } = loadFixture();
    const hash = '0371ee50d839798126e465309675ce59';
    const result = await buildPaperDocx(
      doc,
      model,
      { mode: 'questions-only' },
      [],
      loadRealFormulaImages(),
      new Map([[hash, '<div>不是公式</div>']]),
    );
    const xml = await readDocumentXml(result.blob);
    expect(xml).not.toContain('m:oMath');
    // 位图被内联为 data URL 后，hash 出现在图片关联里而不是明文 URL
    expect(xml).toContain('<w:drawing>');
  });
});

/** 构造一个含非法文件名字符的标题，验证文件名净化。 */
function buildBadTitleFixture() {
  const { doc, model } = loadFixture();
  const bad = `${model.title}：含/非法\\字符*?"<>|`;
  return { doc, model: { ...model, title: bad } };
}

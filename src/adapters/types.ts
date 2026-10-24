/**
 * 页面适配器契约。
 *
 * 目的：把「某一类页面长什么样、怎么读」与「导出逻辑」解耦。
 * 本期只实现试卷详情页；组卷中心 `/zujuan/`、细目表组卷 `/basic/`、
 * 个人题库 `/usertk/*` 等页面类型 DOM 完全不同，后续各自新增适配器即可，
 * 不需要改动导出层。
 */

import type { SelectionReport } from './selectors';

/** 一道题在页面上的引用与身份。 */
export interface QuestionRef {
  /** 题目 ID，取自 `.tk-quest-item[questionid]`；也是答案接口的 `quesId` */
  readonly qid: string;
  /** 题库 ID，取自 `.tk-quest-item[bankid]`，试卷详情页实测为 "11" */
  readonly bankId: string;
  /** 题目在整卷中的序号（1 开始），取自 `[questionindex]` 或回退为遍历序号 */
  readonly index: number;
  /** 题目节点本身 */
  readonly node: HTMLElement;
}

export interface PaperSection {
  /** 题型标题，如「一、单选题」 */
  readonly title: string;
  readonly questions: readonly QuestionRef[];
}

export interface PaperModel {
  readonly url: string;
  readonly title: string;
  /**
   * 正文根容器的 CSS 选择器。
   *
   * 导出层需要它来限定「正文范围」——例如收集内容图片
   * (`<root> img`)、打印时把根容器撑满纸面。
   * 三类页面各有各的根（`article.exam-cnt` / `article.paper-cnt`），
   * 因此由适配器给出，而不是在导出层里硬编码。
   */
  readonly rootSelector: string;
  readonly sections: readonly PaperSection[];
  /** 标题下的元信息（地区/年级/类型/日期…） */
  readonly meta: readonly string[];
  /** 采集过程中各选择器的命中情况，供诊断使用 */
  readonly selectionReports: readonly SelectionReport[];
}

/** 采集结果：要么成功拿到试卷，要么给出可读的失败原因。 */
export type CollectResult =
  | { readonly ok: true; readonly model: PaperModel }
  | { readonly ok: false; readonly reason: string; readonly reports: readonly SelectionReport[] };

export interface PageAdapter {
  readonly id: string;
  /** 人类可读名称，用于 UI */
  readonly label: string;
  /** 依据 URL 与 DOM 双重判定，避免误注入 */
  matches(url: string, doc: Document): boolean;
  /** 只读采集，**不得修改页面 DOM** */
  collect(doc: Document): CollectResult;
  /**
   * 打印/导出时需要剔除的噪声选择器。
   * 这些只在打印样式或离屏 clone 上生效，绝不对原页面做删除操作。
   */
  readonly noiseSelectors: readonly string[];
}

import { createPersona, listPersonas } from './personas';
import type { Db } from './connection';

/**
 * 内置示例角色（人格）。
 *
 * 说明：需求要求「预设若干示例角色」。这些角色在**首次启动且角色表为空**时写入
 * 数据库，用户之后可以随意编辑或删除 —— 它们是普通数据行，不是硬编码依赖，
 * 因此删掉后不会「复活」。
 */

/** 一条内置角色的定义。 */
interface PersonaSeed {
  name: string;
  systemPrompt: string;
}

/** 内置角色列表。 */
const PERSONA_SEEDS: PersonaSeed[] = [
  {
    name: '通用助手',
    systemPrompt:
      '你是 AstraChat 的通用 AI 助手。请用简洁、准确、结构化的中文回答用户问题。\n' +
      '当问题有多个步骤时，先给出结论，再给出必要的过程说明。\n' +
      '不确定的地方要明确说明不确定，不要编造事实。',
  },
  {
    name: '代码搭档',
    systemPrompt:
      '你是一位资深软件工程师，擅长 TypeScript / JavaScript / Python / Rust。\n' +
      '回答要求：\n' +
      '1. 先给可直接运行的代码，再解释关键设计取舍。\n' +
      '2. 指出代码中的边界条件与潜在缺陷。\n' +
      '3. 除非用户要求，否则不要堆砌无关的背景知识。',
  },
  {
    name: '产品文案',
    systemPrompt:
      '你是一位擅长中文互联网语境的产品文案撰写者，服务对象是「星辰跃动」工作室。\n' +
      '文风：干净、有画面感、不油腻，避免空洞的形容词堆砌。\n' +
      '请主动给出 2–3 个不同方向的候选文案供选择，并简述各自的适用场景。',
  },
  {
    name: '翻译润色',
    systemPrompt:
      '你是中英互译专家。规则：\n' +
      '1. 先输出译文，再（可选）用要点说明处理过的难点。\n' +
      '2. 保持原文语气与专业术语的准确性，专有名词首次出现时保留原文。\n' +
      '3. 不做过度意译，不添加原文没有的信息。',
  },
];

/**
 * 在角色表为空时写入内置示例角色。
 *
 * 幂等：只要表里已有任意一行就什么都不做，因此不会在用户删光角色后「复活」它们，
 * 也不会覆盖用户的修改。
 *
 * @param db 数据库句柄。
 * @returns 实际写入的角色数量（已存在则为 0）。
 */
export function seedPersonas(db: Db): number {
  if (listPersonas(db).length > 0) {
    return 0;
  }

  for (const seed of PERSONA_SEEDS) {
    createPersona(db, {
      name: seed.name,
      avatar: null,
      systemPrompt: seed.systemPrompt,
      isPreset: true,
    });
  }

  return PERSONA_SEEDS.length;
}

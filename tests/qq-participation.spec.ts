import { describe, expect, it } from 'vitest';
import {
  SILENCE_SENTINEL,
  SILENCE_INSTRUCTION,
  VERDICT_SYSTEM_PROMPT,
  createParticipationBudget,
  parseVerdict,
  readSentinelVerdict,
  stripSentinel,
} from '../src/services/qq/participation';

/**
 * 「让模型自行决定是否回复」的纯逻辑测试。
 *
 * 两种模式（都在这里测，因为判定语义只有一处）：
 *
 * - **标准**：单次调用 + 哨兵。不想说话时模型只输出 `[[SILENCE]]`。
 * - **EXP 实验性**：两次调用。先问「要不要说话」，再生成。
 *
 * ## 这里最要紧的一条规则
 *
 * 判定「沉默」**只在整条输出除了哨兵什么都没有时才成立**。
 * 正文里出现哨兵字样（模型复述了提示词、或提到这个词）绝不能把真实内容一起丢掉 ——
 * 那会造成「模型说了话，但用户什么都没收到」这种最难查的故障。
 */

describe('哨兵常量与提示词', () => {
  it('沉默提示词里必须写明哨兵本身（否则模型不可能知道要输出什么）', () => {
    expect(SILENCE_INSTRUCTION).toContain(SILENCE_SENTINEL);
  });

  it('判定提示词里要同时给出「说话」与「沉默」两个答案', () => {
    expect(VERDICT_SYSTEM_PROMPT).toContain('SPEAK');
    expect(VERDICT_SYSTEM_PROMPT).toContain('SILENCE');
  });

  it('提示词要说明「大多数时候应该沉默」——否则模型会倾向于说话', () => {
    // 群聊里默认参与会立刻变成刷屏，所以提示词必须把沉默设为默认
    expect(SILENCE_INSTRUCTION).toMatch(/大多数|通常|默认/);
    expect(VERDICT_SYSTEM_PROMPT).toMatch(/大多数|通常|默认/);
  });
});

describe('标准模式：从整条输出判定', () => {
  it('整条恰好是哨兵 → 沉默', () => {
    expect(readSentinelVerdict(SILENCE_SENTINEL).speak).toBe(false);
  });

  it('前后有空白与换行也算', () => {
    expect(readSentinelVerdict(`\n\n  ${SILENCE_SENTINEL}  \n`).speak).toBe(false);
  });

  it('被引号或反引号包住也算（模型常这么做）', () => {
    for (const raw of [
      `"${SILENCE_SENTINEL}"`,
      `'${SILENCE_SENTINEL}'`,
      '`' + SILENCE_SENTINEL + '`',
      `“${SILENCE_SENTINEL}”`,
    ]) {
      expect(readSentinelVerdict(raw).speak, raw).toBe(false);
    }
  });

  it('后面跟一个句号也算（模型爱加标点）', () => {
    expect(readSentinelVerdict(`${SILENCE_SENTINEL}。`).speak).toBe(false);
    expect(readSentinelVerdict(`${SILENCE_SENTINEL}.`).speak).toBe(false);
  });

  it('重复输出哨兵也算沉默', () => {
    expect(readSentinelVerdict(`${SILENCE_SENTINEL}${SILENCE_SENTINEL}`).speak).toBe(false);
  });

  it('大小写不敏感，且容忍全角方括号', () => {
    expect(readSentinelVerdict('[[silence]]').speak).toBe(false);
    expect(readSentinelVerdict('【【SILENCE】】').speak).toBe(false);
  });

  it('【关键】正文里出现哨兵但还有真实内容 → 必须说话，不能把内容丢掉', () => {
    const raw = `${SILENCE_SENTINEL} 但是我觉得这个方案可行`;
    const verdict = readSentinelVerdict(raw);

    expect(verdict.speak).toBe(true);
  });

  it('普通回复 → 说话', () => {
    expect(readSentinelVerdict('这波稳了').speak).toBe(true);
  });

  it('空输出 → 判定为「说话」，把空内容交给下游的空内容分支处理', () => {
    // 空输出不是「沉默」这个语义：沉默是模型的主动选择，空输出是异常。
    // 混为一谈会让日志里分不清「模型不想说」与「模型没说出东西」。
    const verdict = readSentinelVerdict('   ');
    expect(verdict.speak).toBe(true);
  });
});

describe('stripSentinel：清掉正文里偶现的哨兵字样', () => {
  it('删掉哨兵并保留真实内容', () => {
    expect(stripSentinel(`${SILENCE_SENTINEL} 你好`)).toBe('你好');
    expect(stripSentinel(`你好 ${SILENCE_SENTINEL}`)).toBe('你好');
  });

  it('没有哨兵时原样返回（只去首尾空白）', () => {
    expect(stripSentinel('  你好  ')).toBe('你好');
  });

  it('只删哨兵，不影响其它方括号内容', () => {
    expect(stripSentinel('[惊讶] 你好')).toBe('[惊讶] 你好');
  });
});

describe('EXP 模式：解析判定调用的输出', () => {
  it('SPEAK → 说话', () => {
    expect(parseVerdict('SPEAK').speak).toBe(true);
    expect(parseVerdict('speak').speak).toBe(true);
    expect(parseVerdict(' Speak。').speak).toBe(true);
  });

  it('SILENCE → 沉默', () => {
    expect(parseVerdict('SILENCE').speak).toBe(false);
    expect(parseVerdict('silence').speak).toBe(false);
  });

  it('接受中文写法', () => {
    expect(parseVerdict('说话').speak).toBe(true);
    expect(parseVerdict('沉默').speak).toBe(false);
    expect(parseVerdict('不说话').speak).toBe(false);
  });

  it('取第一个词，后面的解释不影响判定', () => {
    expect(parseVerdict('SPEAK\n理由：他们在问我').speak).toBe(true);
    expect(parseVerdict('SILENCE 因为跟我无关').speak).toBe(false);
  });

  it('【关键】无法解析时按沉默处理（fail-closed）', () => {
    // 判定器坏掉不应该导致插嘴；而且 @ 消息不经过判定，所以不会「全哑」
    for (const raw of ['MAYBE', '我不确定', '', '   ', '???']) {
      const verdict = parseVerdict(raw);
      expect(verdict.speak, raw).toBe(false);
      if (!verdict.speak) {
        expect(verdict.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it('无法解析的原因要能区分于「模型主动选择沉默」', () => {
    const active = parseVerdict('SILENCE');
    const broken = parseVerdict('???');
    expect(active.speak).toBe(false);
    expect(broken.speak).toBe(false);
    if (!active.speak && !broken.speak) {
      expect(active.reason).not.toBe(broken.reason);
    }
  });
});

describe('冷却与每小时预算', () => {
  const LIMITS = { cooldownMs: 30_000, maxPerHour: 3 };

  it('第一次检查放行', () => {
    const budget = createParticipationBudget(LIMITS);
    expect(budget.check('group:A', 1_000_000).allowed).toBe(true);
  });

  it('发言后处于冷却期内不放行', () => {
    const budget = createParticipationBudget(LIMITS);
    budget.record('group:A', 1_000_000);

    const decision = budget.check('group:A', 1_010_000);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain('冷却');
    }
  });

  it('冷却期过后放行', () => {
    const budget = createParticipationBudget(LIMITS);
    budget.record('group:A', 1_000_000);
    expect(budget.check('group:A', 1_030_000).allowed).toBe(true);
  });

  it('超过每小时上限后不放行', () => {
    const budget = createParticipationBudget({ cooldownMs: 0, maxPerHour: 2 });
    budget.record('group:A', 1_000_000);
    budget.record('group:A', 1_100_000);

    const decision = budget.check('group:A', 1_200_000);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain('上限');
    }
  });

  it('一小时以前的发言不再计数', () => {
    const budget = createParticipationBudget({ cooldownMs: 0, maxPerHour: 2 });
    budget.record('group:A', 1_000_000);
    budget.record('group:A', 1_100_000);

    // 过了一小时：两条旧记录都过期
    expect(budget.check('group:A', 1_000_000 + 3_600_001).allowed).toBe(true);
  });

  it('冷却与预算按来源隔离', () => {
    const budget = createParticipationBudget(LIMITS);
    budget.record('group:A', 1_000_000);

    expect(budget.check('group:A', 1_001_000).allowed).toBe(false);
    expect(budget.check('group:B', 1_001_000).allowed).toBe(true);
  });

  it('reset 清掉某来源的冷却与计数', () => {
    const budget = createParticipationBudget(LIMITS);
    budget.record('group:A', 1_000_000);
    budget.reset('group:A');

    expect(budget.check('group:A', 1_000_001).allowed).toBe(true);
  });

  it('非法上限被夹到安全值（不能因为配置成 0 就永久静音）', () => {
    const budget = createParticipationBudget({ cooldownMs: 0, maxPerHour: 0 });
    budget.record('group:A', 1_000_000);
    // maxPerHour 被夹到 1：刚 record 完在这一小时内已经用掉额度
    expect(budget.check('group:A', 1_000_001).allowed).toBe(false);
    // 但冷却为 0，一小时后就该放行
    expect(budget.check('group:A', 1_000_000 + 3_600_001).allowed).toBe(true);
  });

  it('冷却时间非法时按 0 处理（不阻塞）', () => {
    const budget = createParticipationBudget({ cooldownMs: -5, maxPerHour: 5 });
    budget.record('group:A', 1_000_000);
    expect(budget.check('group:A', 1_000_000).allowed).toBe(true);
  });
});

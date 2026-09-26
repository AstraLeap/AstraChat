import { describe, expect, it } from 'vitest';
import {
  ROLE_CLEAR_TOKENS,
  isRoleClearRequest,
  resolveCommand,
  type CommandDecision,
} from '../src/services/qq/commands';

/**
 * 管理命令判定的测试。
 *
 * 这是设计 §6.3 的硬边界：**管理命令由程序执行、不经过模型**，群友的斜杠命令必须被
 * 程序拦下而不是交给模型。原因是——只要斜杠命令进了模型，群友就可以用话术尝试让模型
 * 「扮演」管理员执行动作；拦在程序层则话术在设计上就不可能生效。
 *
 * 另一条同样重要的决定：**所有以 `/` 开头的消息都不进模型**，无论认不认识这个命令。
 * 把一个不认识的 `/xxx` 交给模型，等于把命令语法本身变成了一条提示词注入通道。
 */

/** 便于断言的简写：取出 action。 */
function actionOf(decision: CommandDecision): string {
  return decision.action;
}

describe('非命令', () => {
  it('不以斜杠开头 → 走正常聊天', () => {
    expect(actionOf(resolveCommand('今天天气不错', 'member'))).toBe('chat');
    expect(actionOf(resolveCommand('今天天气不错', 'owner'))).toBe('chat');
  });

  it('斜杠出现在句中不算命令', () => {
    expect(actionOf(resolveCommand('path 是 a/b 这样', 'owner'))).toBe('chat');
  });

  it('空内容 → 走正常聊天', () => {
    expect(actionOf(resolveCommand('', 'owner'))).toBe('chat');
    expect(actionOf(resolveCommand('   ', 'owner'))).toBe('chat');
  });

  it('只有斜杠但无名字 → 算未知命令（不是聊天）', () => {
    expect(actionOf(resolveCommand('/', 'owner'))).toBe('unknown');
  });
});

describe('管理员执行', () => {
  it('/status', () => {
    const decision = resolveCommand('/status', 'owner');
    expect(decision.action).toBe('execute');
    if (decision.action !== 'execute') {
      return;
    }
    expect(decision.command.name).toBe('status');
    expect(decision.command.raw).toBe('/status');
  });

  it('命令名大小写不敏感', () => {
    const decision = resolveCommand('/STATUS', 'owner');
    expect(decision.action).toBe('execute');
    if (decision.action !== 'execute') {
      return;
    }
    expect(decision.command.name).toBe('status');
  });

  it('接受全角斜杠（中文输入法下很常见）', () => {
    const decision = resolveCommand('／silent', 'owner');
    expect(decision.action).toBe('execute');
    if (decision.action !== 'execute') {
      return;
    }
    expect(decision.command.name).toBe('silent');
  });

  it('前后空白被容忍', () => {
    expect(actionOf(resolveCommand('   /active   ', 'owner'))).toBe('execute');
  });

  it('其余内置命令都能识别', () => {
    for (const name of ['reset', 'silent', 'active', 'status', 'help'] as const) {
      const decision = resolveCommand(`/${name}`, 'owner');
      expect(decision.action, name).toBe('execute');
      if (decision.action !== 'execute') {
        continue;
      }
      expect(decision.command.name).toBe(name);
    }
  });
});

describe('/role 带参数', () => {
  it('取出角色名', () => {
    const decision = resolveCommand('/role 傲娇助手', 'owner');
    expect(decision.action).toBe('execute');
    if (decision.action !== 'execute') {
      return;
    }
    expect(decision.command.name).toBe('role');
    expect(decision.command.argument).toBe('傲娇助手');
  });

  it('/role off 是「清除角色」的表达', () => {
    const decision = resolveCommand('/role off', 'owner');
    if (decision.action !== 'execute') {
      return;
    }
    expect(decision.command.argument).toBe('off');
    expect(isRoleClearRequest(decision.command.argument)).toBe(true);
  });

  it('清除角色的几种写法都认', () => {
    for (const token of ROLE_CLEAR_TOKENS) {
      expect(isRoleClearRequest(token), token).toBe(true);
      expect(isRoleClearRequest(token.toUpperCase()), token).toBe(true);
    }
  });

  it('正常角色名不会被当成清除', () => {
    expect(isRoleClearRequest('傲娇助手')).toBe(false);
    expect(isRoleClearRequest(null)).toBe(false);
  });

  it('角色名里的空格被保留（去掉首尾）', () => {
    const decision = resolveCommand('/role   小 鲸 鱼  ', 'owner');
    if (decision.action !== 'execute') {
      return;
    }
    expect(decision.command.argument).toBe('小 鲸 鱼');
  });

  it('/role 不带参数 → 未知命令并提示用法', () => {
    const decision = resolveCommand('/role', 'owner');
    expect(decision.action).toBe('unknown');
    if (decision.action !== 'unknown') {
      return;
    }
    expect(decision.reason).toContain('role');
  });
});

describe('群友的命令必须被拦下', () => {
  it('认识的管理命令也不执行', () => {
    for (const text of ['/status', '/reset', '/silent', '/active', '/role 傲娇助手']) {
      const decision = resolveCommand(text, 'member');
      expect(decision.action, text).toBe('reject');
      if (decision.action !== 'reject') {
        continue;
      }
      expect(decision.reason).toContain('管理员');
    }
  });

  it('不认识的斜杠命令同样拦下（理由仍是权限，而不是「不认识」）', () => {
    // 对群友而言「认不认识」不重要 —— 他没有执行权限，先按权限拒绝
    const decision = resolveCommand('/bogus', 'member');
    expect(decision.action).toBe('reject');
  });

  it('命令前加空格也拦得住', () => {
    expect(actionOf(resolveCommand('   /status', 'member'))).toBe('reject');
  });

  it('全角斜杠也拦得住', () => {
    expect(actionOf(resolveCommand('／reset', 'member'))).toBe('reject');
  });
});

describe('管理员的不明命令', () => {
  it('不认识的命令报「未知」而不是执行', () => {
    const decision = resolveCommand('/bogus', 'owner');
    expect(decision.action).toBe('unknown');
    if (decision.action !== 'unknown') {
      return;
    }
    expect(decision.reason).toContain('bogus');
    expect(decision.raw).toBe('/bogus');
  });

  it('不带斜杠的命令名（如 status）是普通聊天，不是命令', () => {
    expect(actionOf(resolveCommand('status', 'owner'))).toBe('chat');
  });

  it('多行内容只看是否为命令，参数保留首行之后的部分', () => {
    const decision = resolveCommand('/role 傲娇助手\n第二行', 'owner');
    expect(decision.action).toBe('execute');
    if (decision.action !== 'execute') {
      return;
    }
    expect(decision.command.name).toBe('role');
    // 参数取整段（含换行）—— 由调用方决定怎么截断，这里不擅自丢掉内容
    expect(decision.command.argument).toContain('傲娇助手');
  });
});

describe('每个判定都给出可解释的信息', () => {
  it('reject 与 unknown 都带非空 reason', () => {
    const cases: [string, 'owner' | 'member'][] = [
      ['/status', 'member'],
      ['/bogus', 'owner'],
      ['/role', 'owner'],
      ['/', 'owner'],
    ];
    for (const [text, role] of cases) {
      const decision = resolveCommand(text, role);
      if (decision.action === 'reject' || decision.action === 'unknown') {
        expect(decision.reason.length, `${text}/${role}`).toBeGreaterThan(0);
      }
    }
  });
});

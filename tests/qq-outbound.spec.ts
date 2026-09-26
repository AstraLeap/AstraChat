import { describe, expect, it } from 'vitest';
import { prepareOutbound } from '../src/services/qq/outbound';

/**
 * 出站文本管线的测试。
 *
 * 管线顺序是「**先转纯文本 → 再审计 → 再切分**」，这个文件里有专门用例锁住它：
 * 审计必须检查**真正会发出去的那段文本**，否则审计对象与发送对象可能不一致。
 */

/** 默认选项：审计开启、单条 4000 字符。 */
const DEFAULTS = { maxChars: 4000, auditEnabled: true } as const;

describe('正常路径：转换 + 切分', () => {
  it('Markdown 被转成纯文本', () => {
    const result = prepareOutbound('**你好**，见 [文档](https://a.com/b)', DEFAULTS);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') {
      return;
    }
    expect(result.parts).toEqual(['你好，见 文档 (https://a.com/b)']);
  });

  it('超长文本按上限切成多段', () => {
    const result = prepareOutbound('a'.repeat(10), { ...DEFAULTS, maxChars: 4 });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') {
      return;
    }
    expect(result.parts).toEqual(['aaaa', 'aaaa', 'aa']);
  });

  it('切分拼接结果等于转换后的纯文本（不丢字）', () => {
    const text = '混排 😀 与中文，还有 **标记** 和 `code`。'.repeat(3);
    const result = prepareOutbound(text, { ...DEFAULTS, maxChars: 7 });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') {
      return;
    }
    expect(result.parts.join('')).toBe('混排 😀 与中文，还有 标记 和 code。'.repeat(3));
  });

  it('代码块内容原样保留（不被当 Markdown 处理）', () => {
    const result = prepareOutbound('```js\nconst a = 2 * 3 * 4;\n```', DEFAULTS);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') {
      return;
    }
    expect(result.parts).toEqual(['const a = 2 * 3 * 4;']);
  });
});

describe('审计：接在纯文本之后', () => {
  it('命中本机路径 → 整条不发', () => {
    const result = prepareOutbound('文件在 C:\\Users\\a\\b.txt', DEFAULTS);
    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') {
      return;
    }
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it('命中已知密钥 → 整条不发', () => {
    const result = prepareOutbound('key: my-super-secret-key-12345', {
      ...DEFAULTS,
      knownSecrets: ['my-super-secret-key-12345'],
    });
    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') {
      return;
    }
    expect(result.findings[0]?.rule).toBe('known-secret');
  });

  it('【顺序】finding 的位置对应**转换后的纯文本**，不是原始 Markdown', () => {
    // 原始 Markdown 里 `**` 占了 2 个字符；转换后凭据从位置 0 开始。
    // 若先审计再转换，start 会是 2 —— 这条用例就是用来锁住「先转后审」的。
    const result = prepareOutbound('**token: sk-abc123def456**', DEFAULTS);
    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') {
      return;
    }
    const finding = result.findings[0]!;
    expect(finding.start).toBe(0);
    // 纯文本是 'token: sk-abc123def456'，共 22 个字符
    expect(finding.end).toBe(22);
  });

  it('拦截时不产出任何可发送的段落', () => {
    const result = prepareOutbound('密码：hunter2xyz', DEFAULTS);
    expect(result.status).toBe('blocked');
    expect('parts' in result).toBe(false);
  });

  it('auditEnabled=false 时跳过审计', () => {
    const result = prepareOutbound('文件在 C:\\Users\\a\\b.txt', {
      ...DEFAULTS,
      auditEnabled: false,
    });
    expect(result.status).toBe('ready');
  });

  it('auditEnabled 缺省视为开启（fail-closed）', () => {
    const result = prepareOutbound('文件在 C:\\Users\\a\\b.txt', { maxChars: 4000 });
    expect(result.status).toBe('blocked');
  });

  it('正常聊天不被拦', () => {
    const result = prepareOutbound('这个 token 怎么申请？我也想配一个。', DEFAULTS);
    expect(result.status).toBe('ready');
  });
});

describe('空内容', () => {
  it('空串 → empty', () => {
    expect(prepareOutbound('', DEFAULTS).status).toBe('empty');
  });

  it('只有空白 → empty', () => {
    expect(prepareOutbound('   \n\n  ', DEFAULTS).status).toBe('empty');
  });

  it('转换后变成空 → empty', () => {
    // 单行都是空白，转换后 trim 成空串
    expect(prepareOutbound('  \n  \n  ', DEFAULTS).status).toBe('empty');
  });

  it('empty 不是 blocked（没有内容可发不等于被安全策略拦截）', () => {
    const result = prepareOutbound('   ', DEFAULTS);
    expect(result.status).toBe('empty');
    expect(result.status).not.toBe('blocked');
  });
});

describe('选项透传', () => {
  it('maxChars 生效', () => {
    const result = prepareOutbound('abcdef', { ...DEFAULTS, maxChars: 2 });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') {
      return;
    }
    expect(result.parts).toEqual(['ab', 'cd', 'ef']);
  });

  it('auditOptions 可单独关掉路径检查', () => {
    const result = prepareOutbound('文件在 C:\\Users\\a\\b.txt', {
      ...DEFAULTS,
      auditOptions: { checkPaths: false },
    });
    expect(result.status).toBe('ready');
  });

  it('auditOptions 可单独关掉凭据检查', () => {
    const result = prepareOutbound('token: sk-abc123def456', {
      ...DEFAULTS,
      auditOptions: { checkCredentials: false },
    });
    expect(result.status).toBe('ready');
  });
});

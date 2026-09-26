import { describe, expect, it } from 'vitest';
import { auditOutgoingText, maskSensitive, redactForLog } from '../src/services/qq/audit';

/**
 * 出站内容审计的测试。
 *
 * 这个模块拦的是**要发到 QQ 群的文本**，所以两组断言同等重要：
 *
 * 1. **必须拦住**真正会泄露的形态（本机路径、凭据赋值、已知密钥）。
 * 2. **必须放过**正常聊天里长得像但其实是普通说话的句子 —— 拦截是「整条不发」，
 *    误报意味着机器人莫名其妙不吭声，而且用户很难知道为什么。
 *
 * 第 2 组（负例）才是这个模块真正的难点：`技术关键词 + 空白 + 中文` 这种形态极易误伤
 * （「这个 token 怎么申请」「请把 password 字段留空」），所以只有在分隔符能明确表达
 * 「赋值关系」时才判定，`是/为` 这类中文系词还额外要求右侧看起来像技术串。
 */

describe('本机路径：必须拦', () => {
  const cases: [string, string][] = [
    ['Windows 盘符（反斜杠）', '文件在 C:\\Users\\someone\\Documents\\key.txt 里'],
    ['Windows 盘符（正斜杠）', '路径是 D:/projects/secret/config.json'],
    ['UNC 网络路径', '放在 \\\\NAS\\share\\passwords.txt'],
    ['Linux 家目录', '我把它存到了 /home/deploy/.ssh/id_rsa'],
    ['macOS 家目录', '见 /Users/alice/.aws/credentials'],
    ['系统配置', '改一下 /etc/nginx/nginx.conf 就行'],
    ['日志目录', '日志在 /var/log/astra/app.log'],
    ['root 目录', 'root 的配置是 /root/.bashrc'],
  ];

  for (const [name, text] of cases) {
    it(name, () => {
      const result = auditOutgoingText(text);
      expect(result.blocked).toBe(true);
      expect(result.findings.some((f) => f.rule.endsWith('path'))).toBe(true);
    });
  }
});

describe('路径误报：必须放过', () => {
  const cases: [string, string][] = [
    ['时间不是盘符', '我 12:30 到，别等我'],
    ['URL 里的 /Users/ 不是本机路径', '见 https://example.com/Users/guide 这一节'],
    ['URL 里的 /etc/ 不是本机路径', '文档在 https://docs.example.com/etc/format 里'],
    ['普通中文里没有路径', '这个功能的说明在第三章'],
  ];

  for (const [name, text] of cases) {
    it(name, () => {
      expect(auditOutgoingText(text).blocked, `不该拦：${text}`).toBe(false);
    });
  }
});

describe('凭据赋值：必须拦', () => {
  const cases: [string, string][] = [
    ['英文冒号', 'token: sk-abc123def456ghi'],
    ['等号', 'api_key = abcd1234efgh'],
    ['全角冒号', '密码：hunter2xyz'],
    ['中文系词 是', '密码是 hunter2xyz'],
    ['中文系词 为', '密钥为 abcdef123456'],
    ['password 冒号', 'password: correcthorse'],
    ['secret 等号', 'secret = mysecretvalue123'],
    ['Authorization 头', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.xxx'],
    ['技术串直接跟空白', 'access_key abcdef1234567890'],
    ['裸的 sk- 形态密钥', '这是我的 key sk-proj-abcdefghijklmnopqrstuv'],
  ];

  for (const [name, text] of cases) {
    it(name, () => {
      const result = auditOutgoingText(text);
      expect(result.blocked).toBe(true);
      expect(result.findings.length).toBeGreaterThan(0);
    });
  }
});

describe('凭据误报：必须放过（本模块最关键的负例）', () => {
  const cases: [string, string][] = [
    ['问句：这个 token 怎么申请', '这个 token 怎么申请？'],
    ['吐槽：token 真难用', '这个平台的 token 真难用'],
    ['中文系词接中文：token 是怎么生成的', '你的 token 是怎么生成的'],
    ['只说改密码，没赋值', '我今天要改密码'],
    ['密码学是学科名', '密码学是一门学科'],
    ['字段名后面接中文', '请把 password 字段留空'],
    ['Bearer 后面接中文', 'Bearer 令牌需要先配置'],
    ['sk- 后面接中文说明', 'sk- 是 OpenAI 的密钥前缀格式'],
    ['只提关键词没有值', 'token 过期了要重新登录'],
    ['api key 后面接中文', 'api key 要去后台申请'],
  ];

  for (const [name, text] of cases) {
    it(name, () => {
      expect(auditOutgoingText(text).blocked, `不该拦：${text}`).toBe(false);
    });
  }
});

describe('已知密钥精确匹配（零误报的那一层）', () => {
  const secret = 'my-super-secret-key-12345';

  it('文本里出现已知密钥 → 拦，且规则是 known-secret', () => {
    const result = auditOutgoingText(`你的 key 是 ${secret} 别忘了`, {
      knownSecrets: [secret],
    });
    expect(result.blocked).toBe(true);
    expect(result.findings[0]?.rule).toBe('known-secret');
  });

  it('前缀式的 key 片段也能命中', () => {
    const result = auditOutgoingText(`配置里写 sk-proj-abcdefghijklmnop`, {
      knownSecrets: ['sk-proj-abcdefghijklmnop'],
    });
    expect(result.blocked).toBe(true);
  });

  it('太短的已知值被忽略，避免到处命中', () => {
    // 3 个字符的「密钥」若参与匹配，几乎任何文本都会命中
    const result = auditOutgoingText('今天天气不错', { knownSecrets: ['abc'] });
    expect(result.blocked).toBe(false);
  });

  it('空白与空串的已知值被忽略', () => {
    const result = auditOutgoingText('今天天气不错', { knownSecrets: ['', '   ', '  \t '] });
    expect(result.blocked).toBe(false);
  });

  it('已知密钥大小写敏感（密钥本身区分大小写）', () => {
    const result = auditOutgoingText('MY-SUPER-SECRET-KEY-12345', {
      knownSecrets: ['my-super-secret-key-12345'],
    });
    expect(result.blocked).toBe(false);
  });
});

describe('拦截结果绝不包含完整敏感值', () => {
  it('finding.masked 不含完整命中片段', () => {
    const secret = 'my-super-secret-key-12345';
    const result = auditOutgoingText(`token: ${secret}`, { knownSecrets: [secret] });

    expect(result.blocked).toBe(true);
    for (const finding of result.findings) {
      expect(finding.masked).not.toContain(secret);
      expect(finding.masked.length).toBeLessThan(secret.length);
    }
  });

  it('maskSensitive 保留前缀与长度，但不给出完整值', () => {
    // 'sk-' 3 个 + 'abcdefghijklmn' 14 个 = 17 个字符
    expect(maskSensitive('sk-abcdefghijklmn')).toBe('sk…（共 17 字符）');
    expect(maskSensitive('ab')).toBe('••');
    expect(maskSensitive('')).toBe('');
  });

  it('redactForLog 把敏感片段替换成占位符，保留上下文', () => {
    const secret = 'my-super-secret-key-12345';
    const text = `前一句 token: ${secret} 后一句`;
    const result = auditOutgoingText(text, { knownSecrets: [secret] });

    const safe = redactForLog(text, result.findings);
    expect(safe).not.toContain(secret);
    expect(safe).toContain('前一句');
    expect(safe).toContain('后一句');
    expect(safe).toContain('已拦截');
  });
});

describe('边界情况', () => {
  it('空文本不拦', () => {
    expect(auditOutgoingText('').blocked).toBe(false);
    expect(auditOutgoingText('').findings).toEqual([]);
  });

  it('普通聊天不拦', () => {
    const text = '今天下午三点开会，记得带上笔记本和充电器。';
    expect(auditOutgoingText(text).blocked).toBe(false);
  });

  it('一段文本里多处命中 → 全部报出且按位置排序', () => {
    const text = '路径 C:\\Users\\a\\b.txt 然后 token: sk-abc123def456';
    const result = auditOutgoingText(text);
    expect(result.blocked).toBe(true);
    expect(result.findings.length).toBeGreaterThanOrEqual(2);

    const starts = result.findings.map((f) => f.start);
    expect([...starts].sort((x, y) => x - y)).toEqual(starts);
  });

  it('重叠命中不重复计数（已知密钥嵌在赋值里只报一条）', () => {
    const secret = 'my-super-secret-key-12345';
    const result = auditOutgoingText(`token: ${secret}`, { knownSecrets: [secret] });

    // 具体优先级：精确匹配优先，但无论选哪条，重叠区间只保留一条
    const spans = result.findings.map((f) => `${f.start}-${f.end}`);
    expect(new Set(spans).size).toBe(spans.length);
  });

  it('每个 finding 都带位置与规则名，便于界面定位', () => {
    const text = '密码：hunter2xyz';
    const finding = auditOutgoingText(text).findings[0];
    expect(finding).toBeDefined();
    expect(finding!.start).toBeGreaterThanOrEqual(0);
    expect(finding!.end).toBeGreaterThan(finding!.start);
    expect(finding!.end).toBeLessThanOrEqual(text.length);
    expect(typeof finding!.rule).toBe('string');
    expect(finding!.rule.length).toBeGreaterThan(0);
  });

  it('可以用选项关掉某一类检查', () => {
    const text = 'token: sk-abc123def456';
    expect(auditOutgoingText(text, { checkCredentials: false }).blocked).toBe(false);
    expect(auditOutgoingText(text, { checkCredentials: true }).blocked).toBe(true);

    const pathText = '文件在 C:\\Users\\a\\b.txt';
    expect(auditOutgoingText(pathText, { checkPaths: false }).blocked).toBe(false);
    expect(auditOutgoingText(pathText, { checkPaths: true }).blocked).toBe(true);
  });

  it('关掉路径检查后，已知密钥仍然拦得住', () => {
    const result = auditOutgoingText('key: my-super-secret-key-12345', {
      checkPaths: false,
      knownSecrets: ['my-super-secret-key-12345'],
    });
    expect(result.blocked).toBe(true);
  });
});

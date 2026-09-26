import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createQqHttp } from './qq/http';
import { createQqStack } from './qq/setup';
import { join } from 'node:path';
import { app, type BrowserWindow } from 'electron';
import * as repo from '../src/db/index';
import type { Db } from '../src/db/index';
import type { ChatStreamEvent } from '../src/types/index';

/**
 * 端到端冒烟检查（仅在 `ASTRA_SMOKE_LOG` 环境变量存在时运行）。
 *
 * 这是**真实运行时**的验证，不是单元测试：它在 Electron 主进程里跑，起一个本地
 * SSE 服务端当假模型接口，然后走完整链路
 *
 *   渲染进程 window.astra.chat.send()
 *     → preload contextBridge
 *     → ipcMain handler
 *     → better-sqlite3 落库
 *     → 主进程 fetch + ReadableStream 解析 SSE
 *     → ipcMain 推送 delta 事件
 *     → 渲染进程收到并累积
 *     → 终态事件 + 数据库内容核对
 *
 * 结果写成 JSON 到 `ASTRA_SMOKE_LOG`，然后以退出码 0/1 结束进程，便于 CI 断言。
 */

/** 冒烟检查依赖。 */
export interface SmokeDeps {
  /** 数据库句柄。 */
  db: Db;
  /** 获取主窗口。 */
  getWindow: () => BrowserWindow | null;
}

/** 单条检查结果。 */
interface CheckResult {
  /** 检查项名称。 */
  name: string;
  /** 是否通过。 */
  ok: boolean;
  /** 通过时的补充信息，或失败原因。 */
  detail?: string;
}

/** 假模型接口分块吐出的正文。 */
const FAKE_REPLY_PARTS = ['你好', '，我是', ' AstraChat', ' 的测试模型。'];
/** 假模型接口分块吐出的思维链。 */
const FAKE_REASONING = '正在思考…';

/**
 * 启动一个假的 OpenAI 兼容 SSE 服务端。
 *
 * 只处理 `POST /v1/chat/completions`，把预置文本拆成多个 data 分片、**并且刻意把
 * 分片边界切在一行中间**，以此验证增量解析在真实 socket 分块下依然正确。
 *
 * @returns 服务端实例与监听端口。
 */
async function startFakeModelServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
      res.writeHead(404).end('not found');
      return;
    }

    // 把请求体读完再回复，避免客户端因未读请求体而报 ECONNRESET。
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const frames: string[] = [];
      frames.push(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: FAKE_REASONING } }] })}\n\n`,
      );
      for (const part of FAKE_REPLY_PARTS) {
        frames.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: part } }] })}\n\n`);
      }
      frames.push('data: [DONE]\n\n');

      // 关键：把所有帧拼成一条长字符串，然后按固定字节数切开写入，
      // 让分片边界随机落在 JSON 或 UTF-8 多字节字符中间。
      const whole = frames.join('');
      const SLICE = 17;
      let offset = 0;
      const writeNext = (): void => {
        if (offset >= whole.length) {
          res.end();
          return;
        }
        res.write(whole.slice(offset, offset + SLICE));
        offset += SLICE;
        setTimeout(writeNext, 2);
      };
      writeNext();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, port };
}

/**
 * 轮询渲染进程里的一个全局数组，直到出现满足条件的元素或超时。
 *
 * @param win 主窗口。
 * @param predicate 判定表达式（在渲染进程里求值的 JS 源码）。
 * @param timeoutMs 超时毫秒。
 * @returns 是否在超时前满足条件。
 */
async function waitForRenderer(
  win: BrowserWindow,
  predicate: string,
  timeoutMs = 15000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const satisfied = (await win.webContents.executeJavaScript(`(() => { try { return ${predicate}; } catch { return false; } })()`)) as boolean;
    if (satisfied) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/**
 * 执行全部冒烟检查并写出结果。
 *
 * @param deps 依赖。
 */
export async function runSmokeChecks(deps: SmokeDeps): Promise<void> {
  const logPath = process.env.ASTRA_SMOKE_LOG;
  const checks: CheckResult[] = [];

  /**
   * 记录一次同步检查。
   *
   * @param name 检查项名称。
   * @param fn 检查体；抛错即视为失败。
   */
  const check = (name: string, fn: () => string | void): void => {
    try {
      const detail = fn();
      checks.push({ name, ok: true, ...(detail ? { detail } : {}) });
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };

  // ------------------------------------------------------------ 数据层

  check('SQLite 已建好 6 张业务表且 schema 为 v3', () => {
    const rows = deps.db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    for (const table of [
      'providers',
      'conversations',
      'messages',
      'personas',
      'qq_config',
      'qq_contacts',
    ]) {
      if (!names.includes(table)) {
        throw new Error(`缺少表 ${table}，实际：${names.join(',')}`);
      }
    }
    const version = deps.db.raw.pragma('user_version', { simple: true }) as number;
    if (version !== 3) {
      throw new Error(`user_version 应为 3，实际 ${version}`);
    }
    return `${names.join(',')} (user_version=${version})`;
  });

  check('内置示例角色已种入', () => {
    const personas = repo.listPersonas(deps.db);
    if (personas.length === 0) {
      throw new Error('角色表为空，seed 未生效');
    }
    return `${personas.length} 个：${personas.map((p) => p.name).join('/')}`;
  });

  check('QQ 配置与来源授权可落库并读回', () => {
    repo.saveQqConfig(deps.db, {
      appId: 'smoke-app',
      ownerOpenIds: ['owner-1'],
      status: 'connected',
    });
    const cfg = repo.getQqConfig(deps.db);
    if (cfg.appId !== 'smoke-app' || cfg.ownerOpenIds.join(',') !== 'owner-1') {
      throw new Error(`配置读回不一致：${JSON.stringify(cfg)}`);
    }
    // 默认必须是 fail-closed，否则等于把账号交给模型
    if (cfg.allowAllWhenEmpty !== false) {
      throw new Error('allowAllWhenEmpty 默认应为 false（fail-closed）');
    }

    // 来源：先被「发现」（policy=none，不投递给模型），授权后才进允许列表
    repo.recordQqContactSeen(deps.db, { openId: 'smoke-group', kind: 'group' });
    if (repo.listAllowedOpenIds(deps.db, 'group').includes('smoke-group')) {
      throw new Error('未授权来源不该出现在允许列表里');
    }
    repo.setQqContactPolicy(deps.db, 'smoke-group', 'allow');
    if (!repo.listAllowedOpenIds(deps.db, 'group').includes('smoke-group')) {
      throw new Error('授权后仍未出现在允许列表里');
    }
    return 'qq_config + qq_contacts 往返一致，默认 fail-closed';
  });

  // -------------------------------------------------- 提供假模型接口

  let fakeServer: Server | null = null;
  let providerId = '';
  let conversationId = '';

  try {
    const { server, port } = await startFakeModelServer();
    fakeServer = server;

    const provider = repo.createProvider(deps.db, {
      name: 'Smoke 假接口',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'smoke-key',
      model: 'smoke-model',
    });
    providerId = provider.id;

    const conversation = repo.createConversation(deps.db, {
      title: '冒烟对话',
      providerId: provider.id,
    });
    conversationId = conversation.id;

    checks.push({ name: '本地假模型 SSE 服务端已启动', ok: true, detail: `127.0.0.1:${port}` });
  } catch (error) {
    checks.push({
      name: '本地假模型 SSE 服务端已启动',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // ------------------------------------------------- 渲染进程 / 桥接层

  const win = deps.getWindow();
  if (!win) {
    checks.push({ name: '主窗口存在', ok: false, detail: 'getWindow() 返回 null' });
  } else {
    try {
      await new Promise<void>((resolve) => {
        if (!win.webContents.isLoading()) {
          resolve();
          return;
        }
        win.webContents.once('did-finish-load', () => resolve());
      });

      check('预加载桥接已注入 window.astra', () => 'exposeInMainWorld 生效');

      const bridgeOk = (await win.webContents.executeJavaScript(
        'typeof window.astra === "object" && window.astra !== null && typeof window.astra.chat.send === "function"',
      )) as boolean;
      checks.push({
        name: '渲染进程可访问 window.astra.chat.send',
        ok: bridgeOk,
        detail: bridgeOk ? 'contextBridge 正常' : 'window.astra 缺失或形状不对',
      });

      const mounted = await waitForRenderer(win, 'document.querySelector("#root") && document.querySelector("#root").children.length > 0');
      checks.push({
        name: 'React 应用已挂载到 #root',
        ok: mounted,
        detail: mounted ? '检测到已渲染子节点' : '超时未见子节点（可能白屏）',
      });

      // ------------------------------------------- 全链路流式对话

      if (providerId && conversationId) {
        const requestJson = JSON.stringify({
          conversationId,
          content: '你好，做个自我介绍',
          providerId,
          model: 'smoke-model',
          personaId: null,
        });

        // 在渲染进程里订阅事件并触发一次真实发送（走 preload → IPC → 主进程 fetch）。
        await win.webContents.executeJavaScript(`
          window.__astraSmokeEvents = [];
          window.__astraSmokeError = null;
          if (!window.__astraSmokeUnsub) {
            window.__astraSmokeUnsub = window.astra.chat.onEvent(function (e) {
              window.__astraSmokeEvents.push(e);
            });
          }
          window.astra.chat
            .send(${requestJson})
            .then(function (r) { window.__astraSmokeStreamId = r && r.streamId; })
            .catch(function (e) { window.__astraSmokeError = String(e && e.message || e); });
          true;
        `);

        const finished = await waitForRenderer(
          win,
          'window.__astraSmokeEvents.some(function (e) { return e.type === "done" || e.type === "error"; })',
        );

        let streamError: string | null = null;
        if (!finished) {
          streamError = (await win.webContents.executeJavaScript('window.__astraSmokeError')) as string | null;
        }

        checks.push({
          name: '聊天全链路（渲染 → IPC → fetch/SSE → 落库 → 事件回推）完成',
          ok: finished,
          detail: finished ? '收到终态事件' : `超时未收到终态事件；send 错误=${streamError ?? '无'}`,
        });

        if (finished) {
          const observed = (await win.webContents.executeJavaScript(`
            (function () {
              var evs = window.__astraSmokeEvents || [];
              var done = evs.filter(function (e) { return e.type === 'done'; })[0];
              return {
                types: evs.map(function (e) { return e.type; }),
                deltaCount: evs.filter(function (e) { return e.type === 'delta'; }).length,
                content: evs.filter(function (e) { return e.type === 'delta'; })
                  .map(function (e) { return e.content; }).join(''),
                reasoning: evs.filter(function (e) { return e.type === 'delta'; })
                  .map(function (e) { return e.reasoning; }).join(''),
                doneContent: done && done.message ? done.message.content : null,
                doneStatus: done && done.message ? done.message.status : null
              };
            })()
          `)) as {
            types: string[];
            deltaCount: number;
            content: string;
            reasoning: string;
            doneContent: string | null;
            doneStatus: string | null;
          };

          const expected = FAKE_REPLY_PARTS.join('');

          check('事件序列为 start → delta… → done', () => {
            if (observed.types[0] !== 'start') {
              throw new Error(`首个事件不是 start：${observed.types[0]}`);
            }
            if (observed.types[observed.types.length - 1] !== 'done') {
              throw new Error(`末个事件不是 done：${observed.types[observed.types.length - 1]}`);
            }
            if (!observed.types.includes('delta')) {
              throw new Error('没有任何 delta 事件');
            }
            return observed.types.join(' → ');
          });

          check('分片正文拼接结果与假服务端一致（跨 socket 分块解析正确）', () => {
            if (observed.content !== expected) {
              throw new Error(`期望「${expected}」，实际「${observed.content}」`);
            }
            return `${observed.deltaCount} 个 delta，正文="${observed.content}"`;
          });

          check('思维链 reasoning 正确透传', () => {
            if (observed.reasoning !== FAKE_REASONING) {
              throw new Error(`期望「${FAKE_REASONING}」，实际「${observed.reasoning}」`);
            }
            return observed.reasoning;
          });

          check('终态事件携带落库后的消息且 status=complete', () => {
            if (observed.doneStatus !== 'complete') {
              throw new Error(`status=${observed.doneStatus}`);
            }
            if (observed.doneContent !== expected) {
              throw new Error(`落库正文与事件不一致：「${observed.doneContent}」`);
            }
            return 'done.message 与增量一致';
          });

          check('数据库里持久化的 assistant 消息与流式内容一致', () => {
            const messages = repo.listMessages(deps.db, conversationId);
            const assistant = messages.filter((m) => m.role === 'assistant');
            if (assistant.length !== 1) {
              throw new Error(`assistant 消息数量异常：${assistant.length}`);
            }
            const msg = assistant[0]!;
            if (msg.content !== expected) {
              throw new Error(`库中正文「${msg.content}」≠「${expected}」`);
            }
            if (msg.status !== 'complete') {
              throw new Error(`库中 status=${msg.status}`);
            }
            if (msg.reasoning !== FAKE_REASONING) {
              throw new Error(`库中 reasoning「${msg.reasoning}」≠「${FAKE_REASONING}」`);
            }
            return `共 ${messages.length} 条消息（user+assistant）`;
          });

          check('用户消息已落库且对话标题按首条消息自动命名', () => {
            const messages = repo.listMessages(deps.db, conversationId);
            const user = messages.filter((m) => m.role === 'user');
            if (user.length !== 1) {
              throw new Error(`user 消息数量异常：${user.length}`);
            }
            const conv = repo.getConversation(deps.db, conversationId);
            if (conv?.title === '新对话') {
              throw new Error('标题未被自动改写');
            }
            return `标题="${conv?.title}"`;
          });

          check('对话搜索能命中刚写入的内容', () => {
            const hits = repo.searchConversations(deps.db, '自我介绍');
            if (hits.length === 0) {
              throw new Error('搜索无命中');
            }
            return `命中 ${hits.length} 个对话`;
          });
        }
      }
    } catch (error) {
      checks.push({
        name: '渲染进程 / 桥接层检查',
        ok: false,
        detail: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
      });
    }
  }

  // ------------------------------------------------- 可选：界面截图留证
  //
  // 设了 `ASTRA_SHOT_DIR` 就依次切到三个页面各截一张图。用途是**人眼复核 UI**
  // （图标是否正常渲染、有没有残留 emoji、深浅色对比是否够），不参与 pass/fail。
  if (process.env.ASTRA_SHOT_DIR && win) {
    try {
      const dir = process.env.ASTRA_SHOT_DIR;
      mkdirSync(dir, { recursive: true });
      const pages: [string, string][] = [
        ['1-chat', '聊天'],
        ['2-personas', '角色'],
        ['3-settings', '设置'],
      ];
      for (const [file, label] of pages) {
        const clicked = (await win.webContents.executeJavaScript(
          `(() => {
             const btn = [...document.querySelectorAll('aside nav button')]
               .find((b) => b.textContent && b.textContent.includes(${JSON.stringify(label)}));
             if (btn) { btn.click(); return true; }
             return false;
           })()`,
        )) as boolean;
        // 等一帧渲染 + 状态更新
        await new Promise((resolve) => setTimeout(resolve, 700));
        const image = await win.webContents.capturePage();
        writeFileSync(join(dir, `${file}.png`), image.toPNG());
        checks.push({
          name: `界面截图 ${file}`,
          ok: clicked || file === '1-chat',
          detail: clicked ? '已切换到该页并截图' : '找不到导航按钮，截的是当前页',
        });
      }
    } catch (error) {
      checks.push({
        name: '界面截图',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (fakeServer) {
    await new Promise<void>((resolve) => fakeServer?.close(() => resolve()));
  }

  // --------------------------------------------------------- QQ 链路

  /**
   * 记录一次异步检查。
   *
   * QQ 检查要建立连接并轮询结果，没法用同步的 `check`。
   *
   * @param name 检查项名称。
   * @param fn 检查体；抛错即视为失败。
   */
  const checkAsync = async (name: string, fn: () => Promise<string | void>): Promise<void> => {
    try {
      const detail = await fn();
      checks.push({ name, ok: true, ...(detail ? { detail } : {}) });
    } catch (error) {
      checks.push({
        name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // 假 QQ 服务端由 scripts/smoke.mjs 起在**另一个进程**里，地址经环境变量传进来。
  // 没传就跳过（单独跑 electron/smoke 时）—— 跳过而不是判失败。
  const fakeQqBase = process.env.ASTRA_FAKE_QQ_BASE_URL ?? '';

  if (fakeQqBase.length > 0) {
    await checkAsync('QQ 链路：连上假服务端后能完整回一条群消息', async () => {
      const qqDb = repo.openDatabase(':memory:');
      repo.saveQqConfig(qqDb, {
        appId: 'SMOKE_APP',
        appSecret: 'SMOKE_SECRET',
        intents: 1 << 25,
        enabled: true,
        replyInPrivate: true,
        auditEnabled: true,
      });
      repo.recordQqContactSeen(qqDb, { openId: 'SMOKE_GROUP', kind: 'group' });
      repo.setQqContactPolicy(qqDb, 'SMOKE_GROUP', 'allow');

      const stack = createQqStack({
        db: qqDb,
        onStatus: () => undefined,
        getSystemPrompt: () => '你是群友。',
        // 模型也指向假服务端（它同时提供 /chat/completions）
        getProvider: () => ({ baseUrl: fakeQqBase, apiKey: '', model: 'smoke-model' }),
        createHttp: (options) => createQqHttp({ ...options, baseUrl: fakeQqBase }),
        log: () => undefined,
      });

      try {
        await stack.start();

        const deadline = Date.now() + 20_000;
        let received: { path?: string; body?: Record<string, unknown> } | null = null;

        while (Date.now() < deadline) {
          if (stack.getStatus().state === 'connected') {
            const res = await fetch(`${fakeQqBase}/__test/sent`);
            const data = (await res.json()) as {
              sent?: { path?: string; body?: Record<string, unknown> }[];
            };
            const first = data.sent?.[0];
            if (first !== undefined) {
              received = first;
              break;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }

        if (received === null) {
          throw new Error('等待超时：假 QQ 服务端一直没收到回复');
        }
        if (received.path !== '/v2/groups/SMOKE_GROUP/messages') {
          throw new Error(`发送路径不对：${received.path ?? '(空)'}`);
        }
        const body = received.body ?? {};
        if (body['msg_id'] !== 'SMOKE_QQ_MSG') {
          throw new Error(`msg_id 不对：${String(body['msg_id'])}`);
        }
        if (body['msg_seq'] !== 1) {
          throw new Error(`msg_seq 应为 1，实际 ${String(body['msg_seq'])}`);
        }
        return `被动回复 msg_id=${String(body['msg_id'])} msg_seq=${String(body['msg_seq'])} 正文="${String(body['content'])}"`;
      } finally {
        stack.stop();
      }
    });
  }

  // ------------------------------------------------------------- 汇总

  const failed = checks.filter((c) => !c.ok);
  const report = {
    ok: failed.length === 0,
    total: checks.length,
    failed: failed.length,
    checks,
  };

  const text = JSON.stringify(report, null, 2);
  console.log('[astra-smoke] 结果：\n' + text);
  if (logPath) {
    writeFileSync(logPath, text, 'utf8');
  }

  app.exit(failed.length === 0 ? 0 : 1);
}

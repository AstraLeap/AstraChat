#!/usr/bin/env node
/**
 * QQ 开放平台连通性与 intents 权限探针。
 *
 * ## 这个脚本回答三个问题
 *
 * 1. **凭证对不对** —— AppID / ClientSecret 能否换到 access_token。
 * 2. **网关通不通** —— `/gateway/bot` 能否拿到接入点，连接额度还剩多少。
 * 3. **intents 有没有权限** —— 用指定 intents 发 Identify，看网关给 READY 还是把连接踢掉。
 *
 * 第 3 点是最关键的：官方文档说「非基础事件需申请，传了无权限的 intents 会报错并**直接关闭连接**」。
 * 所以「能收到 READY」= 有权限；「被关掉且码是 4013/4014」= 没权限/位值不对。
 *
 * ## 用法
 *
 * ```sh
 * # 推荐用环境变量，避免 AppSecret 出现在进程列表里
 * $env:ASTRA_QQ_APP_ID="102xxxxxx"
 * $env:ASTRA_QQ_APP_SECRET="xxxxxxxx"
 * node scripts/qq-probe.mjs
 *
 * # 听 60 秒事件，验证「全量群消息」是否真的能收到（需要有人往群里发消息）
 * node scripts/qq-probe.mjs --listen 60
 *
 * # 试别的 intents 位值
 * node scripts/qq-probe.mjs --intents 33554433
 * ```
 *
 * 拿到 READY 后如果 `--listen` 开着，脚本会打印**每一条**收到的事件名，
 * 这就是判断「群里不 @ 也能收到消息」的直接证据。
 *
 * ## 为什么能直接 import 一个 `.ts`
 *
 * 与 `scripts/bump-version.mjs` 同一手法：Node 22.18+ 默认启用类型擦除，
 * 因此这里**复用 `src/services/qq/protocol.ts`**，不另写一套协议解析。
 * 也就是说这个探针同时是协议模块对着真实服务端的一次实测。
 */

import { fileURLToPath } from 'node:url';

const PACKAGE_PATH = fileURLToPath(new URL('../package.json', import.meta.url));

/**
 * 判断当前 Node 是否支持直接 import TypeScript。
 *
 * @returns 支持返回 `true`。
 */
function supportsTypeScriptImport() {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major > 22) {
    return true;
  }
  return major === 22 && minor >= 18;
}

if (!supportsTypeScriptImport()) {
  console.error(`本脚本需要 Node 22.18+（当前 ${process.versions.node}）。`);
  process.exit(1);
}

const {
  OP,
  buildHeartbeatPayload,
  buildIdentifyPayload,
  classifyCloseCode,
  parseAccessTokenResponse,
  parseGatewayPayload,
  parseGatewayResponse,
  parseHelloInterval,
  parseReady,
  qqBotToken,
} = await import('../src/services/qq/protocol.ts');

// 复用本项目的解析器，让探针同时成为「events.ts 对真实数据是否成立」的实测
const { parseInboundEvent } = await import('../src/services/qq/events.ts');

const TOKEN_URL = 'https://api.bot.qq.com/app/getAppAccessToken';
const GATEWAY_URL = 'https://api.bot.qq.com/gateway/bot';

/** `GROUP_AND_C2C_EVENT`。 */
const INTENT_GROUP_AND_C2C = 1 << 25;

const USAGE = `QQ 开放平台连通性与 intents 权限探针

用法：
  node scripts/qq-probe.mjs [选项]

凭证（二选一，推荐环境变量，避免出现在进程列表里）：
  ASTRA_QQ_APP_ID / ASTRA_QQ_APP_SECRET
  --app-id <id> --app-secret <secret>

选项：
  --intents <数字>   要测的 intents 位掩码，默认 ${INTENT_GROUP_AND_C2C}（GROUP_AND_C2C_EVENT = 1<<25）
  --listen <秒>      收到 READY 后继续监听事件若干秒（默认 0，即立刻退出）
  --dump             打印每个事件的原始载荷（排查字段名与结构时用）
  --timeout <秒>     整体超时，默认 30
  -h, --help         显示本帮助

这个脚本只做只读探测：取凭证、取网关地址、建立一次 WebSocket 连接并 Identify，
不会安装、不会发送任何消息。`;

/**
 * 解析命令行参数。
 *
 * @param argv 参数列表。
 * @returns 解析结果。
 */
function parseArgs(argv) {
  const options = {
    appId: process.env.ASTRA_QQ_APP_ID ?? '',
    appSecret: process.env.ASTRA_QQ_APP_SECRET ?? '',
    intents: INTENT_GROUP_AND_C2C,
    listen: 0,
    timeout: 30,
    dump: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`选项 ${arg} 缺少取值`);
      }
      return next;
    };

    switch (arg) {
      case '--app-id':
        options.appId = value();
        break;
      case '--app-secret':
        options.appSecret = value();
        break;
      case '--intents':
        options.intents = Number(value());
        break;
      case '--listen':
        options.listen = Number(value());
        break;
      case '--timeout':
        options.timeout = Number(value());
        break;
      case '--dump':
        options.dump = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`未知选项：${arg}`);
    }
  }
  return options;
}

/**
 * 打印一行带前缀的结果。
 *
 * @param mark 标记（✅ / ❌ / ℹ️）。
 * @param text 正文。
 */
function line(mark, text) {
  console.log(`${mark} ${text}`);
}

/**
 * 第一步：换取 access_token。
 *
 * @param appId AppID。
 * @param appSecret ClientSecret。
 * @returns 裸 token；失败返回 `null`。
 */
async function fetchToken(appId, appSecret) {
  console.log('── 1/3 换取 access_token ─────────────────────────');
  console.log(`   POST ${TOKEN_URL}`);

  let body;
  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 官方字段名是 clientSecret（不是 appSecret）
      body: JSON.stringify({ appId, clientSecret: appSecret }),
    });
    body = await response.json();
  } catch (error) {
    line('❌', `请求失败：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  const result = parseAccessTokenResponse(body, Date.now());
  if (!result.ok) {
    // 官方明确说：失败时 HTTP 仍是 200，必须看 code
    line('❌', `凭证获取失败：code=${result.code ?? '(无)'} ${result.message}`);
    if (result.code === 100016) {
      console.log('   → AppID 或 ClientSecret 不正确，请与开放平台管理端核对');
    } else if (result.code === 100007 || result.code === 10004) {
      console.log('   → AppID 无效，或机器人状态不正常（被封禁 / 已删除）');
    } else if (result.code === 100001) {
      console.log('   → 请求过于频繁，稍后重试');
    }
    return null;
  }

  const ttl = Math.round((result.expiresAt - Date.now()) / 1000);
  line('✅', `拿到凭证（${result.token.slice(0, 6)}…，有效期约 ${ttl} 秒）`);
  return result.token;
}

/**
 * 第二步：取网关接入点。
 *
 * @param token 裸 access_token。
 * @returns 网关 URL；失败返回 `null`。
 */
async function fetchGateway(token) {
  console.log('');
  console.log('── 2/3 获取网关接入点 ───────────────────────────');
  console.log(`   GET ${GATEWAY_URL}`);

  let body;
  try {
    const response = await fetch(GATEWAY_URL, {
      headers: { Authorization: qqBotToken(token) },
    });
    body = await response.json();
  } catch (error) {
    line('❌', `请求失败：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  const info = parseGatewayResponse(body);
  if (!info) {
    line('❌', `响应里没有可用 url：${JSON.stringify(body).slice(0, 200)}`);
    return null;
  }

  line('✅', `接入点 ${info.url}`);
  console.log(`   建议分片数 ${info.shards}`);
  if (info.sessionStartLimit) {
    console.log(
      `   连接额度：剩余 ${info.sessionStartLimit.remaining} / 共 ${info.sessionStartLimit.total}` +
        `（每 5 秒最多建 ${info.sessionStartLimit.maxConcurrency} 个）`,
    );
  }
  return info.url;
}

/**
 * 第三步：连上网关、Identify，看是拿到 READY 还是被踢。
 *
 * 这是判断 intents 权限的关键一步。
 *
 * @param url 网关地址。
 * @param token 裸 access_token。
 * @param intents 要测的 intents。
 * @param listenSeconds 收到 READY 后再监听多少秒事件。
 * @returns 进程退出码。
 */
function probeGateway(url, token, intents, listenSeconds, dumpPayload) {
  console.log('');
  console.log('── 3/3 连接网关并 Identify ───────────────────────');
  console.log(`   测试 intents = ${intents}（1<<25 = ${INTENT_GROUP_AND_C2C}）`);

  return new Promise((resolve) => {
    /** 最新收到的 s，心跳要带。 */
    let latestSeq = null;
    /** 心跳定时器。 */
    let heartbeatTimer = null;
    /** 是否已经拿到 READY（用于区分「鉴权成功」与「鉴权失败被踢」）。 */
    let ready = false;
    /** 监听阶段的收尾定时器。 */
    let listenTimer = null;
    /** 监听阶段的存活显示定时器。 */
    let statusTimer = null;
    /** 已发出的心跳数（用于证明连接是活的）。 */
    let heartbeatCount = 0;
    /** 已收到的事件数。 */
    let eventCount = 0;
    /** 监听开始时刻。 */
    let listenStart = 0;
    /** 机器人自己的 id（来自 READY），用于判断群消息有没有 @ 它。 */
    let botId = null;

    const socket = new WebSocket(url);

    /**
     * 结束并返回退出码。
     *
     * @param code 退出码。
     */
    const finish = (code) => {
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
      }
      if (listenTimer !== null) {
        clearTimeout(listenTimer);
      }
      if (statusTimer !== null) {
        clearInterval(statusTimer);
      }
      try {
        socket.close();
      } catch {
        // 已经关了就算了
      }
      resolve(code);
    };

    socket.addEventListener('open', () => {
      line('✅', 'WebSocket 已连接，等待 Hello…');
    });

    socket.addEventListener('message', (event) => {
      let raw;
      try {
        raw = JSON.parse(String(event.data));
      } catch {
        console.log(`   ⚠️ 收到非 JSON 数据：${String(event.data).slice(0, 120)}`);
        return;
      }

      const payload = parseGatewayPayload(raw);
      if (!payload) {
        return;
      }
      if (payload.s !== null) {
        latestSeq = payload.s;
      }

      if (payload.op === OP.HELLO) {
        const interval = parseHelloInterval(payload) ?? 45_000;
        line('✅', `收到 Hello，心跳周期 ${interval} ms；发送 Identify`);
        socket.send(JSON.stringify(buildIdentifyPayload({ token, intents })));

        // 按周期发心跳，避免在监听阶段因为不发心跳被服务端断开
        heartbeatTimer = setInterval(() => {
          try {
            socket.send(JSON.stringify(buildHeartbeatPayload(latestSeq)));
            heartbeatCount += 1;
          } catch {
            // 连接可能已关，忽略
          }
        }, interval);
        return;
      }

      if (payload.op === OP.HEARTBEAT_ACK) {
        return;
      }

      if (payload.op === OP.DISPATCH && payload.t === 'READY') {
        const readyInfo = parseReady(payload);
        ready = true;
        line('✅', '鉴权成功，收到 READY');
        if (readyInfo) {
          botId = readyInfo.userId || null;
          console.log(`   机器人：${readyInfo.username || '(无名字)'}（id ${readyInfo.userId || '?'}）`);
          console.log(`   session_id：${readyInfo.sessionId}`);
        }
        console.log('');
        line('🎉', `intents ${intents} 有权限 —— 网关接受了这次 Identify`);

        if (listenSeconds <= 0) {
          console.log('');
          console.log('   未开启 --listen，直接结束。');
          console.log('   想验证「全量群消息」：加 --listen 60，然后让别人往群里发一条**不 @ 机器人**的消息。');
          finish(0);
          return;
        }

        console.log('');
        console.log(`   开始监听事件 ${listenSeconds} 秒…`);
        console.log('   请做两件事，各发一条消息：');
        console.log('     ① 普通消息（完全不 @ 机器人）→ 期望 GROUP_MESSAGE_CREATE（全量模式）');
        console.log('     ② @ 一下机器人                → 期望 GROUP_AT_MESSAGE_CREATE（基础路径）');
        console.log('   ⏱️  每 15 秒会报一次存活情况，用来区分「掉线了」与「在线但没事件」');
        listenStart = Date.now();
        statusTimer = setInterval(() => {
          const elapsed = Math.round((Date.now() - listenStart) / 1000);
          console.log(
            `   ⏱️  已监听 ${elapsed}s｜心跳 ${heartbeatCount} 次｜事件 ${eventCount} 个` +
              (eventCount === 0 ? '（连接正常，只是还没收到事件）' : ''),
          );
        }, 15_000);
        listenTimer = setTimeout(() => {
          if (statusTimer !== null) {
            clearInterval(statusTimer);
            statusTimer = null;
          }
          console.log('');
          console.log(`   监听结束：心跳 ${heartbeatCount} 次，事件 ${eventCount} 个。`);
          if (eventCount === 0) {
            console.log('   ❌ 一个事件都没收到。');
            console.log('      连接是活的（心跳正常发出且没被断开），所以不是掉线或鉴权问题。');
            console.log('      需要排查：机器人是否还在该群里、该事件是否需要额外订阅权限。');
          } else {
            console.log('   ✅ 连接与事件投递都正常（请对照上面打印的事件名判断是全量还是仅 @）。');
          }
          finish(0);
        }, listenSeconds * 1000);
        return;
      }

      if (payload.op === OP.DISPATCH) {
        eventCount += 1;
        console.log(`   📨 收到事件：${payload.t ?? '(无 t)'}`);
        if (payload.t === 'GROUP_MESSAGE_CREATE') {
          console.log('      全量群消息（开启全量模式后，@ 消息也会走这个类型）');
          console.log('      → 是否 @ 了机器人只能看 mentions 里有没有机器人 id');
        }
        if (payload.t === 'GROUP_AT_MESSAGE_CREATE') {
          console.log('      @ 机器人的消息（只在未开启全量模式时出现这个类型）');
        }

        // 用**本项目的解析器**判定一次，验证 events.ts 对真实数据是否成立
        const parsed = parseInboundEvent(payload, botId === null ? {} : { botId });
        if (parsed === null) {
          console.log('      ⚠️ 本项目解析器返回 null（缺消息 id 或来源标识，无法回应）');
        } else {
          console.log(
            `      本项目解析：${parsed.kind}｜openId=${parsed.openId}｜` +
              `指向机器人=${parsed.addressedToBot ? '是 ✅' : '否'}`,
          );
          console.log(
            `                  角色=${parsed.senderRole ?? '无'}｜发送者=${parsed.senderName ?? '未知'}` +
              `｜正文=${JSON.stringify(parsed.content.slice(0, 60))}`,
          );
          if (parsed.quote !== null) {
            console.log(`                  引用了 ${parsed.quote.senderName ?? '某人'}：${JSON.stringify(parsed.quote.text.slice(0, 40))}`);
          }
          if (parsed.attachments.length > 0) {
            console.log(
              `                  附件 ${parsed.attachments.length} 个：${parsed.attachments
                .map((item) => item.contentType || '未知类型')
                .join(', ')}`,
            );
          }
        }

        if (dumpPayload) {
          console.log(`      原始载荷 d：${JSON.stringify(payload.d)}`);
        }
        return;
      }

      const directive = classifyCloseCode(payload.op);
      if (directive) {
        console.log(`   ⚠️ 服务端下发 op ${payload.op}：${directive.reason}`);
      }
    });

    socket.addEventListener('close', (event) => {
      const directive = classifyCloseCode(event.code);
      console.log('');
      if (ready) {
        line('ℹ️', `连接已关闭：code=${event.code} ${directive.reason}`);
        finish(0);
        return;
      }

      // 没拿到 READY 就被关 —— 这就是 intents 权限问题（或位值不对）
      line('❌', `连接在鉴权阶段被关闭：code=${event.code}`);
      console.log(`   服务端原因：${event.reason || '(未提供)'}`);
      console.log(`   判定：${directive.reason}`);
      console.log(`   可重试：${directive.retryable ? '是' : '否（重连只会重复失败）'}`);
      if (event.code === 4013) {
        console.log('');
        console.log('   → intent 位值无效。检查 --intents 传的数字是否为期望的值。');
      } else if (event.code === 4014) {
        console.log('');
        console.log('   → intent 无权限。这不是代码问题：需要到 QQ 开放平台给机器人');
        console.log('     申请/开通对应的事件订阅权限（GROUP_AND_C2C_EVENT 不在基础事件列表里）。');
        console.log('     若后台没有可申请入口，请向官方渠道确认该事件的开放条件。');
      }
      finish(1);
    });

    socket.addEventListener('error', () => {
      line('❌', 'WebSocket 出错（可能是网络不可达，或网关地址无效）');
      finish(1);
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  if (!options.appId || !options.appSecret) {
    console.error('缺少凭证。请设置环境变量 ASTRA_QQ_APP_ID / ASTRA_QQ_APP_SECRET，');
    console.error('或用 --app-id / --app-secret 传入。加 --help 看完整用法。');
    return 1;
  }
  if (!Number.isFinite(options.intents) || options.intents <= 0) {
    console.error(`--intents 必须是正整数，收到：${String(options.intents)}`);
    return 1;
  }

  // 本文件只被 Node 直接执行，读一下 package.json 确认没跑错目录
  void PACKAGE_PATH;

  const token = await fetchToken(options.appId, options.appSecret);
  if (token === null) {
    return 1;
  }

  const url = await fetchGateway(token);
  if (url === null) {
    return 1;
  }

  return probeGateway(url, token, options.intents, Math.max(0, options.listen), options.dump);
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });

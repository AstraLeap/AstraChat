#!/usr/bin/env node
/**
 * 版本号推进脚本。
 *
 * 规则与实现见 `docs/versioning.md` 与 `src/services/version.ts`（本脚本**复用**那份实现，
 * 不自己再写一套解析逻辑）。
 *
 * ## 用法
 *
 * ```sh
 * node scripts/bump-version.mjs                  # 同一阶段序号 +1（日常的功能 / 修复）
 * node scripts/bump-version.mjs --promote        # 推进到下一阶段；从 rc 推进 → 稳定版
 * node scripts/bump-version.mjs --stage rc       # 指定阶段（往上走归零；同阶段即 +1）
 * node scripts/bump-version.mjs --stage stable   # 直接成为稳定版（去掉后缀）
 * node scripts/bump-version.mjs --numeric minor  # 大规模更新 / 稳定版之后：数字 +1，阶段回 alpha0
 * node scripts/bump-version.mjs --set 0.1.0-rc0  # 显式指定（仍会校验格式）
 * node scripts/bump-version.mjs --dry-run        # 只预览，不写文件
 * node scripts/bump-version.mjs --tag            # 【只打 tag】给 package.json 当前版本打 tag
 * ```
 *
 * ## 为什么 `--tag` 不跟改版本号一起做
 *
 * `git tag` 只能给**已有的提交**打标签。如果「改 package.json」和「打 tag」在一条命令里
 * 完成，此时版本改动**还没提交**，tag 就会指向一个 `package.json` 里还是**旧版本号**的提交
 * —— 版本号与 tag 对不上。所以正确顺序必然是两步：
 *
 * ```sh
 * npm run version:bump                    # 1) 改版本号
 * git add -A && git commit -m "..."       # 2) 提交
 * npm run version:bump -- --tag           # 3) 提交之后才打 tag
 * ```
 *
 * `--tag` 会校验 package.json 相对 HEAD 没有未提交改动，否则拒绝打 tag。
 *
 * ## 为什么能直接 import 一个 `.ts`
 *
 * Node 22.18+ 默认启用「类型擦除」，可以直接 import TypeScript 文件（要求只用可擦除语法，
 * 本模块满足）。因此版本规则的实现只存在一份，脚本与单测共用，不存在「脚本一套、文档
 * 另一套」的漂移。下面有 Node 版本守卫，老版本 Node 会得到明确提示而不是费解的报错。
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** package.json 的绝对路径（版本号唯一的真源）。 */
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
  console.error(
    `本脚本需要 Node 22.18+（当前 ${process.versions.node}），因为要直接 import ` +
      `src/services/version.ts。请升级 Node，或手动改 package.json。`,
  );
  process.exit(1);
}

const {
  RELEASE_STAGES,
  STABLE_TARGET,
  bumpNumeric,
  compareVersions,
  formatVersion,
  isStable,
  nextIteration,
  parseVersion,
  promoteStage,
  setStage,
} = await import('../src/services/version.ts');

const STAGE_CHOICES = [...RELEASE_STAGES, STABLE_TARGET];

const USAGE = `版本号推进脚本

用法：
  node scripts/bump-version.mjs [选项]

选项：
  --promote                推进到下一个更高的稳定性阶段；从 rc 推进则成为稳定版
  --stage <name>           切换到指定阶段：${STAGE_CHOICES.join(' | ')}
                           （stable 即去掉后缀成为稳定版）
  --allow-downgrade        允许把阶段往回退（默认拒绝）
  --numeric <part>         增加数字版本：major | minor | patch
                           （大规模更新，或稳定版之后的任何改动）
  --keep-stage             --numeric 时保留当前阶段（默认重置为 alpha0）
  --set <version>          显式指定版本号（仍会校验格式）
  --tag                    只给 package.json 里的当前版本打 tag v<版本号>，不改版本号
  --dry-run                只打印将要变成什么，不写文件
  --json                   以 JSON 输出结果
  -h, --help               显示本帮助

不带任何阶段/数字选项时，默认行为是「同一阶段序号 +1」，即日常的功能与修复。

阶段从低到高：${RELEASE_STAGES.join(' < ')} < 稳定版（裸版本，如 0.1.0）。
推进阶段时序号归零；成为稳定版时后缀整体消失。`;

/**
 * 解析命令行参数。
 *
 * @param argv 去掉 node 与脚本名之后的参数。
 * @returns 解析结果。
 */
function parseArgs(argv) {
  const options = {
    promote: false,
    stage: null,
    allowDowngrade: false,
    numeric: null,
    keepStage: false,
    set: null,
    tag: false,
    dryRun: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`选项 ${arg} 缺少取值`);
      }
      return value;
    };

    switch (arg) {
      case '--promote':
        options.promote = true;
        break;
      case '--stage':
        options.stage = next();
        break;
      case '--allow-downgrade':
        options.allowDowngrade = true;
        break;
      case '--numeric':
        options.numeric = next();
        break;
      case '--keep-stage':
        options.keepStage = true;
        break;
      case '--set':
        options.set = next();
        break;
      case '--tag':
        options.tag = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--json':
        options.json = true;
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
 * 依据选项算出新版本号。
 *
 * @param current 当前解析后的版本号。
 * @param options 命令行选项。
 * @returns 新的解析后版本号。
 */
function resolveNextVersion(current, options) {
  const actions = [
    options.set !== null,
    options.promote,
    options.stage !== null,
    options.numeric !== null,
  ].filter(Boolean).length;
  if (actions > 1) {
    throw new Error('--set / --promote / --stage / --numeric 只能选一个');
  }

  if (options.set !== null) {
    return parseVersion(options.set);
  }
  if (options.promote) {
    return promoteStage(current);
  }
  if (options.stage !== null) {
    const stage = String(options.stage);
    if (!STAGE_CHOICES.includes(stage)) {
      throw new Error(`--stage 只能是 ${STAGE_CHOICES.join(' | ')}，收到：${stage}`);
    }
    return setStage(current, stage, options.allowDowngrade);
  }
  if (options.numeric !== null) {
    const part = String(options.numeric);
    if (!['major', 'minor', 'patch'].includes(part)) {
      throw new Error(`--numeric 只能是 major | minor | patch，收到：${part}`);
    }
    return bumpNumeric(current, part, { keepStage: options.keepStage });
  }
  // 默认：同阶段序号 +1
  return nextIteration(current);
}

/**
 * 只替换 package.json 里的版本号，其余内容保持字节不变。
 *
 * 比「读成对象再整体 `JSON.stringify`」安全：后者会重排/重格式化整个文件，产生巨大 diff。
 *
 * @param raw package.json 原始文本。
 * @param version 新版本号。
 * @returns 替换后的文本。
 */
function replaceVersionInText(raw, version) {
  const pattern = /("version"\s*:\s*")([^"]*)(")/;
  if (!pattern.test(raw)) {
    throw new Error('在 package.json 中找不到 "version" 字段');
  }
  return raw.replace(pattern, `$1${version}$3`);
}

/**
 * 运行一条 git 命令并返回标准输出。
 *
 * 用 `stdio: 'pipe'` 读取输出，但**捕获失败时不要重试**：本机受限模式下 Node 的
 * `child_process` 用管道 stdio 会 EPERM，此时需要放宽沙箱权限，换写法没有意义。
 *
 * @param args git 参数。
 * @returns 标准输出文本（已去首尾空白）。
 */
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/**
 * 「只打 tag」模式。
 *
 * 关键校验：package.json 相对 HEAD **不能有未提交改动**，否则 tag 会指向一个版本号
 * 与 tag 名不一致的提交。
 *
 * @param version 要打 tag 的版本号。
 * @param dryRun 是否只预览。
 */
function tagCurrentVersion(version, dryRun) {
  const tagName = `v${version}`;

  const dirty = git(['status', '--porcelain', '--', 'package.json']);
  if (dirty !== '') {
    throw new Error(
      `package.json 有未提交的改动，此时打 tag 会指向版本号还是旧值的提交。` +
        `请先提交，再运行本命令。`,
    );
  }

  const headVersion = JSON.parse(git(['show', 'HEAD:package.json'])).version;
  if (headVersion !== version) {
    throw new Error(
      `HEAD 里的版本号是 ${headVersion}，与工作区的 ${version} 不一致（工作区可能未同步）。`,
    );
  }

  const existing = git(['tag', '-l', tagName]);
  if (existing !== '') {
    throw new Error(`tag ${tagName} 已存在。`);
  }

  if (dryRun) {
    console.log(`[dry-run] 将创建 annotated tag ${tagName}（指向 ${git(['rev-parse', '--short', 'HEAD'])}）`);
    return;
  }

  // tag 说明信息写临时文件再用 -F 传入：避免中文经命令行参数被编码破坏。
  const messagePath = join(tmpdir(), `astra-tag-${Date.now()}.txt`);
  writeFileSync(
    messagePath,
    `AstraChat ${version}\n\n由 scripts/bump-version.mjs --tag 创建于提交 ${git(['rev-parse', '--short', 'HEAD'])}。\n`,
    'utf8',
  );
  try {
    // stdio: 'inherit' —— 本机沙箱下管道式 stdio 会 EPERM（见 README 已知坑 11）
    execFileSync('git', ['tag', '-a', tagName, '-F', messagePath], { stdio: 'inherit' });
  } finally {
    if (existsSync(messagePath)) {
      unlinkSync(messagePath);
    }
  }

  console.log(`已创建 annotated tag ${tagName}`);
  console.log(`推送：git push origin ${tagName}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const raw = readFileSync(PACKAGE_PATH, 'utf8');
  const currentText = parseVersion(JSON.parse(raw).version);
  const current = formatVersion(currentText);

  // --tag 是独立模式：只打 tag，不改版本号
  if (options.tag) {
    const conflicting = options.promote || options.stage !== null || options.numeric !== null || options.set !== null;
    if (conflicting) {
      throw new Error(
        `--tag 不能与改版本号的选项同时使用：tag 只能打给**已提交**的版本。` +
          `请先改版本号并提交，再单独运行 --tag。`,
      );
    }
    tagCurrentVersion(current, options.dryRun);
    return;
  }

  const next = resolveNextVersion(currentText, options);
  const nextText = formatVersion(next);

  if (nextText === current) {
    throw new Error(`版本号没有变化（仍是 ${current}）`);
  }

  // 除 --set 外，所有操作都应让版本号变大；变小通常意味着参数用错了。
  if (options.set === null && compareVersions(current, nextText) >= 0) {
    throw new Error(`新版本号 ${nextText} 没有高于当前版本 ${current}，请检查参数`);
  }

  if (!options.dryRun) {
    writeFileSync(PACKAGE_PATH, replaceVersionInText(raw, nextText), 'utf8');
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          from: current,
          to: nextText,
          stage: next.stage,
          stable: isStable(next),
          dryRun: options.dryRun,
        },
        null,
        2,
      ),
    );
    return;
  }

  const prefix = options.dryRun ? '[dry-run] 将更新' : '已更新';
  console.log(`${prefix} package.json 版本号：${current} → ${nextText}`);
  if (isStable(next) && !isStable(currentText)) {
    console.log('（成为稳定版：后缀整体消失）');
  } else if (next.stage !== null && next.iteration === 0 && next.stage !== currentText.stage) {
    console.log(`（推进到 ${next.stage} 阶段，序号归零）`);
  }

  if (!options.dryRun) {
    console.log('');
    console.log('后续步骤：');
    console.log(`  1. git add -A && git commit -m "..."`);
    console.log(`  2. npm run version:bump -- --tag    # 提交之后再打 tag v${nextText}`);
    console.log('（README 的功能描述按「数字版本线」叙述，通常无需随阶段后缀改动。）');
  }
}

try {
  await main();
} catch (error) {
  console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

/**
 * AstraChat 版本号规则。
 *
 * ## 格式
 *
 * ```
 * <major>.<minor>.<patch>-<stage><序号>      预发布
 *      0    .   1   .   0   -  alpha   0
 *
 * <major>.<minor>.<patch>                    稳定版（LTS）
 *      0    .   1   .   0
 * ```
 *
 * - **数字部分**（`0.1.0`）只在**大规模更新**时增加，平时一动不动。
 * - **阶段后缀**表示稳定性，从低到高：`alpha` < `beta` < `rc` < **裸版本**。
 * - **裸版本就是稳定版 / LTS** —— 不带任何后缀，因此它天然是 semver 里最大的那个，
 *   规则与 semver 的排序**完全一致**（早先设计过的 `-ltsN` 后缀会让 lts 排序低于裸版本，
 *   自相矛盾，已废弃）。
 * - **序号**只存在于预发布阶段：同一阶段内每次「新增功能 / 修复 BUG」加一
 *   （`rc0` → `rc1`）；**推进阶段时序号归零**（`alpha3` → `beta0`），推进到稳定版时
 *   后缀整体消失（`rc2` → `0.1.0`，没有序号）。
 *
 * ## 一条数字版本线的完整生命周期
 *
 * ```text
 * 0.1.0-alpha0 → alpha1 → … → beta0 → … → rc0 → … → 0.1.0   ← 稳定版/LTS
 *                                                        │
 *                       任何后续改动都要开新的数字版本线 ─┘
 *                       修 BUG：--numeric patch  → 0.1.1-alpha0
 *                       加功能：--numeric minor  → 0.2.0-alpha0
 * ```
 *
 * **稳定版是不可变的**：`0.1.0` 一旦作为稳定版发出，它的内容就不能再变（否则同一个版本号
 * 对应两份不同的东西）。所以稳定版之后的任何改动**必须**进入新的数字版本线，这也是
 * 「数字部分只在…时增加」唯一的例外情形 —— 它不是「大规模更新」，而是「上一版已冻结」。
 *
 * ## 为什么规则写在代码里而不是只在文档里
 *
 * 版本号是会被**人手动改**的东西，只写在文档里必然写歪。这里把解析、比较、推进都实现成
 * 纯函数并配单测，`scripts/bump-version.mjs` 直接复用同一份实现（Node 22.18+ 可原生
 * import TS），因此不存在「脚本一套逻辑、文档另一套说法」的漂移。
 */

/**
 * **预发布**阶段，从低到高。顺序即优先级，不要随意调整。
 *
 * 稳定版（LTS）不在这里 —— 它是「没有后缀」，不属于任何一个预发布阶段。
 */
export const RELEASE_STAGES = ['alpha', 'beta', 'rc'] as const;

/** 预发布阶段类型。 */
export type ReleaseStage = (typeof RELEASE_STAGES)[number];

/** 稳定版的表示方式：不带后缀。用于命令行参数等需要「指名」稳定版的场合。 */
export const STABLE_TARGET = 'stable' as const;

/** 可以切换到的目标阶段：三个预发布阶段，或稳定版。 */
export type StageTarget = ReleaseStage | typeof STABLE_TARGET;

/** 数字版本部分的字段名。 */
export type NumericPart = 'major' | 'minor' | 'patch';

/** 解析后的版本号。 */
export interface ParsedVersion {
  /** 主版本号。 */
  major: number;
  /** 次版本号。 */
  minor: number;
  /** 修订号。 */
  patch: number;
  /** 预发布阶段；`null` 表示**稳定版（LTS）**。 */
  stage: ReleaseStage | null;
  /** 阶段内序号；稳定版固定为 0（稳定版没有序号）。 */
  iteration: number;
}

/**
 * 版本号格式。
 *
 * 后缀里的序号用 `\d*`（允许为空）而不是 `\d+`：这样 `0.1.0-alpha` 能匹配上、落到
 * 「阶段后面必须带序号」的分支，给出**具体**提示；若用 `\d+`，这种写法会直接落到
 * 「格式不合法」，用户看不出是少了序号。
 */
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z]+)(\d*))?$/;

/** 已废弃的阶段名 → 废弃原因（用于给出可操作的报错）。 */
const RETIRED_STAGES: Record<string, string> = {
  lts: `稳定版（LTS）不加后缀，写成裸版本即可，例如 0.1.0。若要在命令行指名，用 --stage stable`,
};

/** 是否是稳定版（不带后缀）。 */
export function isStable(version: ParsedVersion): boolean {
  return version.stage === null;
}

/** 是否是预发布版（带后缀）。 */
export function isPreRelease(version: ParsedVersion): boolean {
  return version.stage !== null;
}

/** 是否是不带后缀的版本（`isStable` 的别名，语义更中性）。 */
export function isBareVersion(version: ParsedVersion): boolean {
  return version.stage === null;
}

/**
 * 稳定性等级：`alpha` = 0、`beta` = 1、`rc` = 2、**稳定版** = 3。
 *
 * 与 semver 的排序一致：等级越高版本越大。
 *
 * @param version 解析后的版本号。
 * @returns 等级数字，越大越稳定。
 */
export function stabilityRank(version: ParsedVersion): number {
  return version.stage === null ? RELEASE_STAGES.length : RELEASE_STAGES.indexOf(version.stage);
}

/**
 * 预发布阶段的稳定性等级：`alpha` = 0、`beta` = 1、`rc` = 2。
 *
 * @param stage 预发布阶段。
 * @returns 等级数字。
 */
export function stageRank(stage: ReleaseStage): number {
  return RELEASE_STAGES.indexOf(stage);
}

/**
 * 解析版本号字符串。
 *
 * @param input 版本号，如 `0.1.0-alpha0` 或 `0.1.0`（稳定版）。
 * @returns 解析结果。
 * @throws 格式不合法时抛出带具体原因的 `Error`。
 */
export function parseVersion(input: string): ParsedVersion {
  const text = String(input ?? '').trim();
  const match = VERSION_PATTERN.exec(text);
  if (!match) {
    throw new Error(
      `版本号格式不合法：${JSON.stringify(text)}。` +
        `应为 <major>.<minor>.<patch>-<stage><序号>（如 0.1.0-alpha0），或裸版本（稳定版）如 0.1.0。`,
    );
  }

  const stageText = match[4];
  const iterationText = match[5];

  let stage: ReleaseStage | null = null;
  let iteration = 0;

  if (stageText !== undefined) {
    const lowered = stageText.toLowerCase();
    const retired = RETIRED_STAGES[lowered];
    if (retired !== undefined) {
      throw new Error(`阶段 ${lowered} 已废弃：${retired}`);
    }
    if (!(RELEASE_STAGES as readonly string[]).includes(lowered)) {
      throw new Error(
        `未知的稳定性阶段：${JSON.stringify(stageText)}。` +
          `预发布阶段只能是 ${RELEASE_STAGES.join(' / ')}（从低到高）；稳定版不要后缀。`,
      );
    }
    if (iterationText === undefined || iterationText === '') {
      throw new Error(
        `阶段后面必须带序号，例如 ${text}-0。规则约定同一阶段内每次改动序号加一。`,
      );
    }
    stage = lowered as ReleaseStage;
    iteration = Number(iterationText);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    stage,
    iteration,
  };
}

/**
 * 解析版本号；失败时返回 `null` 而不抛错。
 *
 * @param input 版本号字符串。
 * @returns 解析结果或 `null`。
 */
export function tryParseVersion(input: string): ParsedVersion | null {
  try {
    return parseVersion(input);
  } catch {
    return null;
  }
}

/**
 * 把解析结果格式化回字符串。
 *
 * @param version 解析后的版本号。
 * @returns 版本号字符串；稳定版不带后缀。
 */
export function formatVersion(version: ParsedVersion): string {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  return version.stage === null ? base : `${base}-${version.stage}${version.iteration}`;
}

/**
 * 校验版本号格式。
 *
 * @param input 版本号字符串。
 * @returns 合法返回 `true`。
 */
export function isValidVersion(input: string): boolean {
  return tryParseVersion(input) !== null;
}

/**
 * 取数字版本线（去掉阶段后缀）。
 *
 * @param version 解析后的版本号。
 * @returns 形如 `0.1.0` 的字符串。
 */
export function numericLine(version: ParsedVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/**
 * 按 **semver** 语义比较两个版本号。
 *
 * 数字部分优先；数字相同时，预发布版（带后缀）**小于**稳定版（裸版本），
 * 预发布阶段之间按等级与序号比较。因为稳定版就是裸版本，本函数的排序结果与规则里
 * 「稳定版最稳定」的定义**完全一致**，不存在例外。
 *
 * @param a 左版本号字符串。
 * @param b 右版本号字符串。
 * @returns `a < b` 返回负数，`a > b` 返回正数，相等返回 0。
 * @throws 任一格式不合法时抛出 `Error`。
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);

  for (const part of ['major', 'minor', 'patch'] as const) {
    const diff = left[part] - right[part];
    if (diff !== 0) {
      return diff < 0 ? -1 : 1;
    }
  }

  // semver：有 prerelease 的一方更小；两边都没有则相等
  if (left.stage === null && right.stage === null) {
    return 0;
  }
  if (left.stage === null) {
    return 1;
  }
  if (right.stage === null) {
    return -1;
  }

  const rankDiff = stageRank(left.stage) - stageRank(right.stage);
  if (rankDiff !== 0) {
    return rankDiff < 0 ? -1 : 1;
  }
  const iterationDiff = left.iteration - right.iteration;
  if (iterationDiff !== 0) {
    return iterationDiff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * 同阶段内序号加一 —— 常规的「新增功能 / 修复 BUG」。
 *
 * @param version 当前版本号。
 * @returns 新版本号。
 * @throws 当前是稳定版时抛出 `Error`（稳定版已冻结，必须开新的数字版本线）。
 */
export function nextIteration(version: ParsedVersion): ParsedVersion {
  if (version.stage === null) {
    throw new Error(
      `${formatVersion(version)} 已是稳定版，不能再改内容（同一版本号不能对应两份不同的东西）。` +
        `请开新的数字版本线：修 BUG 用 --numeric patch，加功能用 --numeric minor。`,
    );
  }
  return { ...version, iteration: version.iteration + 1 };
}

/**
 * 推进到下一个更高的稳定性阶段，**序号归零**；从 `rc` 推进则成为稳定版（去掉后缀）。
 *
 * @param version 当前版本号。
 * @returns 新版本号。
 * @throws 已是稳定版时抛出 `Error`。
 */
export function promoteStage(version: ParsedVersion): ParsedVersion {
  if (version.stage === null) {
    throw new Error(
      `${formatVersion(version)} 已是稳定版（最高稳定性），没有更高的阶段可推进。` +
        `请用 --numeric patch | minor | major 开新的数字版本线。`,
    );
  }
  const currentRank = stageRank(version.stage);
  const next = RELEASE_STAGES[currentRank + 1];
  if (next === undefined) {
    // rc 之后就是稳定版：后缀整体消失，没有序号
    return { ...version, stage: null, iteration: 0 };
  }
  return { ...version, stage: next, iteration: 0 };
}

/**
 * 切换到指定阶段。
 *
 * - 往上推进时序号归零；
 * - 指定**当前所在**阶段视为「同阶段加一」；
 * - 目标为 `stable` 时去掉后缀（成为稳定版）；
 * - 往下退回需要显式 `allowDowngrade`（默认拒绝，避免手滑把 rc 退回 alpha）。
 *
 * @param version 当前版本号。
 * @param target 目标阶段，或 `'stable'`。
 * @param allowDowngrade 是否允许退回更低的阶段。
 * @returns 新版本号。
 * @throws 目标阶段更低且未允许退回时抛出 `Error`。
 */
export function setStage(
  version: ParsedVersion,
  target: StageTarget,
  allowDowngrade = false,
): ParsedVersion {
  const currentRank = stabilityRank(version);
  const targetRank =
    target === STABLE_TARGET ? RELEASE_STAGES.length : stageRank(target);

  if (targetRank < currentRank && !allowDowngrade) {
    throw new Error(
      `不允许从 ${formatVersion(version)} 退回 ${target}（稳定性只能往上走）。` +
        `确实要退回请显式加 --allow-downgrade。`,
    );
  }
  if (targetRank === currentRank) {
    return nextIteration(version);
  }
  if (target === STABLE_TARGET) {
    return { ...version, stage: null, iteration: 0 };
  }
  return { ...version, stage: target, iteration: 0 };
}

/** 增加数字版本号时的可选项。 */
export interface BumpNumericOptions {
  /**
   * 是否保留当前阶段。
   *
   * 默认 `false`：数字版本升级意味着**新开一条版本线**，从 `alpha0` 重新开始；
   * 若你希望「只换数字、阶段不动」，传 `true`。
   */
  keepStage?: boolean;
}

/**
 * 增加数字版本号（大规模更新，或稳定版之后的任何改动）。
 *
 * 默认把阶段重置为 `alpha0` —— 新的数字版本线从最不稳定的阶段开始。
 *
 * @param version 当前版本号。
 * @param part 要增加的位（`major` / `minor` / `patch`）。
 * @param options 可选项。
 * @returns 新版本号。
 */
export function bumpNumeric(
  version: ParsedVersion,
  part: NumericPart,
  options: BumpNumericOptions = {},
): ParsedVersion {
  const next: ParsedVersion = { ...version };
  if (part === 'major') {
    next.major += 1;
    next.minor = 0;
    next.patch = 0;
  } else if (part === 'minor') {
    next.minor += 1;
    next.patch = 0;
  } else {
    next.patch += 1;
  }

  if (options.keepStage === true) {
    return next;
  }
  return { ...next, stage: RELEASE_STAGES[0], iteration: 0 };
}

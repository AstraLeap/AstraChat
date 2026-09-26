/**
 * AstraChat 版本号规则。
 *
 * ## 格式
 *
 * ```
 * <major>.<minor>.<patch>-<stage><iteration>
 *      0    .   1   .   0   -  alpha     0
 * ```
 *
 * - **数字部分**（`0.1.0`）只在**大规模更新**时增加，平时一动不动。
 * - **阶段后缀**表示稳定性，从低到高：`alpha` < `beta` < `rc` < `lts`。
 * - **序号**在**同一个阶段内**每次「新增功能 / 修复 BUG」加一（`rc0` → `rc1`）。
 * - **推进阶段时序号归零**（`alpha3` → `beta0`），因此序号只在一个阶段内有意义。
 *
 * ## 一个必须知道的 semver 事实
 *
 * 只要带后缀，semver 就把它当作 **prerelease**，而 prerelease 排序**低于**同号的裸版本：
 *
 * ```text
 * 0.1.0-alpha0 < 0.1.0-beta0 < 0.1.0-rc0 < 0.1.0-lts0 < 0.1.0
 *                                                          ↑ 裸版本排最高
 * ```
 *
 * 也就是说 `lts` **不是** semver 意义上的「最高」——它仍是预发布版。这里按用户定义的
 * 分级实现（`lts` 是四个后缀里最稳定的），但 {@link compareVersions} 严格遵守 semver，
 * 所以排序结果里裸版本排在最后。如果哪天真要发「正式版」，用裸的 `0.1.0`；
 * 若希望 `lts` 在排序上也最高，需要改规则（那时也应同步改本文件与
 * `docs/versioning.md`，`tests/version-rules.spec.ts` 里有对应断言会提醒你）。
 *
 * ## 为什么规则写在代码里而不是只在文档里
 *
 * 版本号是会被**人手动改**的东西，只写在文档里必然写歪。这里把解析、比较、推进都实现成
 * 纯函数并配单测，`scripts/bump-version.mjs` 直接复用同一份实现（Node 22.18+ 可原生
 * import TS），因此不存在「脚本一套逻辑、文档另一套说法」的漂移。
 */

/** 稳定性阶段，**从低到高**。顺序即优先级，不要随意调整。 */
export const RELEASE_STAGES = ['alpha', 'beta', 'rc', 'lts'] as const;

/** 稳定性阶段类型。 */
export type ReleaseStage = (typeof RELEASE_STAGES)[number];

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
  /** 稳定性阶段；`null` 表示不带后缀的裸版本。 */
  stage: ReleaseStage | null;
  /** 阶段内序号；裸版本固定为 0。 */
  iteration: number;
}

/**
 * 版本号格式（数字部分可选带后缀）。
 *
 * 注意后缀里的序号用的是 `\d*`（允许为空）而不是 `\d+`：这样 `0.1.0-alpha` 能匹配上、
 * 落到下面「阶段后面必须带序号」的分支，给出**具体**的提示；若用 `\d+`，这种写法会直接
 * 落到「格式不合法」，用户看不出是少了序号。
 */
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z]+)(\d*))?$/;

/** 是否是不带后缀的裸版本。 */
export function isBareVersion(version: ParsedVersion): boolean {
  return version.stage === null;
}

/**
 * 阶段的稳定性等级：`alpha` = 0、`beta` = 1、`rc` = 2、`lts` = 3。
 *
 * @param stage 稳定性阶段。
 * @returns 等级数字，越大越稳定。
 */
export function stageRank(stage: ReleaseStage): number {
  return RELEASE_STAGES.indexOf(stage);
}

/**
 * 解析版本号字符串。
 *
 * @param input 版本号，如 `0.1.0-alpha0` 或 `0.1.0`。
 * @returns 解析结果。
 * @throws 格式不合法时抛出带具体原因的 `Error`。
 */
export function parseVersion(input: string): ParsedVersion {
  const text = String(input ?? '').trim();
  const match = VERSION_PATTERN.exec(text);
  if (!match) {
    throw new Error(
      `版本号格式不合法：${JSON.stringify(text)}。` +
        `应为 <major>.<minor>.<patch>-<stage><序号>（如 0.1.0-alpha0），或裸版本 0.1.0。`,
    );
  }

  const stageText = match[4];
  const iterationText = match[5];

  let stage: ReleaseStage | null = null;
  let iteration = 0;

  if (stageText !== undefined) {
    const lowered = stageText.toLowerCase();
    if (!(RELEASE_STAGES as readonly string[]).includes(lowered)) {
      throw new Error(
        `未知的稳定性阶段：${JSON.stringify(stageText)}。` +
          `只能是 ${RELEASE_STAGES.join(' / ')}（从低到高）。`,
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
 * @returns 版本号字符串。
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
 * 按 **semver** 语义比较两个版本号。
 *
 * 数字部分优先；数字相同时，带后缀的（prerelease）**小于**裸版本，且阶段等级低的小于
 * 等级高的，同阶段则比序号。
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

  // semver：有 prerelease 的一方更小
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
 * @throws 当前是裸版本时抛出 `Error`（裸版本没有阶段，无法判断该往哪个阶段走）。
 */
export function nextIteration(version: ParsedVersion): ParsedVersion {
  if (version.stage === null) {
    throw new Error(
      `当前是裸版本 ${formatVersion(version)}，没有阶段后缀，无法只加序号。` +
        `请用 --stage <alpha|beta|rc|lts> 指定要进入的阶段（或 --promote 进入 alpha）。`,
    );
  }
  return { ...version, iteration: version.iteration + 1 };
}

/**
 * 推进到下一个更高的稳定性阶段，**序号归零**。
 *
 * 裸版本视为「尚未进入预发布」，推进结果是 `alpha0`。
 *
 * @param version 当前版本号。
 * @returns 新版本号。
 * @throws 已在最高阶段 `lts` 时抛出 `Error`。
 */
export function promoteStage(version: ParsedVersion): ParsedVersion {
  if (version.stage === null) {
    return { ...version, stage: RELEASE_STAGES[0], iteration: 0 };
  }
  const next = RELEASE_STAGES[stageRank(version.stage) + 1];
  if (next === undefined) {
    throw new Error(
      `当前已在最高阶段 ${version.stage}，无法再推进。` +
        `若这是大规模更新，请用 --numeric <major|minor|patch> 增加数字版本号。`,
    );
  }
  return { ...version, stage: next, iteration: 0 };
}

/**
 * 切换到指定阶段。
 *
 * 往上推进时序号归零；指定**当前所在**阶段视为「同阶段加一」；往下退回需要显式
 * `allowDowngrade`（默认拒绝，避免手滑把 rc 退回 alpha）。
 *
 * @param version 当前版本号。
 * @param stage 目标阶段。
 * @param allowDowngrade 是否允许退回更低的阶段。
 * @returns 新版本号。
 * @throws 目标阶段更低且未允许退回时抛出 `Error`。
 */
export function setStage(
  version: ParsedVersion,
  stage: ReleaseStage,
  allowDowngrade = false,
): ParsedVersion {
  if (version.stage === null) {
    return { ...version, stage, iteration: 0 };
  }
  const current = stageRank(version.stage);
  const target = stageRank(stage);
  if (target < current && !allowDowngrade) {
    throw new Error(
      `不允许从 ${version.stage} 退回 ${stage}（稳定性只能往上走）。` +
        `确实要退回请显式加 --allow-downgrade。`,
    );
  }
  if (target === current) {
    return nextIteration(version);
  }
  return { ...version, stage, iteration: 0 };
}

/** 增加数字版本号时的可选项。 */
export interface BumpNumericOptions {
  /**
   * 是否保留当前阶段。
   *
   * 默认 `false`：数字版本升级意味着**大规模更新**，新版本线从 `alpha0` 重新开始；
   * 若你希望「只换数字、阶段不动」，传 `true`。
   */
  keepStage?: boolean;
}

/**
 * 增加数字版本号（**只用于大规模更新**）。
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

/**
 * 取数字版本线（去掉阶段后缀），用于「同一条版本线」的判断与展示。
 *
 * @param version 解析后的版本号。
 * @returns 形如 `0.1.0` 的字符串。
 */
export function numericLine(version: ParsedVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

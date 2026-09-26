import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import {
  RELEASE_STAGES,
  bumpNumeric,
  compareVersions,
  formatVersion,
  isBareVersion,
  isValidVersion,
  nextIteration,
  numericLine,
  parseVersion,
  promoteStage,
  setStage,
  stageRank,
  tryParseVersion,
} from '../src/services/version';

/**
 * 版本号规则的测试。
 *
 * 这个文件承担两件事：
 * 1. 锁住 `docs/versioning.md` 里写下的规则（格式、阶段顺序、序号归零、何时动数字版本）。
 * 2. **守卫 `package.json` 里的版本号**，让规则不会随着手改而腐化 —— 只要有人写了个
 *    格式不对的版本号，`npm test` 就会红。
 *
 * 另外显式断言了那个容易踩的 semver 事实：带后缀的版本**小于**同号裸版本，
 * 所以 `0.1.0-lts0 < 0.1.0`。如果哪天改了这条规则，这里会提醒你同步改文档。
 */

describe('版本号格式', () => {
  it('解析带阶段后缀的版本号', () => {
    expect(parseVersion('0.1.0-alpha0')).toEqual({
      major: 0,
      minor: 1,
      patch: 0,
      stage: 'alpha',
      iteration: 0,
    });
    expect(parseVersion('1.2.3-rc12')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      stage: 'rc',
      iteration: 12,
    });
  });

  it('解析裸版本（无后缀）', () => {
    const parsed = parseVersion('0.1.0');
    expect(parsed.stage).toBeNull();
    expect(parsed.iteration).toBe(0);
    expect(isBareVersion(parsed)).toBe(true);
  });

  it('阶段名大小写不敏感，统一归一成小写', () => {
    expect(parseVersion('0.1.0-LTS3').stage).toBe('lts');
    expect(parseVersion('0.1.0-Rc3').stage).toBe('rc');
  });

  it('去掉首尾空白', () => {
    expect(formatVersion(parseVersion('  0.1.0-beta2  '))).toBe('0.1.0-beta2');
  });

  it('格式化与解析可往返', () => {
    for (const text of [
      '0.1.0-alpha0',
      '0.1.0-beta3',
      '0.1.0-rc0',
      '0.1.0-lts9',
      '2.10.3',
    ]) {
      expect(formatVersion(parseVersion(text))).toBe(text);
    }
  });

  it('拒绝各种不合法写法', () => {
    const bad = [
      '',
      '0.1',
      '0.1.0.',
      'v0.1.0',
      '0.1.0-',
      '0.1.0-alpha',
      '0.1.0-alpha-1',
      '0.1.0-alpha0.1',
      '0.1.0-gamma0',
      '0.1.0-alpha0-beta1',
      '1.0.0-0',
    ];
    for (const text of bad) {
      expect(isValidVersion(text), `应判定为不合法：${JSON.stringify(text)}`).toBe(false);
      expect(tryParseVersion(text)).toBeNull();
      expect(() => parseVersion(text)).toThrow();
    }
  });

  it('报错信息指出具体原因', () => {
    expect(() => parseVersion('0.1.0-gamma0')).toThrow(/未知的稳定性阶段/);
    expect(() => parseVersion('0.1.0-alpha')).toThrow(/必须带序号/);
    expect(() => parseVersion('nope')).toThrow(/格式不合法/);
  });
});

describe('阶段顺序：alpha < beta < rc < lts', () => {
  it('RELEASE_STAGES 的顺序就是从低到高', () => {
    expect([...RELEASE_STAGES]).toEqual(['alpha', 'beta', 'rc', 'lts']);
  });

  it('stageRank 反映稳定性等级', () => {
    expect(stageRank('alpha')).toBe(0);
    expect(stageRank('beta')).toBe(1);
    expect(stageRank('rc')).toBe(2);
    expect(stageRank('lts')).toBe(3);
  });

  it('阶段越高排名越大', () => {
    for (let i = 1; i < RELEASE_STAGES.length; i++) {
      const lower = RELEASE_STAGES[i - 1]!;
      const higher = RELEASE_STAGES[i]!;
      expect(stageRank(higher)).toBeGreaterThan(stageRank(lower));
    }
  });
});

describe('compareVersions 的 semver 语义', () => {
  it('数字部分优先于阶段', () => {
    expect(compareVersions('0.1.0-lts9', '0.1.1-alpha0')).toBeLessThan(0);
    expect(compareVersions('0.2.0-alpha0', '0.1.9-lts9')).toBeGreaterThan(0);
  });

  it('数字按数值比，不按字符串比', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('10.0.0', '9.0.0')).toBeGreaterThan(0);
  });

  it('同阶段比序号', () => {
    expect(compareVersions('0.1.0-alpha0', '0.1.0-alpha1')).toBeLessThan(0);
    expect(compareVersions('0.1.0-rc9', '0.1.0-rc10')).toBeLessThan(0);
  });

  it('阶段顺序参与比较', () => {
    expect(compareVersions('0.1.0-alpha9', '0.1.0-beta0')).toBeLessThan(0);
    expect(compareVersions('0.1.0-beta9', '0.1.0-rc0')).toBeLessThan(0);
    expect(compareVersions('0.1.0-rc9', '0.1.0-lts0')).toBeLessThan(0);
  });

  it('【semver 事实】带后缀的版本小于同号裸版本', () => {
    // 这正是「lts 不是 semver 意义上的最高」的原因；改规则时这里会红
    expect(compareVersions('0.1.0-lts0', '0.1.0')).toBeLessThan(0);
    expect(compareVersions('0.1.0', '0.1.0-lts0')).toBeGreaterThan(0);
  });

  it('完全相同的版本返回 0', () => {
    expect(compareVersions('0.1.0-alpha0', '0.1.0-alpha0')).toBe(0);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
  });

  it('对非法输入抛错而不是给出错误结论', () => {
    expect(() => compareVersions('0.1.0', 'oops')).toThrow();
  });
});

describe('nextIteration：同阶段加一', () => {
  it('常规的功能 / 修复就是序号加一', () => {
    expect(formatVersion(nextIteration(parseVersion('0.1.0-alpha0')))).toBe('0.1.0-alpha1');
    expect(formatVersion(nextIteration(parseVersion('0.1.0-rc0')))).toBe('0.1.0-rc1');
    expect(formatVersion(nextIteration(parseVersion('0.1.0-lts11')))).toBe('0.1.0-lts12');
  });

  it('裸版本无法只加序号，报错并给出下一步建议', () => {
    expect(() => nextIteration(parseVersion('0.1.0'))).toThrow(/没有阶段后缀/);
  });
});

describe('promoteStage：推进阶段、序号归零', () => {
  it('依次推进并归零', () => {
    expect(formatVersion(promoteStage(parseVersion('0.1.0-alpha3')))).toBe('0.1.0-beta0');
    expect(formatVersion(promoteStage(parseVersion('0.1.0-beta7')))).toBe('0.1.0-rc0');
    expect(formatVersion(promoteStage(parseVersion('0.1.0-rc5')))).toBe('0.1.0-lts0');
  });

  it('裸版本推进到 alpha0', () => {
    expect(formatVersion(promoteStage(parseVersion('0.1.0')))).toBe('0.1.0-alpha0');
  });

  it('已在 lts 时不能再推进，并提示改用 --numeric', () => {
    expect(() => promoteStage(parseVersion('0.1.0-lts0'))).toThrow(/最高阶段/);
    expect(() => promoteStage(parseVersion('0.1.0-lts0'))).toThrow(/--numeric/);
  });
});

describe('setStage：指定阶段', () => {
  it('往上走时归零', () => {
    expect(formatVersion(setStage(parseVersion('0.1.0-alpha9'), 'rc'))).toBe('0.1.0-rc0');
  });

  it('指定当前所在阶段视为同阶段加一', () => {
    expect(formatVersion(setStage(parseVersion('0.1.0-alpha9'), 'alpha'))).toBe('0.1.0-alpha10');
  });

  it('默认拒绝往回退，除非显式允许', () => {
    expect(() => setStage(parseVersion('0.1.0-rc0'), 'alpha')).toThrow(/稳定性只能往上走/);
    expect(formatVersion(setStage(parseVersion('0.1.0-rc0'), 'alpha', true))).toBe(
      '0.1.0-alpha0',
    );
  });

  it('从裸版本进入任意阶段都是序号 0', () => {
    expect(formatVersion(setStage(parseVersion('0.1.0'), 'beta'))).toBe('0.1.0-beta0');
  });
});

describe('bumpNumeric：只在大规模更新时增加数字版本', () => {
  it('默认把阶段重置为 alpha0（新版本线从最不稳定开始）', () => {
    expect(formatVersion(bumpNumeric(parseVersion('0.1.0-alpha5'), 'minor'))).toBe(
      '0.2.0-alpha0',
    );
    expect(formatVersion(bumpNumeric(parseVersion('0.1.3-rc2'), 'patch'))).toBe('0.1.4-alpha0');
    expect(formatVersion(bumpNumeric(parseVersion('0.9.9-lts0'), 'major'))).toBe('1.0.0-alpha0');
  });

  it('进位规则符合语义化版本', () => {
    const minor = bumpNumeric(parseVersion('1.4.7-rc1'), 'minor');
    expect([minor.major, minor.minor, minor.patch]).toEqual([1, 5, 0]);

    const major = bumpNumeric(parseVersion('1.4.7-rc1'), 'major');
    expect([major.major, major.minor, major.patch]).toEqual([2, 0, 0]);

    const patch = bumpNumeric(parseVersion('1.4.7-rc1'), 'patch');
    expect([patch.major, patch.minor, patch.patch]).toEqual([1, 4, 8]);
  });

  it('keepStage 可以只换数字、不动阶段', () => {
    expect(formatVersion(bumpNumeric(parseVersion('0.1.0-rc7'), 'minor', { keepStage: true }))).toBe(
      '0.2.0-rc7',
    );
  });
});

describe('numericLine：数字版本线', () => {
  it('去掉阶段后缀', () => {
    expect(numericLine(parseVersion('0.1.0-alpha9'))).toBe('0.1.0');
    expect(numericLine(parseVersion('2.3.4'))).toBe('2.3.4');
  });
});

describe('完整生命周期演练', () => {
  it('从 alpha0 一路走到 lts，再进入下一条数字版本线', () => {
    const trail: string[] = [];
    let current = parseVersion('0.1.0-alpha0');
    trail.push(formatVersion(current));

    // alpha 阶段内两次改动
    current = nextIteration(current);
    trail.push(formatVersion(current));
    current = nextIteration(current);
    trail.push(formatVersion(current));

    // 推进到 beta、rc、lts，每次序号归零
    current = promoteStage(current);
    trail.push(formatVersion(current));
    current = nextIteration(current);
    trail.push(formatVersion(current));
    current = promoteStage(current);
    trail.push(formatVersion(current));
    current = promoteStage(current);
    trail.push(formatVersion(current));

    expect(trail).toEqual([
      '0.1.0-alpha0',
      '0.1.0-alpha1',
      '0.1.0-alpha2',
      '0.1.0-beta0',
      '0.1.0-beta1',
      '0.1.0-rc0',
      '0.1.0-lts0',
    ]);

    // 一路上稳定性单调不减
    for (let i = 1; i < trail.length; i++) {
      expect(compareVersions(trail[i - 1]!, trail[i]!), `${trail[i - 1]} → ${trail[i]}`)
        .toBeLessThan(0);
    }

    // 大规模更新才动数字版本
    const nextLine = bumpNumeric(current, 'minor');
    expect(formatVersion(nextLine)).toBe('0.2.0-alpha0');
    expect(compareVersions(formatVersion(nextLine), '0.1.0-lts0')).toBeGreaterThan(0);
  });
});

describe('守卫：package.json 的版本号必须符合规则', () => {
  it('能按规则解析', () => {
    expect(() => parseVersion(pkg.version)).not.toThrow();
  });

  it('必须带阶段后缀，而不是裸版本的 0.1.0', () => {
    const parsed = parseVersion(pkg.version);
    expect(isBareVersion(parsed), `package.json 版本不应是裸版本：${pkg.version}`).toBe(false);
  });

  it('阶段必须是四档之一', () => {
    const parsed = parseVersion(pkg.version);
    expect(RELEASE_STAGES).toContain(parsed.stage);
  });

  it('当前处于 0.1.0 数字版本线的 alpha 阶段', () => {
    const parsed = parseVersion(pkg.version);
    // 数字版本只在大规模更新时才变；QQ 接入等常规功能迭代留在 0.1.0 线
    expect(numericLine(parsed)).toBe('0.1.0');
    expect(parsed.stage).toBe('alpha');
  });
});

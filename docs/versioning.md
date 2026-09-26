# 版本号规则

本项目**不用**「每次发布 +1 个 patch」的常规做法。规则如下。

## 格式

```
<major>.<minor>.<patch>-<stage><序号>
      0    .   1   .   0   -  alpha   0
```

当前版本：**`0.1.0-alpha0`**

| 部分 | 含义 | 什么时候变 |
|---|---|---|
| `major.minor.patch` | 数字版本线 | **只在「大规模级别的更新」时增加**，平时一动不动 |
| `alpha` / `beta` / `rc` / `lts` | 稳定性阶段 | 从低到高推进，见下表 |
| 末尾数字 | 阶段内序号 | 每次**新增功能 / 修复 BUG** 加一（`rc0` → `rc1`） |

## 稳定性阶段

从低到高：

| 阶段 | 等级 | 含义 |
|---|---|---|
| `alpha` | 0 | 早期开发，功能可能不完整、会有返工 |
| `beta` | 1 | 主要功能齐了，仍在试错、接口可能变 |
| `rc` | 2 | 候选发布，只修问题不加功能 |
| `lts` | 3 | 本规则内的最高稳定档，长期支持 |

**推进阶段时序号归零**：`0.1.0-alpha3` → `0.1.0-beta0`。所以序号只在一个阶段内有意义，
跨阶段比较看阶段本身（`compareVersions` 就是这么做的）。

## 三条判断准则

1. **加功能 / 修 BUG** → 同阶段序号 +1。这是绝大多数提交要做的事。
2. **稳定性明显提升**（比如功能齐了、可以给别人试用） → 推进阶段，序号归零。
3. **大规模更新**（架构换代、破坏性变更） → 才动数字版本，且默认回到 `alpha0`。

## 命令

```sh
npm run version:bump                 # 同阶段序号 +1（日常）
npm run version:bump -- --promote    # 推进到下一阶段，序号归零
npm run version:bump -- --stage rc   # 指定阶段（往上走归零；指定当前阶段即 +1）
npm run version:bump -- --numeric minor   # 大规模更新：数字版本 +1，阶段回 alpha0
npm run version:bump -- --set 0.1.0-rc0   # 显式指定（仍会校验格式）
npm run version:bump -- --dry-run    # 只预览
npm run version:bump -- --tag        # 改完顺带打 git tag v<版本>
```

`--numeric` 默认把阶段重置为 `alpha0`（新的数字版本线从最不稳定开始）；如果你要
「只换数字、阶段不动」，加 `--keep-stage`。

## ⚠️ 一个必须知道的 semver 事实

只要带后缀，semver 就把它当作 **prerelease**，而 prerelease 排序**低于**同号的裸版本：

```
0.1.0-alpha0 < 0.1.0-beta0 < 0.1.0-rc0 < 0.1.0-lts0 < 0.1.0
                                                         ↑ 裸版本排最高
```

也就是说 **`lts` 不是 semver 意义上的「最高」** —— 它仍然是预发布版。本规则按上面的
四档定义实现（`lts` 是四个后缀里最稳定的），但 `compareVersions` 严格遵守 semver，
所以排序结果里裸版本排最后。

实际影响：

- 目前没有任何自动更新/依赖比较逻辑，所以**不影响使用**。
- 将来若做自动更新，「`0.1.0-lts0` → `0.1.0`」会被视为**升级**（因为裸版本更大），这通常正是你要的。
- 若你希望 `lts` 在排序上也是最高，需要改规则（例如改用 `+lts0` 构建元数据，
  或把 `lts` 表示为裸版本）。改的时候要同步改
  [`src/services/version.ts`](../src/services/version.ts) 与
  [`docs/versioning.md`](versioning.md)（本文），
  `tests/version-rules.spec.ts` 里有对应断言会提醒你。

## 为什么规则写在代码里

版本号是**需要人手改**的东西。只写在文档里必然会写歪 —— 要么格式不对，要么阶段跳级，
要么「加了个功能却忘了 +1」。

所以：

- 解析、比较、推进、数字版本升级都实现在
  [`src/services/version.ts`](../src/services/version.ts) 的**纯函数**里；
- [`scripts/bump-version.mjs`](../scripts/bump-version.mjs) **复用同一份实现**
  （Node 22.18+ 可原生 import TS，不需要编译步骤），因此不存在「脚本一套逻辑、
  文档另一套说法」的漂移；
- [`tests/version-rules.spec.ts`](../tests/version-rules.spec.ts) 锁住全部规则，
  并且有一条**守卫用例**直接读 `package.json` 断言版本号合法、带阶段后缀、处于
  `0.1.0` 数字版本线的 `alpha` 阶段 —— 谁写歪了，`npm test` 就红。

`package.json` 是版本号的**唯一真源**：`electron-builder` 用 `${version}` 生成产物名，
「关于」区块通过 `app.getVersion()` 显示它。代码注释与 README 里出现的 `v0.1.0`
指的是**数字版本线**，不随阶段后缀变化。

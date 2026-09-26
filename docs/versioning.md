# 版本号规则

本项目**不用**「每次发布 +1 个 patch」的常规做法。规则如下。

## 格式

```
<major>.<minor>.<patch>-<stage><序号>      预发布
      0    .   1   .   0   -  alpha   0

<major>.<minor>.<patch>                    稳定版（LTS）
      0    .   1   .   0
```

当前版本：**`0.1.0-alpha1`**

| 部分 | 含义 | 什么时候变 |
|---|---|---|
| `major.minor.patch` | 数字版本线 | **只在「大规模级别的更新」时增加**，平时一动不动（唯一例外见下） |
| `alpha` / `beta` / `rc` | 预发布阶段 | 从低到高推进 |
| **没有后缀** | **稳定版（LTS）** | 本规则内的最高稳定档 |
| 末尾数字 | 阶段内序号 | 每次**新增功能 / 修复 BUG** 加一（`rc0` → `rc1`） |

## 稳定性从低到高

| 档位 | 写法 | 含义 |
|---|---|---|
| 1 | `0.1.0-alpha0` | 早期开发，功能可能不完整、会有返工 |
| 2 | `0.1.0-beta0` | 主要功能齐了，仍在试错、接口可能变 |
| 3 | `0.1.0-rc0` | 候选发布，只修问题不加功能 |
| 4 | `0.1.0` | **稳定版 / LTS** —— 裸版本，不带后缀 |

**稳定版为什么不加 `-ltsN` 后缀**：semver 里只要带后缀就是 prerelease，排序**低于**同号的
裸版本，也就是 `0.1.0-lts0 < 0.1.0` —— 那样「最稳定的档位」反而排在最小，规则自相矛盾。
用裸版本表示稳定版，规则与 semver 的排序就**完全一致**了。

**推进阶段时序号归零**：`0.1.0-alpha3` → `0.1.0-beta0`。所以序号只在预发布阶段内有意义；
稳定版**没有序号**（`0.1.0-rc2` → `0.1.0`，后缀整体消失）。

## 一条数字版本线的完整生命周期

```text
0.1.0-alpha0 → alpha1 → … → beta0 → … → rc0 → … → 0.1.0   ← 稳定版 / LTS
                                                        │
                    任何后续改动都要开新的数字版本线 ──────┘
                      修 BUG：--numeric patch  → 0.1.1-alpha0
                      加功能：--numeric minor  → 0.2.0-alpha0
```

**稳定版是不可变的**：`0.1.0` 一旦作为稳定版发出，就不能再改它的内容 —— 否则同一个版本号
会对应两份不同的东西。所以稳定版之后的任何改动**必须**进入新的数字版本线。

这是「数字部分只在…时增加」的**唯一例外**：它不是「大规模更新」，而是「上一版已冻结」。
判断方式很简单：

- 还没发稳定版 → 只动**序号**（必要时推进阶段），数字不动。
- 已经发了稳定版 → 必须**动数字**，同时新版本线从 `alpha0` 重新走一遍。

## 命令

```sh
npm run version:bump                      # 同一阶段序号 +1（日常）
npm run version:bump -- --promote         # 推进阶段；从 rc 推进 → 稳定版
npm run version:bump -- --stage rc        # 指定阶段（往上走归零；指定当前阶段即 +1）
npm run version:bump -- --stage stable    # 直接成为稳定版（去掉后缀）
npm run version:bump -- --numeric minor   # 大规模更新 / 稳定版之后：数字 +1，阶段回 alpha0
npm run version:bump -- --set 0.1.0-rc0   # 显式指定（仍会校验格式）
npm run version:bump -- --dry-run         # 只预览
```

`--numeric` 默认把阶段重置为 `alpha0`（新的数字版本线从最不稳定开始）；如果你要
「只换数字、阶段不动」，加 `--keep-stage`。

## 打 tag

**顺序很重要，必须两步**：

```sh
npm run version:bump                      # 1) 改 package.json
git add -A && git commit -m "..."         # 2) 提交
npm run version:bump -- --tag             # 3) 提交之后才打 tag v<版本号>
```

原因是 `git tag` 只能给**已有的提交**打标签。如果「改版本号」和「打 tag」在一条命令里做完，
此时改动还没提交，tag 就会指向一个 `package.json` 里还是**旧版本号**的提交 —— 版本号与 tag
对不上。所以 `--tag` 现在只负责打 tag、不改版本号，并且会校验 `package.json` 相对 HEAD
没有未提交改动，否则直接拒绝。

打好后推送：

```sh
git push origin v0.1.0-alpha1
```

已发布的 tag：`v0.1.0-alpha0`（对应提交 `da216eb`）。

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
  并且有一条**守卫用例**直接读 `package.json` 断言版本号合法、带预发布后缀、处于
  `0.1.0` 数字版本线的 `alpha` 阶段 —— 谁写歪了，`npm test` 就红。

`package.json` 是版本号的**唯一真源**：`electron-builder` 用 `${version}` 生成产物名，
「关于」区块通过 `app.getVersion()` 显示它。代码注释与 README 里出现的 `v0.1.0`
指的是**数字版本线**，不随阶段后缀变化。

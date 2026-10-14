# dsh-motor-ai-l0 免费「有限次」门禁评价报告 —— 0.4.3 基线 vs 0.5.0 复核

**评测日期**：2026-10-14
**评测对象**：`dsh-motor-ai-l0` 当前工作树 **v0.5.0**（`bad4873`，已发 npm latest）
**历史基线**：用户此前贴出的 0.4.3 评价（对应 commit `9e3d273`）
**方法**：从 git 历史读出 0.4.3 真实代码逐条复核（未凭贴文转述），再对 0.5.0 重新静态核验 + 动态实测。实测脚本 `scripts/quota_probe_0.5.0.mjs`（临时 `DSH_HOME` 隔离，不触碰真实配额文件），**13/13 断言全绿，exit 0**。

> ⚠️ 命名说明：用户原始要求文件名含 `0.4.3`，但实测对象是 0.5.0 代码。按「真实代码 + 诚实披露」原则以 0.5.0 命名，标题与正文均标明这是 0.4.3 基线的复核版。

---

## 一、结论速览

| 你贴的 0.4.3 发现 | 0.5.0 状态 | 证据 |
|---|---|---|
| P0-门1 `runL0Pipeline` 纯函数入口脱闸 | 🔴 **仍残留** | `pipeline.mjs:70` 纯函数零 quota 引用；闸门仅在 `registerL0Pipeline.execute:206`。实测：直调 ×12，本地 `free` 恒 =0 |
| P0-门2 零本地态 + 离线 fail-open | 🟢 **已修** | 本地 `free-quota.json` 计数 + fail-closed；实测离线第 11 次必拦 |
| P1「5 次/天」由后端下发 | 🟢 **已修** | 0.4.4 起 `??5→??10` 本地回落；0.5.0 本地优先（`DSH_FREE_DAILY_LIMIT`） |
| P1 两入口差异 / 体验生硬 | 🟡 部分修复 | 拦截文案含 `used/limit`、返回 `remaining`；两入口差异仍未文档化 |
| P2 离线 4s 阻塞 | 🟢 **已修** | `enforceQuota` 完全不触网；实测 11 次 **31ms**（0.4.3 基线为 `await fetch` + 4s 超时，`quota.mjs:64`） |
| P2 指纹仅 3 字段 | 🟡 残留但低危 | `hostname\|platform\|arch` 实测不变（`b52d4c51acffcb59`）；当前仅用于遥测同步、**不参与放行** |
| （新增）软限制 | 🟡 残留 | 删 `free-quota.json` 即清零——技术用户可绕过（0.5.0 docstring 已诚实自承） |

**总体判断**：0.5.0 把 0.4.3 的两条 P0 中的一条（门2 断网不限次）和一条 P2（4s 阻塞）彻底修掉，门禁语义从「后端说了算」翻转为「本地硬闸 + 旁路遥测」。**唯一仍待修的高优先级项是 P0-门1：纯函数入口脱闸。**

---

## 二、逐条复核详情

### 2.1 P0-门1：`runL0Pipeline` 纯函数脱闸（🔴 仍残留）

**代码事实（0.5.0）**：

- `tools/l0/pipeline.mjs:70` —— `export function runL0Pipeline(rawArgs, config = {})`，三步链聚合**纯函数**（注释自述「零依赖，可单测」），函数体内**零** quota 引用。
- 闸门只挂在一处：`tools/l0/pipeline.mjs:206`，位于 `registerL0Pipeline` 注册的 `execute` 内（`const quotaErr = await enforceQuota(config)`）。
- 三个子工具的纯函数出口（param-matrix / estimate / validate 的聚合函数）同样不过闸。

**实测复现**（探针 A/A2）：

```
runL0Pipeline({power_kw:15, speed_rpm:1460, voltage_v:380, ...}) 直调 ×12
→ 本地 free-quota.json free 恒 =0（纯函数根本不写配额文件）
```

**影响面**：脚本 / CI / 其他插件直接 import `runL0Pipeline` 调用时，**零限制**。走 DSH 工具入口的用户不受影响（有闸）。这是「限流只防普通用户、防不了 API 直调」的经典缺口。

**建议修法**（未实施，待授权）：在 `runL0Pipeline` 顶部注入 `assertFreeQuota('pipeline', config)`，与工具入口共用同一 `config` 对象引用、靠 0.5.0 已有的一次性消费标记防重复扣次。三个子工具纯函数出口同理。

### 2.2 P0-门2：零本地态 + 离线 fail-open（🟢 已修）

**0.4.3 基线**（`git show 9e3d273:lib/quota.mjs`）：

- `:64` `await fetch(url, {...})` 带超时；`:73/:78/:81` 网络异常、超时、坏响应一律 `{allowed:true, reason:'...fail-open'}`；`:83` 只有显式 `allowed===false` 才拦。
-  ⇒ 断网 = 不限次；且每次调用白等最多 4 秒。

**0.5.0 现状**：

- 放行决策 100% 本地：`free-quota.json`（`$DSH_HOME/storages/dsh-motor-ai/`，与完整版激活态同文件 ⇒ 同机两端共用一本账）。
- 免费档 fail-closed：用尽即抛 `QuotaExceededError`，断网也拦。
- 后端不再决定放行：即使回 `allowed:false`，本地未超限即放行（语义反转）。

**实测**（探针 D/D2）：不配任何后端，前 10 次放行、第 11 次拦 —— fail-closed 生效。

### 2.3 P1：「5 次/天」后端下发 + 体验生硬（🟢/🟡）

- **限额口径**：0.4.3 由后端 `info.limit ?? 5` 下发；0.4.4 已改 `?? 10`；0.5.0 本地优先（`DSH_FREE_DAILY_LIMIT` 可覆盖），默认 10 次/天。
- **体验**：拦截文案现含 `今日免费额度已用尽（10/10 次/天，按本地自然日重置）。`（实测输出），比 0.4.3 的裸 reason 字符串显著改善。
- **仍残留**：工具入口（`execute`）与纯函数入口的差异、`remaining` 字段语义，README 未成文（🟡 文档债，非代码缺陷）。

### 2.4 P2：离线 4s 阻塞（🟢 已修）

- 0.4.3 `checkFreeQuota` = `await fetch` + 4s 超时；后端不可达时每次调用白等 4s。
- 0.5.0 `enforceQuota` 完全不触网；旁路遥测改 fire-and-forget（超时定时器 `unref()`）。
- **实测**：11 次连续 `enforceQuota` 合计 **31ms**（平均 ~3ms/次），4s 阻塞彻底消除。

### 2.5 P2：设备指纹 3 字段（🟡 残留但低危）

- 算法仍为 `sha256(hostname|platform|arch).slice(0,16)`，实测值 `b52d4c51acffcb59`。
- **风险等级下调**：0.5.0 起指纹仅用于旁路遥测归并，**不参与放行决策**（放行只看本地计数）。与完整版逐字节一致是刻意保留的兼容性设计。

### 2.6 新增发现：本地硬闸本质是软限制（🟡）

- 删除 `$DSH_HOME/storages/dsh-motor-ai/free-quota.json` 即清零重置（探针 E/E2 实测复现）。
- 0.5.0 `lib/quota.mjs` docstring 已诚实自承此边界。对「防止普通用户超用」足够；对抗刻意绕过无效 —— 这是免费档的合理定位，商业版走激活码硬闸。

---

## 三、实测方法与可复现性

**脚本**：`scripts/quota_probe_0.5.0.mjs`
**运行**：`node scripts/quota_probe_0.5.0.mjs`（需 Node ≥18；预期输出 `QUOTA_PROBE_0.5.0_ALL_OK`，exit 0）
**隔离**：`mkdtempSync` 建临时 `DSH_HOME`，`finally` 还原全部环境变量并 `rmSync` 临时目录；**绝不触碰用户真实 `free-quota.json`**。

**本次实测原始输出**（13/13）：

```
✅ 探针隔离生效：配额文件落在临时 DSH_HOME
✅ A) P0-门1 复现：runL0Pipeline 直调 ×12 不触发闸门（本地 free 仍=0）
✅ A2) 直调纯函数完全不写配额文件 / 不计数（脱闸证据）
✅ B) 硬闸生效：前 10 次放行
✅ B2) 第 11 次（>上限 10）被拦（fail-closed，不依赖后端）
✅ B3) 拦截文案含"免费额度已用尽"引导 | 今日免费额度已用尽（10/10 次/天，按本地自然日重置）。
✅ C) freeQuotaEnabled=false 直接放行（即使本地已 9/10）
✅ D) 离线（无后端）前 10 次放行 | nulls=10
✅ D2) 离线仍在第 11 次拦截（fail-closed，证 P0-门2 已修）
✅ D3) 无后端时单次 enforceQuota 不触网（整批 11 次 <300ms）| 11 calls elapsed=31ms
✅ E) 软限制残留：已用尽时被拦
✅ E2) 软限制残留：删除 free-quota.json 即清零放行（技术用户可绕过）
✅ 指纹仍为 3 字段 hostname|platform|arch（P2 残留项，仅用于遥测、不参与放行）
QUOTA_PROBE_0.5.0_ALL_OK
```

覆盖矩阵：脱闸复现（A）｜硬闸边界恰好 10+1（B）｜运维开关（C）｜离线 fail-closed 与延迟回归（D）｜软限制诚实边界（E）｜指纹算法核对。

---

## 四、待办与优先级

| 优先级 | 事项 | 状态 |
|---|---|---|
| **P0** | 修 P0-门1：`runL0Pipeline` 及子工具纯函数出口注入 `assertFreeQuota`（共用 config + 一次性消费标记防重扣） | ⬜ 待授权改码 |
| P2 | 文档化两入口差异与 `remaining` 语义（README） | ⬜ 可选 |
| P2 | 指纹扩字段评估（如加 node 版本维度）——仅影响遥测归并粒度 | ⬜ 可选 |

---

## 五、附录：版本坐标

| 项 | 值 |
|---|---|
| 0.5.0 commit | `bad4873`（已 push origin/main，npm latest，shasum `f26bc0a3...`） |
| 0.4.3 基线 commit | `9e3d273` |
| 探针脚本 | `scripts/quota_probe_0.5.0.mjs`（未入 git 跟踪，发布白名单外，不影响 npm 包） |
| 门禁现状 | `verify.mjs` 117/117；`_selftest_quota.mjs` 17/17 |

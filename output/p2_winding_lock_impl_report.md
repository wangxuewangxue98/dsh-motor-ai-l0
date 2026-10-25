# P2-A 绕组锁定（winding-lock）实施报告

> **任务**：修复 `deriveElectricalClosure` 静默覆盖入参绕组（根因报告 §3.3），
> 以 E 平衡闭合反推 Bg，根治齿磁密/磁密族估算的 Bg 断裂（65 台真值 MAPE 77.5%）。
> **授权**：用户选 B + A（2026-10-25）。**性质**：additive，默认 OFF 零回归。
>
> **改动范围**：`@wangxue98/dsh-motor-ai-core` `lib/formula-engine.mjs`（+74 行）、
> `lib/param-schema.mjs`（+4 字段登记）、`index.mjs`（+3 导出）；
> l0 侧 `tools/l0/param-matrix.mjs` / `tools/l0/pipeline.mjs`（count 缺省 20→1000）、
> `skills/motor-l0-estimate/SKILL.md`（文档同步）。**未动**：铁损标定口径、意图磁密口径、
> `doSaturationLoop`、analytics 通道主指标。

---

## 1. 修了什么（根因 → 修复映射）

| 根因（报告 §3.3） | 修复 |
|---|---|
| `deriveElectricalClosure` 不收 `turns_per_coil` / `conductors_per_slot` 入参 | 签名增加 `windingLock / turnsPerCoilIn / conductorsPerSlotIn / kwEff` 四个入参 |
| `effTurns = closure?.turns_per_coil ?? turnsPerCoil` 使重算值覆盖入参（实测入参 6/24/144 → 输出全 2） | lock ON 且有入参时 `turns_per_coil` 输出**入参值**（锚点机 144→72=cps/2，不再被 round(turnsIdeal)=34 覆盖） |
| Bg 只能走"意图常量 0.80 × 匝比"二级传导，与真值 pearson=0.030 | lock ON 时 E 平衡直接闭合：`Φ = Uph/(4.44·f·N·kw_eff)`，`Bg = Φ/极距面积`；`bgForFlux = bg_locked ?? bg_actual ?? intent` |

**匝数口径**（与 RMxprt 求解器实验结论一致——`turns_per_coil` 字段无效、只吃 `conductors_per_slot`）：

```
N_phase = conductors_per_slot 有效 ? (Qs/3)·(cps/2)/a     ← cps 优先（求解器口径）
                              : (Qs/3)·turns_per_coil/a   ← tpc 兜底（标准语义=每线圈匝数）
```

## 2. 开关与标定常量（双通道，默认 OFF）

| 项 | 默认 | 通道 |
|---|---|---|
| `DSH_L0_WINDING_LOCK` | `0`（OFF） | env + `opts.windingLock` |
| `kw_eff` | `0.697` | `opts.kwEff` > `DSH_L0_KW_EFF` > 0.697 |

- `kw_eff=0.697`：65 台 RMxprt 真值反算（`output/p2_kw_eff.json`，mean=0.697、CV=5.1%），
  与 `WINDING_FACTOR=0.95`（仅分布+短距）的差额主要为斜槽削弱。
- 默认 OFF ⇒ 现有行为**零回归**（门禁锚点机实证：lock OFF 时 `Bg_eff=0.793` 与旧路径一致）。

## 3. 新增输出字段（已登记 L0_NATIVE_FIELDS 白名单）

| 字段 | 含义 |
|---|---|
| `winding_lock` | bool 本行 lock 是否生效 |
| `bg_locked_t` | lock 生效时的闭合 Bg（否则 null） |
| `kw_eff_used` | 本次闭合用的有效绕组系数 |
| `air_gap_flux_density_effective` | 最终生效 Bg = bg_locked ?? bg_actual ?? intent（实际口径链源头） |

生效磁密走 **`*_flux_density_actual` 族**（与质量门 V08 同口径，P0-1 既定设计）；
意图口径 `*_flux_density` 与铁损 `bEffIron` **不变**（v3 铁损标定红线）。

## 4. 65 台真值验收（`dev-calib/accept_winding_lock.mjs`）

| 指标 | lock OFF | lock ON |
|---|---|---|
| **Bg MAPE** | 77.5% | **4.7%** |
| **Bg 偏差** | +77.4% | +3.6% |
| **Bg pearson** | 0.030 | **0.988** |
| Bt MAPE | 30.2% | 32.5% |
| **Bt pearson** | −0.027 | **0.961** |
| Bt 偏差 | +16.0% | −32.5% |

分族（Bg lock ON）：2 极 7.2% / 4 极 3.7% / 6 极 4.1% / 8 极 3.5% MAPE——**无族级异常**。

**诚实解读**：
- Bg 治本达成（与 predeem 预测 3.9% 一致；4.7% 为全局单 kw 口径，分族中位可更低）；
- Bt **区分度恢复**（pearson −0.03→0.96，排序/可行性判定可依赖）；
- Bt 残余 **−32.5% 系统性低估**归因齿宽口径（派生 0.5×槽距 vs 真机 0.264×槽距 ⇒ 面积大 1.89×），
  走显式 `params.tooth_width` 通道解决（已实证生效：tw=3.92⇒Bt 2.96T 逐位吻合公式）；
  `toothShapeK()` 标定（k_fit CV=33%）受齿部饱和非线性主导，未作默认值（前轮结论不变）。

## 5. 门禁与反向破坏（`scripts/verify_winding_lock.mjs`，14 项）

覆盖：默认 OFF / env 通道 / opts 通道 / 零回归锚点 / 公式同口径重算自证 /
入参消费 / kw_eff 双通道 / 新字段透传 / closure 回显 / 65 台验收门
（Bg MAPE<10% 且 pearson>0.9）。

**反向破坏验证**（临时改镜像、不动真源、验完恢复）：

| 破坏 | 结果 |
|---|---|
| `windingLockOn` 默认 false→true | **4 项变红**（默认 OFF / 两条零回归 / lock OFF 入参消费） |
| 短路 lock 入参消费（`if (windingLock)`→`if (false && …)`） | **6 项变红**（env/opts 通道 / 公式自证 / 入参消费 / closure 回显 / 65 台验收） |
| 恢复后 | 14/14 回绿 ✓ |

**过程中门禁自身抓到一个真问题**：公式自证项的极面积初版写成 `π·Di·L/(poles/2)`（多除 2），
被同口径重算断言当场抓获（输出 0.325 vs 重算 0.1625，恰差 2 倍）⇒ 修正门禁后通过
（core 侧 `Ag=π·Di·L/(2pp)` 本就正确，65 台 MAPE 4.7% 佐证）。

## 6. 回归与兼容

| 验证 | 结果 |
|---|---|
| `scripts/verify.mjs` 全量 | **135/135 通过**（含 count 改动与 winding-lock） |
| `scripts/verify_winding_lock.mjs` | **14/14 通过** |
| 语法 | `node --check` 全过 |
| 铁损口径 | `bEffIron` 代码路径未触碰（红线保持） |

**已知行为变更（必须知情）**：`count` 缺省 20→1000 后，
`strictMaxMatrixSize=true` 且 `maxMatrixSize<1000` 的调用方由静默通过转为抛错
（原 20 不触发）——此类调用需显式传 `count` 或提高 `maxMatrixSize`。

## 7. 诚实边界

1. `kw_eff=0.697` 的 65 台样本中 6/8 极为 EMF 合成绕组（4 极 37 台真实绕组），
   跨族泛化需真实冲片绕组复核（与前轮报告 §10 同款披露）；
2. 验收集 = 标定集（闭环自证），非独立留出；泛化误差可能高于 4.7%；
3. winding-lock 只修 Bg 链路；齿宽口径（Bt −32.5%）与齿部饱和修正（k_fit 无稳定标定）
   是下一轮独立议题；
4. 真值集 inputs 曾存在字段名不一致（`speed` vs `speed_rpm`）导致 closure 整体返回 null
   的调试插曲——已在验收脚本修正（`i.speed ?? i.speed_rpm`），
   提醒：**所有消费真值集的脚本必须核对 inputs 字段名**。

---

*实施：2026-10-25 ｜ core 侧改动待提交（D:/dsh-motor-ai-core）｜ l0 0.6.6 待发布（需另行授权 npm publish）*

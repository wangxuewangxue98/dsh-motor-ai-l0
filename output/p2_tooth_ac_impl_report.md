# A+C 组合落地报告：齿部等效宽模型

> 授权：用户选 **A（齿宽真值化）+ C（显式等效齿宽模型）**
> 落地：`dsh-motor-ai-core@master 6418a82` + `dsh-motor-ai-l0@main 953a735`（均已推送 origin）
> 验收：`dev-calib/verify_ac_tooth.mjs` 全部通过｜`scripts/verify.mjs` **134/134**

---

## 1. 做了什么

### C：显式等效齿宽模型（core 新增）

| 新增导出 | 作用 |
|---|---|
| `effectiveToothWidth(opts)` | 求"喂给磁路计算的齿部等效宽"（mm），≤0 表示几何不足 |
| `effectiveToothWidthInfo(opts)` | 可追溯版：返回 `{width, base, k, source}` |
| `toothShapeK({toothWidthTop, toothWidthRoot, slotShape})` | **C 的物理模型**：齿宽沿径向线性变化 ⇒ `k = 平均宽 / 最小截面宽` |
| `TOOTH_EFF_K_SHAPE_DEFAULT = 1.0` | 默认零缩放 ⇒ **零回归** |
| `TOOTH_EFF_K_BY_SHAPE = { parallel: 1.0 }` | 槽形查表（其余待真值扩充） |

`k` 取值优先级：**显式 `kShape` > env `DSH_L0_TOOTH_K_SHAPE` > 齿形尺寸推算 > 查表 > 默认 1.0**

### A：齿宽真值化（无条件生效）

`toothWidth` 缺失或非正 ⇒ 回退 `core` 派生 `0.5×槽距`。

**顺带修掉一个此前未被发现的真实缺陷**：`l0/analytic-engine.mjs` 的 `doSaturationLoop` 原直接吃 `row.tooth_width`，缺失时 `At = 0` ⇒ `Bt = Infinity`（JSON 序列化为 `null`），且 `B_y`/`B_delta` 全被污染、**不报错静默产出**：

| 输入 | 改前 `B_t` | 改前 `B_y` | 改后 `B_t` | 改后 `B_y` |
|---|---|---|---|---|
| 缺 `tooth_width` | `null`（实为 Infinity） | 2.009 | **0.972** | 2.407 |
| 给派生值 7.42 | 0.972 | 2.407 | 0.972 | 2.407 |

（改后"缺失"与"显式给派生值"结果**完全一致**，回退口径正确。）

### l0 侧改造

- `At`、`carterFactor` 由原 `toothWidth` 改为 `twEff`
- 新增"齿宽不足"短路（几何齐全但齿宽无法派生时不产出 Infinity）
- 返回体新增 `tooth_width: { effective_mm, base_mm, k_shape, source }` 供口径溯源
- 生产两处调用（shadow / on\|exclusive）透传 `row.slot_shape`、`row.tooth_k_shape`、`row.tooth_width_top/root`（行内无 ⇒ `undefined` ⇒ 默认 1.0，零回归）

---

## 2. 验收结果（全部通过）

| 项 | 内容 | 结果 |
|---|---|---|
| ① 单元 | 五条取值通道（显式/env/齿形尺寸/查表/默认） | ✅ |
| ② A 回退 | 缺齿宽 ⇒ `B_t=0.972T` 有限正值，`source=derived_0.5pitch` | ✅ |
| ③ 零回归 | 齿宽 7.42 / 3.92 / 6.12 时 `At` 与 `k_shape` 与改前**完全一致** | ✅ |
| ④ 真机归一 | 见下表 | ✅ |
| ⑤ 反向破坏 | 显式 `kShape=1` ≡ 默认；几何不足先短路不产出 Infinity | ✅ |

### ④ 真机域归一

| 机型 | 真值 Bt | `k=1.0` 时 K | `k=1.352` 时 K | 该机 `k_fit` |
|---|---|---|---|---|
| Y160L-4 | 1.39767 T | 1.319（+31.9%） | **1.000（0.0%）** | 1.353 |
| Y180M-4 | 1.42464 T | 1.363（+36.3%） | 1.051（+5.1%） | 1.426 |

### 零回归（71 台类比设计重跑）

| 指标 | 改前 | 改后 |
|---|---|---|
| `K_TOOTH_EFF` 均值 / 中位 | 0.9910 / 0.9405 | **0.9910 / 0.9405** |
| MAPE / MAE / R² | 9.9% / 0.090T / 0.229 | **9.9% / 0.090T / 0.229** |
| 分家族 K | 0.950 / 0.915 / 0.979 / 1.035 | **全同** |

> CV R² 0.196 → 0.208 属 k 折洗牌随机噪声（其余指标逐位相同）。

---

## 3. 🔴 诚实边界：单一 k 仍不适用

两台真机 `k_fit` = **1.353 vs 1.426**，离散 **5.3%**；类比设计域全体 K 的 CV 更是 **18.2%**。

⇒ **与类比设计域结论同构：单一 `k_shape` 不能普适**。因此：

- **`TOOTH_EFF_K_SHAPE_DEFAULT` 仍为 1.0，未启用任何缩放**（不外推铁律）
- 真机实测 1.352 仅作为**文档化实测值**与可选通道，不进默认路径
- 启用方式：显式传 `kShape`，或 `env DSH_L0_TOOTH_K_SHAPE=1.352`

**要真正定标，需补 ≥30 台真机**（含真实齿宽 / 齿顶宽 / 齿根宽 / 槽形 Bs0-Bs2-Hs），届时 `toothShapeK()` 可直接吃齿顶/齿根宽算出 `k`，无需拟合。

---

## 4. 与协作方报告 P0-b 的关系

报告建议"统一口径，写死最小截面"。本实现**不是**写死最小截面，而是：

- **保留**最小截面齿宽作为输入（`toothWidth`）
- **显式换算**为磁路等效宽（`toothShapeK`），并把 `source` / `k_shape` 写进输出供审计

这既消除了"两引擎面积划分约定不一致"，又不丢失物理信息 —— 比写死最小截面更可追溯。

---

## 5. 产物

| 文件 | 说明 |
|---|---|
| `dev-calib/verify_ac_tooth.mjs` | A+C 验收（5 组，含反向破坏） |
| `output/p2_tooth_ac_impl_report.md` | 本报告 |
| core `lib/motor-constants.mjs` | `effectiveToothWidth` / `toothShapeK` / 常量 |
| core `index.mjs` | 新增 5 个导出 |
| l0 `tools/l0/analytic-engine.mjs` | `doSaturationLoop` 吃等效齿宽 + 溯源输出 |

## 6. 下一步

1. **补 ≥30 台真机**（真实齿宽/齿顶宽/齿根宽/槽形）→ 用 `toothShapeK()` 定标 `k`，可考虑把默认值从 1.0 改为标定值
2. **By 仍不可用**（类比设计轭厚过薄，重跑 By 中位 1.755T、9 行 >2.0T）⇒ 需另一轮真值
3. 若需发布：core bump + l0 bump 0.6.5（当前 l0 仍 0.6.4，本次代码改动未发 npm）

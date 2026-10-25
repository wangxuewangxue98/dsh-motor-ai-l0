# 变频驱动建模（M1~M7）+ IP67（S1~S8）实施报告

> 机型：通风机异步电机 450kW / 690V / **变频驱动** / 985rpm / 6 极 / 风扇冷却 / **IP67** / H 级 / η≥92%
> 插件：`dsh-motor-ai-l0@0.6.8`（本次新增）+ `core@1.5.2`
> 依据：附件《变频驱动建模详细方案 M1~M7》《MD-SDE 评分体系问题·变频建模·IP67 三合一报告》
> 性质：**additive 新开关（`vfd` / `ip67` 默认 OFF），默认路径逐字节零回归**

---

## 1. 缺口与结论先行

### 1.1 实证缺口

`0.6.7 + core@1.5.2` **无任何 VFD 参数**（grep `vfd|inverter|drive|变频` 于 `param-schema.mjs` / `pipeline.mjs` 无命中）⇒ L0 全程按 **50Hz 理想正弦**计算。

> **既有报告的温升是正弦工况值，不是变频实机值。**

### 1.2 本次交付

| 层 | 内容 |
|---|---|
| 新模块 | `tools/l0/vfd-ip67-model.mjs`（纯函数，零依赖；仅复用 core 的 `INSULATION_LIMITS`） |
| 接线 | `l0-estimate` / `pipeline` 新增 `vfd` / `ip67` / `vfd_measures` 参数；排序白名单增 3 个 `*_vfd` 键；pipeline 顶层回紧凑摘要 + 告警并入 `warnings` |
| 门禁 | `scripts/verify_vfd_ip67.mjs`（**102/102**） |
| 断点 | `dev-calib/_break_vfd_ip67.py`（**五场景双路变红 + 恢复回绿**） |

**⚠ 双口径纪律（复用齿磁密事故教训）**：本模块**只新增字段，绝不覆写** `temp_rise` / `total_loss` / `efficiency`。门禁 J3/J4 实证「无既有字段被删除、无既有字段被改写」。

---

## 2. 建模范围：算什么、不算什么

诚实边界是本次设计的核心。模块内 `limits.modeled` / `passthrough` / `not_modeled` 三清单强制区分：

| 类别 | 项 | 处理 |
|---|---|---|
| **可算（l0 有物理模型）** | M1 谐波损耗、M2 附加温升、M3 低速冷却衰减、效率重推 | 计算 + 同口径自证 |
| **必须外部给（无模型可算）** | M4 绝缘 dv/dt、M5 轴承电蚀、M6 EMC/接地、M7 控制适配 | **只透传声明值 + 阈值判定 + 溯源标记，缺值进 gaps，绝不填占位值** |
| **明确未建模** | 集肤/趋肤效应、载波频率对 k_h 的影响、局部放电寿命模型、轴电流产生机理 | 列在 `not_modeled`，不假装已实现 |

> 载波频率说明：k_h 表**不随 `carrier_khz` 变化**，因为缺少标定依据。这是**保守处理**（记录 `carrier_khz` 但不调 k_h），非遗漏。

---

## 3. M1 谐波损耗系数 k_h

### 3.1 反解口径

| 滤波器 | k_h 区间 | 说明 |
|---|---|---|
| `none` 无滤波（长电缆） | 0.15 ~ 0.20 | 最保守档 |
| `dvdt` dv/dt 滤波器 | 0.08 ~ 0.12 | |
| `sine` 正弦波滤波器 | ≤ 0.05 | |

电缆长度在 **[50m, 300m]** 内线性插值；**未给 `cable_m` ⇒ 取 0.5 分位**（中位，保守）。
显式 `vfd.k_h` 优先覆盖（`source='explicit_override'`）；钳 **[0, 0.30]**。

**保守回落原则**：未给 `filter` 或取值非法 ⇒ **按最差档 `none` 反解并告警**（`VFD_FILTER_UNSPECIFIED` / `VFD_FILTER_UNKNOWN`），**绝不静默按 0 算**。

### 3.2 计损基数（`kh_basis`）

| 口径 | 定义 | 说明 |
|---|---|---|
| `total`（默认） | ΔP_h = k_h × P_loss（含机械耗） | 附件 M1 原口径 |
| `electromagnetic` | ΔP_h = k_h ×（铜耗+铁耗） | 谐波属电磁损耗，物理更严 |

两者均暴露，由调用方选，**不静默改口径**。

---

## 4. M2 / M3 温升

**M2**：`ΔT_vfd = ΔT_sine × (1 + k_h)`（ΔT ∝ P_loss，热阻不变）。

**M3 低速冷却衰减**：

| `fan` | 处理 |
|---|---|
| `independent` 独立风机 | `derate = 1`，无衰减 |
| `self` 同轴自扇 | `q = n_min/n_rated`，`derate = 1/q` |
| **未澄清** | **`derate = null` + `VFD_FAN_UNSPECIFIED` 告警，不给数值** |

> 未澄清风机型式（附件 P0-1）时**不臆造系数**——这是本模块最重要的一条"不出数"边界。

**极端值保护**：低速外推温升 > 绝缘限值 1.5× ⇒ `VFD_LOW_SPEED_TEMP_EXTREME` 告警。**不钳位**（钳位即编造），而是在 `low_speed_note` 说明：Q∝n 线性外推在极低转速比下严重高估，结论应读作「该转速下同轴自扇**不可行**」而非具体数值。

---

## 5. 450kW 第一方实测（count=1000，无滤波 + 200m 电缆 ⇒ k_h=0.18）

### 5.1 Top5（效率序）正弦 vs 变频

| 方案 | Δθ 正弦 | Δθ 变频 | 低速(300rpm) | η 正弦→变频 | H 级余量 |
|---|---|---|---|---|---|
| OD738 / L487 / 6P | 98.2K | **115.9K** | 380.5K⚠ | 94.51% → 93.59% | **+9.1K** |
| OD749 / L480 / 6P | 97.7K | 115.3K | 378.5K⚠ | 94.49% → 93.56% | +9.7K |
| OD761 / L473 / 6P | 97.2K | 114.7K | 376.6K⚠ | 94.47% → 93.54% | +10.3K |
| **OD753 / L487 / 4P** | 107.4K | **126.7K** | 416K⚠ | 94.46% → 93.53% | **−1.7K 越限** |
| OD773 / L466 / 6P | 96.6K | 114.0K | 374.3K⚠ | 94.46% → 93.53% | +11.0K |

Top1 损耗拆分：铜耗 11773W / 铁耗 6422W / 机械耗 3211W；总损 **21406W → 25259W（+18%）**。

### 5.2 k_h 灵敏度（复现附件 §四结论）

| 温升倍率 (1+k_h) | Δθ | MD-SDE TH 档（advisory） | 越限 |
|---|---|---|---|
| 1.00（理想正弦） | 98.2K | **0.500 (3/6)** | −26.8K |
| 1.05 | 103.1K | **0.333 (2/6)** | −21.9K |
| 1.10 | 108.0K | 0.333 (2/6) | −17.0K |
| 1.15 | 112.9K | **0.167 (1/6)** | −12.1K |
| 1.20 | 117.8K | 0.167 (1/6) | −7.2K |

**与附件结论一致**：TH 优势在倍率 **≥1.05 即消失**（0.5→0.333）。
⚠ TH 阈值属 **MD-SDE（daoyi）外部口径**，仅 `th_band_lookup=true` 时输出，标记 advisory，**不进 L0 判据、不影响 verdict**。

### 5.3 四项降损措施（`vfd_measures=true`，目标 110K）

基线：正弦 98.2K / 变频 115.9K

| 措施 | 温升 | Δ vs 变频基线 | 达标 |
|---|---|---|---|
| ① dv/dt 滤波器 | 108.4K | −7.5K | ✔ |
| ① 正弦波滤波器 | 101.1K | −14.7K | ✔ |
| ② 独立风机 / 加大风量（×1.25） | **92.7K** | −23.2K | ✔ |
| ③ 加大机座/铁心（L×1.15、OD×1.05，重估） | 103.4K | −12.5K | ✔ |
| ④ 低损耗硅钢（铁耗 −20%） | 108.9K | −7.0K | ✔ |

建议：**② 独立轴流风机**单项最优（92.7K）。注意 ③ 为几何变更，须重跑矩阵验证磁密/槽满率/转矩不越界。
> 措施 ③ 若无重估函数 ⇒ 标 `needs_reestimate: true` 且 **`temp_rise_after` 为 null**（不套用臆造缩放系数）。

---

## 6. M4~M7 → EC 域可喂入项

**只透传声明值**（`source='declared'`）+ 阈值判定；缺值一律进 `gaps` 并标明 `required_input`。

本次实测（声明 10 项 / 派生 1 项 / 缺口 0）：

| 检查点 | 值 | 判据 | pass |
|---|---|---|---|
| `_m4_reflection_overshoot_v`（派生基准） | 1864 V = 2×U_dc | ref | null |
| EC040301 绝缘配合裕度 | 1.8 | ≥1.5 | ✔ |
| EC040501 浪涌耐受 | 1.5 | ≥1.3 | ✔ |
| CM050101 绝缘寿命 | 15 年 | ≥10 | ✔ |
| EC050601 轴电流 | 0.18 A | ≤0.3 | ✔ |
| EC050101 EMC 发射余量 | 8 dB | ≥6 | ✔ |
| EC050201 抗扰度 | 3 级 | ≥3 | ✔ |
| EC020101 控制方式 | vector | ref | ✔ |
| EC020301 弱磁扩速 | 1.8 | ≥1.5 | ✔ |
| EC020201 转矩带宽 | 60 Hz | ≥50 | ✔ |
| EC010601 死区时间 | 1.5 μs | ∈[0.5,3] | ✔ |

**反编造两条硬约束**（门禁 H6/H12 守护，反向破坏场景 5 实证）：
1. 无声明 ⇒ `declared_n = 0`，**不填占位值**；
2. 只声明轴承型式（`bearing:'insulated'`）而无实测轴电流 ⇒ `EC050601` **不出现在 feed**，另记 `_m5_bearing_mitigation` 参考项（`pass=null`）。
   —— 喂布尔会被引擎 `norm_threshold` 分层放大成假象（L3 §3.6 实证）。

派生项（如 2×U_dc）单独计数 `derived_n`，**不计入"已声明证据数"**，防止「已有 1 项证据」的误判导致该 abstain 时误喂。

---

## 7. IP67 S1~S8

标准：IEC 60034-5 / GB/T 4942.1（IP6X 尘密 + IPX7：1m/30min）。属**结构详细设计**，L0 电磁-热模型不覆盖（MD-SDE ME 域 abstain）。

| # | 部位 | 声明字段 | 可喂入 | 落点 |
|---|---|---|---|---|
| S1 | 机壳接合面 | `joint_seal` | — | ME（待补） |
| S2 | 轴伸密封 | `shaft_seal` | 需 EC050601 通过 | CM050601 电蚀寿命 |
| S3 | 接线盒 | `terminal_box_gland` | — | ME（待补） |
| S4 | 引出线 | `lead_capillary_blocked` + `insulation_life_years` | ✔ | CM050101 |
| S5 | 凝露/呼吸 | `breather` | ✔ | CM060101 / CM060601 |
| S6 | 防腐涂层 | `coating` (C3/C4/C5) | ✔ | CM060501 |
| S7 | 与变频交互 | **`vfd.bearing` + `vfd.shaft_current_a`** | 需实测达标 | EC050601 |
| S8 | 试验验证 | `tests{ip6x,ipx7,insulation_retest,thermal_cycle}` | — | 闭环判据 |

本次实测：声明 **8/8**、缺口 0、verified=true、可喂入 **5 项**（CM050601 / CM050101 / CM060101 / CM060601 / CM060501）。

**三项实现要点**：
1. 涂层取值**大小写不敏感**（`C5` / `c5` 均识别；`C7` 判 gap）——否则 `C5` 会被静默判成未声明；
2. **S7 的抑制措施声明在 `vfd` 侧**（`vfd.bearing`），不在 `ip67` 对象里——跨块取值由门禁 I4b 双路断言守护（反向破坏场景 4 实证）；
3. 仅声明措施无实测轴电流 ⇒ 单列 `mitigation_only`，**仍计缺口**。

**⚠ 喂入风险（`ip67_model.feed_risk`）**：CM 域在场即参与均分，同域其他检查点诚实值不达标时喂入会**拉低** F（实测 bridged 全量 0.393 vs evidence-only 0.706）。**仅当该域全部检查点达标时才喂入，否则宁可 abstain。**

---

## 8. 使用方式

```js
// motor_l0_pipeline（推荐入口）
runL0Pipeline({
  power_kw: 450, speed_rpm: 985, voltage_v: 690, poles: 6,
  cooling: 'forced_air', insulation_class: 'H', motor_type: 'induction',
  count: 1000,
  vfd: { filter: 'none', cable_m: 200, fan: 'self', min_speed_rpm: 300,
         shaft_current_a: 0.18, bearing: 'insulated', /* M4~M7 声明值 */ },
  ip67: { joint_seal: 'o_ring_fkm', coating: 'C5', /* S1~S8 */ },
  vfd_measures: true,          // 四项降损措施评估
  sort_by: 'temp_rise_vfd',    // 按变频口径排序（可选）
})
```

开关：`vfd` / `ip67` 对象即开启；env `DSH_L0_VFD=1` / `DSH_L0_IP67=1`；显式 `enabled:false` **胜出** env。

**读数字段对照**（防双口径误读）：

| 口径 | 温升 | 总损 | 效率 |
|---|---|---|---|
| 正弦（50Hz 理想） | `temp_rise` | `total_loss` | `efficiency` / `efficiency_raw` |
| **变频修正** | **`temp_rise_vfd`** | **`total_loss_vfd`** | **`efficiency_vfd_raw`** |
| 变频 + 低速最恶劣 | `temp_rise_vfd_min_speed` | — | — |

---

## 9. 验证

| 项 | 结果 |
|---|---|
| `scripts/verify_vfd_ip67.mjs` | **102 / 102** |
| 反向破坏（默认改 ON / 拆 M2 / 拆大小写 / 拆 S7 取值 / 允许编造） | **五场景双路变红 + 恢复回绿** |
| `l0 verify` 全量 | **135 / 135** |
| `verify_tw_axis` / `verify_bg_bins_calib` | 40/40 / 22/22 |
| core tests / 真值门禁 | 26/26 / 18/18 |

门禁分组：A 静态锚点(9) / B 解析器(9) / C k_h(10) / D 温升损耗效率(8) / E 低速冷却(5) / F 扫描+TH(8) / G 四项措施(6) / H EC 可喂入(12) / I IP67(12) / **J 零回归(7)** / K env+opts 双通道(5) / L pipeline 集成(9)。

### 反向破坏中抓到的真实门禁缺口（值得记录）

场景 4 首次**未变红**：`def.fromVfd ? vfdSpec[def.key] : ip67[def.key]` 改成只从 `ip67` 取值后行为不变——因为后续轴电流判定把 `status` 覆盖了，S7 的**取值路径实际未被断言**（正是记忆里「返回串声称但体内无断言」的翻版）。已补 I4b（仅声明措施无实测 ⇒ `mitigation_only`），破坏后如期变红。

---

## 10. 诚实边界与后续

1. **未建模**：集肤/趋肤效应、载波频率对 k_h 的影响、局部放电寿命模型、轴电流产生机理（模块内 `limits.not_modeled` 已列）；
2. **温升本身是热负荷法代理值**（core V12 同口径标注），变频修正建立在其上 ⇒ 结论为量级判断，须过 L1/L2 热模型才算数；
3. **k_h 分档是工程经验值**，非本机标定所得；
4. **TH 6 档是 MD-SDE 外部口径**，仅 advisory；
5. **P0-1 仍未澄清**：`fan` 是同轴自扇还是独立风机——未澄清前低速段温升**不可算**（模块按此设计，不臆造）；
6. 后续可取：`carrier_khz` 对 k_h 的标定（需变频器实测数据）、`airflow_gain` 按风机型谱实配、措施③与矩阵的联动重跑。

---

## 11. 文件清单

| 文件 | 说明 |
|---|---|
| `tools/l0/vfd-ip67-model.mjs` | 新建：变频 + IP67 建模（纯函数） |
| `tools/l0/l0-estimate.mjs` | 接线：参数声明 + 排序键 + 三通道施加 |
| `tools/l0/pipeline.mjs` | 接线：参数声明 + 透传 + 顶层摘要 + 告警 |
| `scripts/verify_vfd_ip67.mjs` | 新建：102 项门禁 |
| `dev-calib/_break_vfd_ip67.py` | 新建：反向破坏五场景 |
| `dev-calib/_smoke_vfd_ip67.mjs`、`_probe_vfd_ip67_evidence.mjs` | 本地冒烟与取证探针 |
| `CHANGELOG.md` / `package.json` / `SKILL.md` | 0.6.8 三重一致性 |

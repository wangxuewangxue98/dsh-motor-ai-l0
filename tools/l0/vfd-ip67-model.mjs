/**
 * v0.6.8 P2：变频驱动建模（M1~M7）+ IP67 结构技术点（S1~S8）
 * ===========================================================================
 * 存在理由（缺口实证）：
 *   `dsh-motor-ai-l0@0.6.7 + core@1.5.2` **无任何 VFD 参数**（grep `vfd|inverter|drive|变频`
 *   于 param-schema.mjs / pipeline.mjs 无命中）⇒ L0 全程按 **50Hz 理想正弦**计算。
 *   因此既有报告的温升是**正弦工况值，不是变频实机值**——变频附加谐波损耗会把
 *   温升整体抬高（附件实测 k_h=0.05 即 101.8K→107.0K）。
 *
 * 本模块是 l0 侧的**后处理建模层**（不动 core 公式引擎、不改既有字段），
 * 且**默认 OFF**（零回归）。开启后：
 *   - 计算能算的：M1 谐波损耗、M2 附加温升、M3 低速冷却衰减、
 *                 效率重推、k_h 灵敏度扫描、四项降损措施评估；
 *   - 透传必须外部给的：M4 绝缘 dv/dt、M5 轴承电蚀、M6 EMC/接地、M7 控制适配
 *     —— 这些是**变频器/绝缘/轴承/EMC 厂家数据**，L0 无物理模型可算，
 *     故只做「声明值 + 阈值判定 + 溯源标记」，**绝不凭空编造数值**。
 *
 * ⚠ 双口径纪律（复用齿磁密事故教训）：
 *   本模块**不覆写** temp_rise / total_loss / efficiency 等既有字段，
 *   一律产出 `*_vfd` 新字段。调用方若误读旧字段，看到的是正弦工况值。
 *
 * ⚠ 阈值溯源：
 *   k_h 分档与各项阈值来自附件《变频驱动建模详细方案 M1~M7》与《IP67 结构技术点
 *   S1~S8》，属**工程经验值/标准条款值**，非本机标定所得；每项均带 `source` 标记。
 *   TH 6 档阈值属 **MD-SDE（daoyi）侧口径**，仅作 advisory 输出，不进 L0 判据。
 *
 * 纯函数：零依赖（除 core 的 INSULATION_LIMITS 常量），可单测。
 */

import { INSULATION_LIMITS } from '@wangxue98/dsh-motor-ai-core'

export const VFD_MODULE_VERSION = '0.6.8'

/** env 开关名（与 tw_axis 同风格） */
export const ENV_VFD = 'DSH_L0_VFD'
export const ENV_IP67 = 'DSH_L0_IP67'

/** 与 core formula-engine ENV_ON 同口径（未设→默认；'0'/'false'/'off'→关；其余→开） */
const envOnLocal = (v, dflt = false) => (v === undefined || v === ''
  ? dflt
  : !(v === '0' || String(v).toLowerCase() === 'false' || String(v).toLowerCase() === 'off'))
const truthy = (v) => !(v === false || v === '0' || v === '' || v == null
  || String(v).toLowerCase() === 'false' || String(v).toLowerCase() === 'off')

// ---------------------------------------------------------------------------
// M1：谐波损耗系数 k_h
// ---------------------------------------------------------------------------

/**
 * k_h 分档（附件 M1）：
 *   none  无滤波（长电缆）  0.15~0.20
 *   dvdt  带 dv/dt 滤波器   0.08~0.12
 *   sine  正弦波滤波器      ≤0.05
 * 电缆长度在 [50m, 300m] 内线性插值；未给电缆长度取 0.5 分位（中位，保守）。
 */
export const KH_TABLE = {
  none: [0.15, 0.20],
  dvdt: [0.08, 0.12],
  sine: [0.00, 0.05],
}
export const KH_FILTER_LABEL = {
  none: '无滤波（长电缆）',
  dvdt: 'dv/dt 滤波器',
  sine: '正弦波滤波器',
}
export const CABLE_REF_M = [50, 300]
/** k_h 物理钳位（防负值/荒谬值） */
export const KH_CLAMP = [0, 0.30]

// ---------------------------------------------------------------------------
// 默认口径（用户 2026-10-26 明确答复，写死为常量以便门禁断言）
// ---------------------------------------------------------------------------

/** 载波频率默认值 3kHz（用户口径：变频电机按 3kHz 计） */
export const CARRIER_DEFAULT_KHZ = 3000
/**
 * 载波频率合理区间（**只告警、不钳位** —— 钳位等于用臆造边界改写用户数据）。
 * 常见低压变频器 2~16kHz，故取 1~20kHz 作"值得提示"的边界。
 */
export const CARRIER_SANITY_KHZ = [1000, 20000]
/**
 * 风机型式默认值：**独立风机**（用户口径 2026-10-26「变频电机默认按独立风机」）。
 * ⚠ 此前 P0-1 未澄清时本模块**不出数**（derate=null + 告警）；口径澄清后改为默认值，
 *   但仍须显式标记 `fan_source='default'` + 告警，防止"默认值被当成实测声明"误喂。
 */
export const FAN_DEFAULT = 'independent'
export const FAN_ALLOWED = ['self', 'independent']

/**
 * vfd 默认口径归一化（载波频率 + 风机型式）
 * 纪律：**默认值必须自带 source 标记与告警**，绝不静默冒充声明值。
 * @param {object} vfd
 * @returns {{carrier_khz:number, carrier_source:'declared'|'default',
 *            fan:'self'|'independent', fan_source:'declared'|'default', warnings:string[]}}
 */
export function vfdDefaults(vfd = {}) {
  const warnings = []

  // ---- 载波频率 ----
  const rawC = vfd?.carrier_khz
  const nC = Number(rawC)
  let carrier = CARRIER_DEFAULT_KHZ
  let carrierSource = 'default'
  if (rawC !== undefined && rawC !== null && rawC !== '') {
    if (Number.isFinite(nC) && nC > 0) {
      carrier = nC
      carrierSource = 'declared'
      if (nC < CARRIER_SANITY_KHZ[0] || nC > CARRIER_SANITY_KHZ[1]) {
        warnings.push('VFD_CARRIER_OUT_OF_RANGE')
      }
    } else {
      warnings.push('VFD_CARRIER_INVALID')
    }
  } else {
    warnings.push('VFD_CARRIER_DEFAULTED')
  }

  // ---- 风机型式（去空格 + 大小写不敏感；非法取值回落默认并告警，不静默放过）----
  const rawFan = String(vfd?.fan ?? '').trim().toLowerCase()
  let fan = FAN_DEFAULT
  let fanSource = 'default'
  if (FAN_ALLOWED.includes(rawFan)) {
    fan = rawFan
    fanSource = 'declared'
  } else if (rawFan) {
    warnings.push('VFD_FAN_UNKNOWN')
  } else {
    warnings.push('VFD_FAN_DEFAULTED')
  }

  return {
    carrier_khz: carrier,
    carrier_source: carrierSource,
    fan,
    fan_source: fanSource,
    warnings,
  }
}

/**
 * 电缆长度分位（0~1）：<50m→0，>300m→1，未知→0.5
 * @param {number|undefined} cableM
 * @returns {number}
 */
export function cableQuantile(cableM) {
  const v = Number(cableM)
  if (!Number.isFinite(v)) return 0.5
  const [lo, hi] = CABLE_REF_M
  return Math.min(1, Math.max(0, (v - lo) / (hi - lo)))
}

/**
 * 反解 k_h
 * @param {object} vfd 已归一化的 vfd spec
 * @returns {{k_h:number, source:string, filter:string, cable_quantile:number|null, label:string, warnings:string[], note:string}}
 */
export function deriveKh(vfd = {}) {
  const warnings = []
  const explicit = Number(vfd.k_h)
  if (Number.isFinite(explicit)) {
    const k = Math.min(KH_CLAMP[1], Math.max(KH_CLAMP[0], explicit))
    if (k !== explicit) warnings.push('VFD_KH_CLAMPED')
    return {
      k_h: Math.round(k * 10000) / 10000,
      source: 'explicit_override',
      filter: String(vfd.filter ?? '').toLowerCase() || null,
      cable_quantile: null,
      label: '显式给定',
      warnings,
      note: `k_h 由 vfd.k_h 显式指定（${explicit}），滤波器/电缆仅作记录，不参与反解。`,
    }
  }
  const rawFilter = String(vfd.filter ?? '').toLowerCase()
  let filter = rawFilter
  if (!KH_TABLE[filter]) {
    filter = 'none'
    if (rawFilter) warnings.push('VFD_FILTER_UNKNOWN')
    else warnings.push('VFD_FILTER_UNSPECIFIED')
  }
  const band = KH_TABLE[filter]
  const cableKnown = Number.isFinite(Number(vfd.cable_m))
  if (!cableKnown) warnings.push('VFD_CABLE_LENGTH_UNSPECIFIED')
  const q = cableQuantile(vfd.cable_m)
  const k = band[0] + (band[1] - band[0]) * q
  const note = (rawFilter && !KH_TABLE[rawFilter])
    ? `未知滤波器 "${rawFilter}" —— 按最保守档 none(${KH_FILTER_LABEL.none}) 反解，请核对 vfd.filter 取值（none/dvdt/sine）。`
    : (!rawFilter
      ? '未给 vfd.filter —— 按最保守档 none（无滤波长电缆）反解。若已配置滤波器请显式传入，否则温升评估偏保守。'
      : `按 ${KH_FILTER_LABEL[filter]} 档 + 电缆长度分位 ${q.toFixed(2)} 插值。`)
  return {
    k_h: Math.round(k * 10000) / 10000,
    source: 'filter_table',
    filter,
    cable_quantile: cableKnown ? Math.round(q * 1000) / 1000 : null,
    label: KH_FILTER_LABEL[filter],
    warnings,
    note,
  }
}

// ---------------------------------------------------------------------------
// M3：低速冷却衰减
// ---------------------------------------------------------------------------

/**
 * 冷却模型（附件 M3）：同轴自扇时 Q ∝ n ⇒ 散热随转速下降；独立风机无衰减。
 * 风机型式未声明时按用户口径 **默认独立风机**（`fan_source='default'` + 告警），
 * ⚠ 变更史：此前 P0-1 未澄清 ⇒ derate=null 不出数；2026-10-26 用户明确「变频电机默认
 *   独立风机」后改为默认值。默认值**必须带 source 与告警**，防被误当实测声明。
 * @param {object} vfd
 * @param {object} row 参数行（取 speed_rpm 作额定转速）
 */
export function coolingModel(vfd = {}, row = {}) {
  const d = vfdDefaults(vfd)
  const fan = d.fan
  const fanWarn = d.warnings.filter((w) => w === 'VFD_FAN_UNKNOWN' || w === 'VFD_FAN_DEFAULTED')
  const rated = Number(vfd.rated_speed_rpm ?? row?.speed_rpm)
  const min = Number(vfd.min_speed_rpm)

  if (fan === 'independent') {
    return {
      fan: 'independent', fan_source: d.fan_source,
      speed_ratio: null, q_factor: 1, derate: 1,
      warnings: fanWarn,
      note: d.fan_source === 'default'
        ? 'vfd.fan 未声明 ⇒ 按用户口径「变频电机默认独立风机」取 independent（风量与转速解耦，'
          + '低速段无冷却衰减）。⚠ 若实机为同轴自扇，须显式传 vfd.fan="self"，否则会**低估**低速温升。'
        : '独立轴流风机：风量与转速解耦，低速段无冷却衰减。',
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(rated) || rated <= 0) {
    return {
      fan: 'self', fan_source: d.fan_source,
      speed_ratio: null, q_factor: null, derate: null,
      warnings: [...fanWarn, 'VFD_MIN_SPEED_MISSING'],
      note: '同轴自扇已确认，但缺 vfd.min_speed_rpm（或无法取到额定转速）⇒ 低速衰减量不可算。',
    }
  }
  const ratio = Math.min(1, Math.max(0.05, min / rated))
  return {
    fan: 'self',
    fan_source: d.fan_source,
    speed_ratio: Math.round(ratio * 1000) / 1000,
    q_factor: Math.round(ratio * 1000) / 1000,
    derate: Math.round((1 / ratio) * 1000) / 1000,
    warnings: fanWarn,
    note: `同轴自扇：最低运行转速/额定 = ${ratio.toFixed(3)} ⇒ 风量比 ${ratio.toFixed(3)} ⇒ 温升放大 ${(1 / ratio).toFixed(2)}×（ΔT ∝ 1/Q）。`,
  }
}

// ---------------------------------------------------------------------------
// 损耗/温升/效率重推
// ---------------------------------------------------------------------------

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10)
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100)
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000)

/**
 * 给定 k_h 与损耗缩放后的总损耗
 * @param {number} kh 谐波损耗系数
 * @param {number} cu 铜耗 W
 * @param {number} fe 铁耗 W
 * @param {number} mech 机械耗 W
 * @param {'total'|'electromagnetic'} basis 谐波附加损耗的**计损基数口径**
 *   'total'（默认，附件 M1 口径 ΔP_h ≈ k_h × P_loss 全损）
 *   'electromagnetic'（仅电磁损耗：谐波损耗不作用于机械耗，物理更严）
 * @param {number} steelScale 铁耗缩放（1=不变；0.8=低损耗硅钢降 20%）
 * @param {number} copperScale 铜耗缩放
 */
export function totalLossUnder(kh, cu, fe, mech, basis = 'total', steelScale = 1, copperScale = 1) {
  const cu2 = cu * copperScale
  const fe2 = fe * steelScale
  const base = basis === 'electromagnetic' ? (cu2 + fe2) : (cu2 + fe2 + mech)
  return cu2 + fe2 + mech + kh * base
}

/**
 * 由效率与总损耗反推输出功率 P_out（W）
 * η = P_out / (P_out + P_loss) ⇒ P_out = P_loss · η/(1−η)
 * @param {object} estimate
 * @param {object} row
 * @returns {number|null}
 */
export function deriveOutputPower(estimate, row = {}) {
  const effPct = num(estimate?.efficiency_raw ?? estimate?.efficiency)
  const loss = num(estimate?.total_loss)
  if (effPct != null && loss != null && effPct > 0 && effPct < 100) {
    const e = effPct / 100
    return loss * e / (1 - e)
  }
  const kw = num(row?.power_kw)
  return kw != null ? kw * 1000 : null
}

// ---------------------------------------------------------------------------
// M1~M3 主模型
// ---------------------------------------------------------------------------

/**
 * 对单行 L0 估算结果施加变频建模
 * @param {object} estimate quickL0Estimate 结果（单行）
 * @param {object} row 对应参数行
 * @param {object} vfd 已归一化 vfd spec
 * @param {object} [opts] { include_th_band }
 * @returns {object} vfd_model
 */
export function applyVfdModel(estimate, row = {}, vfd = {}, opts = {}) {
  const warnings = []
  const tSine = num(estimate?.temp_rise)
  const cu = num(estimate?.copper_loss)
  const fe = num(estimate?.iron_loss)
  const mech = num(estimate?.mechanical_loss)
  const totalSine = num(estimate?.total_loss)
  const hasLoss = cu != null || fe != null || mech != null

  const khInfo = deriveKh(vfd)
  warnings.push(...khInfo.warnings)

  // 默认口径（载波频率 / 风机型式）—— 默认值一律带 source + 告警，不静默冒充声明值
  const dflt = vfdDefaults(vfd)
  warnings.push(...dflt.warnings)

  const basis = vfd.kh_basis === 'electromagnetic' ? 'electromagnetic' : 'total'
  const lossSine = totalLossUnder(0, cu ?? 0, fe ?? 0, mech ?? 0, basis)
  const lossVfd = totalLossUnder(khInfo.k_h, cu ?? 0, fe ?? 0, mech ?? 0, basis)
  const deltaLoss = hasLoss ? r1(lossVfd - lossSine) : null
  const ratio = lossSine > 0 ? lossVfd / lossSine : (1 + khInfo.k_h)

  const tVfd = tSine != null ? r1(tSine * ratio) : null

  // ---- 温升限值（与 core INSULATION_LIMITS 同源；必须先于低速衰减判定求值）----
  const insClass = String(
    estimate?.insulation_class_effective ?? row?.insulation_class ?? 'F'
  ).toUpperCase()
  const limit = INSULATION_LIMITS[insClass] ?? null

  const cool = coolingModel(vfd, row)
  warnings.push(...cool.warnings)
  const tVfdMin = (tVfd != null && cool.derate != null) ? r1(tVfd * cool.derate) : null
  // 低速段 Q∝n 为**线性外推**：转速比很低时会算出远超任何绝缘等级的荒谬温升。
  // 不做钳位（那才是编造），而是显式告警 + 说明模型边界：实机在该转速必然已改独立风机。
  const lowSpeedExtreme = (tVfdMin != null && limit != null && tVfdMin > limit * 1.5)
  if (lowSpeedExtreme) warnings.push('VFD_LOW_SPEED_TEMP_EXTREME')

  const pOut = deriveOutputPower(estimate, row)
  const effSine = num(estimate?.efficiency_raw ?? estimate?.efficiency)
  const effVfd = (pOut != null && lossVfd > 0) ? r2(pOut / (pOut + lossVfd) * 100) : null

  const overLimit = (tVfd != null && limit != null) ? r1(tVfd - limit) : null
  if (overLimit != null && overLimit > 0) warnings.push('VFD_TEMP_OVER_LIMIT')

  // ---- k_h 灵敏度扫描（附件 §四）----
  const scan = khScan(estimate, row, vfd, opts)

  const model = {
    active: true,
    version: VFD_MODULE_VERSION,
    /** M1 谐波损耗系数 */
    k_h: khInfo.k_h,
    k_h_source: khInfo.source,
    k_h_filter: khInfo.filter,
    k_h_filter_label: khInfo.label,
    k_h_cable_quantile: khInfo.cable_quantile,
    k_h_note: khInfo.note,
    /** 载波频率（默认 3kHz；**k_h 不随其变化** —— 无标定依据，保守处理） */
    carrier: {
      khz: dflt.carrier_khz,
      source: dflt.carrier_source,
      sanity_range_hz: CARRIER_SANITY_KHZ.map((v) => v),
      note: dflt.carrier_source === 'declared'
        ? `载波频率 ${dflt.carrier_khz}Hz（vfd.carrier_khz 显式声明）。`
          + '⚠ k_h 分档表是**经验总包值，不随载波频率调整**（缺标定依据）；'
          + '若需区分载波影响，请提供不同载波下的实测损耗/温升以升级模型。'
        : `vfd.carrier_khz 未声明 ⇒ 按默认 ${CARRIER_DEFAULT_KHZ}Hz 记录（仅记录，不参与 k_h 反解）。`
          + '⚠ k_h 分档表不随载波频率调整（缺标定依据），故该默认值**不改变任何出数**。',
    },
    /** 谐波附加损耗的计损基数口径 */
    kh_basis: basis,
    kh_basis_note: basis === 'total'
      ? 'total（附件 M1 口径 ΔP_h ≈ k_h × P_loss，含机械耗）'
      : 'electromagnetic（仅铜耗+铁耗；谐波属电磁损耗，物理更严，但偏离附件原口径）',

    // ---- M1：损耗 ----
    losses: {
      sine: {
        copper_loss: cu, iron_loss: fe, mechanical_loss: mech,
        total_loss: totalSine ?? (hasLoss ? r1(lossSine) : null),
      },
      vfd: {
        copper_loss: cu, iron_loss: fe, mechanical_loss: mech,
        total_loss: hasLoss ? r1(lossVfd) : null,
      },
      delta_loss_w: deltaLoss,
      delta_loss_pct: (totalSine != null && totalSine > 0 && deltaLoss != null)
        ? r1(deltaLoss / totalSine * 100) : null,
      loss_ratio: hasLoss ? r3(ratio) : null,
      note: '谐波附加损耗按 k_h 线性附加；铜/铁耗本身不变（集肤/趋肤效应未建模，见 limits）。',
    },

    // ---- M2：附加温升 ----
    temp: {
      sine: tSine,
      vfd: tVfd,
      vfd_min_speed: tVfdMin,
      harmonic_factor: r3(1 + khInfo.k_h),
      insulation_class: insClass,
      limit_k: limit,
      over_limit_k: overLimit,
      headroom_k: (tVfd != null && limit != null) ? r1(limit - tVfd) : null,
      low_speed_extreme: lowSpeedExtreme,
      low_speed_note: lowSpeedExtreme
        ? '⚠ 低速温升远超绝缘限值：Q∝n 线性外推在极低转速比下会严重高估（实际还有传导/辐射散热基底）。'
          + '结论应读作「该转速下同轴自扇**不可行**」而非具体温升数值 —— 实机须改独立风机或限制最低转速。'
        : null,
      note: 'ΔT_vfd = ΔT_sine × (1+k_h)（ΔT ∝ P_loss，热阻不变）；vfd_min_speed 另计 M3 低速冷却衰减。',
    },

    // ---- M3：低速冷却 ----
    cooling: cool,

    // ---- 效率重推 ----
    efficiency: {
      sine: effSine,
      vfd: effVfd,
      delta_pp: (effSine != null && effVfd != null) ? r2(effVfd - effSine) : null,
      note: 'η_vfd = P_out/(P_out+P_loss_vfd)；P_out 由 η 与总损反推（缺 η 时退回 power_kw×1000）。',
    },

    // ---- k_h 灵敏度（附件 §四 同口径）----
    kh_scan: scan,

    warnings: [...new Set(warnings)],
    limits: {
      modeled: ['M1 谐波损耗', 'M2 附加温升', 'M3 低速冷却衰减'],
      passthrough: ['M4 绝缘 dv/dt', 'M5 轴承电蚀', 'M6 EMC/接地', 'M7 控制适配'],
      not_modeled: [
        '集肤/趋肤效应引起的铜耗额外增加（k_h 表为经验总包值，未分离）',
        `载波频率（当前 ${dflt.carrier_khz}Hz）对 k_h 的影响（缺少标定依据，故 k_h 不随 carrier_khz 变化 —— 这是保守处理，非遗漏）`,
        '局部放电/PDIV 寿命物理模型',
        '轴电流产生机理（需变频器共模参数 + 轴承阻抗模型）',
      ],
    },
  }
  return model
}

/**
 * k_h 灵敏度扫描（附件 §四：k_h 列实为温升倍率 1+k_h）
 * 默认 [1.00, 1.05, 1.10, 1.15, 1.20]，可经 vfd.kh_scan 覆盖。
 */
export function khScan(estimate, row = {}, vfd = {}, opts = {}) {
  const tSine = num(estimate?.temp_rise)
  if (tSine == null) return null
  const targets = (Array.isArray(vfd.kh_scan) && vfd.kh_scan.length)
    ? vfd.kh_scan.map(Number).filter(Number.isFinite)
    : [1.00, 1.05, 1.10, 1.15, 1.20]
  const insClass = String(estimate?.insulation_class_effective ?? row?.insulation_class ?? 'F').toUpperCase()
  const limit = INSULATION_LIMITS[insClass] ?? null
  const wantBand = vfd.th_band_lookup === true || opts.include_th_band === true
  return targets.map((m) => {
    const t = r1(tSine * m)
    const rowOut = {
      harmonic_factor: r3(m),
      k_h: r3(m - 1),
      temp_rise: t,
      over_limit_k: limit != null ? r1(t - limit) : null,
    }
    if (wantBand) {
      rowOut.th_band_advisory = thBandOf(t)
      rowOut.th_passed_axes = `${Math.round(thBandOf(t) * 6)}/6`
    }
    return rowOut
  })
}

/**
 * MD-SDE（daoyi）TH 域 6 档方面轴阈值（自宽到严）
 * ⚠ 外部口径，仅 advisory：**不进 L0 判据、不影响 verdict**。
 */
export const TH_BANDS_MDSDE = [125, 110, 100, 85, 72.5, 65]

/**
 * 温升 → TH 域分（通过方面数/6）。advisory only。
 * @param {number} tempRise
 * @returns {number} 0~1，粒度 1/6
 */
export function thBandOf(tempRise) {
  if (!Number.isFinite(Number(tempRise))) return 0
  let passed = 0
  for (const t of TH_BANDS_MDSDE) if (Number(tempRise) <= t) passed += 1
  return Math.round((passed / TH_BANDS_MDSDE.length) * 1000) / 1000
}

// ---------------------------------------------------------------------------
// 四项降损措施（附件 §五）
// ---------------------------------------------------------------------------

/**
 * 评估四项降损措施对温升的效果
 * @param {object} estimate
 * @param {object} row
 * @param {object} vfd
 * @param {object} [opts] { estimateFn(row)=>estimate, target_temp_rise, core_gain, od_gain, steel_gain, airflow_gain }
 */
export function evaluateVfdMeasures(estimate, row = {}, vfd = {}, opts = {}) {
  const tSine = num(estimate?.temp_rise)
  if (tSine == null) return null
  const cu = num(estimate?.copper_loss) ?? 0
  const fe = num(estimate?.iron_loss) ?? 0
  const mech = num(estimate?.mechanical_loss) ?? 0
  const basis = vfd.kh_basis === 'electromagnetic' ? 'electromagnetic' : 'total'
  const kh = deriveKh(vfd).k_h
  const target = Number(vfd.target_temp_rise ?? opts.target_temp_rise ?? 110)
  const lossSine = totalLossUnder(0, cu, fe, mech, basis)
  const tVfd = lossSine > 0 ? tSine * (totalLossUnder(kh, cu, fe, mech, basis) / lossSine) : null
  const insClass = String(estimate?.insulation_class_effective ?? row?.insulation_class ?? 'F').toUpperCase()
  const limit = INSULATION_LIMITS[insClass] ?? null

  const pack = (id, name, action, tempAfter, extra = {}) => ({
    id, name, action,
    temp_rise_after: tempAfter == null ? null : r1(tempAfter),
    vs_vfd_baseline_k: (tVfd != null && tempAfter != null) ? r1(tempAfter - tVfd) : null,
    meets_target: (tempAfter != null && Number.isFinite(target)) ? tempAfter <= target : null,
    within_insulation: (tempAfter != null && limit != null) ? tempAfter <= limit : null,
    target_k: Number.isFinite(target) ? target : null,
    ...extra,
  })

  const out = []

  // ① dv/dt 或正弦波滤波器 —— 降 k_h（附件：可降至 ≤1.05 温升倍率）
  for (const f of ['dvdt', 'sine']) {
    const kh2 = deriveKh({ ...vfd, filter: f }).k_h
    const l2 = totalLossUnder(kh2, cu, fe, mech, basis)
    const t2 = lossSine > 0 ? tSine * (l2 / lossSine) : null
    out.push(pack(`measure-1-${f}`, `① ${KH_FILTER_LABEL[f]}`, { filter: f }, t2, {
      k_h_after: kh2,
      harmonic_factor_after: r3(1 + kh2),
      note: `滤波器把 k_h 由 ${kh} 降至 ${kh2}；同时缓解 M4（dv/dt 过冲）与 M5（轴电流）。`,
    }))
  }

  // ② 独立轴流风机 / 加大风量 —— ΔT ∝ 1/Q
  const airflowGain = Number(vfd.airflow_gain ?? opts.airflow_gain ?? 1.25)
  if (Number.isFinite(airflowGain) && airflowGain > 0) {
    const t2 = tVfd != null ? tVfd / airflowGain : null
    out.push(pack('measure-2-fan', '② 独立轴流风机 / 加大风量', { fan: 'independent', airflow_gain: airflowGain }, t2, {
      note: 'ΔT ∝ 1/Q（Q=风量）；独立风机同时消除 M3 低速衰减。airflow_gain 需风机型谱支撑，默认 1.25 为占位，请按实际风量比覆盖。',
      assumption: '热阻与风量成反比（等效散热系数线性）',
    }))
  }

  // ③ 加大机座或铁心 —— 必须重估（几何变了，损耗/散热都变）
  const coreGain = Number(vfd.core_gain ?? opts.core_gain ?? 0.15)
  const odGain = Number(vfd.od_gain ?? opts.od_gain ?? 0.05)
  const designChange = {
    core_length_scale: Number.isFinite(coreGain) ? 1 + coreGain : null,
    stator_od_scale: Number.isFinite(odGain) ? 1 + odGain : null,
    note: '加大铁心降电流密度与磁通密度 ⇒ 铜耗/铁耗双降；加大机座另增散热面积。二者都改变几何，必须重估。',
  }
  if (typeof opts.estimateFn === 'function' && Number.isFinite(Number(row?.core_length))) {
    try {
      const row2 = {
        ...row,
        ...(Number.isFinite(Number(row.core_length)) ? { core_length: r1(Number(row.core_length) * (1 + coreGain)) } : {}),
        ...(Number.isFinite(Number(row.stator_od)) && Number.isFinite(odGain) ? { stator_od: r1(Number(row.stator_od) * (1 + odGain)) } : {}),
      }
      const e2 = opts.estimateFn(row2)
      const t2Sine = num(e2?.temp_rise)
      if (t2Sine != null) {
        const cu2 = num(e2?.copper_loss) ?? 0
        const fe2 = num(e2?.iron_loss) ?? 0
        const mech2 = num(e2?.mechanical_loss) ?? 0
        const l2Sine = totalLossUnder(0, cu2, fe2, mech2, basis)
        const l2 = totalLossUnder(kh, cu2, fe2, mech2, basis)
        const t2 = l2Sine > 0 ? t2Sine * (l2 / l2Sine) : null
        out.push(pack('measure-3-frame', '③ 加大机座或铁心', designChange, t2, {
          reestimated: true,
          geometry_after: { core_length: row2.core_length, stator_od: row2.stator_od },
          note: `在同一次调用内重估（铁心 ×${(1 + coreGain).toFixed(2)}、机座 ×${(1 + odGain).toFixed(2)}）后叠加 k_h=${kh}。`,
        }))
      }
    } catch { /* 重估失败则退回 needs_reestimate */ }
  }
  if (!out.some((m) => m.id === 'measure-3-frame')) {
    out.push({
      id: 'measure-3-frame', name: '③ 加大机座或铁心', action: designChange,
      temp_rise_after: null, meets_target: null, needs_reestimate: true,
      note: '本项为**几何变更**，须重跑估算才能给数；本模块不臆造缩放系数。'
        + '调用方可通过 estimateFn 注入重估函数，或自行跑 pipeline(count=…) 后比对。',
    })
  }

  // ④ 更低损耗硅钢 / 优化绕组 —— 铁耗/铜耗缩放（解析，无需重估）
  const steelGain = Number(vfd.steel_gain ?? opts.steel_gain ?? 0.20)
  const copperGain = Number(vfd.copper_gain ?? opts.copper_gain ?? 0)
  if (Number.isFinite(steelGain) || Number.isFinite(copperGain)) {
    const sScale = Number.isFinite(steelGain) ? Math.max(0, 1 - steelGain) : 1
    const cScale = Number.isFinite(copperGain) ? Math.max(0, 1 - copperGain) : 1
    const l2 = totalLossUnder(kh, cu, fe, mech, basis, sScale, cScale)
    const t2 = lossSine > 0 ? tSine * (l2 / lossSine) : null
    out.push(pack('measure-4-steel', '④ 更低损耗硅钢 / 优化绕组', {
      iron_loss_scale: r3(sScale), copper_loss_scale: r3(cScale),
    }, t2, {
      note: `铁耗 ×${sScale.toFixed(2)}（默认按硅钢牌号升级降 20%，请按材料实测铁耗曲线覆盖）；铜耗 ×${cScale.toFixed(2)}。`,
      assumption: 'ΔT ∝ P_loss（热阻不变），与 M2 同假设',
    }))
  }

  return {
    target_temp_rise_k: Number.isFinite(target) ? target : null,
    target_note: `目标温升默认 ${target}K（MD-SDE 热裕度检查点「温升余量 ≥15K」⇒ 125−15=110K 的可操作线）。`,
    baseline: { sine: tSine, vfd: tVfd != null ? r1(tVfd) : null, k_h: kh },
    measures: out,
    recommendation: recommendMeasures(out, tVfd, target),
  }
}

/** 从四项措施里挑出达标且代价最小的组合建议 */
function recommendMeasures(measures, tVfd, target) {
  const ok = measures.filter((m) => m.meets_target === true && m.temp_rise_after != null)
  if (!ok.length) {
    return {
      feasible: false,
      text: `四项措施单独施加均无法把温升降到 ${target}K 目标线；需**组合施加**（如 ①+② 或 ①+③），`
        + '或上调 target_temp_rise（工程上须与热裕度检查点口径一并确认）。',
    }
  }
  ok.sort((a, b) => a.temp_rise_after - b.temp_rise_after)
  return {
    feasible: true,
    best_single: ok[0].id,
    text: `单项即可达标：${ok[0].name} ⇒ ${ok[0].temp_rise_after}K（目标 ${target}K）。`
      + '注意 ③ 为几何变更，须重跑矩阵验证其余指标（磁密/槽满率/转矩）不越界。',
  }
}

// ---------------------------------------------------------------------------
// M4~M7：EC 域可喂入项（透传 + 阈值判定，不编造）
// ---------------------------------------------------------------------------

/** 阈值（附件 M4~M7；IEC 60034-18-41/42、IEC 61800-3） */
export const VFD_LIMITS = {
  shaft_current_a: { limit: 0.3, op: '<=', checkpoint: 'EC050601', unit: 'A' },
  emc_margin_db: { limit: 6, op: '>=', checkpoint: 'EC0501xx', unit: 'dB' },
  immunity_level: { limit: 3, op: '>=', checkpoint: 'EC0501xx', unit: '级(IEC 61800-3)' },
  insulation_coordination: { limit: 1.5, op: '>=', checkpoint: 'EC040301', unit: '倍' },
  surge_withstand: { limit: 1.3, op: '>=', checkpoint: 'EC040501', unit: '倍' },
  insulation_life_years: { limit: 10, op: '>=', checkpoint: 'CM050101', unit: '年' },
  field_weakening: { limit: 1.5, op: '>=', checkpoint: 'EC020301', unit: '倍' },
  torque_bandwidth_hz: { limit: 50, op: '>=', checkpoint: 'EC020201', unit: 'Hz' },
  dead_time_us: { range: [0.5, 3], op: 'in', checkpoint: 'EC010601', unit: 'μs' },
}

/** 直流母线电压（未声明时按 1.35×线电压反推） */
export function dcBusVoltage(vfd = {}, row = {}) {
  const declared = Number(vfd.dc_bus_v)
  if (Number.isFinite(declared)) return { value: declared, source: 'declared' }
  // 注意字段名：矩阵行/estimate.params 的电压字段名是 `voltage`（不是 `voltage_v`）
  const vLine = Number(vfd.voltage_v ?? vfd.voltage ?? row?.voltage_v ?? row?.voltage)
  if (Number.isFinite(vLine) && vLine > 0) {
    return { value: Math.round(vLine * 1.35), source: 'derived:1.35×V_line' }
  }
  return { value: null, source: null }
}

/**
 * M4~M7 → MD-SDE EC/CM 域可喂入项
 * **只透传声明值**：无声明的项进 gaps（附"需索取的输入"），绝不填占位值。
 * @param {object} vfd
 * @param {object} row
 * @returns {{feed:object, gaps:object[], declared_n:number, gap_n:number}}
 */
export function buildVfdEcFeed(vfd = {}, row = {}) {
  const feed = {}
  const gaps = []
  const put = (key, id, value, unit, op, limit, range, source, note) => {
    const v = Number(value)
    if (!Number.isFinite(v)) {
      gaps.push({ module: key, checkpoint: id, unit, required_input: `vfd.${key}`, note })
      return
    }
    let pass = null
    if (op === 'in' && Array.isArray(range)) pass = v >= range[0] && v <= range[1]
    else if (op === '<=') pass = v <= limit
    else if (op === '>=') pass = v >= limit
    feed[id] = {
      module: key, value: v, unit, op, limit: limit ?? range, pass,
      source: 'declared', note,
    }
  }
  const L = VFD_LIMITS

  // ---- M4 绝缘 ----
  const dc = dcBusVoltage(vfd, row)
  const overshoot = dc.value != null ? Math.round(dc.value * 2) : null
  if (overshoot != null) {
    feed._m4_reflection_overshoot_v = {
      module: 'M4', value: overshoot, unit: 'V', op: 'ref', limit: null, pass: null,
      source: dc.source,
      note: '反射过冲 ≈ 2×U_dc（IEC 60034-18-41/42 工程估算）：用于核对绝缘配合与浪涌耐受的**基准电压**。',
    }
  } else {
    gaps.push({
      module: 'M4', checkpoint: '_m4_reflection_overshoot_v', unit: 'V',
      required_input: 'vfd.dc_bus_v 或 vfd.voltage_v',
      note: '无母线电压 ⇒ 反射过冲基准不可算，M4 的绝缘配合/浪涌耐受无法判定。',
    })
  }

  put('insulation_coordination_margin', L.insulation_coordination.checkpoint,
    vfd.insulation_coordination_margin, L.insulation_coordination.unit, '>=',
    L.insulation_coordination.limit, null, 'declared',
    'EC040301 绝缘配合裕度 ≥1.5（耐电晕漆包线 + 绝缘系统配合，须厂家/试验给出）')
  put('surge_withstand_ratio', L.surge_withstand.checkpoint,
    vfd.surge_withstand_ratio, L.surge_withstand.unit, '>=',
    L.surge_withstand.limit, null, 'declared',
    'EC040501 浪涌耐受 ≥1.3（IEC 60034-18-42 冲击电压耐受）')
  put('insulation_life_years', L.insulation_life_years.checkpoint,
    vfd.insulation_life_years, L.insulation_life_years.unit, '>=',
    L.insulation_life_years.limit, null, 'declared',
    'CM050101 绝缘寿命 ≥10 年（变频工况按 IEC 60034-18-41 评）')

  // ---- M5 轴承电蚀 ----
  put('shaft_current_a', L.shaft_current_a.checkpoint,
    vfd.shaft_current_a, L.shaft_current_a.unit, '<=',
    L.shaft_current_a.limit, null, 'declared',
    'EC050601 轴电流 ≤0.3A（抑制：绝缘轴承 / 接地碳刷 / 共模磁环）')
  if (vfd.bearing && !Number.isFinite(Number(vfd.shaft_current_a))) {
    feed._m5_bearing_mitigation = {
      module: 'M5', value: String(vfd.bearing), unit: null, op: 'ref', limit: null,
      pass: ['insulated', 'grounding_brush', 'both'].includes(String(vfd.bearing).toLowerCase())
        ? true : null,
      source: 'declared',
      note: '轴承电蚀抑制措施已声明（insulated/grounding_brush/both），但**未给实测轴电流** ⇒ '
        + 'EC050601 仍不可喂入（喂布尔会被引擎 norm_threshold 分层放大成假象，见 L3 §3.6）。',
    }
  }

  // ---- M6 EMC/接地 ----
  put('emc_margin_db', 'EC050101', vfd.emc_margin_db, L.emc_margin_db.unit, '>=',
    L.emc_margin_db.limit, null, 'declared',
    'EC0501xx 传导/辐射发射余量 ≥6dB（IEC 61800-3）')
  put('immunity_level', 'EC050201', vfd.immunity_level, L.immunity_level.unit, '>=',
    L.immunity_level.limit, null, 'declared',
    'EC0502xx 抗扰度 ≥3 级（IEC 61800-3）')

  // ---- M7 控制适配 ----
  if (vfd.control) {
    const c = String(vfd.control).toLowerCase()
    feed.EC020101 = {
      module: 'M7', value: c, unit: null, op: 'ref', limit: null,
      pass: ['vector', 'servo', 'foc', 'vc'].includes(c) ? true
        : (['scalar', 'v/f', 'vf'].includes(c) ? false : null),
      source: 'declared',
      note: 'EC020101 矢量控制完整度：vector/servo 视为达标；scalar/VF 视为未达标；未知取值不判定。',
    }
  } else {
    gaps.push({
      module: 'M7', checkpoint: 'EC020101', unit: null, required_input: 'vfd.control',
      note: '控制方式未声明（vector/scalar/servo）',
    })
  }
  put('field_weakening_ratio', L.field_weakening.checkpoint,
    vfd.field_weakening_ratio, L.field_weakening.unit, '>=',
    L.field_weakening.limit, null, 'declared',
    'EC020301 弱磁扩速 ≥1.5')
  put('torque_bandwidth_hz', L.torque_bandwidth_hz.checkpoint,
    vfd.torque_bandwidth_hz, L.torque_bandwidth_hz.unit, '>=',
    L.torque_bandwidth_hz.limit, null, 'declared',
    'EC020201 转矩带宽 ≥50Hz')
  put('dead_time_us', L.dead_time_us.checkpoint,
    vfd.dead_time_us, L.dead_time_us.unit, 'in',
    null, L.dead_time_us.range, 'declared',
    `EC010601 死区时间 ${L.dead_time_us.range[0]}~${L.dead_time_us.range[1]}μs`)

  // 口径纪律：只把 source==='declared'（外部声明值）计入「可喂入证据数」。
  // 派生项（如 2×U_dc 反射过冲）只是**核对基准**，不是证据 —— 混入会让人误以为
  // 「已有 1 项证据」，从而在该 abstain 时误喂。
  const declaredN = Object.values(feed).filter((f) => f.source === 'declared').length
  const derivedN = Object.keys(feed).length - declaredN
  return {
    feed,
    gaps,
    declared_n: declaredN,
    derived_n: derivedN,
    gap_n: gaps.length,
    note: declaredN === 0
      ? 'M4~M7 无任何声明值 ⇒ EC 域不可喂入（喂占位值会被引擎 norm_threshold 分层放大成假象，'
        + '宁可 abstain）。请按 gaps 逐项索取变频器/绝缘/EMC 厂家数据。'
      : `已声明 ${declaredN} 项可喂入，另有 ${gaps.length} 项缺口。**仅当 gaps 中涉及的强关联检查点`
        + '全部达标时才喂入 EC 域**（强关联失败即触发 strong_veto，与分数无关）。',
  }
}

// ---------------------------------------------------------------------------
// IP67 结构技术点 S1~S8
// ---------------------------------------------------------------------------

/** S1~S8 定义（附件 §三；标准 IEC 60034-5 / GB/T 4942.1） */
export const IP67_ITEMS = [
  {
    id: 'S1', part: '机壳接合面', key: 'joint_seal',
    allowed: ['o_ring_fkm', 'o_ring_vmq', 'sealant'], feed: null, domain: 'ME',
    note: '端盖-机壳止口 O 型圈（氟橡胶/硅橡胶）或平面密封胶；控制接合面宽度与螺栓间距；气压/氦检漏。',
  },
  {
    id: 'S2', part: '轴伸密封', key: 'shaft_seal',
    allowed: ['double_lip', 'labyrinth'], feed: 'CM050601', domain: 'CM',
    note: '双唇骨架油封 + 甩水环/迷宫；轴伸粗糙度与硬度；变频工况配绝缘轴承。IPX7 后内部无进水。',
  },
  {
    id: 'S3', part: '接线盒', key: 'terminal_box_gland', type: 'bool', feed: null, domain: 'ME',
    note: '盒盖密封垫、平面度；IP67 电缆格兰头与电缆外径匹配；备用孔堵头。',
  },
  {
    id: 'S4', part: '引出线', key: 'lead_capillary_blocked', type: 'bool', feed: 'CM050101', domain: 'CM',
    note: '耐水耐热电缆；防毛细渗水（绞合间隙封填/灌封）；浸水 + 绝缘测试。',
  },
  {
    id: 'S5', part: '凝露/呼吸', key: 'breather',
    allowed: ['membrane', 'drain', 'heater'], feed: ['CM060101', 'CM060601'], domain: 'CM',
    note: '呼吸器（防水透气阀）或排水孔；可选防凝露加热器；交变湿热试验。',
  },
  {
    id: 'S6', part: '防腐涂层', key: 'coating',
    allowed: ['C3', 'C4', 'C5'], feed: 'CM060501', domain: 'CM',
    note: '涂层体系（环氧/聚氨酯，沿海/井下 C4~C5）；紧固件不锈钢/达克罗；盐雾试验。',
  },
  {
    id: 'S7', part: '与变频交互', key: 'bearing', fromVfd: true, feed: 'EC050601', domain: 'EC',
    note: '轴电流电蚀会破坏轴封与油封 ⇒ 绝缘轴承 / 接地碳刷 / 共模磁环；轴电流 ≤0.3A。',
  },
  {
    id: 'S8', part: '试验验证', key: 'tests', type: 'tests', feed: null, domain: '—',
    tests: ['ip6x', 'ipx7', 'insulation_retest', 'thermal_cycle'],
    note: 'IP6X 尘室（负压）+ IPX7（1m/30min）+ 绝缘复测；热-冷循环后复测密封。',
  },
]

/**
 * IP67 建模（声明式 + 可喂入项抽取）
 * @param {object} ip67 spec
 * @param {object} [vfdModel] 变频模型（S7 复用其轴电流判定）
 * @param {object} [vfdSpec] 原始 vfd spec（S7 的 bearing 抑制措施在 vfd 侧声明）
 */
export function buildIp67Model(ip67 = {}, vfdModel = null, vfdSpec = {}) {
  const warnings = []
  const items = {}
  const feed = {}
  let declaredN = 0
  let gapN = 0

  const pushFeed = (id, value, unit, op, limit, source, note) => {
    feed[id] = { value, unit, op, limit, pass: op === '>=' ? value >= limit : (op === '<=' ? value <= limit : null), source, note }
  }

  for (const def of IP67_ITEMS) {
    // S7「与变频交互」的抑制措施声明在 vfd 侧（vfd.bearing），不在 ip67 对象里
    const raw = def.fromVfd ? vfdSpec[def.key] : ip67[def.key]
    let status = 'gap'
    let value = raw

    if (def.type === 'bool') {
      status = raw === true ? 'declared' : (raw === false ? 'declared_false' : 'gap')
    } else if (def.type === 'tests') {
      const t = (raw && typeof raw === 'object') ? raw : {}
      const done = def.tests.filter((k) => t[k] === true)
      status = done.length === def.tests.length ? 'complete'
        : (done.length ? 'partial' : 'gap')
      value = { done, missing: def.tests.filter((k) => t[k] !== true) }
    } else if (Array.isArray(def.allowed)) {
      // 大小写不敏感：coating 的合法值是 'C3'/'C4'/'C5'（大写），用户侧大小写不定
      const allowed = def.allowed.map((x) => String(x).toLowerCase())
      status = allowed.includes(String(raw ?? '').toLowerCase()) ? 'declared' : 'gap'
    }

    // S7 的达标判据是**轴电流实测值**（EC050601），措施声明本身不算证据 ——
    // 「只声明绝缘轴承、无实测轴电流」单列为 mitigation_only（仍计缺口）。
    // ⚠ 这里的 raw 必须来自 **vfdSpec**（抑制措施声明在 vfd 侧），取值路径由
    //   门禁 I4b 双路断言守护：改回 ip67 取值会让 mitigation_only 塌成 gap ⇒ 变红。
    if (def.id === 'S7') {
      const sc = vfdModel?.ec_feed?.feed?.EC050601
      const mitigationDeclared = ['insulated', 'grounding_brush', 'both']
        .includes(String(raw ?? '').toLowerCase())
      status = sc?.pass === true ? 'declared'
        : (mitigationDeclared ? 'mitigation_only' : 'gap')
      value = sc?.pass === true ? sc.value : (raw ?? null)
    }

    if (status === 'gap' || status === 'declared_false' || status === 'mitigation_only') gapN += 1
    else declaredN += 1

    const item = {
      id: def.id, part: def.part, domain: def.domain,
      declared: value ?? null,
      status,
      feed: def.feed ?? null,
      note: def.note,
    }

    // ---- 可喂入项抽取（仅对真正有证据的项；绝不填占位值）----
    if (def.feed && (status === 'declared' || status === 'complete' || status === 'partial')) {
      if (def.id === 'S6') {
        // 涂层体系 ⇒ CM060501（无量纲达标标记）
        pushFeed('CM060501', 1, null, '>=', 1, `declared:coating=${String(raw).toUpperCase()}`,
          '声明涂层体系即计达标标记 1。⚠ 该检查点阈值口径待 MD-SDE 确认（E4 类）：'
          + '若其为 min 型数值阈值（如盐雾小时数），须改喂数值，本标记不可直接当分用。')
        item.feed_value = 1
      } else if (def.id === 'S5') {
        pushFeed('CM060101', 1, null, '>=', 1, `declared:breather=${String(raw)}`,
          '环境等级：已配置呼吸/排水/防凝露措施即计达标标记 1（阈值口径待 MD-SDE 确认）。')
        pushFeed('CM060601', 1, null, '>=', 1, `declared:breather=${String(raw)}`,
          '湿度：同上（阈值口径待 MD-SDE 确认）。')
        item.feed_value = 1
      } else if (def.id === 'S2') {
        // 轴封 + 绝缘轴承 ⇒ 电蚀寿命（仅当变频侧轴电流真达标才喂）
        const sc = vfdModel?.ec_feed?.feed?.EC050601
        if (sc?.pass === true) {
          pushFeed('CM050601', 1, null, '>=', 1, 'declared:shaft_seal+shaft_current_pass',
            '轴封结构已声明且轴电流实测达标 ⇒ 电蚀寿命可计达标。')
          item.feed_value = 1
        } else {
          item.status = 'gap'
          item.blocked_by = 'EC050601 轴电流未实测达标'
          warnings.push('IP67_S2_BLOCKED_BY_SHAFT_CURRENT')
        }
      } else if (def.id === 'S4') {
        const life = Number(ip67.insulation_life_years)
        if (Number.isFinite(life) && life >= VFD_LIMITS.insulation_life_years.limit) {
          pushFeed('CM050101', life, '年', '>=', VFD_LIMITS.insulation_life_years.limit,
            'declared:ip67.insulation_life_years',
            '引出线防毛细 + 绝缘寿命声明值达标 ⇒ 可喂入。')
          item.feed_value = life
        } else {
          item.status = 'gap'
          item.blocked_by = '缺 ip67.insulation_life_years（≥10 年）'
        }
      } else if (def.id === 'S7') {
        const sc = vfdModel?.ec_feed?.feed?.EC050601
        if (sc?.pass === true) { item.feed_value = sc.value } else { item.status = 'gap'; item.blocked_by = 'EC050601 轴电流未实测达标' }
      }
    }
    items[def.id] = item
  }

  const verified = items.S8?.status === 'complete'
  if (!verified) warnings.push('IP67_TESTS_INCOMPLETE')

  const feedableN = Object.keys(feed).length
  return {
    active: true,
    version: VFD_MODULE_VERSION,
    standard: 'IEC 60034-5 / GB/T 4942.1（IP6X 尘密 + IPX7：1m / 30min）',
    items,
    declared_n: declaredN,
    gap_n: gapN,
    verified,
    feedable: feed,
    feedable_n: feedableN,
    warnings: [...new Set(warnings)],
    note: 'IP67 属**结构详细设计**，L0 电磁-热模型不覆盖（MD-SDE ME 域 abstain）。'
      + '本模块按声明值逐项登记，只对有真实证据的项抽取可喂入值。',
    feed_risk: feedableN === 0
      ? '无可喂入项 ⇒ CM 域应保持 abstain（不喂）。'
      : `⚠ 已有 ${feedableN} 项可喂入。**CM 域在场即参与均分**：若同域其他检查点诚实值不达标，`
        + '喂入会**拉低** F（实测 bridged 全量 F=0.393 vs evidence-only 0.706）。'
        + '仅当该域全部检查点达标时才喂入，否则宁可 abstain。',
  }
}

// ---------------------------------------------------------------------------
// 告警文案（供 pipeline / 门禁按 code 渲染，避免各调用方重复写死）
// ---------------------------------------------------------------------------

export const VFD_IP67_WARNING_TEXT = {
  VFD_FILTER_UNSPECIFIED: '未给 vfd.filter —— 已按最保守档「无滤波长电缆」反解 k_h，温升评估偏保守；已配置滤波器请显式传入。',
  VFD_FILTER_UNKNOWN: 'vfd.filter 取值不在 none/dvdt/sine 内 —— 已按最保守档 none 反解 k_h，请核对取值。',
  VFD_CABLE_LENGTH_UNSPECIFIED: '未给 vfd.cable_m —— 电缆长度分位取 0.5（中值）反解 k_h。',
  VFD_KH_CLAMPED: 'vfd.k_h 超出物理范围 [0,0.30]，已被钳位。',
  VFD_FAN_DEFAULTED: 'vfd.fan 未声明 ⇒ 按用户口径「变频电机默认独立风机」取 independent（低速段无冷却衰减）。'
    + '⚠ 若实机为同轴自扇（self），必须显式传 vfd.fan="self"，否则会低估低速温升。',
  VFD_FAN_UNKNOWN: 'vfd.fan 取值不在 self/independent 内 ⇒ 已回落默认 independent 并告警（不静默按用户原值算）。',
  VFD_MIN_SPEED_MISSING: '已确认同轴自扇但缺 vfd.min_speed_rpm ⇒ 低速冷却衰减量不可算。',
  VFD_CARRIER_DEFAULTED: `vfd.carrier_khz 未声明 ⇒ 按默认 ${CARRIER_DEFAULT_KHZ}Hz 记录。`
    + '⚠ k_h 分档表为经验总包值，不随载波频率调整（缺标定依据），故该默认值不改变任何出数；'
    + '若需区分载波影响，请提供不同载波下的实测损耗/温升。',
  VFD_CARRIER_INVALID: `vfd.carrier_khz 非法（非正数或非数值）⇒ 已回落默认 ${CARRIER_DEFAULT_KHZ}Hz，请核对取值。`,
  VFD_CARRIER_OUT_OF_RANGE: 'vfd.carrier_khz 超出常见变频器区间（1~20kHz）⇒ 仅记录提示，不做钳位（钳位等于用臆造边界改数据）；请核对是否单位写错（如误填 Hz）。',
  VFD_TEMP_OVER_LIMIT: '⚠ 变频修正后温升已超绝缘等级限值：热裕度不足为 P0 风险，须落实至少一项降损措施（vfd_measures=true 查看四项措施效果）。',
  VFD_LOW_SPEED_TEMP_EXTREME: '⚠ 低速段温升远超绝缘限值：Q∝n 线性外推在极低转速比下严重高估，结论应读作「该转速下同轴自扇不可行」而非具体数值；实机须改独立风机或限制最低转速。',
  IP67_TESTS_INCOMPLETE: 'IP67 试验验证不完整（IP6X / IPX7 / 绝缘复测 / 热-冷循环未全过）⇒ 结构防护等级未闭环。',
  IP67_S2_BLOCKED_BY_SHAFT_CURRENT: 'S2 轴伸密封的电蚀寿命不可喂入：EC050601 轴电流未实测达标（变频轴电流会破坏轴封）。',
}

// ---------------------------------------------------------------------------
// 归一化 + 总入口
// ---------------------------------------------------------------------------

/**
 * 归一化 vfd spec（env 兜底；显式对象即视为开启）
 * @param {*} raw
 * @param {object} [env]
 */
export function resolveVfdSpec(raw, env = globalThis?.process?.env ?? {}) {
  if (raw === true) return { enabled: true }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const envOn = envOnLocal(env?.[ENV_VFD], false)
    return { ...raw, enabled: raw.enabled === undefined ? (envOn || true) : truthy(raw.enabled) }
  }
  return { enabled: envOnLocal(env?.[ENV_VFD], false) }
}

/**
 * 归一化 ip67 spec
 * @param {*} raw
 * @param {object} [env]
 */
export function resolveIp67Spec(raw, env = globalThis?.process?.env ?? {}) {
  if (raw === true) return { enabled: true }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const envOn = envOnLocal(env?.[ENV_IP67], false)
    return { ...raw, enabled: raw.enabled === undefined ? (envOn || true) : truthy(raw.enabled) }
  }
  return { enabled: envOnLocal(env?.[ENV_IP67], false) }
}

/**
 * 总入口：对单行施加变频 + IP67 建模（任一未启用则该块为 null，零回归）
 * @param {object} estimate quickL0Estimate 单行结果
 * @param {object} row 参数行
 * @param {object} spec { vfd, ip67 }
 * @param {object} [opts] { estimateFn, include_th_band, with_measures }
 * @returns {{vfd_model:object|null, ip67_model:object|null, warnings:string[]}}
 */
export function runVfdIp67(estimate, row = {}, spec = {}, opts = {}) {
  const warnings = []
  const vfdSpec = resolveVfdSpec(spec.vfd)
  const ip67Spec = resolveIp67Spec(spec.ip67)

  let vfdModel = null
  if (vfdSpec.enabled && estimate && typeof estimate === 'object') {
    vfdModel = applyVfdModel(estimate, row, vfdSpec, opts)
    vfdModel.ec_feed = buildVfdEcFeed(vfdSpec, row)
    if (opts.with_measures) {
      vfdModel.measures = evaluateVfdMeasures(estimate, row, vfdSpec, opts)
    }
    warnings.push(...(vfdModel.warnings ?? []))
  }

  let ip67Model = null
  if (ip67Spec.enabled) {
    ip67Model = buildIp67Model(ip67Spec, vfdModel, vfdSpec)
    warnings.push(...(ip67Model.warnings ?? []))
  }

  return { vfd_model: vfdModel, ip67_model: ip67Model, warnings: [...new Set(warnings)] }
}

export default {
  VFD_MODULE_VERSION, ENV_VFD, ENV_IP67, KH_TABLE, KH_FILTER_LABEL, CABLE_REF_M, KH_CLAMP,
  TH_BANDS_MDSDE, VFD_LIMITS, IP67_ITEMS,
  CARRIER_DEFAULT_KHZ, CARRIER_SANITY_KHZ, FAN_DEFAULT, FAN_ALLOWED,
  cableQuantile, deriveKh, vfdDefaults, coolingModel, totalLossUnder, deriveOutputPower,
  applyVfdModel, khScan, thBandOf, evaluateVfdMeasures, buildVfdEcFeed, dcBusVoltage,
  buildIp67Model, resolveVfdSpec, resolveIp67Spec, runVfdIp67,
}

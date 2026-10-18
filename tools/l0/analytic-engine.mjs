/**
 * analytic-engine.mjs —— L0 解析通道求解器（新增第三支路）
 * ===========================================================
 * 设计原则（提案 v2 第三章 A / 第四章 4.0–4.6 / 第七章 S0–S6）：
 *   1. 并联第三支路：与 formula / surrogate 平级，复用公式通道永久回退保底（零回归）。
 *   2. 只增不改：本模块不修改 core 的 formula/surrogate 任何逻辑（blast radius 最小）。
 *   3. 回退契约（仿 lib/surrogate-engine.mjs:393-433）：
 *      超合理域 / 迭代不收敛 → {error, fallback_to_formula:true, confidence:0, skipped:true}；
 *      exclusive 模式不收敛 → {error, infeasible:true, solve_mode:'l0-analytic-infeasible'}。
 *   4. 迭代边界（4.0）：方案参数（匝数/线规/气隙/槽形/铁长）一旦给定即冻结；
 *      仅允许方程求解收敛迭代（磁路饱和 doSaturationLoop / 热-电耦合 thermalCouplingLoop），
 *      绝不因核算不达标回头改设计输入重算。
 *
 * 能力分阶段：
 *   - A 代数骨架：formula 基线 + 通道元数据；B/S2 增强由 env DSH_L0_ANALYTIC 门控。
 *   - B/S2 引擎加固：doSaturationLoop（μr(B)+卡特） + thermalCouplingLoop（电阻温度回代）。
 *   - B/S0 标定：calibrate_analytic_rmxprt.mjs（RMxprt 离线标定，沙箱无 ANSYS 仅 dry-run）。
 *   - 完整效率/性能再推导（4.4 slip/dq 求解器）属 S5，本轮未实现，诚实标注 pending。
 *
 * ⚠ 能力边界（诚实披露）：doSaturationLoop / thermalCouplingLoop 是「真实迭代机械」，
 *   但其绝对系数（B-H 曲线牌号 / 热阻网络常数）来自典型值，未经 RMxprt 真值标定。
 *   故解析结果恒标 analytic_calibrated:false + confidence:0.5（公式级），待 S0 标定后上调。
 */

import { quickL0Estimate, estimateTempRise } from '@wangxue98/dsh-motor-ai-core'

// ───────────────────────────────────────────────────────────
// A-⑥ env 开关（仿 formula-engine.mjs:46-48 范式）
// ───────────────────────────────────────────────────────────
// 默认 'off'：解析通道仅作公式基线 + 元数据（骨架），不跑实验性迭代。
// 'shadow'：公式主出数 + 解析并行记偏差不打流（S3，零风险）。
// 'on'     ：解析迭代求解生效，逐行公式回退保底。
// 'exclusive'：仅解析出数，无公式回退（严格验证用，不收敛即标 infeasible）。
const ANALYTIC_MODE_ENV = (v, dflt = 'off') =>
  (v === undefined || v === '' ? dflt : String(v).toLowerCase())
export const analyticModeOf = (opts) =>
  (opts?.analyticMode ?? ANALYTIC_MODE_ENV(process.env.DSH_L0_ANALYTIC, 'off'))
export const ANALYTIC_MINC = Number(process.env.DSH_L0_ANALYTIC_MINC ?? 0.99)

// ───────────────────────────────────────────────────────────
// B/S2 4.2 硅钢 B-H 曲线（代表牌号 DW540-50，单位 [T, A/m]）
// 仅作迭代初值；S0 标定后由 calibrate_analytic_rmxprt.mjs 反算替换。
// ───────────────────────────────────────────────────────────
const BH_CURVE = [
  [0.0, 0], [0.5, 40], [0.8, 70], [1.0, 100], [1.2, 150],
  [1.4, 230], [1.5, 300], [1.6, 400], [1.7, 540], [1.8, 760],
  [1.9, 1100], [2.0, 1700], [2.1, 2700], [2.2, 4500],
]
const MU0 = 4e-7 * Math.PI

/** B → H（A/m）线性插值查表 */
function HfromB(B) {
  const b = Math.abs(B)
  if (b <= BH_CURVE[0][0]) return BH_CURVE[0][1]
  for (let i = 0; i < BH_CURVE.length - 1; i++) {
    const [b0, h0] = BH_CURVE[i]
    const [b1, h1] = BH_CURVE[i + 1]
    if (b >= b0 && b <= b1) {
      const t = (b - b0) / (b1 - b0)
      return h0 + t * (h1 - h0)
    }
  }
  return BH_CURVE[BH_CURVE.length - 1][1]
}

/** B → 相对磁导率 μr（用于饱和判据与迭代反馈） */
export function muRFromB(B) {
  const b = Math.abs(B)
  if (b <= 0) return 5000
  const H = HfromB(b)
  return H > 0 ? b / (MU0 * H) : 5000
}

/**
 * 卡特系数 k_C（4.2）：开槽使气隙磁导有效减小。
 * γ = (4/π)·k，k = (2/π)·[atan(g) − g·ln(1+g²)/(1+g²)]，g = b0/(2δ)。
 * @param {number} b0 槽口宽 mm
 * @param {number} delta 气隙 mm
 * @param {number} t1 齿距 mm
 */
export function carterFactor(b0, delta, t1) {
  if (!(t1 > 0) || !(delta > 0)) return 1
  const g = b0 / (2 * delta)
  const k = (2 / Math.PI) * (Math.atan(g) - (g * Math.log(1 + g * g)) / (1 + g * g))
  const gamma = (4 / Math.PI) * k
  const kC = t1 / (t1 - gamma * delta)
  return kC > 1 ? kC : 1
}

/**
 * B/S2 4.2 磁路饱和迭代（真实固定点）：
 * 给定公式基线气隙磁密，按非线性 μr(B) 反解同励磁磁势下的自洽磁通，
 * 输出修正后的齿/轭/气隙磁密及饱和状态。
 *
 * 物理：固定 MMF（由基线 B 场按线性 μr0 推得）→ 以非线性 μr 解磁通 Φ，
 * 饱和使 μr 下降 ⇒ 同 MMF 下磁通低于线性基线 ⇒ 输出 B* ≤ 基线（真实饱和效应）。
 * @param {object} p 几何 + 基线磁密
 * @returns {object} { B_delta, B_t, B_y, muR_t, muR_y, saturated, converged, iterations }
 */
export function doSaturationLoop(p, maxIter = 60) {
  const {
    B_delta_base = 0.8, B_t_base = 0, B_y_base = 0,
    statorId = 0, statorOd = 0, yokeThickness = 0, toothWidth = 0,
    airGap = 0, slotsStator = 0, poles = 4, coreLength = 0, muR0 = 2000,
  } = p
  const pp = Math.max(1, Math.round(poles))
  const Di = statorId, L = coreLength, y = yokeThickness, Zs = slotsStator
  if (!(Di > 0) || !(L > 0) || !(Zs > 0)) {
    return { B_delta: B_delta_base, B_t: B_t_base, B_y: B_y_base, muR_t: muR0, muR_y: muR0, saturated: false, converged: false, iterations: 0, reason: '几何不足' }
  }
  const Ag = Math.PI * Di * L / (2 * pp)
  const At = (Zs / (2 * pp)) * toothWidth * L
  const Ay = Math.PI * (Di + y) * y / (2 * pp)
  const kC = carterFactor(toothWidth * 0.5, airGap, Math.PI * Di / Zs)
  const dEff = airGap * kC
  const lt = Math.max(1, (statorOd - Di) / 2 - y)
  const ly = Math.max(1, y)
  const lg = 2 * dEff
  // 基线所隐含的励磁磁势（按线性 μr0）
  const Fapplied = (B_t_base / (MU0 * muR0)) * lt + (B_y_base / (MU0 * muR0)) * ly + (B_delta_base / MU0) * lg
  // 非线性磁势函数 F(Φ)
  const Fof = (Phi) => {
    const Bg = Phi / Ag, Bt = Phi / At, By = Phi / (2 * Ay)
    const Hg = Bg / MU0
    const Ht = HfromB(Bt), Hy = HfromB(By)
    return Ht * lt + Hy * ly + Hg * lg
  }
  const Phi0 = B_delta_base * Ag
  let lo = 0, hi = (Phi0 * 1.2) || 1e-6
  // 确保 F(hi) ≥ Fapplied（F 随 Φ 单调增）
  let guard = 0
  while (Fof(hi) < Fapplied && guard < 20) { hi *= 1.5; guard++ }
  let it = 0, converged = false, PhiStar = Phi0
  for (; it < maxIter; it++) {
    const mid = (lo + hi) / 2
    const Fmid = Fof(mid)
    if (Math.abs(Fmid - Fapplied) <= 1e-3 * Fapplied + 1e-6) { PhiStar = mid; converged = true; break }
    if (Fmid < Fapplied) lo = mid; else hi = mid
  }
  if (!converged) PhiStar = (lo + hi) / 2
  const Bg = PhiStar / Ag, Bt = PhiStar / At, By = PhiStar / (2 * Ay)
  const muRt = muRFromB(Bt), muRy = muRFromB(By)
  return {
    B_delta: Math.round(Bg * 1000) / 1000,
    B_t: Math.round(Bt * 1000) / 1000,
    B_y: Math.round(By * 1000) / 1000,
    muR_t: Math.round(muRt), muR_y: Math.round(muRy),
    mmf_applied: Math.round(Fapplied), mmf_solved: Math.round(Fof(PhiStar)),
    saturated: (Bt > 1.8 || By > 1.7),
    converged, iterations: converged ? it + 1 : maxIter,
  }
}

/**
 * B/S2 4.6 热-电耦合迭代（真实固定点，复用 core estimateTempRise 作热阻步）：
 * T_w(0)=T_amb+40 → R1(T_w) → P_Cu(T_w) → 总损 → estimateTempRise → ΔT_w(k+1)
 * 收敛判据 |ΔT_w(k+1)−ΔT_w(k)|<1K。
 * @returns {object} { temp_rise, converged, iterations, copper_fraction }
 */
export function thermalCouplingLoop(p, maxIter = 80) {
  const { statorOd = 0, coreLength = 0, cooling = 'forced_air', totalLossW = 0, baseTempRise = 40 } = p
  const ambient = 25
  const alpha = 0.00393
  const copperFraction = 0.5
  const Pcu0 = totalLossW * copperFraction
  const Pother = totalLossW - Pcu0
  let Tw = ambient + (Number.isFinite(baseTempRise) ? baseTempRise : 40)
  let converged = false, it = 0
  for (; it < maxIter; it++) {
    const Pcu = Pcu0 * (1 + alpha * (Tw - 20))
    const totalNow = Pother + Pcu
    const dT = estimateTempRise({ statorOd, coreLength, cooling }, totalNow)
    const TwNext = ambient + (Number.isFinite(dT) ? dT : 40)
    if (Math.abs(TwNext - Tw) < 1) { Tw = TwNext; converged = true; break }
    Tw = TwNext
  }
  return {
    temp_rise: Math.round((Tw - ambient) * 10) / 10,
    converged, iterations: converged ? it + 1 : maxIter,
    copper_fraction: copperFraction,
  }
}

/**
 * 单行解析求解：formula 基线 + 可选 B/S2 迭代增强。
 * @param {object} row 参数行
 * @param {object} o { estimateOpts, mode }
 * @returns {object} 完整 L0 结果对象（基线 + 覆盖/元数据），或非收敛回退标记
 */
function analyticSolveOne(row, { estimateOpts, mode = 'off' } = {}) {
  const m = analyticModeOf({ analyticMode: mode })
  const opts = estimateOpts ? estimateOpts(row) : {}
  let base
  try {
    base = quickL0Estimate(row, opts) // 完整基线结果（含全部 B 场/效率/损耗）
  } catch (err) {
    // 公式基线本身失败 → 该行直接不可解（与公式通道同判据）
    return { error: String(err?.message ?? err), fallback_to_formula: true, confidence: 0, skipped: true }
  }

  if (m === 'off') {
    return {
      ...base,
      prediction_source: 'analytic',
      solve_mode: 'l0-analytic-baseline',
      analytic_mode: 'off',
      analytic_active: true,
      analytic_calibrated: false,
      analytic_experimental: false,
      analytic_note: 'analytic 通道已激活（骨架）；B/S2 迭代增强由 env DSH_L0_ANALYTIC=on/shadow/exclusive 启用，绝对系数待 S0 RMxprt 标定',
    }
  }

  if (m === 'shadow') {
    // 公式主出数 + 解析并行记偏差不打流
    const out = { ...base, analytic_mode: 'shadow', analytic_active: true, analytic_calibrated: false }
    try {
      const sat = doSaturationLoop({
        B_delta_base: base.air_gap_flux_density ?? base.air_gap_flux ?? 0.8,
        B_t_base: base.tooth_flux_density ?? 0, B_y_base: base.yoke_flux_density ?? 0,
        statorId: row.stator_id, statorOd: row.stator_od, yokeThickness: row.yoke_thickness,
        toothWidth: row.tooth_width, airGap: row.air_gap, slotsStator: row.slots_stator,
        poles: row.poles, coreLength: row.core_length,
      })
      const th = thermalCouplingLoop({
        statorOd: row.stator_od, coreLength: row.core_length, cooling: row.cooling,
        totalLossW: base.total_loss ?? 0, baseTempRise: base.temp_rise,
      })
      out.analytic_shadow = {
        converged: sat.converged && th.converged,
        saturation: { B_delta: sat.B_delta, B_t: sat.B_t, B_y: sat.B_y, muR_t: sat.muR_t, muR_y: sat.muR_y, saturated: sat.saturated },
        thermal: { temp_rise: th.temp_rise, converged: th.converged },
        note: 'shadow 模式：公式结果不变，以下为解析迭代并行偏差记录（不打流）',
      }
    } catch (err) {
      out.analytic_shadow = { error: String(err?.message ?? err) }
    }
    return out
  }

  // 'on' | 'exclusive'：应用迭代增强
  try {
    const sat = doSaturationLoop({
      B_delta_base: base.air_gap_flux_density ?? base.air_gap_flux ?? 0.8,
      B_t_base: base.tooth_flux_density ?? 0, B_y_base: base.yoke_flux_density ?? 0,
      statorId: row.stator_id, statorOd: row.stator_od, yokeThickness: row.yoke_thickness,
      toothWidth: row.tooth_width, airGap: row.air_gap, slotsStator: row.slots_stator,
      poles: row.poles, coreLength: row.core_length,
    })
    const th = thermalCouplingLoop({
      statorOd: row.stator_od, coreLength: row.core_length, cooling: row.cooling,
      totalLossW: base.total_loss ?? 0, baseTempRise: base.temp_rise,
    })
    if (!(sat.converged && th.converged)) {
      if (m === 'exclusive') {
        return { error: 'analytic 迭代不收敛', solve_mode: 'l0-analytic-infeasible', fallback_to_formula: false, confidence: 0, skipped: true, infeasible: true }
      }
      return { error: 'analytic 迭代不收敛，回退公式', fallback_to_formula: true, confidence: 0, skipped: true }
    }
    return {
      ...base,
      prediction_source: 'analytic',
      solve_mode: m === 'exclusive' ? 'l0-analytic' : 'l0-analytic-refined',
      analytic_mode: m,
      analytic_active: true,
      analytic_calibrated: false,
      analytic_experimental: true,
      // 预校准期：权威字段保持公式基线不变；迭代值仅作实验性附字段，绝不覆盖权威值
      air_gap_flux_density_analytic: sat.B_delta,
      tooth_flux_density_analytic: sat.B_t,
      yoke_flux_density_analytic: sat.B_y,
      temp_rise_analytic: th.temp_rise,
      analytic_refined: {
        saturation: { B_delta: sat.B_delta, B_t: sat.B_t, B_y: sat.B_y, muR_t: sat.muR_t, muR_y: sat.muR_y, saturated: sat.saturated },
        thermal: { temp_rise: th.temp_rise, converged: th.converged },
        note: 'B/S2 迭代增强已计算（实验性附字段 *_analytic，未覆盖公式权威值）；'
          + '绝对系数（B-H 曲线 / 热阻）待 S0 RMxprt 标定后，翻 analytic_calibrated=true 才覆盖权威字段，confidence 由 0.5 上调至 0.8',
      },
    }
  } catch (err) {
    if (m === 'exclusive') {
      return { error: String(err?.message ?? err), solve_mode: 'l0-analytic-infeasible', fallback_to_formula: false, confidence: 0, skipped: true, infeasible: true }
    }
    return { error: String(err?.message ?? err), fallback_to_formula: true, confidence: 0, skipped: true }
  }
}

/**
 * 批量解析预测（复用 surrogate predictBatch 形态，lib/surrogate-engine.mjs:393-433）。
 * @param {Array<object>} paramsList 参数列表
 * @param {object} [options] { estimateOpts, mode }
 * @returns {object} { results, fallbacks, skipped }
 */
export function predictAnalyticBatch(paramsList, options = {}) {
  const { estimateOpts, mode = 'off' } = options
  const m = analyticModeOf({ analyticMode: mode })
  const results = []
  let fallbacks = 0
  let skipped = 0
  for (const row of paramsList) {
    try {
      const res = analyticSolveOne(row, { estimateOpts, mode: m })
      if (res.fallback_to_formula || res.error) {
        fallbacks++
        if (res.skipped) skipped++
      }
      results.push(res)
    } catch (err) {
      fallbacks++
      skipped++
      results.push({ error: String(err?.message ?? err), fallback_to_formula: true, confidence: 0, skipped: true })
    }
  }
  return { results, fallbacks, skipped }
}

export default {
  analyticModeOf, ANALYTIC_MINC, muRFromB, carterFactor,
  doSaturationLoop, thermalCouplingLoop, predictAnalyticBatch,
}

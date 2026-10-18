// 探针：复现 analyticEngine.doSaturationLoop 的轭磁密 Bug（Y160L-4 / Y180M-4）
// 忠实复刻 l0-estimate.mjs:243-249 的 on 模式入参：
//   B_delta_base = base.air_gap_flux_density (P0-1 实际口径, ≈0.8)
//   B_t_base     = base.tooth_flux_density   (公式基线)
//   B_y_base     = base.yoke_flux_density     (公式基线)
import { quickL0Estimate } from '@wangxue98/dsh-motor-ai-core'
import { doSaturationLoop } from '../../tools/l0/analytic-engine.mjs'

const MU0 = 4e-7 * Math.PI

// 两机几何（Y 系列 4 极）
const MACHINES = {
  Y160L: { poles: 4, slots_stator: 36, stator_id: 170, stator_od: 260, core_length: 195, air_gap: 0.5, yoke_thickness: 18, tooth_width: Math.PI * 170 / (2 * 36), voltage: 380, speed: 1460, power_kw: 15, cooling: 'forced_air' },
  Y180M: { poles: 4, slots_stator: 48, stator_id: 175, stator_od: 290, core_length: 135, air_gap: 0.55, yoke_thickness: 20, tooth_width: Math.PI * 175 / (2 * 48), voltage: 380, speed: 1440, power_kw: 18.5, cooling: 'forced_air' },
}

// 修正版：pp=极对数; 轭面积=整环π(Di+y)y; By=Φ/Ay（不再 /2）
function correctedSat(p) {
  const { B_delta_base = 0.8, B_t_base = 0, B_y_base = 0,
    statorId, statorOd, yokeThickness, toothWidth, airGap, slotsStator, poles, coreLength, muR0 = 2000 } = p
  const pp = Math.max(1, Math.round(poles / 2))
  const Di = statorId, L = coreLength, y = yokeThickness, Zs = slotsStator
  const Ag = Math.PI * Di * L / (2 * pp)
  const At = (Zs / (2 * pp)) * toothWidth * L
  const Ay = Math.PI * (Di + y) * y
  const dEff = airGap, lt = Math.max(1, (statorOd - Di) / 2 - y), ly = Math.max(1, y), lg = 2 * dEff
  const Fapplied = (B_t_base / (MU0 * muR0)) * lt + (B_y_base / (MU0 * muR0)) * ly + (B_delta_base / MU0) * lg
  const HfromB = (B) => { const b = Math.abs(B); return b <= 0 ? 0 : b * 200 }
  const Fof = (Phi) => { const Bg = Phi / Ag, Bt = Phi / At, By = Phi / Ay; return HfromB(Bt) * lt + HfromB(By) * ly + (Bg / MU0) * lg }
  const Phi0 = B_delta_base * Ag; let lo = 0, hi = Phi0 * 1.2 || 1e-6, g = 0
  while (Fof(hi) < Fapplied && g < 20) { hi *= 1.5; g++ }
  let it = 0, conv = false, PhiStar = Phi0
  for (; it < 60; it++) { const m = (lo + hi) / 2, Fm = Fof(m); if (Math.abs(Fm - Fapplied) <= 1e-3 * Fapplied + 1e-6) { PhiStar = m; conv = true; break } if (Fm < Fapplied) lo = m; else hi = m }
  if (!conv) PhiStar = (lo + hi) / 2
  return { B_delta: Math.round(PhiStar / Ag * 1000) / 1000, B_t: Math.round(PhiStar / At * 1000) / 1000, B_y: Math.round(PhiStar / Ay * 1000) / 1000, converged: conv }
}

console.log('机器       | 公式基线 By | doSaturationLoop By(异常) | 修正版 By | 公式 saturated | 实际 saturated')
for (const [name, m] of Object.entries(MACHINES)) {
  const row = { ...m, stator_id: m.stator_id, stator_od: m.stator_od }
  let base
  try { base = quickL0Estimate(row) } catch (e) { console.log(name, 'quickL0Estimate 失败:', e.message); continue }
  const baseBg = base.air_gap_flux_density ?? 0.8
  const baseBt = base.tooth_flux_density ?? 0
  const baseBy = base.yoke_flux_density ?? 0
  const buggy = doSaturationLoop({
    B_delta_base: baseBg, B_t_base: baseBt, B_y_base: baseBy,
    statorId: m.stator_id, statorOd: m.stator_od, yokeThickness: m.yoke_thickness,
    toothWidth: m.tooth_width, airGap: m.air_gap, slotsStator: m.slots_stator,
    poles: m.poles, coreLength: m.core_length,
  })
  const fixed = correctedSat({
    B_delta_base: baseBg, B_t_base: baseBt, B_y_base: baseBy,
    statorId: m.stator_id, statorOd: m.stator_od, yokeThickness: m.yoke_thickness,
    toothWidth: m.tooth_width, airGap: m.air_gap, slotsStator: m.slots_stator,
    poles: m.poles, coreLength: m.core_length,
  })
  console.log('%s | %s | %s (sat=%s) | %s | %s',
    name.padEnd(8),
    String(baseBy).padEnd(10),
    String(buggy.B_y).padEnd(18),
    buggy.saturated,
    String(fixed.B_y).padEnd(8),
    baseBy > 1.8 ? 'YES' : 'no')
}
console.log('\n注：公式基线 By 由 quickL0Estimate 实测；doSaturationLoop 为插件现状(on 模式)；修正版为 pp/轭面积修复原型。')

/**
 * 口径分裂证伪/证实：quickL0Estimate 的 tooth_flux_density（formula 基线）
 * vs doSaturationLoop 的 B_t（P1-1 修 K_WAVE 后）是否差 π/2。
 *
 * 手工推导（待数值验证）：
 *   formula:    Bt = 2·Bg·Di/(Zs·tw·k)                     （Bg 峰值口径）
 *   saturation: At = (Zs/2pp)·tw·L·k·(π/2), Φ = Bg·Ag
 *               Bt = Φ/At = Bg·π·Di/(2pp) / [(Zs/2pp)·tw·L·k·π/2]
 *                         = 2·Bg·Di/(Zs·tw·k)              ← 与 formula 相同
 * ⇒ 若推导正确，两通道同口径，报告 §6「差 1.571 倍」结论错误，须更正。
 *
 * 运行：node dev-calib/xcheck_caliber_split.mjs
 */
import { quickL0Estimate } from '@wangxue98/dsh-motor-ai-core'
import { doSaturationLoop } from '../tools/l0/analytic-engine.mjs'
import { readFileSync } from 'node:fs'

const truth = JSON.parse(readFileSync('D:/dsh-motor-ai-l0/output/p2_real_truth.json', 'utf8')).rows

const rec = []
for (const r of truth) {
  if (!r.solve_ok) continue
  const i = r.inputs
  let e
  try {
    e = quickL0Estimate({
      stator_od: i.stator_od, stator_id: i.stator_id, air_gap: i.air_gap,
      slots_stator: i.slots_stator, poles: i.poles, voltage: i.voltage,
      speed: i.speed_rpm, core_length: i.core_length, power_kw: i.power_kw,
      motor_type: 'induction', cooling: i.cooling ?? 'forced_air',
      yoke_thickness: i.yoke_thickness,
    })
  } catch { continue }
  let sat
  try {
    sat = doSaturationLoop({
      B_delta_base: e.air_gap_flux_density ?? 0.8,
      B_t_base: e.tooth_flux_density ?? 0, B_y_base: e.yoke_flux_density ?? 0,
      statorId: i.stator_id, statorOd: i.stator_od, yokeThickness: i.yoke_thickness,
      toothWidth: i.tooth_width, airGap: i.air_gap, slotsStator: i.slots_stator,
      poles: i.poles, coreLength: i.core_length,
    })
  } catch { continue }
  rec.push({
    tag: r.tag, poles: i.poles,
    btFormula: e.tooth_flux_density, btSat: sat.B_t,
    byFormula: e.yoke_flux_density, bySat: sat.B_y,
    bgEst: e.air_gap_flux_density,
    twEff: sat.tooth_width?.effective_mm, twBase: sat.tooth_width?.base_mm,
    twGiven: i.tooth_width,
    satFlag: sat.saturated, converged: sat.converged,
  })
}

const n = rec.length
console.log(`n = ${n} 台\n`)
console.log('通道对比（齿磁密 T）：')
console.log('  formula 均值 =', (rec.reduce((s, r) => s + r.btFormula, 0) / n).toFixed(4))
console.log('  sat     均值 =', (rec.reduce((s, r) => s + r.btSat, 0) / n).toFixed(4))
const ratios = rec.map((r) => r.btSat / r.btFormula)
console.log('  sat/formula 比值: mean=%.4f  min=%.4f  max=%.4f' % (
  ratios.reduce((a, b) => a + b, 0) / n, Math.min(...ratios), Math.max(...ratios)))
console.log('  若比值 ≈1.0 ⇒ 两通道同口径（报告 §6 错误）；≈1.571 ⇒ 口径分裂成立\n')

// 只取未饱和样本（线性区应收敛到基线）
const lin = rec.filter((r) => !r.satFlag)
console.log(`未饱和子集 n=${lin.length}:`)
if (lin.length) {
  const lr = lin.map((r) => r.btSat / r.btFormula)
  console.log('  sat/formula 比值: mean=%.4f  min=%.4f  max=%.4f' % (
    lr.reduce((a, b) => a + b, 0) / lr.length, Math.min(...lr), Math.max(...lr)))
  console.log('  逐台 |Bt_sat - Bt_formula| 最大 = %.4f T' % Math.max(...lin.map((r) => Math.abs(r.btSat - r.btFormula))))
}

// 齿宽口径一致性
const twMatch = rec.filter((r) => r.twGiven && r.twBase && Math.abs(r.twGiven - r.twBase) < 0.01).length
const twGiven = rec.filter((r) => r.twGiven).length
console.log(`\n齿宽口径: 入参 tooth_width 有值 ${twGiven} 台，其中 sat 通道 base 与入参一致 ${twMatch} 台`)
console.log('  sat 通道 effective/base 样本:', rec.slice(0, 3).map((r) => `${r.twEff?.toFixed(2)}/${r.twBase?.toFixed(2)}`).join('  '))

// 输出明细表（前 8 台）
console.log('\n明细（前 8 台）:')
console.log('tag'.padEnd(22) + 'p'.padStart(3) + 'Bt_form'.padStart(9) + 'Bt_sat'.padStart(9) + '比值'.padStart(8) + 'tw_giv'.padStart(8) + 'tw_base'.padStart(8) + 'tw_eff'.padStart(8) + 'sat')
for (const r of rec.slice(0, 8)) {
  console.log(r.tag.padEnd(22) + String(r.poles).padStart(3)
    + r.btFormula.toFixed(3).padStart(9) + r.btSat.toFixed(3).padStart(9)
    + (r.btSat / r.btFormula).toFixed(3).padStart(8)
    + String(r.twGiven ?? '-').padStart(8) + String(r.twBase ?? '-').padStart(8)
    + String(r.twEff ?? '-').padStart(8) + String(r.satFlag))
}

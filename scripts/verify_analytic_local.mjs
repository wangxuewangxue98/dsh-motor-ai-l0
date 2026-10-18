/**
 * verify_analytic_local.mjs —— 解析通道 A/B/C 落地本地集成验证（零回归 + 新通道）
 * 运行：node scripts/verify_analytic_local.mjs
 */
import { runL0Estimate } from '../tools/l0/l0-estimate.mjs'
import { buildParamMatrix } from '../tools/l0/param-matrix.mjs'

const cfg = { freeQuotaEnabled: false, efficiencyCap: 96, tempRiseRange: [45, 130], insulationClass: 'F' }
const spec = { power_kw: 15, speed_rpm: 1460, voltage: 380, count: 6 }
const { matrix } = buildParamMatrix(spec, cfg)
console.log('[buildParamMatrix] matrix size =', matrix.length, '| sample slots =', matrix[0]?.slots_stator)

function run(mode, extra = {}) {
  return runL0Estimate({ params_list: matrix, top_n: 3 }, { ...cfg, l0Mode: mode, ...extra })
}

// 1. formula 回归基线
const rForm = run('formula')
console.log('\n[1] formula 回归: l0_mode=%s results=%d eff0=%s feasible0=%s',
  rForm.l0_mode, rForm.results.length, rForm.results[0]?.efficiency, rForm.results[0]?.feasible)

// 2. analytic off（骨架：公式基线 + 元数据）
process.env.DSH_L0_ANALYTIC = 'off'
const rOff = run('analytic')
console.log('[2] analytic off: l0_mode=%s analytic_mode=%s pred_src=%s note=%s',
  rOff.l0_mode, rOff.analytic_mode, rOff.results[0]?.prediction_source, rOff.analytic_note ? 'present' : 'MISSING')

// 3. analytic on（迭代增强）
process.env.DSH_L0_ANALYTIC = 'on'
const rOn = run('analytic')
const top = rOn.results[0]
console.log('[3] analytic on: l0_mode=%s analytic_mode=%s eff0=%s temp0=%s sat=%s',
  rOn.l0_mode, rOn.analytic_mode, top?.efficiency, top?.temp_rise,
  JSON.stringify(top?.analytic_refined?.saturation))
console.log('    analytic_calibrated=%s analytic_experimental=%s',
  top?.analytic_calibrated, top?.analytic_experimental)

// 4. param-matrix 槽数覆盖（C/S1）
const spec2 = { power_kw: 15, speed_rpm: 1460, voltage: 380, count: 4, slots_stator: 48, rotor_slots: 44 }
const { matrix: m2 } = buildParamMatrix(spec2, cfg)
const all48 = m2.every((r) => r.slots_stator === 48)
const all44 = m2.every((r) => r.slots_rotor === 44)
const { matrix: m3 } = buildParamMatrix({ power_kw: 15, speed_rpm: 1460, voltage: 380, count: 4 }, cfg)
console.log('\n[4] C/S1 槽数覆盖: override slots_stator==48? %s (sample %d) | slots_rotor==44? %s (sample %d) | 默认 slots_stator=%d',
  all48, m2[0]?.slots_stator, all44, m2[0]?.slots_rotor, m3[0]?.slots_stator)

// ── 断言 ──
const checks = []
checks.push(['formula 基线可用', rForm.l0_mode === 'formula' && rForm.results.length > 0])
checks.push(['analytic off 走骨架', rOff.l0_mode === 'analytic' && rOff.analytic_mode === 'off' && !!rOff.analytic_note])
checks.push(['analytic on 走迭代', rOn.l0_mode === 'analytic' && rOn.analytic_mode === 'on' && top?.analytic_experimental === true])
checks.push(['analytic on 未伪造高置信', top?.analytic_calibrated === false])
checks.push(['C/S1 槽数覆盖生效', all48 && all44])
checks.push(['C/S1 默认slot不变', m3[0]?.slots_stator !== 48])
// 权威字段不被未标定迭代值污染（预校准期安全边界）
checks.push(['权威 temp_rise 未被覆盖', rForm.results[0]?.temp_rise === rOn.results[0]?.temp_rise])
checks.push(['权威 yoke 磁密未被覆盖', rForm.results[0]?.yoke_flux_density === rOn.results[0]?.yoke_flux_density])
// 实验附字段独立存在且物理有界（加固：防止 P0 轭密放大 bug 回潮——旧 bug 曾输出 3.5T）
checks.push(['实验附字段独立且物理有界', typeof top?.yoke_flux_density_analytic === 'number' && top?.yoke_flux_density_analytic !== top?.yoke_flux_density && top?.yoke_flux_density_analytic > 0 && top?.yoke_flux_density_analytic < 2.2])
let ok = true
console.log('\n=== 断言 ===')
for (const [name, pass] of checks) {
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}`)
  if (!pass) ok = false
}
console.log(ok ? '\nALL PASS ✅' : '\nSOME FAILED ❌')
process.exit(ok ? 0 : 1)

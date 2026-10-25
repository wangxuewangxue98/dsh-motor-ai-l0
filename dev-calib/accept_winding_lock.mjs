/**
 * P2-A 绕组锁定 65 台真值验收（lock ON vs OFF）
 * 口径：N = (Qs/3)·(cps/2)/a（cps 优先，与 RMxprt 求解器口径一致）
 *       Φ = Uph/(4.44·f·N·kw_eff)，kw_eff=0.697（65 台反算标定）
 * 运行：node dev-calib/accept_winding_lock.mjs
 */
import { quickL0Estimate } from '@wangxue98/dsh-motor-ai-core'
import { readFileSync } from 'node:fs'

const truth = JSON.parse(readFileSync('D:/dsh-motor-ai-l0/output/p2_real_truth.json', 'utf8')).rows
const rec = []
for (const r of truth) {
  if (!r.solve_ok) continue
  const i = r.inputs
  const row = {
    stator_od: i.stator_od, stator_id: i.stator_id, air_gap: i.air_gap,
    slots_stator: i.slots_stator, poles: i.poles, voltage: i.voltage,
    speed: i.speed ?? i.speed_rpm, core_length: i.core_length, power_kw: i.power ?? i.power_kw,
    motor_type: 'induction', cooling: i.cooling ?? 'forced_air',
    yoke_thickness: i.yoke_thickness,
    turns_per_coil: i.turns_per_coil, conductors_per_slot: i.conductors_per_slot,
    parallel_circuits: i.parallel_circuits ?? 1,
  }
  let off, on
  try {
    off = quickL0Estimate(row, {})
    on = quickL0Estimate(row, { windingLock: true })
  } catch { continue }
  const btT = Number(r.rmxprt?.stator_tooth_flux_density)
  const bgT = Number(r.rmxprt?.air_gap_flux_density)
  if (!Number.isFinite(bgT)) continue
  rec.push({
    tag: r.tag, poles: i.poles,
    bgOff: off.air_gap_flux_density_effective, bgOn: on.air_gap_flux_density_effective,
    bgTruth: bgT, btOff: off.tooth_flux_density_actual, btOn: on.tooth_flux_density_actual,
    btTruth: btT, wl: on.winding_lock,
  })
}

const mape = (a, b) => a.reduce((s, x, k) => s + Math.abs(x / b[k] - 1), 0) / a.length * 100
const bias = (a, b) => (a.reduce((s, x, k) => s + x / b[k], 0) / a.length - 1) * 100
const pearson = (x, y) => {
  const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n
  const sxx = x.reduce((s, a) => s + (a - mx) ** 2, 0), syy = y.reduce((s, b) => s + (b - my) ** 2, 0)
  const sxy = x.reduce((s, a, k) => s + (a - mx) * (y[k] - my), 0)
  return sxy / Math.sqrt(sxx * syy)
}

console.log(`n = ${rec.length} 台，winding_lock 生效 ${rec.filter((r) => r.wl).length} 台\n`)
const btOk = rec.filter((r) => Number.isFinite(r.btTruth))
console.log('字段'.padEnd(20) + 'MAPE'.padStart(9) + '偏差'.padStart(10) + 'pearson'.padStart(9))
for (const [name, offK, onK] of [['Bg', 'bgOff', 'bgOn'], ['Bt', 'btOff', 'btOn']]) {
  const truK = name === 'Bg' ? 'bgTruth' : 'btTruth'
  const rows = rec.filter((r) => Number.isFinite(r[truK]))
  const off = rows.map((r) => r[offK]), on = rows.map((r) => r[onK]), tru = rows.map((r) => r[truK])
  console.log(`${name} lock=OFF`.padEnd(20) + mape(off, tru).toFixed(1).padStart(8) + '%'
    + bias(off, tru).toFixed(1).padStart(9) + '%' + pearson(off, tru).toFixed(3).padStart(9))
  console.log(`${name} lock=ON `.padEnd(20) + mape(on, tru).toFixed(1).padStart(8) + '%'
    + bias(on, tru).toFixed(1).padStart(9) + '%' + pearson(on, tru).toFixed(3).padStart(9))
  console.log('')
}

console.log('分族（Bg lock ON vs 真值）:')
const fam = {}
for (const r of rec) {
  const k = `p=${r.poles}`
  if (!fam[k]) fam[k] = []
  fam[k].push(r)
}
for (const k of Object.keys(fam).sort()) {
  const v = fam[k]
  const on = v.map((r) => r.bgOn), tru = v.map((r) => r.bgTruth)
  console.log(`  ${k.padEnd(6)} n=${String(v.length).padStart(2)}  估算 ${Math.min(...on).toFixed(2)}~${Math.max(...on).toFixed(2)}T`
    + `  真值 ${Math.min(...tru).toFixed(2)}~${Math.max(...tru).toFixed(2)}T  MAPE ${mape(on, tru).toFixed(1)}%`)
}

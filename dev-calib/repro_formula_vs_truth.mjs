/**
 * formula-engine 基线口径（quickL0Estimate，MD-SDE 实际读取的口径）
 * 与 65 台 RMxprt 真值的偏差量化（只读分析）
 */
import { quickL0Estimate } from '@wangxue98/dsh-motor-ai-core'
import { readFileSync } from 'node:fs'

const truth = JSON.parse(readFileSync('D:/dsh-motor-ai-l0/output/p2_real_truth.json', 'utf8')).rows
const cat = JSON.parse(readFileSync('D:/dsh-motor-ai-l0/dev-calib/real_slot_catalogue.json', 'utf8')).rows
const catByTag = new Map(cat.map((r) => [r.tag, r]))

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
  const btT = Number(r.rmxprt?.stator_tooth_flux_density)
  const byT = Number(r.rmxprt?.stator_yoke_flux_density)
  const bgT = Number(r.rmxprt?.air_gap_flux_density)
  if (!Number.isFinite(btT)) continue
  rec.push({
    tag: r.tag, poles: i.poles, P: i.power_kw,
    btEst: e.tooth_flux_density, btTruth: btT,
    byEst: e.yoke_flux_density, byTruth: byT, bgEst: e.air_gap_flux_density, bgTruth: bgT,
  })
}

const mape = (a, b) => (a.reduce((s, x, k) => s + Math.abs(x / b[k] - 1), 0) / a.length) * 100
const bias = (a, b) => ((a.reduce((s, x, k) => s + x / b[k], 0) / a.length) - 1) * 100
const pearson = (x, y) => {
  const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n
  const sxx = x.reduce((s, a) => s + (a - mx) ** 2, 0), syy = y.reduce((s, b) => s + (b - my) ** 2, 0)
  const sxy = x.reduce((s, a, k) => s + (a - mx) * (y[k] - my), 0)
  return sxy / Math.sqrt(sxx * syy)
}

console.log(`n = ${rec.length} 台（65 台真值集中 solve_ok 且有齿磁密真值）\n`)
console.log('字段'.padEnd(14) + 'MAPE'.padStart(8) + '偏差'.padStart(9) + 'pearson'.padStart(9) + '  估算范围'.padStart(22) + '真值范围')
const rows = [
  ['齿磁密 Bt', rec.map((r) => r.btEst), rec.map((r) => r.btTruth)],
  ['轭磁密 By', rec.map((r) => r.byEst), rec.map((r) => r.byTruth)],
  ['气隙磁密 Bg', rec.map((r) => r.bgEst), rec.map((r) => r.bgTruth)],
]
for (const [name, est, tru] of rows) {
  const ok = tru.filter(Number.isFinite)
  console.log(name.padEnd(14)
    + mape(est.slice(0, ok.length), ok).toFixed(1).padStart(7) + '%'
    + (bias(est.slice(0, ok.length), ok).toFixed(1) + '%').padStart(9)
    + pearson(est.slice(0, ok.length), ok).toFixed(3).padStart(9)
    + ('[' + Math.min(...est).toFixed(2) + ',' + Math.max(...est).toFixed(2) + ']').padStart(22)
    + ('[' + Math.min(...ok).toFixed(2) + ',' + Math.max(...ok).toFixed(2) + ']').padStart(20))
}

console.log('\n齿磁密估算值分布（应验证「钢印」）：')
const btEsts = rec.map((r) => r.btEst)
const uniq = [...new Set(btEsts.map((v) => v.toFixed(2)))].sort()
console.log(`  去重值: ${uniq.join(', ')}  (n=${btEsts.length}, 去重 ${uniq.length} 个)`)
console.log(`  极差: ${(Math.max(...btEsts) - Math.min(...btEsts)).toFixed(4)}T`)

console.log('\n分族明细（齿磁密 估算 vs 真值）：')
const fam = {}
for (const r of rec) {
  const k = `p=${r.poles} P=${r.P}kW`
  if (!fam[k]) fam[k] = []
  fam[k].push(r)
}
for (const k of Object.keys(fam).sort()) {
  const v = fam[k]
  const ests = v.map((r) => r.btEst), trus = v.map((r) => r.btTruth)
  console.log(`  ${k.padEnd(16)} n=${String(v.length).padStart(2)}  估算 ${Math.min(...ests).toFixed(2)}~${Math.max(...ests).toFixed(2)}T`
    + `  真值 ${Math.min(...trus).toFixed(2)}~${Math.max(...trus).toFixed(2)}T`
    + `  比值均值 ${(ests.reduce((s, x, i2) => s + x / trus[i2], 0) / v.length).toFixed(2)}`)
}

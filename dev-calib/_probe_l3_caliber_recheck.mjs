// L3 口径核对复跑探针（只读）：50 默认可行三口径统计 + tw 覆写行的 actual≡intent 验证
// 对标并行会话取证记录，用第一方数据验证其统计底座。
import { buildParamMatrix } from '../tools/l0/param-matrix.mjs'
import { quickL0Estimate } from '@wangxue98/dsh-motor-ai-core'

const SPEC = { power_kw: 450, speed_rpm: 985, voltage_v: 690, poles: 6, cooling: 'forced_air', insulation_class: 'H', motor_type: 'induction' }
const CFG = { freeQuotaEnabled: false }

const stat = (vals, name) => {
  const v = vals.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) { console.log(`${name}: n=0`); return null }
  const q = (p) => v[Math.min(v.length - 1, Math.floor(v.length * p))]
  console.log(`${name}: n=${v.length} min=${v[0].toFixed(3)} p25=${q(0.25).toFixed(3)} median=${q(0.5).toFixed(3)} p75=${q(0.75).toFixed(3)} max=${v[v.length - 1].toFixed(3)}`)
  return v
}

const m = buildParamMatrix({ ...SPEC, count: 50 }, CFG)
const rows = m.matrix
console.log('=== 池构成 ===')
console.log('rows =', rows.length, '| feasible(估计器口径,未过估) = n/a')

const est = rows.map((r) => { try { return { r, e: quickL0Estimate(r, {}) } } catch (err) { return { r, e: null, err } } })
const okEst = est.filter((x) => x.e)
console.log('estimate ok =', okEst.length, '/', est.length)

console.log('\n=== 三口径统计（50 行） ===')
stat(okEst.map((x) => x.e.tooth_flux_density), 'Bt 意图口径 tooth_flux_density   ')
const actualVals = okEst.map((x) => x.e.tooth_flux_density_actual).filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v)))
console.log('Bt 实际口径 actual 非空行 =', actualVals.length, '/', okEst.length)
stat(actualVals.map(Number), 'Bt 实际口径 tooth_flux_density_actual')
const bgNull = okEst.filter((x) => x.e.air_gap_flux_density_actual === null || x.e.air_gap_flux_density_actual === undefined).length
console.log('air_gap_flux_density_actual = null 行 =', bgNull, '/', okEst.length, '(null 时消费方回退意图口径 ⇒ actual≡intent)')
const sameIa = okEst.filter((x) => Math.abs((x.e.tooth_flux_density_actual ?? x.e.tooth_flux_density) - x.e.tooth_flux_density) < 1e-9).length
console.log('actual≡intent 的 Bt 行 =', sameIa, '/', okEst.length)

console.log('\n=== vs MD-SDE 带宽 ===')
const inBandI = okEst.filter((x) => x.e.tooth_flux_density >= 1.4 && x.e.tooth_flux_density <= 1.7).length
const inBandA = okEst.filter((x) => { const b = x.e.tooth_flux_density_actual ?? x.e.tooth_flux_density; return b >= 1.4 && b <= 1.7 }).length
console.log('意图口径命中 [1.4,1.7]:', inBandI, '/', okEst.length)
console.log('实际口径命中 [1.4,1.7]:', inBandA, '/', okEst.length)

console.log('\n=== fill 口径倍率 ===')
const ratios = []
for (const x of okEst) {
  const eng = x.e.slot_fill_engineering
  const geo = x.e.slot_fill_ratio
  if (Number.isFinite(Number(eng)) && Number.isFinite(Number(geo)) && Number(geo) > 0) ratios.push(Number(eng) / Number(geo))
}
stat(ratios, 'fill 工程/几何倍率                 ')

console.log('\n=== tw 覆写行：actual≡intent 验证 ===')
const ctl = rows[10]
const base = quickL0Estimate(ctl, {})
const tw0 = ctl.tooth_width
console.log('控制行: tw =', tw0, '| Bt intent =', base.tooth_flux_density, '| Bt actual =', base.tooth_flux_density_actual, '| bgActual =', base.air_gap_flux_density_actual)
for (const f of [0.6, 0.5]) {
  const v = { ...ctl, tooth_width: Number((tw0 * f).toFixed(3)) }
  const ev = quickL0Estimate(v, {})
  const expI = base.tooth_flux_density / f
  const expA = (base.tooth_flux_density_actual ?? base.tooth_flux_density) / f
  console.log(`覆写 f=${f}: tw=${v.tooth_width} | Bt intent=${ev.tooth_flux_density} (期望≈${expI.toFixed(3)}) | Bt actual=${ev.tooth_flux_density_actual} (期望≈${expA.toFixed(3)}) | bgActual=${ev.air_gap_flux_density_actual} | intent≡actual? ${Math.abs(ev.tooth_flux_density_actual - ev.tooth_flux_density) < 1e-9}`)
}

console.log('\n=== V07 门禁参照（core 侧目标 1.02T / fail 1.53T）===')
const over = okEst.filter((x) => (x.e.tooth_flux_density_actual ?? x.e.tooth_flux_density) > 1.53).length
console.log('实际口径 Bt > 1.53T 行 =', over, '/', okEst.length)

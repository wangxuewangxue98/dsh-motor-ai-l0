/**
 * calib_k_shape.mjs — 用 ≥30 台「真机型谱 + 显式自洽槽形」真值，检验 toothShapeK() 等效齿宽模型
 *
 * 待回答的两个问题：
 *   ① 解析吃「最小截面齿宽」(齿顶宽) 时，K = Bt_analytic / Bt_rmxprt 是否随齿形梯形度 τ 单调？
 *   ② 若把 k = toothShapeK(齿顶宽, 齿根宽) = 平均宽/最小宽 代进去，K 是否收敛到 1.0？
 *      —— 若是，C 的模型形式成立；若否，需换等效方式（几何均值/调和均值/1/3 截面）。
 *
 * 输入：output/p2_real_truth.json（run_p2_real_truth.py 产出）+ dev-calib/real_slot_catalogue.json
 * 用法：node dev-calib/calib_k_shape.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const L0ROOT = 'D:/dsh-motor-ai-l0'
const core = await import(pathToFileURL(resolve(L0ROOT, 'node_modules/@wangxue98/dsh-motor-ai-core/index.mjs')).href)
const { quickL0Estimate, toothShapeK, effectiveToothWidth } = core
const { doSaturationLoop } = await import(pathToFileURL(resolve(L0ROOT, 'tools/l0/analytic-engine.mjs')).href)

const TRUTH = process.env.TRUTH_JSON ? resolve(process.env.TRUTH_JSON)
  : resolve(L0ROOT, 'output/p2_real_truth.json')
const CAT = resolve(L0ROOT, 'dev-calib/real_slot_catalogue.json')
const OUT = process.env.KCAL_OUT ? resolve(process.env.KCAL_OUT)
  : resolve(L0ROOT, 'output/p2_k_shape_calib.json')

const truth = JSON.parse(readFileSync(TRUTH, 'utf8'))
const cat = JSON.parse(readFileSync(CAT, 'utf8'))
const catByTag = new Map(cat.rows.map(r => [r.tag, r]))

function analytic(i, tw, kShape) {
  const est = quickL0Estimate({
    stator_od: i.stator_od, stator_id: i.stator_id, air_gap: i.air_gap,
    slots_stator: i.slots_stator, poles: i.poles, voltage: i.voltage,
    speed: i.speed, motor_type: 'induction', cooling: 'forced_air',
    parallel_circuits: i.parallel_circuits, core_length: i.core_length, power_kw: i.power,
  })
  const g = {
    B_delta_base: est.air_gap_flux_density_actual ?? 0.8,
    B_t_base: est.tooth_flux_density ?? 0,
    B_y_base: est.yoke_flux_density ?? 0,
    statorId: i.stator_id, statorOd: i.stator_od,
    yokeThickness: geomOf(i).yoke, toothWidth: tw,
    airGap: i.air_gap, slotsStator: i.slots_stator, poles: i.poles,
    coreLength: i.core_length,
  }
  return doSaturationLoop({ ...g, kShape })
}
function geomOf(i) { return catByTag.get(i.tag).geom }
function estBg(i) {
  const est = quickL0Estimate({
    stator_od: i.stator_od, stator_id: i.stator_id, air_gap: i.air_gap,
    slots_stator: i.slots_stator, poles: i.poles, voltage: i.voltage,
    speed: i.speed, motor_type: 'induction', cooling: 'forced_air',
    parallel_circuits: i.parallel_circuits, core_length: i.core_length, power_kw: i.power,
  })
  return est.air_gap_flux_density_actual ?? est.air_gap_flux_density ?? 0
}
function twOf(i) {
  const c = catByTag.get(i.tag)
  return { top: c.geom.tw_top_mm, root: c.geom.tw_root_mm, tau: c.geom.tau_effective }
}

// ── 组装可用行 ────────────────────────────────────────────────
const rows = []
for (const r of truth.rows) {
  if (!r.solve_ok) continue
  const bt = Number(r.rmxprt?.stator_tooth_flux_density)
  if (!(bt > 0.05)) continue
  const g = geomOf(r.inputs)
  const { top, root, tau } = twOf(r.inputs)
  const kAvg = (top + root) / 2 / Math.min(top, root)
  const kGeo = Math.sqrt(top * root) / Math.min(top, root)
  const kHarm = (2 / (1 / top + 1 / root)) / Math.min(top, root)
  const kThird = (top + (root - top) / 3) / Math.min(top, root)
  rows.push({ tag: r.tag, inputs: r.inputs, poles: r.inputs.poles, P: r.inputs.power, bt, g, top, root, tau,
              kAvg, kGeo, kHarm, kThird,
              by: Number(r.rmxprt?.stator_yoke_flux_density),
              bg: Number(r.rmxprt?.air_gap_flux_density) })
}
console.log(`[load] 真值可用 ${rows.length} 台（总 ${truth.total}）`)

const VARIANTS = [
  { id: 'k=1（齿顶/最小截面）', k: r => 1 },
  { id: 'k=avg/min（toothShapeK）', k: r => r.kAvg },
  { id: 'k=geo/min', k: r => r.kGeo },
  { id: 'k=harmonic/min', k: r => r.kHarm },
  { id: 'k=1/3截面/min', k: r => r.kThird },
]

function stats(xs, ys) {
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxx = 0, sxy = 0, syy = 0
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy }
  const slope = sxx > 0 ? sxy / sxx : 0
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0
  return { mx, my, slope, r2 }
}

console.log('\n=== ① 五种等效宽口径的解析 Bt 对 RMxprt 真值 ===')
console.log('口径'.padEnd(28) + '偏差(mean K−1)'.padStart(16) + 'MAPE'.padStart(9) + 'MAE(T)'.padStart(9) + 'R²'.padStart(8))
const perVariant = {}
for (const v of VARIANTS) {
  const pred = [], obs = []
  let bias = 0, mape = 0, mae = 0
  for (const r of rows) {
    const out = analytic(r.inputs, r.top, v.k(r))
    const bt = out.B_t
    pred.push(bt); obs.push(r.bt)
    const k = bt / r.bt
    bias += k - 1
    mape += Math.abs(k - 1)
    mae += Math.abs(bt - r.bt)
  }
  const n = rows.length
  const st = stats(pred, obs)
  perVariant[v.id] = { bias: bias / n, mape: mape / n, mae: mae / n, r2: st.r2, slope: st.slope }
  console.log(v.id.padEnd(28) + `${(bias / n * 100).toFixed(2)}%`.padStart(16) +
    `${(mape / n * 100).toFixed(2)}%`.padStart(9) + `${(mae / n).toFixed(4)}`.padStart(9) +
    `${st.r2.toFixed(3)}`.padStart(8))
}

console.log('\n=== ② 逐台明细（k=1 与 k=avg/min）===')
console.log('机型'.padEnd(11) + 'p'.padStart(2) + '  kW'.padStart(7) + 'τ'.padStart(6) + '齿顶'.padStart(7) + '齿根'.padStart(7) +
  'Bt真值'.padStart(9) + 'K(k=1)'.padStart(9) + 'K(k=avg)'.padStart(10))
for (const r of rows) {
  const b1 = analytic(r.inputs, r.top, 1).B_t
  const b2 = analytic(r.inputs, r.top, r.kAvg).B_t
  console.log(r.tag.padEnd(11) + String(r.poles).padStart(2) + String(r.P).padStart(7) +
    r.tau.toFixed(2).padStart(6) + r.top.toFixed(2).padStart(7) + r.root.toFixed(2).padStart(7) +
    r.bt.toFixed(4).padStart(9) + (b1 / r.bt).toFixed(3).padStart(9) + (b2 / r.bt).toFixed(3).padStart(10))
}

console.log('\n=== ③ 核心检验：观测所需 k_fit 是否等于 avg/min ===')
// k_fit：二分出让解析 Bt 命中真值的 k
const pairs = []
for (const r of rows) {
  let lo = 0.3, hi = 6
  for (let i = 0; i < 70; i++) {
    const mid = (lo + hi) / 2
    if (analytic(r.inputs, r.top, mid).B_t > r.bt) lo = mid; else hi = mid
  }
  r.kFit = (lo + hi) / 2
  r.bt0 = analytic(r.inputs, r.top, 1).B_t          // k=1 解析 Bt（第一遍）
  r.btAvg = analytic(r.inputs, r.top, r.kAvg).B_t    // avg/min 解析 Bt
  r.bgEst = estBg(r.inputs)                           // 解析气隙磁密（诊断用）
  pairs.push({ tag: r.tag, tau: r.tau, kFit: r.kFit, kAvg: r.kAvg, kGeo: r.kGeo, kHarm: r.kHarm,
               btTruth: r.bt, bt0: r.bt0, btAvg: r.btAvg, bgEst: r.bgEst, bgTruth: r.bg })
}
const kf = pairs.map(p => p.kFit), ka = pairs.map(p => p.kAvg)
const st = stats(ka, kf)
console.log(`  k_fit 均值=${(kf.reduce((a, b) => a + b, 0) / kf.length).toFixed(3)}  ` +
  `范围 [${Math.min(...kf).toFixed(3)}, ${Math.max(...kf).toFixed(3)}]`)
console.log(`  回归 k_fit ~ k_avg : 斜率=${st.slope.toFixed(3)} R²=${st.r2.toFixed(3)}`)
const devAvg = pairs.map(p => (p.kAvg - p.kFit) / p.kFit)
const devGeo = pairs.map(p => (p.kGeo - p.kFit) / p.kFit)
const devHarm = pairs.map(p => (p.kHarm - p.kFit) / p.kFit)
const ab = a => a.reduce((s, x) => s + Math.abs(x), 0) / a.length
console.log(`  |k_avg−k_fit|/k_fit 均值=${(ab(devAvg) * 100).toFixed(1)}%  ` +
  `|k_geo−k_fit|=${(ab(devGeo) * 100).toFixed(1)}%  |k_harm−k_fit|=${(ab(devHarm) * 100).toFixed(1)}%`)

console.log('\n=== ④ By 真值分布（轭厚按 By≤1.55T 准则反解，**不可用于 By 标定**）===')
const bys = rows.map(r => r.by).filter(x => Number.isFinite(x) && x > 0).sort((a, b) => a - b)
if (bys.length) {
  const med = bys[Math.floor(bys.length / 2)]
  console.log(`  n=${bys.length} 中位=${med.toFixed(3)}T 范围=[${bys[0].toFixed(3)}, ${bys[bys.length - 1].toFixed(3)}]T`)
  console.log(`  >2.0T: ${bys.filter(x => x > 2.0).length} 台   >1.8T: ${bys.filter(x => x > 1.8).length} 台`)
} else {
  console.log('  无可用 By')
}

const fs = await import('node:fs')
const out = {
  generated_by: 'dev-calib/calib_k_shape.mjs',
  n: rows.length,
  variants: perVariant,
  kfit: { mean: kf.reduce((a, b) => a + b, 0) / kf.length, min: Math.min(...kf), max: Math.max(...kf),
          slope_vs_kavg: st.slope, r2_vs_kavg: st.r2,
          mape_avg: ab(devAvg), mape_geo: ab(devGeo), mape_harm: ab(devHarm) },
  detail: pairs,
  by: { n: bys.length, median: bys.length ? bys[Math.floor(bys.length / 2)] : null,
        min: bys[0] ?? null, max: bys[bys.length - 1] ?? null,
        n_gt_2: bys.filter(x => x > 2.0).length },
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 1))
console.log('\n[done] → ' + OUT)

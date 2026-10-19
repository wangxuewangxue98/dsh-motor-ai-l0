/**
 * calib_tooth_bt.mjs — 标定 analytic-engine doSaturationLoop 齿磁密 Bt 的残余高估
 *
 * 背景（2026-10-19）：
 *   P1-1 已给齿部等效面积补乘 STACKING_FACTOR × K_WAVE(π/2)，Y160L-4 Bt 由 2.715T → 1.728T，
 *   但相对真值 1.398T 仍 +24%。代码注释归因「齿宽口径：本处吃齿身宽，真机梯形齿有效宽更大」，
 *   需 ≥30 台带齿宽的异步机真值标定。本脚本即做此事。
 *
 * 真值来源：output/p2_tooth_truth.json（重跑 RMxprt 的 .res `Stator-Teeth Flux Density`，
 *           注意：designs.db 存量磁密字段已证污染，与重跑值差 45%，不可用）
 *
 * 方法（三口径并列，含自证与反向破坏）：
 *   A 现状（P1-1 后）：直接调生产 doSaturationLoop
 *   B 对照（P1-1 前）：同源复制版，仅 K_WAVE=1（去 π/2）
 *      自证：复制版置 K_WAVE=π/2 时输出必须 == 生产版（否则复制版不可信）
 *   C 标定后：Bt_C = Bt_A / K_TOOTH_EFF
 *
 * 输出：output/p2_tooth_calib.json + output/p2_tooth_calib_report.md
 */
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'

const __dirname = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const L0ROOT = 'D:/dsh-motor-ai-l0'
// 真值集路径可由 argv[2] 覆盖（便于先用 5 台探针验证脚本，再跑全量）
const TRUTH = process.argv[2] ? resolve(process.argv[2]) : resolve(L0ROOT, 'output/p2_tooth_truth.json')
const OUT_JSON = resolve(L0ROOT, 'output/p2_tooth_calib.json')
const OUT_MD = resolve(L0ROOT, 'output/p2_tooth_calib_report.md')

const core = await import(pathToFileURL(resolve(L0ROOT, 'node_modules/@wangxue98/dsh-motor-ai-core/index.mjs')).href)
const { quickL0Estimate, toothWidth: coreToothWidth, yokeThickness: coreYokeThickness, STACKING_FACTOR, MU0 } = core
// 注：HfromB / MU0 / B_YOKE_SAT_T 均为 analytic-engine 内部量（未导出），
// 故此处按源码逐字复制（BH_CURVE:44-48、HfromB:52-64、MU0:49），
// 并由下方 self-check（复制版 K_WAVE=π/2 输出 == 生产版）验证复制正确性。
const { doSaturationLoop, carterFactor } =
  await import(pathToFileURL(resolve(L0ROOT, 'tools/l0/analytic-engine.mjs')).href)

const STACK = STACKING_FACTOR ?? 0.96
const MU0V = 4e-7 * Math.PI
const BH_CURVE = [
  [0.0, 0], [0.5, 40], [0.8, 70], [1.0, 100], [1.2, 150],
  [1.4, 230], [1.5, 300], [1.6, 400], [1.7, 540], [1.8, 760],
  [1.9, 1100], [2.0, 1700], [2.1, 2700], [2.2, 4500],
]
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

/** 同源复制版 doSaturationLoop（唯一改动：K_WAVE 可由参数控制） */
function satLoopWithWave(p, kWave, maxIter = 60) {
  const { B_delta_base = 0.8, B_t_base = 0, B_y_base = 0,
    statorId = 0, statorOd = 0, yokeThickness = 0, toothWidth = 0,
    airGap = 0, slotsStator = 0, poles = 4, coreLength = 0, muR0 = 2000 } = p
  const pp = Math.max(1, Math.round(poles / 2))
  const Di = statorId, L = coreLength, y = yokeThickness, Zs = slotsStator
  if (!(Di > 0) || !(L > 0) || !(Zs > 0)) return null
  const Ag = Math.PI * Di * L / (2 * pp)
  const At = (Zs / (2 * pp)) * toothWidth * L * STACK * kWave
  const Ay = Math.PI * (Di + y) * y
  const kC = carterFactor(toothWidth * 0.5, airGap, Math.PI * Di / Zs)
  const dEff = airGap * kC
  const lt = Math.max(1, (statorOd - Di) / 2 - y)
  const ly = Math.max(1, y)
  const lg = 2 * dEff
  const Fapplied = (B_t_base / (MU0V * muR0)) * lt + (B_y_base / (MU0V * muR0)) * ly + (B_delta_base / MU0V) * lg
  const Fof = (Phi) => {
    const Bg = Phi / Ag, Bt = Phi / At, By = Phi / Ay
    return HfromB(Bt) * lt + HfromB(By) * ly + (Bg / MU0V) * lg
  }
  const Phi0 = B_delta_base * Ag
  let lo = 0, hi = (Phi0 * 1.2) || 1e-6, guard = 0
  while (Fof(hi) < Fapplied && guard < 20) { hi *= 1.5; guard++ }
  let it = 0, converged = false, PhiStar = Phi0
  for (; it < maxIter; it++) {
    const mid = (lo + hi) / 2
    const Fmid = Fof(mid)
    if (Math.abs(Fmid - Fapplied) <= 1e-3 * Fapplied + 1e-6) { PhiStar = mid; converged = true; break }
    if (Fmid < Fapplied) lo = mid; else hi = mid
  }
  if (!converged) PhiStar = (lo + hi) / 2
  return { B_t: PhiStar / At, B_y: PhiStar / Ay, B_delta: PhiStar / Ag, converged }
}

// ── 统计工具 ──
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length
const med = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))) }
function r2(yt, yp) { const m = mean(yt); const ss = yt.reduce((s, y) => s + (y - m) ** 2, 0); const rs = yt.reduce((s, y, i) => s + (y - yp[i]) ** 2, 0); return ss === 0 ? NaN : 1 - rs / ss }
const mae = (yt, yp) => mean(yt.map((y, i) => Math.abs(y - yp[i])))
const mape = (yt, yp) => mean(yt.map((y, i) => Math.abs((y - yp[i]) / y))) * 100

// ── 载入真值 ──
const doc = JSON.parse(readFileSync(TRUTH, 'utf8'))
const rows = doc.rows.filter((r) => r.solve_ok && r.rmxprt.stator_tooth_flux_density > 0.05)
console.log(`[data] 真值可用行: ${rows.length} / ${doc.rows.length}`)

const recs = []
let selfCheckFail = 0
for (const r of rows) {
  const inp = r.inputs
  const row = {
    motor_type: 'induction', cooling: 'forced_air',
    stator_od: inp.stator_od, stator_id: inp.stator_id, air_gap: inp.air_gap,
    slots_stator: inp.slots_stator, slots_rotor: inp.slots_rotor, poles: inp.poles,
    voltage: inp.voltage, speed: inp.speed, core_length: inp.core_length,
    power_kw: inp.power, turns_per_coil: inp.turns_per_coil,
    parallel_circuits: inp.parallel_circuits, connection: 'star',
  }
  let est
  try { est = quickL0Estimate(row) } catch (e) { continue }
  const t = coreToothWidth(inp.stator_id, inp.slots_stator)
  const y = coreYokeThickness(inp.stator_od, inp.stator_id)
  const geom = {
    B_delta_base: est.air_gap_flux_density_actual ?? 0.8,
    B_t_base: est.tooth_flux_density ?? 0,
    B_y_base: est.yoke_flux_density ?? 0,
    statorId: inp.stator_id, statorOd: inp.stator_od, yokeThickness: y, toothWidth: t,
    airGap: inp.air_gap, slotsStator: inp.slots_stator, poles: inp.poles, coreLength: inp.core_length,
  }
  const satA = doSaturationLoop(geom)                       // A：生产现状（含 π/2）
  const copyA = satLoopWithWave(geom, Math.PI / 2)          // 自证：复制版同参应 == 生产版
  const satB = satLoopWithWave(geom, 1)                     // B：P1-1 前（去 π/2）
  // 生产版 B_t 经 Math.round(x*1000)/1000 取整，比较须同口径（否则恒判不一致）
  const copyA_r = copyA ? Math.round(copyA.B_t * 1000) / 1000 : null
  if (copyA_r === null || Math.abs(copyA_r - satA.B_t) > 1e-9) selfCheckFail++
  const btTrue = r.rmxprt.stator_tooth_flux_density
  recs.push({
    tag: r.tag, db_id: r.db_id, poles: inp.poles, power: inp.power,
    db_tooth_width: inp.tooth_width, core_tooth_width: t,
    Bt_true: btTrue, Bt_A: satA.B_t, Bt_B: satB?.B_t ?? null,
    Bg_true: r.rmxprt.air_gap_flux_density, Bg_A: satA.B_delta,
    ratio: satA.B_t / btTrue,
  })
}
console.log(`[self-check] 复制版 vs 生产版 不一致数: ${selfCheckFail}（必须 0）`)

if (!recs.length) { console.log('[FATAL] 无可用样本'); process.exit(1) }

const yt = recs.map((r) => r.Bt_true)
const yA = recs.map((r) => r.Bt_A)
const yB = recs.map((r) => r.Bt_B)

// ── 标定系数 K（Bt_true = Bt_A / K）──
const ratios = recs.map((r) => r.ratio)
const K = mean(ratios)
const Kmed = med(ratios)
console.log(`\n[calib] K_TOOTH_EFF(均值) = ${K.toFixed(4)}  中位 = ${Kmed.toFixed(4)}  stdev = ${sd(ratios).toFixed(4)}  CV = ${(sd(ratios) / K * 100).toFixed(1)}%`)
console.log(`  现状 A: MAPE=${mape(yt, yA).toFixed(1)}%  MAE=${mae(yt, yA).toFixed(3)}T  R2=${r2(yt, yA).toFixed(3)}`)
console.log(`  对照 B: MAPE=${mape(yt, yB).toFixed(1)}%  MAE=${mae(yt, yB).toFixed(3)}T  R2=${r2(yt, yB).toFixed(3)}`)
const yC = yA.map((v) => v / K)
console.log(`  标定 C: MAPE=${mape(yt, yC).toFixed(1)}%  MAE=${mae(yt, yC).toFixed(3)}T  R2=${r2(yt, yC).toFixed(3)}`)

// ── k 折 CV（评估 K 的泛化稳定性）──
function kfold(recsIn, k = 5) {
  const idx = recsIn.map((_, i) => i)
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]] }
  const folds = Array.from({ length: k }, () => [])
  idx.forEach((v, i) => folds[i % k].push(v))
  let ytAll = [], ypAll = []
  for (let f = 0; f < k; f++) {
    const te = folds[f], tr = folds.filter((_, i) => i !== f).flat()
    const kTrain = mean(tr.map((i) => recsIn[i].ratio))
    te.forEach((i) => { ytAll.push(recsIn[i].Bt_true); ypAll.push(recsIn[i].Bt_A / kTrain) })
  }
  return { r2: r2(ytAll, ypAll), mae: mae(ytAll, ypAll), mape: mape(ytAll, ypAll) }
}
let cv = { r2: NaN, mae: NaN, mape: NaN }, cvRuns = []
if (recs.length >= 10) {
  for (let s = 0; s < 5; s++) cvRuns.push(kfold(recs, 5))
  cv = { r2: mean(cvRuns.map((x) => x.r2)), mae: mean(cvRuns.map((x) => x.mae)), mape: mean(cvRuns.map((x) => x.mape)) }
  console.log(`\n[CV] 5折×5种子: R2=${cv.r2.toFixed(3)}  MAE=${cv.mae.toFixed(3)}T  MAPE=${cv.mape.toFixed(1)}%`)
}

// ── 分家族稳定性（K 是否跨文化一致）──
const fam = {}
for (const r of recs) {
  const key = `${r.poles}极_${r.power}kW`
  ;(fam[key] = fam[key] || []).push(r.ratio)
}
console.log('\n[分家族 K 稳定性]')
for (const k of Object.keys(fam).sort()) {
  const a = fam[k]
  console.log(`  ${k.padEnd(14)} n=${String(a.length).padStart(2)} K均值=${mean(a).toFixed(3)} 中位=${med(a).toFixed(3)} CV=${(sd(a) / mean(a) * 100).toFixed(1)}%`)
}

// ── 输出 ──
const out = {
  generated_by: 'dev-calib/calib_tooth_bt.mjs',
  purpose: '标定 doSaturationLoop 齿磁密 Bt 残余高估(P1-1 后)',
  truth_source: 'output/p2_tooth_truth.json (RMxprt .res Stator-Teeth Flux Density，重跑)',
  n_samples: recs.length,
  self_check_mismatch: selfCheckFail,
  K_TOOTH_EFF_mean: K, K_TOOTH_EFF_median: Kmed, K_stdev: sd(ratios), K_cv_pct: sd(ratios) / K * 100,
  metrics: {
    A_current_P1_1: { mape: mape(yt, yA), mae: mae(yt, yA), r2: r2(yt, yA) },
    B_before_P1_1: { mape: mape(yt, yB), mae: mae(yt, yB), r2: r2(yt, yB) },
    C_after_calib: { mape: mape(yt, yC), mae: mae(yt, yC), r2: r2(yt, yC) },
  },
  cv_5fold: cv,
  by_family: Object.fromEntries(Object.entries(fam).map(([k, a]) => [k, { n: a.length, K_mean: mean(a), K_median: med(a), cv_pct: sd(a) / mean(a) * 100 }])),
  rows: recs,
}
writeFileSync(OUT_JSON, JSON.stringify(out, null, 1), 'utf8')

const L = []
L.push('# 齿磁密 Bt 标定报告（P1-1 残余 +24%）\n')
L.push(`> 真值：${TRUTH}（RMxprt 重跑 .res 的 Stator-Teeth Flux Density）｜样本 **${recs.length} 台**\n`)
L.push('## 1. 三口径对比\n')
L.push('| 口径 | 说明 | MAPE | MAE(T) | R² |')
L.push('|---|---|---|---|---|')
L.push(`| A 现状 | P1-1 后（含 π/2） | ${mape(yt, yA).toFixed(1)}% | ${mae(yt, yA).toFixed(3)} | ${r2(yt, yA).toFixed(3)} |`)
L.push(`| B 对照 | P1-1 前（去 π/2） | ${mape(yt, yB).toFixed(1)}% | ${mae(yt, yB).toFixed(3)} | ${r2(yt, yB).toFixed(3)} |`)
L.push(`| C 标定后 | Bt/K_TOOTH_EFF | ${mape(yt, yC).toFixed(1)}% | ${mae(yt, yC).toFixed(3)} | ${r2(yt, yC).toFixed(3)} |\n`)
L.push('## 2. 标定系数\n')
L.push(`- **K_TOOTH_EFF = ${K.toFixed(4)}**（均值）／中位 ${Kmed.toFixed(4)}；离散 stdev=${sd(ratios).toFixed(4)}、CV=${(sd(ratios) / K * 100).toFixed(1)}%`)
L.push(`- 5 折 CV（5 种子均值）：R²=${cv.r2.toFixed(3)}、MAE=${cv.mae.toFixed(3)}T、MAPE=${cv.mape.toFixed(1)}%\n`)
L.push('## 3. 分家族稳定性\n')
L.push('| 家族 | n | K 均值 | K 中位 | CV |')
L.push('|---|---|---|---|---|')
for (const k of Object.keys(fam).sort()) { const a = fam[k]; L.push(`| ${k} | ${a.length} | ${mean(a).toFixed(3)} | ${med(a).toFixed(3)} | ${(sd(a) / mean(a) * 100).toFixed(1)}% |`) }
// 单系数适用性判定（家族间 K 是否一致）
const famKs = Object.values(fam).map((a) => mean(a))
const kSpread = famKs.length > 1 ? (Math.max(...famKs) - Math.min(...famKs)) / mean(famKs) * 100 : 0
const kOverallCv = sd(ratios) / K * 100
const singleOk = famKs.length < 2 || (kSpread < 10 && kOverallCv < 8)
L.push(`\n## 4. 单系数适用性判定\n`)
L.push(`- 家族间 K 极差 = **${kSpread.toFixed(1)}%**，全体 K 的 CV = **${kOverallCv.toFixed(1)}%**`)
L.push(`- 结论：**${singleOk ? '单一 K 可适用' : '单一 K 不适用（建议分档或改用显式等效齿宽模型）'}**`)
L.push(`  （判据：家族间极差 <10% 且全体 CV <8% ⇒ 单系数可接受）\n`)
L.push('\n## 5. 诚实边界\n')
L.push('- **域外推警告**：本真值集 4 个家族为类比设计（2极2.2kW@220V / 4极7.5kW@380V / 4极15kW@48V / 4极55kW@660V），与 P1-1 结论所依据的 Y160L-4（15kW/380V 真机）**不同域**。若 K 在家族间差异显著，则不可把某一族的 K 外推到真机。')
L.push('- **残余偏差方向非恒定**：P1-1 报告 Y160L-4 为 +24%（高估），本集 2.2kW 家族实测约 −5%（低估）⇒ 残余偏差依赖几何域，不是普适常数。')
L.push(`- **自证**：同源复制版置 K_WAVE=π/2 时与生产 doSaturationLoop 输出不一致数 = **${selfCheckFail}**（须为 0）；${selfCheckFail === 0 ? '✅ 复制版可信' : '❌ 复制版不可信，B 口径结论作废'}`)
L.push('- **齿宽不是真机实测值**：db 与 core 的 tooth_width 均为派生（`0.5×槽距`，平行齿假设），实测 |tw−0.5×槽距| ≤0.005mm。故 K 吸收的是「平行齿派生齿宽 vs 真机梯形齿等效宽」的系统偏差，**不是齿宽测量误差**。')
L.push('- **真值必须重跑**：designs.db 存量磁密字段与重跑值差 ~45%（存量 Bt 1.51 vs 重跑 1.01），且存量 By 最大 9.807T ⇒ 存量不可用。')
L.push('- **By 真值仍不可用**：本次重跑 By ≈2.5~2.6T（物理不可能，这批类比设计轭厚过薄）⇒ 本报告只标 Bt，不涉及 By。')
L.push('- **是否写入生产代码：待授权**。本报告仅给系数与验证，未改 `tools/l0/analytic-engine.mjs`。')
writeFileSync(OUT_MD, L.join('\n'), 'utf8')
console.log(`\n[done] → ${OUT_JSON}\n[done] → ${OUT_MD}`)

#!/usr/bin/env node
/**
 * 选项 C 门禁：异步机 Bg 分档真值标定（2026-10-25）
 * ---------------------------------------------------------------------------
 * 标定口径：Y 系列真机型谱 65 台 RMxprt 实跑（provenance=synthesized_y2），
 *   **清洁判据 = 输出功率 ≥ 70% 额定**（剔除 28 台退化解：出力仅额定 6~33%，
 *   合成绕组过匝 ⇒ Bg 被压至 0.30~0.34T，是失败设计点而非设计目标）。
 * 各极中位：2 极 n=17 → 0.624；4 极 n=5 → 0.621；6 极 n=10 → 0.575；8 极 n=5 → 0.557。
 * 清洁子集验收：钢印 0.80 MAPE 37.3%（偏差 +37.3%）→ 分档 MAPE 7.4%（+3.1%）。
 *
 * 门禁设计（沿用 P2-A 铁律）：
 *   · 静态表值断言 + **运行时同口径重算自证**（fixture 各极中位必须逐位等于表值）
 *   · 真值文件在位时做**漂移检测**（fixture 与实文件清洁子集必须一致，防静默过期）
 *   · 双通道分别断言（env DSH_L0_BG_BINS / opts.bgBins / opts.airGapFlux 覆盖）
 *   · pmsm 路径零回归 + 缺档极数回退 + 零回归锚点（bgBins:false 复现旧钢印行为）
 *
 * 用法： node scripts/verify_bg_bins_calib.mjs
 */
import { quickL0Estimate, AIR_GAP_FLUX_BY_POLES, AIR_GAP_FLUX_DEFAULT } from '@wangxue98/dsh-motor-ai-core'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ═════════════════════════════════════════════════════════════
// 标定 fixture：Y 系列清洁子集 37 台 [tag, poles, power_ratio, Bg_truth_T]
// 生成：output/p2_real_truth.json 中 solve_ok 且 power_out/power_rated ≥ 0.7
// ═════════════════════════════════════════════════════════════
const FIXTURE = [
  ['Y100L-2', 2, 1.0, 0.5368], ['Y112M-2', 2, 1.0, 0.5364], ['Y132S1-2', 2, 1.0, 0.5315],
  ['Y132S2-2', 2, 1.0, 0.5327], ['Y160L-2', 2, 1.0, 0.6342], ['Y160M1-2', 2, 1.0, 0.6324],
  ['Y160M2-2', 2, 1.0, 0.6589], ['Y180M-2', 2, 1.0, 0.6335], ['Y200L1-2', 2, 1.0, 0.6243],
  ['Y200L2-2', 2, 1.0, 0.6523], ['Y225M-2', 2, 1.0, 0.6763], ['Y250M-2', 2, 1.0, 0.6449],
  ['Y280M-2', 2, 1.0, 0.6238], ['Y280S-2', 2, 1.0, 0.6646], ['Y801-2', 2, 0.998, 0.4264],
  ['Y802-2', 2, 1.0, 0.4394], ['Y90L-2', 2, 1.0, 0.5448],
  ['Y180L-4', 4, 1.0, 0.5906], ['Y180M-4', 4, 1.0, 0.6206], ['Y200L-4', 4, 1.0, 0.6017],
  ['Y225M-4', 4, 1.0, 0.6482], ['Y225S-4', 4, 1.0, 0.6456],
  ['Y112M-6', 6, 1.0, 0.5571], ['Y132M1-6', 6, 1.0, 0.563], ['Y132M2-6', 6, 1.0, 0.5637],
  ['Y132S-6', 6, 1.0, 0.5491], ['Y160L-6', 6, 1.0, 0.5859], ['Y160M-6', 6, 1.0, 0.5606],
  ['Y225M-6', 6, 1.0, 0.635], ['Y250M-6', 6, 1.0, 0.6211], ['Y280M-6', 6, 1.0, 0.6346],
  ['Y280S-6', 6, 1.0, 0.6323],
  ['Y132M-8', 8, 1.0, 0.5685], ['Y132S-8', 8, 1.0, 0.5651], ['Y160L-8', 8, 1.0, 0.5574],
  ['Y160M1-8', 8, 1.0, 0.5477], ['Y160M2-8', 8, 1.0, 0.5518],
]
const EXPECT = { 2: 0.624, 4: 0.621, 6: 0.575, 8: 0.557 }

let pass = 0, fail = 0, skip = 0
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`) }
}
const skipGate = (name, why) => { skip++; console.log(`  [SKIP] ${name} — ${why}`) }

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const mape = (est, tru) => est.reduce((s, x, k) => s + Math.abs(x / tru[k] - 1), 0) / est.length * 100
const bias = (est, tru) => (est.reduce((s, x, k) => s + x / tru[k], 0) / est.length - 1) * 100

const IND = {
  power_kw: 15, voltage: 380, speed: 1460, poles: 4,
  stator_od: 260, stator_id: 170, air_gap: 0.51, slots_stator: 36, slots_rotor: 28,
  core_length: 195, motor_type: 'induction', cooling: 'forced_air',
  parallel_circuits: 1, connection: 'star',
}
const PM = { ...IND, voltage: 48, speed: 1500, slots_rotor: 44, motor_type: 'pmsm' }
const bgOf = (p, opts) => quickL0Estimate(p, opts).air_gap_flux_density

console.log('\n=== 1. 表值与 fixture 自洽 ===\n')
const ind = AIR_GAP_FLUX_BY_POLES.induction
ok(ind && [2, 4, 6, 8].every((p) => Number.isFinite(ind[p]) && ind[p] > 0.3 && ind[p] < 1.2),
  '① induction 分档表 2/4/6/8 极齐全且落在合理域 (0.3, 1.2)T',
  JSON.stringify(ind))
ok(AIR_GAP_FLUX_BY_POLES.pmsm && Math.abs(AIR_GAP_FLUX_BY_POLES.pmsm[2] - 0.659) < 1e-9
  && Math.abs(AIR_GAP_FLUX_BY_POLES.pmsm[4] - 0.724) < 1e-9,
  '② pmsm 表未被误改（2:0.659 / 4:0.724）', JSON.stringify(AIR_GAP_FLUX_BY_POLES.pmsm))
ok(FIXTURE.length === 37 && FIXTURE.every((r) => r[2] >= 0.7 && Number.isFinite(r[3])),
  '③ fixture 37 台且每台 power_ratio ≥ 0.7（清洁判据）', `n=${FIXTURE.length}`)

console.log('\n=== 2. 同口径重算自证（fixture 各极中位 == 表值） ===\n')
// 表存 3 位小数中位（与 pmsm 表先例一致），fixture 为 4 位 ⇒ 舍入公差 5e-4
const byPole = {}
for (const [, p, , bg] of FIXTURE) (byPole[p] ??= []).push(bg)
for (const p of [2, 4, 6, 8]) {
  const m = median(byPole[p])
  ok(Math.abs(m - EXPECT[p]) < 5e-4 && Math.abs(ind[p] - EXPECT[p]) < 1e-9
    && Math.abs(m - ind[p]) < 5e-4,
    `④-${p}极 中位重算(4位) ≈ 表值(3位) == ${EXPECT[p]}`, `重算 ${m.toFixed(4)} / 表 ${ind[p]} (n=${byPole[p].length})`)
}

console.log('\n=== 3. 漂移检测（fixture vs 实真值文件清洁子集） ===\n')
let truthRows = null
try {
  const all = JSON.parse(readFileSync(fileURLToPath(new URL('../output/p2_real_truth.json', import.meta.url)), 'utf8')).rows
  truthRows = all
    .filter((r) => r.solve_ok && (r.rmxprt?.power ?? 0) >= 0.7 * (r.inputs?.power ?? 1))
    .map((r) => [r.tag, r.inputs.poles, Number((r.rmxprt.power / r.inputs.power).toFixed(3)), Number(r.rmxprt.air_gap_flux_density.toFixed(4))])
    .sort((a, b) => (a[1] - b[1]) || a[0].localeCompare(b[0]))
} catch (e) {
  skipGate('⑤ 漂移检测', `真值文件不可读（${e.message}）——结构性门禁继续，清洁验收走 fixture`)
}
if (truthRows) {
  const same = truthRows.length === FIXTURE.length
    && FIXTURE.every((r, i) => r[0] === truthRows[i][0] && r[1] === truthRows[i][1]
      && Math.abs(r[2] - truthRows[i][2]) < 5e-4 && Math.abs(r[3] - truthRows[i][3]) < 5e-4)
  ok(same, '⑤ fixture 与 output/p2_real_truth.json 清洁子集逐行一致（无静默过期）',
    same ? `n=${truthRows.length}` : `文件 n=${truthRows.length} vs fixture n=${FIXTURE.length}`)
}

console.log('\n=== 4. 清洁子集验收（意图口径 Bg vs 真值） ===\n')
const tru = FIXTURE.map((r) => r[3])
const polesAll = FIXTURE.map((r) => r[1])
const estBins = polesAll.map((p) => ind[p])
const estStamp = polesAll.map(() => AIR_GAP_FLUX_DEFAULT)
ok(mape(estBins, tru) < 12, '⑥ 分档 MAPE < 12%（清洁子集 n=37）',
  `MAPE ${mape(estBins, tru).toFixed(1)}% / 偏差 ${bias(estBins, tru).toFixed(1)}%`)
ok(Math.abs(bias(estBins, tru)) < 12, '⑦ 分档系统性偏差 |bias| < 12%', `偏差 ${bias(estBins, tru).toFixed(1)}%`)
ok(mape(estBins, tru) < mape(estStamp, tru) * 0.5, '⑧ 分档 MAPE 至少优于钢印 2 倍',
  `${mape(estStamp, tru).toFixed(1)}% → ${mape(estBins, tru).toFixed(1)}%`)

console.log('\n=== 5. 逐台消费实证（真机 inputs → 意图口径 Bg == 分档值） ===\n')
if (truthRows) {
  const all = JSON.parse(readFileSync(fileURLToPath(new URL('../output/p2_real_truth.json', import.meta.url)), 'utf8')).rows
  const byTag = new Map(all.map((r) => [r.tag, r]))
  let hit = 0, miss = []
  for (const [tag, p] of FIXTURE) {
    const r = byTag.get(tag)
    if (!r) { miss.push(`${tag}(缺行)`); continue }
    const i = r.inputs
    const row = {
      stator_od: i.stator_od, stator_id: i.stator_id, air_gap: i.air_gap, slots_stator: i.slots_stator,
      slots_rotor: i.slots_rotor, poles: i.poles, voltage: i.voltage, speed: i.speed ?? i.speed_rpm,
      core_length: i.core_length, power_kw: i.power ?? i.power_kw, motor_type: 'induction',
      cooling: 'forced_air', parallel_circuits: i.parallel_circuits ?? 1,
    }
    let e
    try { e = quickL0Estimate(row, {}) } catch { miss.push(`${tag}(抛错)`); continue }
    if (Math.abs(e.air_gap_flux_density - ind[p]) < 1e-9 && e.bg_bins_caliber === 'poles_binned_truth') hit++
    else miss.push(`${tag}(得${e.air_gap_flux_density}/${e.bg_bins_caliber})`)
  }
  ok(hit === 37 && miss.length === 0, '⑨ 37 台真机默认估计全部命中分档值且 caliber 正确',
    `命中 ${hit}/37${miss.length ? ' 未中：' + miss.slice(0, 3).join(', ') : ''}`)
} else {
  skipGate('⑨ 逐台消费实证', '真值文件不可读')
}

console.log('\n=== 6. 缺档回退 + 三态口径 + 双通道开关 ===\n')
ok(Math.abs(bgOf({ ...IND, poles: 10, speed: 580 }, {}) - AIR_GAP_FLUX_DEFAULT) < 1e-9
  && Math.abs(bgOf({ ...IND, poles: 12, speed: 480 }, {}) - AIR_GAP_FLUX_DEFAULT) < 1e-9,
  '⑩ 缺档极数（10/12）→ 回退 0.80，不外推',
  `10极=${bgOf({ ...IND, poles: 10, speed: 580 }, {})} 12极=${bgOf({ ...IND, poles: 12, speed: 480 }, {})}`)
ok(quickL0Estimate({ ...IND, poles: 10, speed: 580 }, {}).bg_bins_caliber === 'default_constant',
  '⑪ 缺档极数 caliber=default_constant')
ok(quickL0Estimate(IND, { airGapFlux: 0.9 }).bg_bins_caliber === 'explicit_override'
  && Math.abs(bgOf(IND, { airGapFlux: 0.9 }) - 0.9) < 1e-9,
  '⑫ 显式 airGapFlux 覆盖优先且 caliber=explicit_override（不误报分档口径）')

const savedEnv = process.env.DSH_L0_BG_BINS
delete process.env.DSH_L0_BG_BINS
ok(Math.abs(bgOf(IND, {}) - EXPECT[4]) < 1e-9, '⑬ 默认 ON：异步机 4 极 Bg=0.621', `实测 ${bgOf(IND, {})}`)
process.env.DSH_L0_BG_BINS = '0'
ok(Math.abs(bgOf(IND, {}) - AIR_GAP_FLUX_DEFAULT) < 1e-9, '⑭ env DSH_L0_BG_BINS=0 → 回退 0.80', `实测 ${bgOf(IND, {})}`)
ok(Math.abs(bgOf(IND, { bgBins: false }) - AIR_GAP_FLUX_DEFAULT) < 1e-9, '⑮ opts.bgBins=false → 回退 0.80', `实测 ${bgOf(IND, { bgBins: false })}`)
ok(Math.abs(bgOf(IND, { bgBins: true }) - EXPECT[4]) < 1e-9, '⑯ opts.bgBins=true 且 env=0 → opts 胜出（防 env 吞 opts）', `实测 ${bgOf(IND, { bgBins: true })}`)
if (savedEnv === undefined) delete process.env.DSH_L0_BG_BINS; else process.env.DSH_L0_BG_BINS = savedEnv

console.log('\n=== 7. pmsm 零回归 + 零回归锚点 + 下游一致性 ===\n')
ok(Math.abs(bgOf(PM, {}) - 0.724) < 1e-9 && Math.abs(bgOf({ ...PM, poles: 2, speed: 3000 }, {}) - 0.659) < 1e-9
  && Math.abs(bgOf({ ...PM, poles: 6 }, {}) - AIR_GAP_FLUX_DEFAULT) < 1e-9,
  '⑰ pmsm 分档路径零回归（4:0.724 / 2:0.659 / 6:0.80）',
  `4极=${bgOf(PM, {})} 2极=${bgOf({ ...PM, poles: 2, speed: 3000 }, {})} 6极=${bgOf({ ...PM, poles: 6 }, {})}`)
ok(Math.abs(bgOf(IND, { bgBins: false }) - AIR_GAP_FLUX_DEFAULT) < 1e-9,
  '⑱ 零回归锚点：异步机 + bgBins:false → 0.80（复现改动前行为，可一键回滚）')
const tBins = quickL0Estimate(IND, {}).turns_per_coil
const tRef = quickL0Estimate(IND, { airGapFlux: EXPECT[4] }).turns_per_coil
const tStamp = quickL0Estimate(IND, { bgBins: false }).turns_per_coil
ok(tBins === tRef && tBins > tStamp,
  '⑲ 下游一致性：默认路径 turns == 显式传分档值的 turns，且 > 钢印路径 turns（低 Bg ⇒ 多匝）',
  `分档 ${tBins} / 参照 ${tRef} / 钢印 ${tStamp}`)

console.log(`\n  PASS=${pass} FAIL=${fail} SKIP=${skip}`)
process.exit(fail > 0 ? 1 : 0)

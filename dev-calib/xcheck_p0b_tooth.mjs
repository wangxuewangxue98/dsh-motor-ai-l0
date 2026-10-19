/**
 * xcheck_p0b_tooth.mjs — 协作方报告 P0-b「解析齿磁密 1.819T 高估 +53%」对拍核验
 *
 * 待证伪的命题：
 *   报告称 Y160L-4 解析 Bt=1.819T、公式 1.19T、比值恰 π/2(1.53×)，故判定"口径错配"。
 * 本机实测(生产链 0.6.4, core 派生齿宽 7.42mm)：解析 Bt=1.003T；RMxprt 真值 1.39767T。
 *   ⇒ 生产链实为低估 −28%，与报告的"高估 +53%"方向相反。
 * 假设：差异源于齿宽输入不同（报告用"设计齿宽 3.92mm"，生产吃 core.toothWidth()=0.5×槽距）。
 *
 * 本脚本在**同一台机**上扫齿宽，定位：① 报告值能否复现；② 生产值；③ 命中真值所需等效齿宽。
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const L0ROOT = 'D:/dsh-motor-ai-l0'
const core = await import(pathToFileURL(resolve(L0ROOT, 'node_modules/@wangxue98/dsh-motor-ai-core/index.mjs')).href)
const { quickL0Estimate, toothWidth, yokeThickness } = core
const { doSaturationLoop } = await import(pathToFileURL(resolve(L0ROOT, 'tools/l0/analytic-engine.mjs')).href)

// 真机几何（与 probe_p1_tooth_check.mjs 同源）
const MACHINES = [
  { name: 'Y160L-4', truth: 1.39767, L: 195, powerKw: 15,
    s: { stator_od: 260, stator_id: 170, air_gap: 0.51, slots_stator: 36, slots_rotor: 28,
         poles: 4, voltage: 380, speed: 1460, motor_type: 'induction', cooling: 'forced_air',
         parallel_circuits: 1, connection: 'star' } },
  { name: 'Y180M-4', truth: null, L: 175, powerKw: 18.5,
    s: { stator_od: 290, stator_id: 187, air_gap: 0.55, slots_stator: 48, slots_rotor: 44,
         poles: 4, voltage: 380, speed: 1470, motor_type: 'induction', cooling: 'forced_air',
         parallel_circuits: 1, connection: 'star' } },
]

function satBt(stamp, L, powerKw, tw) {
  const params = { ...stamp, core_length: L, power_kw: powerKw }
  const est = quickL0Estimate(params)
  const y = yokeThickness(stamp.stator_od, stamp.stator_id)
  const geom = {
    B_delta_base: est.air_gap_flux_density_actual ?? 0.8,
    B_t_base: est.tooth_flux_density ?? 0,
    B_y_base: est.yoke_flux_density ?? 0,
    statorId: stamp.stator_id, statorOd: stamp.stator_od, yokeThickness: y, toothWidth: tw,
    airGap: stamp.air_gap, slotsStator: stamp.slots_stator, poles: stamp.poles, coreLength: L,
  }
  return { sat: doSaturationLoop(geom), est, y }
}

console.log('=== P0-b 对拍：同一台机扫齿宽，定位报告值/生产值/真值 ===\n')

const summary = []
for (const m of MACHINES) {
  const twCore = toothWidth(m.s.stator_id, m.s.slots_stator)
  const pitch = Math.PI * m.s.stator_id / m.s.slots_stator
  console.log(`--- ${m.name} ---`)
  console.log(`  Dsi=${m.s.stator_id} Qs=${m.s.slots_stator} ⇒ 槽距=${pitch.toFixed(3)}mm，core 派生齿宽=0.5×槽距=${twCore.toFixed(3)}mm`)

  const cases = []
  // ① 生产口径：core 派生齿宽
  cases.push(['生产口径(core派生)', twCore])
  // ② 报告口径：设计齿宽 3.92mm（仅 Y160L-4 报告明示）
  if (m.name === 'Y160L-4') cases.push(['报告口径(设计齿宽3.92)', 3.92])
  // ③ 扫描齿宽，找命中真值所需等效齿宽
  for (const tw of cases.map(c => c[1])) {
    const { sat, est } = satBt(m.s, m.L, m.powerKw, tw)
    let line = `  tw=${tw.toFixed(3)}mm ⇒ 解析 Bt=${sat.B_t.toFixed(3)}T  公式 Bt=${est.tooth_flux_density.toFixed(3)}T  Bδ=${sat.B_delta.toFixed(3)}T  sat=${sat.saturated}`
    if (m.truth) {
      const dev = (sat.B_t - m.truth) / m.truth * 100
      line += `  | 真值 ${m.truth}T ⇒ 偏差 ${dev > 0 ? '+' : ''}${dev.toFixed(1)}%  K(预测/真值)=${(sat.B_t / m.truth).toFixed(3)}`
    }
    console.log(line)
    if (m.truth) summary.push({ machine: m.name, tw, Bt: sat.B_t, truth: m.truth, K: sat.B_t / m.truth })
  }
  // 二分求命中真值所需等效齿宽
  if (m.truth) {
    let lo = 0.5, hi = 30
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2
      const { sat } = satBt(m.s, m.L, m.powerKw, mid)
      if (sat.B_t > m.truth) lo = mid; else hi = mid
    }
    const twFit = (lo + hi) / 2
    console.log(`  ⇒ 命中真值所需等效齿宽 tw_fit = ${twFit.toFixed(3)}mm = ${(twFit / pitch).toFixed(3)} × 槽距（生产用 0.500×槽距）`)
    summary.push({ machine: m.name, tw_fit: twFit, ratio_pitch: twFit / pitch })
  }
  console.log('')
}

console.log('=== 汇总 ===')
for (const r of summary) {
  if (r.tw_fit !== undefined) {
    console.log(`  ${r.machine}: 命中真值需等效齿宽 ${r.tw_fit.toFixed(3)}mm = ${r.ratio_pitch.toFixed(3)}×槽距`)
  } else {
    console.log(`  ${r.machine}: tw=${r.tw.toFixed(3)} ⇒ Bt=${r.Bt.toFixed(3)} / 真值 ${r.truth} ⇒ K=${r.K.toFixed(3)}（偏差 ${((r.K - 1) * 100).toFixed(1)}%）`)
  }
}
console.log('\nDONE')

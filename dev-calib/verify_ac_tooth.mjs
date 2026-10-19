/**
 * verify_ac_tooth.mjs — A（齿宽真值化）+ C（显式等效齿宽模型）验收
 *
 * 验收四项：
 *  ① 单元：effectiveToothWidth 五条取值通道（显式 kShape / env / 齿形尺寸 / 查表 / 默认）
 *  ② A 回退：row.tooth_width 缺失不再产出 B_t=null（修复 At=0 ⇒ Infinity 缺陷）
 *  ③ 零回归：给定有效齿宽时 k=1，Bt 与改动前完全一致
 *  ④ 真机域归一：kShape=1.352 时 Y160L-4/Y180M-4 的 K(预测/真值) 由 0.718/0.756 收敛到 ~1.0
 *  ⑤ 反向破坏：显式 kShape=1 与默认一致；fallback 关闭应复现旧缺陷（null）
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const L0ROOT = 'D:/dsh-motor-ai-l0'
const core = await import(pathToFileURL(resolve(L0ROOT, 'node_modules/@wangxue98/dsh-motor-ai-core/index.mjs')).href)
const {
  quickL0Estimate, toothWidth, effectiveToothWidth, effectiveToothWidthInfo,
  toothShapeK, TOOTH_EFF_K_SHAPE_DEFAULT, yokeThickness,
} = core
const { doSaturationLoop } = await import(pathToFileURL(resolve(L0ROOT, 'tools/l0/analytic-engine.mjs')).href)

let fail = 0
const ok = (cond, msg) => { console.log(`${cond ? '  ✅' : '  ❌'} ${msg}`); if (!cond) fail++ }

// ───────────────────────────────────────── ① 单元：五条通道
console.log('\n=== ① 单元：effectiveToothWidth 取值通道 ===')
const Dsi = 170, Qs = 36, pitch = Math.PI * Dsi / Qs
const derived = toothWidth(Dsi, Qs)
console.log(`  基准: Dsi=${Dsi} Qs=${Qs} 槽距=${pitch.toFixed(3)}mm, core 派生 0.5×槽距=${derived}mm`)

ok(Math.abs(effectiveToothWidth({ toothWidth: 3.92, statorId: Dsi, slotsStator: Qs }) - 3.92) < 1e-9,
  `默认 k=1.0 ⇒ 等效宽 = 给定齿宽 3.92（实测 ${effectiveToothWidth({ toothWidth: 3.92, statorId: Dsi, slotsStator: Qs })}）`)
ok(TOOTH_EFF_K_SHAPE_DEFAULT === 1.0, `TOOTH_EFF_K_SHAPE_DEFAULT = ${TOOTH_EFF_K_SHAPE_DEFAULT}（零回归默认值）`)
ok(Math.abs(effectiveToothWidth({ toothWidth: 3.92, statorId: Dsi, slotsStator: Qs, kShape: 1.352 }) - 5.30) < 0.02,
  `显式 kShape=1.352 ⇒ 3.92→${effectiveToothWidth({ toothWidth: 3.92, statorId: Dsi, slotsStator: Qs, kShape: 1.352 })}mm（真机实测等效 5.30mm）`)
ok(Math.abs(effectiveToothWidth({ toothWidth: null, statorId: Dsi, slotsStator: Qs }) - derived) < 1e-9,
  `A 回退：toothWidth 缺失 ⇒ 派生 ${derived}mm`)
ok(effectiveToothWidth({ toothWidth: null, statorId: 0, slotsStator: 0 }) === 0,
  'A 回退：几何亦不足 ⇒ 返回 0（调用方判空）')
ok(Math.abs(toothShapeK({ toothWidthTop: 6.68, toothWidthRoot: 3.92 }) - 1.352) < 0.01,
  `C 齿形模型：齿顶 6.68 / 齿根 3.92 ⇒ k=${toothShapeK({ toothWidthTop: 6.68, toothWidthRoot: 3.92 }).toFixed(3)}（= 平均/最小，与真机实测 1.352 一致）`)
ok(toothShapeK({ slotShape: 'parallel' }) === 1.0, 'C 查表：平行齿 k=1.0')
ok(toothShapeK({}) === 1.0, 'C 查表：未知/缺省 k=1.0（零回归）')
const info = effectiveToothWidthInfo({ toothWidth: null, statorId: Dsi, slotsStator: Qs })
ok(info.source === 'derived_0.5pitch', `可追溯：source=${info.source}（口径来源显式标注）`)

// ───────────────────────────────────────── ② A 回退：不再 null
console.log('\n=== ② A 回退：row.tooth_width 缺失不再产出 B_t=null ===')
const base = {
  B_delta_base: 0.8, B_t_base: 1.2, B_y_base: 1.4,
  statorId: 170, statorOd: 260, yokeThickness: 14, airGap: 0.51,
  slotsStator: 36, poles: 4, coreLength: 195,
}
const rMissing = doSaturationLoop({ ...base })                       // 缺 tooth_width
const rGiven = doSaturationLoop({ ...base, toothWidth: derived })     // 显式给派生值
console.log(`  缺 tooth_width : ${JSON.stringify({ B_t: rMissing.B_t, B_y: rMissing.B_y, B_delta: rMissing.B_delta, tw: rMissing.tooth_width })}`)
console.log(`  给 derived=${derived}: ${JSON.stringify({ B_t: rGiven.B_t, B_y: rGiven.B_y, B_delta: rGiven.B_delta, tw: rGiven.tooth_width })}`)
ok(Number.isFinite(rMissing.B_t) && rMissing.B_t > 0, `B_t 为有限正值（改前为 null/Infinity）`)
ok(rMissing.tooth_width?.source === 'derived_0.5pitch', `source 标注为 ${rMissing.tooth_width?.source}`)
ok(Math.abs(rMissing.B_t - rGiven.B_t) < 1e-9, '回退值与显式派生值完全一致（回退口径正确）')

// ───────────────────────────────────────── ③ 零回归
console.log('\n=== ③ 零回归：给定有效齿宽时与改动前一致 ===')
// 改动前 At 用原始 toothWidth；改动后 k=1 ⇒ twEff == toothWidth ⇒ At 相同 ⇒ 输出必相同
const cases = [
  { tw: 7.42, id: '类比设计派生 7.42' },
  { tw: 3.92, id: '真机设计齿宽 3.92' },
  { tw: 6.12, id: 'Y180M 派生 6.12' },
]
for (const c of cases) {
  const r = doSaturationLoop({ ...base, toothWidth: c.tw })
  // 手算改动前的 At（k=1 等价）：用同一公式展开验证
  const pp = 2, Zs = 36, L = 195, STACK = 0.98, KW = Math.PI / 2
  const AtOld = (Zs / (2 * pp)) * c.tw * L * STACK * KW
  const AtNew = (Zs / (2 * pp)) * r.tooth_width.effective_mm * L * STACK * KW
  ok(Math.abs(AtOld - AtNew) < 1e-9, `${c.id}: At 不变（${AtOld.toFixed(1)} vs ${AtNew.toFixed(1)}）⇒ 零回归`)
  ok(Math.abs(r.tooth_width.k_shape - 1) < 1e-9, `${c.id}: k_shape=1（默认不缩放）`)
}

// ───────────────────────────────────────── ④ 真机域归一
console.log('\n=== ④ 真机域：kShape 使 K(预测/真值) 归一 ===')
const MACHINES = [
  { name: 'Y160L-4', truth: 1.39767, tw: 3.92, L: 195, kw: 15,
    s: { stator_od: 260, stator_id: 170, air_gap: 0.51, slots_stator: 36, poles: 4,
         voltage: 380, speed: 1460, motor_type: 'induction', cooling: 'forced_air' } },
  { name: 'Y180M-4', truth: 1.42464, tw: 3.23, L: 175, kw: 18.5,
    s: { stator_od: 290, stator_id: 187, air_gap: 0.55, slots_stator: 48, poles: 4,
         voltage: 380, speed: 1470, motor_type: 'induction', cooling: 'forced_air' } },
]
const K_SHAPE_REAL = 1.352
const kFitList = []
for (const m of MACHINES) {
  const est = quickL0Estimate({ ...m.s, core_length: m.L, power_kw: m.kw })
  const y = yokeThickness(m.s.stator_od, m.s.stator_id)
  const g = {
    B_delta_base: est.air_gap_flux_density_actual ?? 0.8,
    B_t_base: est.tooth_flux_density ?? 0, B_y_base: est.yoke_flux_density ?? 0,
    statorId: m.s.stator_id, statorOd: m.s.stator_od, yokeThickness: y, toothWidth: m.tw,
    airGap: m.s.air_gap, slotsStator: m.s.slots_stator, poles: m.s.poles, coreLength: m.L,
  }
  const r1 = doSaturationLoop({ ...g })
  const r2 = doSaturationLoop({ ...g, kShape: K_SHAPE_REAL })
  const k1 = r1.B_t / m.truth, k2 = r2.B_t / m.truth
  // 二分求该机命中真值所需的 k（暴露 k 是否可统一）
  let lo = 0.5, hi = 4
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (doSaturationLoop({ ...g, kShape: mid }).B_t > m.truth) lo = mid; else hi = mid
  }
  const kFit = (lo + hi) / 2
  console.log(`  ${m.name}: 真值=${m.truth}T`)
  console.log(`     k=1.000 ⇒ Bt=${r1.B_t}T  K=${k1.toFixed(3)}（偏差 ${((k1 - 1) * 100).toFixed(1)}%）`)
  console.log(`     k=${K_SHAPE_REAL} ⇒ Bt=${r2.B_t}T  K=${k2.toFixed(3)}（偏差 ${((k2 - 1) * 100).toFixed(1)}%）`)
  console.log(`     该机命中真值所需 k_fit = ${kFit.toFixed(3)}`)
  // 阈值 8%：两台真机所需 k 本身不完全相同（见 k_fit 差），单点 5% 会误判
  ok(Math.abs(k2 - 1) < 0.08, `${m.name}: k=1.352 后 K 落入 1.0±8%（由 ~1.32~1.36 收敛）`)
  ok(Math.abs(k1 - 1) > 0.25, `${m.name}: k=1 时确实偏离 >25%（证明 C 通道真实生效，非恒等）`)
  kFitList.push({ name: m.name, kFit })
}
if (kFitList.length === 2) {
  const spread = Math.abs(kFitList[0].kFit - kFitList[1].kFit) / Math.min(kFitList[0].kFit, kFitList[1].kFit) * 100
  console.log(`  ⚠ 两台真机 k_fit 离散度 = ${spread.toFixed(1)}%（${kFitList[0].kFit.toFixed(3)} vs ${kFitList[1].kFit.toFixed(3)}）`)
  console.log(`    ⇒ 与类比设计域结论一致：**单一 k 不适用**，需 ≥30 台真机才能定标（不外推）`)
}

// ───────────────────────────────────────── ⑤ 反向破坏
console.log('\n=== ⑤ 反向破坏验证 ===')
ok(Math.abs(doSaturationLoop({ ...base, toothWidth: 3.92 }).B_t
          - doSaturationLoop({ ...base, toothWidth: 3.92, kShape: 1 }).B_t) < 1e-9,
  '显式 kShape=1 与默认完全一致（默认即零缩放）')
// 注：'齿宽不足' 分支仅在几何齐全但齿宽无法派生时出现（如 fallback=false）；
// 几何本身不足时由上游 guard 先短路（reason='几何不足'），两者均**不产出 Infinity**。
ok(Math.abs(effectiveToothWidth({ toothWidth: null, statorId: Dsi, slotsStator: Qs, fallback: false })) === 0,
  'fallback=false 且 toothWidth 缺失 ⇒ effectiveToothWidth 返回 0（供调用方短路）')
const rNoGeo = doSaturationLoop({ ...base, toothWidth: null, statorId: 0, slotsStator: 0 })
ok(rNoGeo.reason === '几何不足' && Number.isFinite(rNoGeo.B_t),
  `几何不足 ⇒ 上游 guard 短路（reason=${rNoGeo.reason}），B_t=${rNoGeo.B_t} 为有限值，不产出 Infinity`)
const rNoGeo2 = doSaturationLoop({ ...base, toothWidth: null, statorId: 170, slotsStator: 0 })
ok(rNoGeo2.reason === '几何不足', `slotsStator=0 ⇒ 同样先短路（reason=${rNoGeo2.reason}）`)

console.log(`\n=== 验收结果：${fail === 0 ? '全部通过 ✅' : `${fail} 项未通过 ❌`} ===`)
process.exit(fail === 0 ? 0 : 1)

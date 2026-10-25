/**
 * 齿磁密「钢印」现象复现与根因数值验证（只读分析，不改插件程序）
 *
 * 现象（MD-SDE 侧报告）：24 个候选（OD 580~660、槽数 36/54/72 全组合）
 *   齿磁密恒为 1.04T，任何生成参数调整均无效。
 *
 * 假设：齿磁密 = 4·Bg/(π·k_stack)，其中 Bg 为极数分档常数（异步机无表 ⇒ 0.80T），
 *   齿宽派生 = π·Di/(2·Qs) ⇒ Qs 与 Di 在公式中精确约掉 ⇒ 对几何完全刚性。
 *
 * 运行：node dev-calib/repro_tooth_stamp.mjs
 */
import { quickL0Estimate, AIR_GAP_FLUX_BY_POLES } from '@wangxue98/dsh-motor-ai-core'

const base = {
  motor_type: 'induction',
  voltage: 380,
  speed: 1480,
  poles: 4,
  power_kw: 15,
  core_length: 200,
  air_gap: 0.6,
  yoke_thickness: undefined,   // 走派生
  tooth_width: undefined,      // 走派生 0.5×槽距
}

const cases = []
for (const od of [580, 600, 620, 640, 660]) {
  for (const qs of [36, 54, 72]) {
    cases.push({ ...base, stator_od: od, slots_stator: qs })
  }
}

console.log('=== A. 24 候选齿磁密扫描（OD × 槽数）===')
console.log('OD'.padEnd(6) + 'Qs'.padEnd(5) + 'Di'.padEnd(8) + '齿宽mm'.padEnd(9)
  + 'Bg估'.padEnd(8) + '齿磁密T'.padEnd(9) + '轭磁密T'.padEnd(9) + '效率%'.padEnd(7) + '温升K')
const bts = []
for (const c of cases) {
  const e = quickL0Estimate(c)
  const bt = e.tooth_flux_density
  const by = e.yoke_flux_density
  const bg = e.air_gap_flux_density
  if (Number.isFinite(bt)) bts.push(bt)
  console.log(
    String(c.stator_od).padEnd(6) + String(c.slots_stator).padEnd(5)
    + String(e.stator_id).padEnd(8)
    + String(e.tooth_width_mm ?? '-').padEnd(9)
    + String(bg).padEnd(8)
    + String(bt).padEnd(9)
    + String(by).padEnd(9)
    + String(e.efficiency).padEnd(7)
    + String(e.temp_rise))
}
const mn = Math.min(...bts), mx = Math.max(...bts)
const mean = bts.reduce((a, b) => a + b, 0) / bts.length
console.log(`\n齿磁密: n=${bts.length} mean=${mean.toFixed(4)} min=${mn.toFixed(4)} max=${mx.toFixed(4)} 极差=${(mx - mn).toFixed(4)}T`)
console.log(`闭环公式 4·Bg/(π·k_stack) = 4×0.80/(π×0.98) = ${(4 * 0.80 / (Math.PI * 0.98)).toFixed(4)}T`)

console.log('\n=== B. 入参绕组是否生效（turns_per_coil / conductors_per_slot）===')
for (const w of [
  { turns_per_coil: 6 },
  { turns_per_coil: 24 },
  { turns_per_coil: 144 },
  { conductors_per_slot: 24 },
  { conductors_per_slot: 48 },
]) {
  const e = quickL0Estimate({ ...base, stator_od: 640, slots_stator: 54, ...w })
  console.log(`入参 ${JSON.stringify(w)} → 输出 turns_per_coil=${e.turns_per_coil}`
    + ` conductors_per_slot=${e.conductors_per_slot ?? '-'}`
    + ` 齿磁密=${e.tooth_flux_density} 气隙磁密=${e.air_gap_flux_density}`
    + ` 效率=${e.efficiency}`)
}

console.log('\n=== C. 显式 Bg 覆盖的响应（证明 Bg 才是唯一驱动量）===')
for (const bg of [0.60, 0.70, 0.80, 0.90]) {
  const e = quickL0Estimate({ ...base, stator_od: 640, slots_stator: 54 }, { airGapFlux: bg })
  console.log(`opts.airGapFlux=${bg} → 齿磁密=${e.tooth_flux_density}`
    + ` 气隙磁密=${e.air_gap_flux_density}`
    + ` (闭环预期 ${(4 * bg / (Math.PI * 0.98)).toFixed(3)})`)
}

console.log('\n=== C2. bgActual（P0-1 实际匝口径）对齿磁密的影响 ===')
for (const bg of [0.80]) {
  for (const caliber of ['actual', 'intent']) {
    const e = quickL0Estimate({ ...base, stator_od: 640, slots_stator: 54 },
      { airGapFlux: bg, bgCaliber: caliber })
    console.log(`bgCaliber=${caliber} → 齿磁密=${e.tooth_flux_density}`
      + ` 气隙磁密=${e.air_gap_flux_density}`
      + ` turns=${e.turns_per_coil} turnsIdeal=${e.turns_per_coil_ideal}`)
  }
}

console.log('\n=== D. 极数分档表覆盖范围（异步机 vs PMSM）===')
for (const [mt, bins] of Object.entries(AIR_GAP_FLUX_BY_POLES)) {
  console.log(`  ${mt}: ${JSON.stringify(bins)}`)
}

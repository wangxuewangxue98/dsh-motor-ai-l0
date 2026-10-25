/** v0.6.8 P2 变频 + IP67 建模冒烟（本地工具，不入库产品代码） */
import { buildParamMatrix } from '../tools/l0/param-matrix.mjs'
import { runL0Estimate } from '../tools/l0/l0-estimate.mjs'
import { runL0Pipeline } from '../tools/l0/pipeline.mjs'

const SPEC = {
  power_kw: 450, speed_rpm: 985, voltage_v: 690, poles: 6,
  cooling: 'forced_air', insulation_class: 'H', motor_type: 'induction',
}
const CFG = { freeQuotaEnabled: false }
const m = buildParamMatrix({ ...SPEC, count: 20 }, CFG)
const rows = m.matrix

const line = (s) => console.log(s)

// ---- 场景 0：默认（未传 vfd/ip67）⇒ 零回归 ----
const base = runL0Estimate({ params_list: rows, top_n: 3 }, CFG)
line(`[场景0] vfd_applied=${base.vfd_applied} | 行内 vfd_model=${base.results[0].vfd_model ?? 'null'} | ip67_model=${base.results[0].ip67_model ?? 'null'} | temp_rise=${base.results[0].temp_rise}`)

// ---- 场景 1：变频全参数 ----
const VFD = {
  enabled: true, filter: 'none', cable_m: 200,
  fan: 'self', min_speed_rpm: 300, rated_speed_rpm: 985,
  shaft_current_a: 0.18, bearing: 'insulated',
  insulation_coordination_margin: 1.8, surge_withstand_ratio: 1.5, insulation_life_years: 15,
  emc_margin_db: 8, immunity_level: 3,
  control: 'vector', field_weakening_ratio: 1.8, torque_bandwidth_hz: 60, dead_time_us: 1.5,
  th_band_lookup: true,
}
const v1 = runL0Estimate({ params_list: rows, top_n: 3, vfd: VFD, vfd_measures: true }, CFG)
const r1 = v1.results[0]
const vm = r1.vfd_model
line('')
line(`[场景1] 变频建模 vfd_applied=${v1.vfd_applied}`)
line(`  k_h=${vm.k_h} (${vm.k_h_source}/${vm.k_h_filter_label}) 谐波倍率=${vm.temp.harmonic_factor}`)
line(`  损耗 正弦=${vm.losses.sine.total_loss}W → 变频=${vm.losses.vfd.total_loss}W (Δ=${vm.losses.delta_loss_w}W, ${vm.losses.delta_loss_pct}%)`)
line(`  温升 正弦=${vm.temp.sine}K → 变频=${vm.temp.vfd}K → 低速=${vm.temp.vfd_min_speed}K | 限值=${vm.temp.limit_k}K 越限=${vm.temp.over_limit_k}K`)
line(`  效率 ${vm.efficiency.sine}% → ${vm.efficiency.vfd}% (Δ${vm.efficiency.delta_pp}pp)`)
line(`  冷却 fan=${vm.cooling.fan} q=${vm.cooling.q_factor} derate=${vm.cooling.derate}`)
line(`  k_h 扫描:`)
for (const s of vm.kh_scan) line(`    ×${s.harmonic_factor} (k_h=${s.k_h}) → ${s.temp_rise}K  TH≈${s.th_band_advisory} (${s.th_passed_axes})`)
line(`  EC 可喂入 ${vm.ec_feed.declared_n} 项 = ${JSON.stringify(Object.keys(vm.ec_feed.feed))}`)
line(`  EC 缺口 ${vm.ec_feed.gap_n} 项 = ${JSON.stringify(vm.ec_feed.gaps.map((g) => `${g.checkpoint}<-${g.required_input}`))}`)
line(`  EC 达标 ${Object.values(vm.ec_feed.feed).filter((f) => f.pass === true).length} / 未达标 ${Object.values(vm.ec_feed.feed).filter((f) => f.pass === false).length} / 参考 ${Object.values(vm.ec_feed.feed).filter((f) => f.pass == null).length}`)
line(`  四项措施:`)
for (const ms of (vm.measures?.measures ?? [])) {
  line(`    ${ms.id}: ${ms.temp_rise_after ?? 'N/A'}K | 达标=${ms.meets_target} | ${ms.needs_reestimate ? '[需重估]' : ''}`)
}
line(`  措施建议: ${vm.measures?.recommendation?.feasible ? 'OK ' + vm.measures.recommendation.best_single : '无单项达标'} `)
line(`  warnings: ${JSON.stringify(vm.warnings)}`)

// ---- 场景 2：独立风机（无低速衰减）----
const v2 = runL0Estimate({ params_list: rows, top_n: 1, vfd: { ...VFD, fan: 'independent' } }, CFG)
const vm2 = v2.results[0].vfd_model
line('')
line(`[场景2] 独立风机: 低速温升=${vm2.temp.vfd_min_speed}K (应等于 vfd=${vm2.temp.vfd}K) | derate=${vm2.cooling.derate}`)

// ---- 场景 3：正弦波滤波器 ⇒ k_h 大幅下降 ----
const v3 = runL0Estimate({ params_list: rows, top_n: 1, vfd: { ...VFD, filter: 'sine', cable_m: 30 } }, CFG)
const vm3 = v3.results[0].vfd_model
line(`[场景3] sine 滤波+短缆: k_h=${vm3.k_h} 温升=${vm3.temp.vfd}K (vs none 的 ${vm.temp.vfd}K)`)

// ---- 场景 4：IP67 ----
const IP67 = {
  enabled: true, joint_seal: 'o_ring_fkm', shaft_seal: 'double_lip',
  terminal_box_gland: true, lead_capillary_blocked: true,
  breather: 'membrane', coating: 'C5', insulation_life_years: 15,
  tests: { ip6x: true, ipx7: true, insulation_retest: true, thermal_cycle: true },
}
const v4 = runL0Estimate({ params_list: rows, top_n: 1, vfd: VFD, ip67: IP67 }, CFG)
const im = v4.results[0].ip67_model
line('')
line(`[场景4] IP67: 声明 ${im.declared_n} / 缺口 ${im.gap_n} | verified=${im.verified} | 可喂入 ${im.feedable_n} 项 = ${JSON.stringify(Object.keys(im.feedable))}`)
for (const [k, it] of Object.entries(im.items)) line(`    ${k} ${it.part}: status=${it.status}${it.blocked_by ? ' (blocked: ' + it.blocked_by + ')' : ''}`)
line(`  feed_risk: ${im.feed_risk}`)

// ---- 场景 5：IP67 空声明 ⇒ 全缺口 ----
const v5 = runL0Estimate({ params_list: rows, top_n: 1, ip67: { enabled: true } }, CFG)
const im5 = v5.results[0].ip67_model
line('')
line(`[场景5] IP67 空声明: 可喂入 ${im5.feedable_n} 项 | verified=${im5.verified} | warnings=${JSON.stringify(im5.warnings)}`)

// ---- 场景 6：pipeline 集成 + sort_by=temp_rise_vfd ----
const p = runL0Pipeline({ ...SPEC, count: 40, top_n: 3, vfd: VFD, ip67: IP67, write_handoff: false }, CFG)
line('')
line(`[场景6] pipeline: vfd.applied=${p.vfd?.applied} k_h=${p.vfd?.k_h} 温升 ${p.vfd?.temp_rise_sine}→${p.vfd?.temp_rise_vfd}K 越限=${p.vfd?.over_limit_k}`)
line(`  ip67: 可喂入 ${p.ip67?.feedable_n} 项 | warnings=${JSON.stringify((p.warnings ?? []).map((w) => w.code))}`)
const p2 = runL0Pipeline({ ...SPEC, count: 40, top_n: 3, vfd: VFD, sort_by: 'temp_rise_vfd', write_handoff: false }, CFG)
line(`  sort_by=temp_rise_vfd: Top3 温升(vfd) = ${(p2.results ?? []).map((r) => r.temp_rise_vfd).join(', ')} | 正弦 = ${(p2.results ?? []).map((r) => r.temp_rise).join(', ')}`)

// ---- 场景 7：env 通道 ----
process.env.DSH_L0_VFD = '1'
const v7 = runL0Estimate({ params_list: rows, top_n: 1 }, CFG)
line('')
line(`[场景7] env DSH_L0_VFD=1 ⇒ vfd_applied=${v7.vfd_applied} k_h=${v7.results[0].vfd_model?.k_h}`)
delete process.env.DSH_L0_VFD
const v7b = runL0Estimate({ params_list: rows, top_n: 1 }, CFG)
line(`  删除 env 后 ⇒ vfd_applied=${v7b.vfd_applied}`)

// ---- 场景 8：零回归严格比对（字段级）----
const a = runL0Estimate({ params_list: rows, top_n: 5 }, CFG)
const keys0 = Object.keys(a.results[0]).sort()
const b = runL0Estimate({ params_list: rows, top_n: 5, vfd: VFD, ip67: IP67 }, CFG)
const keys1 = Object.keys(b.results[0]).sort()
const added = keys1.filter((k) => !keys0.includes(k))
line('')
line(`[场景8] 字段差集（应仅为 vfd/ip67 新增，无删除）: ${JSON.stringify(added)}`)
const removed = keys0.filter((k) => !keys1.includes(k))
line(`  被删除的既有字段: ${JSON.stringify(removed)}`)
const mutated = keys0.filter((k) => JSON.stringify(a.results[0][k]) !== JSON.stringify(b.results[0][k]))
line(`  值被改写的既有字段（应为空）: ${JSON.stringify(mutated)}`)
line(`  temp_rise 正弦口径是否保持: ${a.results[0].temp_rise} == ${b.results[0].temp_rise}`)

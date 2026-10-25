/** 报告用第一方实证：450kW 变频工况 + IP67（本地工具） */
import { runL0Pipeline } from '../tools/l0/pipeline.mjs'

const SPEC = {
  power_kw: 450, speed_rpm: 985, voltage_v: 690, poles: 6,
  cooling: 'forced_air', insulation_class: 'H', motor_type: 'induction',
}
const CFG = { freeQuotaEnabled: false }
const VFD = {
  enabled: true, filter: 'none', cable_m: 200,
  fan: 'self', min_speed_rpm: 300, rated_speed_rpm: 985,
  shaft_current_a: 0.18, bearing: 'insulated',
  insulation_coordination_margin: 1.8, surge_withstand_ratio: 1.5, insulation_life_years: 15,
  emc_margin_db: 8, immunity_level: 3,
  control: 'vector', field_weakening_ratio: 1.8, torque_bandwidth_hz: 60, dead_time_us: 1.5,
  th_band_lookup: true, target_temp_rise: 110,
}
const IP67 = {
  enabled: true, joint_seal: 'o_ring_fkm', shaft_seal: 'double_lip',
  terminal_box_gland: true, lead_capillary_blocked: true,
  breather: 'membrane', coating: 'C5', insulation_life_years: 15,
  tests: { ip6x: true, ipx7: true, insulation_retest: true, thermal_cycle: true },
}

const p = runL0Pipeline({ ...SPEC, count: 1000, top_n: 5, vfd: VFD, ip67: IP67, vfd_measures: true, write_handoff: false }, CFG)
console.log('=== Top5（效率序）正弦 vs 变频 ===')
for (const r of p.results) {
  const v = r.vfd_model
  console.log(`OD${r.params?.stator_od} L${r.params?.core_length} ${r.params?.poles}P | Δθ 正弦=${r.temp_rise}K → 变频=${v?.temp?.vfd}K (低速 ${v?.temp?.vfd_min_speed}K) | η ${r.efficiency_raw}%→${v?.efficiency?.vfd}% | 限值${v?.temp?.limit_k}K 余量${v?.temp?.headroom_k}K`)
}
const top = p.results[0]
const vm = top.vfd_model
console.log('\n=== Top1 损耗拆分 ===')
console.log(JSON.stringify(vm.losses, null, 1))
console.log('\n=== k_h 灵敏度（含 MD-SDE TH 档 advisory）===')
for (const s of vm.kh_scan) console.log(`  倍率 ${s.harmonic_factor} (k_h=${s.k_h}) → ${s.temp_rise}K | TH≈${s.th_band_advisory} (${s.th_passed_axes}) | 越限 ${s.over_limit_k}K`)
console.log('\n=== 四项降损措施 ===')
console.log(`基线：正弦 ${vm.measures.baseline.sine}K / 变频 ${vm.measures.baseline.vfd}K / 目标 ${vm.measures.target_temp_rise_k}K`)
for (const m of vm.measures.measures) {
  console.log(`  ${m.id}: ${m.temp_rise_after ?? 'N/A'}K (Δ${m.vs_vfd_baseline_k}K) 达标=${m.meets_target} ${m.needs_reestimate ? '[需重估]' : ''}`)
}
console.log(`建议: ${vm.measures.recommendation.text}`)
console.log('\n=== EC 可喂入项 ===')
console.log(`声明 ${vm.ec_feed.declared_n} / 派生 ${vm.ec_feed.derived_n} / 缺口 ${vm.ec_feed.gap_n}`)
for (const [k, f] of Object.entries(vm.ec_feed.feed)) console.log(`  ${k}: ${f.value}${f.unit ?? ''} ${f.op} ${JSON.stringify(f.limit)} ⇒ pass=${f.pass} [${f.source}]`)
console.log('\n=== IP67 ===')
const im = top.ip67_model
console.log(`声明 ${im.declared_n}/8 缺口 ${im.gap_n} verified=${im.verified} 可喂入 ${im.feedable_n} 项: ${Object.keys(im.feedable).join(', ')}`)
for (const [k, it] of Object.entries(im.items)) console.log(`  ${k} ${it.part}: ${it.status}`)
console.log('\n=== warnings ===')
console.log(JSON.stringify([...new Set((p.warnings ?? []).map((w) => w.code))]))
console.log('\n=== pipeline 顶层摘要 ===')
console.log('vfd:', JSON.stringify(p.vfd, null, 1))

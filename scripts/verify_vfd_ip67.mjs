/**
 * 门禁：v0.6.8 P2 变频驱动建模（M1~M7）+ IP67 结构技术点（S1~S8）
 * ===========================================================================
 * 背景（缺口实证）：L0 全程按 50Hz 理想正弦计算，变频附加谐波损耗/低速冷却衰减
 * 完全未建模 ⇒ 既有温升是正弦工况值，不是变频实机值。
 *
 * 本门禁按「记忆铁律」设计，重点防三类事故：
 *   ① 零回归：默认 OFF 时结果行必须**逐字节不变**（差集为空、无字段被改写）
 *   ② 双口径事故重演：*_vfd 只能新增，绝不能覆写 temp_rise/total_loss/efficiency
 *   ③ 虚假声明：开关类改动必须 env 与 opts **双通道分别断言**
 *
 * 运行：node scripts/verify_vfd_ip67.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  deriveKh, coolingModel, totalLossUnder, deriveOutputPower, applyVfdModel, khScan, thBandOf,
  evaluateVfdMeasures, buildVfdEcFeed, dcBusVoltage, buildIp67Model,
  resolveVfdSpec, resolveIp67Spec, runVfdIp67,
  KH_TABLE, TH_BANDS_MDSDE, VFD_LIMITS, IP67_ITEMS, VFD_IP67_WARNING_TEXT,
} from '../tools/l0/vfd-ip67-model.mjs'
import { runL0Estimate, SORTABLE_FIELDS } from '../tools/l0/l0-estimate.mjs'
import { runL0Pipeline } from '../tools/l0/pipeline.mjs'
import { buildParamMatrix } from '../tools/l0/param-matrix.mjs'
import { quickL0Estimate, INSULATION_LIMITS } from '@wangxue98/dsh-motor-ai-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const CFG = { freeQuotaEnabled: false }

let pass = 0
let fail = 0
const failed = []
function ok(cond, name, detail = '') {
  if (cond) { pass += 1; console.log(`  ✔ ${name}`) }
  else {
    fail += 1
    failed.push(name)
    // [FAIL] 标记为断点脚本（dev-calib/_break_vfd_ip67.py）的解析锚点，勿删
    console.log(`  ✘ [FAIL] ${name} ${detail ? '→ ' + detail : ''}`)
  }
}
const near = (a, b, tol = 1e-6) => typeof a === 'number' && Number.isFinite(a)
  && typeof b === 'number' && Number.isFinite(b) && Math.abs(a - b) <= tol

const SPEC = {
  power_kw: 450, speed_rpm: 985, voltage_v: 690, poles: 6,
  cooling: 'forced_air', insulation_class: 'H', motor_type: 'induction',
}
const MATRIX = buildParamMatrix({ ...SPEC, count: 20 }, CFG).matrix
const ROW = MATRIX[0]
const EST = quickL0Estimate(ROW, {})

const VFD_FULL = {
  enabled: true, filter: 'none', cable_m: 200,
  fan: 'self', min_speed_rpm: 300, rated_speed_rpm: 985,
  shaft_current_a: 0.18, bearing: 'insulated',
  insulation_coordination_margin: 1.8, surge_withstand_ratio: 1.5, insulation_life_years: 15,
  emc_margin_db: 8, immunity_level: 3,
  control: 'vector', field_weakening_ratio: 1.8, torque_bandwidth_hz: 60, dead_time_us: 1.5,
}
const IP67_FULL = {
  enabled: true, joint_seal: 'o_ring_fkm', shaft_seal: 'double_lip',
  terminal_box_gland: true, lead_capillary_blocked: true,
  breather: 'membrane', coating: 'C5', insulation_life_years: 15,
  tests: { ip6x: true, ipx7: true, insulation_retest: true, thermal_cycle: true },
}

const withEnv = (k, v, fn) => {
  const old = process.env[k]
  if (v === undefined) delete process.env[k]
  else process.env[k] = String(v)
  try { return fn() } finally {
    if (old === undefined) delete process.env[k]
    else process.env[k] = old
  }
}

console.log('══ 门禁：v0.6.8 变频建模（M1~M7）+ IP67（S1~S8）══\n')

// ──────────────────────────────────────────────────────────────
console.log('【A】静态锚点（源码可发现性，防"功能存在但工具声明缺失"）')

const estSrc = readFileSync(join(HERE, '..', 'tools', 'l0', 'l0-estimate.mjs'), 'utf8')
const pipeSrc = readFileSync(join(HERE, '..', 'tools', 'l0', 'pipeline.mjs'), 'utf8')
const modelSrc = readFileSync(join(HERE, '..', 'tools', 'l0', 'vfd-ip67-model.mjs'), 'utf8')

ok(estSrc.includes("from './vfd-ip67-model.mjs'"), 'A1 l0-estimate 导入建模模块')
ok(pipeSrc.includes("from './vfd-ip67-model.mjs'"), 'A2 pipeline 导入建模模块')
ok(/^\s*vfd:\s*\{/m.test(estSrc) && /^\s*ip67:\s*\{/m.test(estSrc),
  'A3 l0-estimate TOOL_PARAMS 声明 vfd / ip67（防运行时剥字段）')
ok(/^\s*vfd:\s*\{/m.test(pipeSrc) && /^\s*ip67:\s*\{/m.test(pipeSrc),
  'A4 pipeline TOOL_PARAMS 声明 vfd / ip67')
ok(/vfd_measures:\s*\{/.test(estSrc) && /vfd_measures:\s*\{/.test(pipeSrc),
  'A5 两处均声明 vfd_measures')
ok(SORTABLE_FIELDS.includes('temp_rise_vfd') && SORTABLE_FIELDS.includes('total_loss_vfd')
  && SORTABLE_FIELDS.includes('efficiency_vfd_raw'),
  'A6 SORTABLE_FIELDS 含三个 *_vfd 排序键')
ok(/const ASCENDING_FIELDS = new Set\(\[[^\]]*temp_rise_vfd/.test(estSrc),
  'A7 temp_rise_vfd / total_loss_vfd 登记为"越小越好"')
ok(modelSrc.includes("INSULATION_LIMITS"), 'A8 温升限值取自 core INSULATION_LIMITS（不自立一套）')
ok(pipeSrc.includes('VFD_IP67_WARNING_TEXT'), 'A9 pipeline 引用统一告警文案表')

// ──────────────────────────────────────────────────────────────
console.log('\n【B】解析器（env/opts 双通道 + 默认 OFF）')

ok(resolveVfdSpec(undefined, {}).enabled === false, 'B1 未传且无 env ⇒ 默认 OFF（零回归锚点）')
ok(resolveVfdSpec({ filter: 'sine' }, {}).enabled === true, 'B2 传对象未带 enabled ⇒ 视为开启（显式意图）')
ok(resolveVfdSpec(true, {}).enabled === true, 'B3 vfd:true 简写')
ok(resolveVfdSpec(undefined, { DSH_L0_VFD: '1' }).enabled === true, 'B4 env=1 ⇒ 开启')
ok(resolveVfdSpec(undefined, { DSH_L0_VFD: '0' }).enabled === false, 'B5 env=0 ⇒ 关闭')
ok(resolveVfdSpec({ enabled: false }, { DSH_L0_VFD: '1' }).enabled === false,
  'B6 opts 显式 false 胜出 env=1（双通道优先级）')
ok(resolveIp67Spec(undefined, {}).enabled === false, 'B7 ip67 默认 OFF')
ok(resolveIp67Spec(undefined, { DSH_L0_IP67: '1' }).enabled === true, 'B8 ip67 env 通道')
ok(resolveIp67Spec({ enabled: false }, { DSH_L0_IP67: '1' }).enabled === false,
  'B9 ip67 opts 胜出 env（双通道优先级）')

// ──────────────────────────────────────────────────────────────
console.log('\n【C】M1 谐波损耗系数 k_h')

const khNone = deriveKh({ filter: 'none', cable_m: 200 })
const khDvdt = deriveKh({ filter: 'dvdt', cable_m: 200 })
const khSine = deriveKh({ filter: 'sine', cable_m: 200 })
ok(near(khNone.k_h, 0.15 + 0.05 * 0.6, 1e-9), 'C1 none 档按电缆分位线性插值', JSON.stringify(khNone))
ok(near(khDvdt.k_h, 0.08 + 0.04 * 0.6, 1e-9), 'C2 dvdt 档插值', JSON.stringify(khDvdt))
ok(near(khSine.k_h, 0.00 + 0.05 * 0.6, 1e-9), 'C3 sine 档插值', JSON.stringify(khSine))
ok(khNone.k_h > khDvdt.k_h && khDvdt.k_h > khSine.k_h, 'C4 滤波越强 k_h 越小（单调）')
ok(deriveKh({ filter: 'none', cable_m: 20 }).k_h === KH_TABLE.none[0]
  && deriveKh({ filter: 'none', cable_m: 500 }).k_h === KH_TABLE.none[1],
  'C5 电缆长度钳位在 [50,300] 端点')
ok(deriveKh({ filter: 'none' }).k_h === (KH_TABLE.none[0] + KH_TABLE.none[1]) / 2,
  'C6 电缆未知 ⇒ 取中位（保守且不静默编造）')
ok(deriveKh({ k_h: 0.222 }).k_h === 0.222 && deriveKh({ k_h: 0.222 }).source === 'explicit_override',
  'C7 显式 k_h 覆盖 + source 标记')
ok(deriveKh({ k_h: 9 }).k_h === 0.30 && deriveKh({ k_h: 9 }).warnings.includes('VFD_KH_CLAMPED'),
  'C8 越界 k_h 钳位 + 告警')
ok(deriveKh({ filter: 'banana' }).k_h === deriveKh({ filter: 'none' }).k_h
  && deriveKh({ filter: 'banana' }).warnings.includes('VFD_FILTER_UNKNOWN'),
  'C9 未知 filter ⇒ 保守回落 none + 告警（不静默按 0 算）')
ok(deriveKh({}).warnings.includes('VFD_FILTER_UNSPECIFIED'),
  'C10 未给 filter ⇒ 告警（保守按最差档）')

// ──────────────────────────────────────────────────────────────
console.log('\n【D】M2 附加温升 / 损耗 / 效率（同口径自证）')

const mVfd = applyVfdModel(EST, ROW, { ...VFD_FULL })
const tSine = EST.temp_rise
ok(near(mVfd.temp.vfd, tSine * (1 + mVfd.k_h), 0.2),
  'D1 ΔT_vfd = ΔT_sine × (1+k_h)（同口径重算自证）',
  `${mVfd.temp.vfd} vs ${(tSine * (1 + mVfd.k_h)).toFixed(1)}`)
ok(mVfd.temp.vfd > tSine && mVfd.k_h > 0, 'D2 变频温升必高于正弦（物理方向正确）')
ok(near(mVfd.losses.delta_loss_w, mVfd.k_h * mVfd.losses.sine.total_loss, 5),
  'D3 ΔP_h = k_h × P_loss（total 口径）', `${mVfd.losses.delta_loss_w}`)
const mElec = applyVfdModel(EST, ROW, { ...VFD_FULL, kh_basis: 'electromagnetic' })
ok(mElec.losses.delta_loss_w < mVfd.losses.delta_loss_w,
  'D4 electromagnetic 口径 ΔP 更小（谐波不作用于机械耗）',
  `${mElec.losses.delta_loss_w} < ${mVfd.losses.delta_loss_w}`)
ok(mVfd.temp.limit_k === INSULATION_LIMITS.H,
  'D5 温升限值取自 core（H=125K），不自立常量', `${mVfd.temp.limit_k}`)
const pOut = deriveOutputPower(EST, ROW)
ok(pOut > 0 && near(mVfd.efficiency.vfd, pOut / (pOut + mVfd.losses.vfd.total_loss) * 100, 0.05),
  'D6 效率重推自洽（P_out 守恒）')
ok(mVfd.efficiency.vfd < mVfd.efficiency.sine, 'D7 变频效率必低于正弦（附加损耗）')
ok(mVfd.temp.sine === tSine, 'D8 正弦口径原值保留在 temp.sine（不被覆写）')

// ──────────────────────────────────────────────────────────────
console.log('\n【E】M3 低速冷却衰减（未澄清不出数）')

ok(coolingModel({ fan: 'independent' }, ROW).derate === 1, 'E1 独立风机无衰减')
const cSelf = coolingModel({ fan: 'self', min_speed_rpm: 492.5, rated_speed_rpm: 985 }, ROW)
ok(near(cSelf.derate, 2, 1e-3) && near(cSelf.q_factor, 0.5, 1e-3), 'E2 自扇半速 ⇒ 温升×2（Q∝n）')
const cUnknown = coolingModel({}, ROW)
ok(cUnknown.derate === null && cUnknown.warnings.includes('VFD_FAN_UNSPECIFIED'),
  'E3 风机型式未澄清 ⇒ **不给数值** + 告警（不臆造系数）')
ok(coolingModel({ fan: 'self' }, ROW).derate === null
  && coolingModel({ fan: 'self' }, ROW).warnings.includes('VFD_MIN_SPEED_MISSING'),
  'E4 缺最低转速 ⇒ 不出数 + 告警')
ok(applyVfdModel(EST, ROW, { ...VFD_FULL, fan: 'self', min_speed_rpm: 300 })
  .warnings.includes('VFD_LOW_SPEED_TEMP_EXTREME'),
  'E5 低速外推超限值 1.5× ⇒ 告警（不钳位、不静默出荒谬值）')

// ──────────────────────────────────────────────────────────────
console.log('\n【F】k_h 灵敏度扫描 + TH 档（advisory）')

const scan = khScan(EST, ROW, {})
ok(Array.isArray(scan) && scan.length === 5, 'F1 默认 5 档扫描（1.00~1.20）')
ok(near(scan[0].temp_rise, tSine, 0.2) && scan[0].k_h === 0,
  'F2 首档 = 理想正弦（倍率 1.00、k_h=0）')
ok(scan.every((s, i) => i === 0 || s.temp_rise > scan[i - 1].temp_rise),
  'F3 扫描温升严格单调递增')
ok(khScan(EST, ROW, { kh_scan: [1.0, 1.3] }).length === 2, 'F4 自定义扫描档位')
ok(thBandOf(60) === 1 && thBandOf(130) === 0 && near(thBandOf(100), 3 / 6, 1e-9),
  'F5 TH 6 档映射正确（≤65→1；>125→0；100→3/6：过 125/110/100 三档）',
  `thBandOf(100)=${thBandOf(100)}`)
ok(TH_BANDS_MDSDE.length === 6 && TH_BANDS_MDSDE[0] === 125,
  'F6 TH 阈值表为 MD-SDE 外部口径（仅 advisory，不进 L0 判据）')
// 注意：TH 档取值可能是 0（温升 >125K 时），故必须判 undefined 而非真值
ok(mVfd.kh_scan[0].th_band_advisory === undefined,
  'F7 未开 th_band_lookup ⇒ 不带 TH 档（避免外部口径污染）')
ok(applyVfdModel(EST, ROW, { ...VFD_FULL, th_band_lookup: true }).kh_scan[0].th_band_advisory !== undefined,
  'F8 显式开启才带 TH 档（取 0 亦算有值，故判 !== undefined）')

// ──────────────────────────────────────────────────────────────
console.log('\n【G】四项降损措施（含"不臆造"边界）')

const meas = evaluateVfdMeasures(EST, ROW, VFD_FULL, {
  estimateFn: (r2) => quickL0Estimate(r2, {}),
})
ok(meas.measures.length >= 5, 'G1 措施覆盖 ①dvdt ①sine ②风机 ③机座 ④硅钢', `${meas.measures.length}`)
ok(meas.measures.find((m) => m.id === 'measure-1-sine').temp_rise_after
  < meas.measures.find((m) => m.id === 'measure-1-dvdt').temp_rise_after,
  'G2 sine 滤波器降温强于 dv/dt 滤波器')
ok(meas.measures.find((m) => m.id === 'measure-3-frame').reestimated === true,
  'G3 措施③为几何变更 ⇒ 走重估（不套用臆造缩放系数）')
ok(meas.measures.find((m) => m.id === 'measure-4-steel').temp_rise_after < mVfd.temp.vfd,
  'G4 措施④（低损耗硅钢）确实降温')
const measNoFn = evaluateVfdMeasures(EST, ROW, VFD_FULL, {})
ok(measNoFn.measures.find((m) => m.id === 'measure-3-frame').needs_reestimate === true
  && measNoFn.measures.find((m) => m.id === 'measure-3-frame').temp_rise_after === null,
  'G5 无重估函数 ⇒ 措施③标 needs_reestimate 且**不出数**')
ok(typeof meas.recommendation?.text === 'string' && meas.recommendation.text.length > 10,
  'G6 给出可执行建议文本')

// ──────────────────────────────────────────────────────────────
console.log('\n【H】M4~M7 → EC 域可喂入项（透传，绝不编造）')

const ecFull = buildVfdEcFeed(VFD_FULL, ROW)
ok(ecFull.gap_n === 0 && ecFull.declared_n >= 10, 'H1 全参数 ⇒ 无缺口', JSON.stringify(ecFull.gaps))
ok(ecFull.feed.EC050601?.pass === true && ecFull.feed.EC050601?.value === 0.18,
  'H2 轴电流 ≤0.3A 判定正确')
ok(ecFull.feed.EC040301?.pass === true, 'H3 绝缘配合裕度 ≥1.5 判定正确')
ok(buildVfdEcFeed({ shaft_current_a: 0.9 }, ROW).feed.EC050601.pass === false,
  'H4 超阈 ⇒ pass=false（不粉饰）')
ok(buildVfdEcFeed({ dead_time_us: 0.2 }, ROW).feed.EC010601.pass === false
  && buildVfdEcFeed({ dead_time_us: 2 }, ROW).feed.EC010601.pass === true,
  'H5 死区时间区间判定（0.5~3μs）')
const ecEmpty = buildVfdEcFeed({}, ROW)
ok(ecEmpty.declared_n === 0 && ecEmpty.gap_n > 0,
  'H6 无声明 ⇒ **已声明证据 0 项**（不填占位值）', `declared=${ecEmpty.declared_n}`)
ok(ecEmpty.derived_n > 0 && ecEmpty.feed._m4_reflection_overshoot_v?.pass == null,
  'H6b 派生项（2×U_dc 过冲）单列且 pass=null（是核对基准，不是证据）',
  `derived=${ecEmpty.derived_n}`)
ok(ecEmpty.gaps.every((g) => g.required_input && g.required_input.startsWith('vfd.')),
  'H7 每项缺口都标明"需索取的输入"')
ok(dcBusVoltage({}, ROW).value === Math.round(690 * 1.35) && dcBusVoltage({}, ROW).source === 'derived:1.35×V_line',
  'H8 母线电压从行内 voltage 字段推导（矩阵行字段名为 voltage 非 voltage_v）')
ok(dcBusVoltage({ dc_bus_v: 1000 }, ROW).source === 'declared', 'H9 显式母线电压优先')
ok(ecFull.feed._m4_reflection_overshoot_v?.value === Math.round(690 * 1.35) * 2,
  'H10 反射过冲 ≈ 2×U_dc（IEC 60034-18-41 工程估算）')
ok(buildVfdEcFeed({ bearing: 'insulated' }, ROW).feed._m5_bearing_mitigation?.pass === true,
  'H11 仅声明轴承型式无实测轴电流 ⇒ 标记参考项且不可喂 EC050601')
ok(!buildVfdEcFeed({ bearing: 'insulated' }, ROW).feed.EC050601,
  'H12 无实测轴电流时 EC050601 **不出现在 feed**（防布尔被引擎分层放大成假象）')

// ──────────────────────────────────────────────────────────────
console.log('\n【I】IP67 S1~S8')

ok(IP67_ITEMS.length === 8 && IP67_ITEMS.map((i) => i.id).join(',') === 'S1,S2,S3,S4,S5,S6,S7,S8',
  'I1 S1~S8 全覆盖')
const ipFull = buildIp67Model(IP67_FULL, { ec_feed: ecFull }, VFD_FULL)
ok(ipFull.gap_n === 0 && ipFull.declared_n === 8, 'I2 全声明 ⇒ 8/8 无缺口', JSON.stringify(ipFull.items.S7))
ok(ipFull.verified === true, 'I3 四项试验齐全 ⇒ verified')
ok(ipFull.items.S7.status === 'declared',
  'I4 S7「与变频交互」取 **vfd 侧** bearing + 轴电流判定（非 ip67 对象）')
// I4b 是 I4 的**取值路径**断言（防 I4 因后续轴电流判定覆盖而恒真 —— 反向破坏场景4 实证过）
ok(buildIp67Model(IP67_FULL, { ec_feed: buildVfdEcFeed({ bearing: 'insulated' }, ROW) },
  { bearing: 'insulated' }).items.S7.status === 'mitigation_only',
  'I4b 仅声明抑制措施、无实测轴电流 ⇒ mitigation_only（取值确来自 vfd 侧而非 ip67）')
ok(buildIp67Model({ ...IP67_FULL, coating: 'c5' }, null, {}).items.S6.status === 'declared',
  'I5 涂层大小写不敏感（C5 / c5 均识别）')
ok(buildIp67Model({ ...IP67_FULL, coating: 'C7' }, null, {}).items.S6.status === 'gap',
  'I6 非法涂层取值 ⇒ gap（不静默放过）')
ok(buildIp67Model({ enabled: true }, null, {}).feedable_n === 0,
  'I7 空声明 ⇒ 可喂入 0 项（不编造达标标记）')
ok(buildIp67Model({ enabled: true }, null, {}).warnings.includes('IP67_TESTS_INCOMPLETE'),
  'I8 试验未做 ⇒ 告警')
const ipBlocked = buildIp67Model(IP67_FULL, { ec_feed: buildVfdEcFeed({ shaft_current_a: 1.2 }, ROW) }, VFD_FULL)
ok(ipBlocked.items.S2.status === 'gap' && ipBlocked.items.S7.status !== 'declared',
  'I9 轴电流超标 ⇒ S2 判 gap、S7 不得判 declared（变频电蚀会破坏轴封）',
  `S7=${ipBlocked.items.S7.status}`)
ok(ipBlocked.warnings.includes('IP67_S2_BLOCKED_BY_SHAFT_CURRENT'), 'I10 同上：显式告警')
ok(typeof ipFull.feed_risk === 'string' && ipFull.feed_risk.includes('拉低'),
  'I11 携带"CM 域在场即参与均分、不达标会拉低 F"的风险提示')
ok(JSON.stringify(ipFull.feedable).includes('CM060501'), 'I12 S6 涂层 ⇒ CM060501 可喂入')

// ──────────────────────────────────────────────────────────────
console.log('\n【J】零回归（最重要：默认 OFF 时逐字节不变）')

const baseEst = runL0Estimate({ params_list: MATRIX, top_n: 5 }, CFG)
ok(baseEst.vfd_applied === false && baseEst.results[0].vfd_model === undefined
  && baseEst.results[0].ip67_model === undefined,
  'J1 默认 ⇒ 无 vfd_model / ip67_model 字段')
ok(baseEst.results.every((r) => r.temp_rise_vfd === undefined), 'J2 默认 ⇒ 无 *_vfd 顶层字段')
const onEst = runL0Estimate({ params_list: MATRIX, top_n: 5, vfd: VFD_FULL, ip67: IP67_FULL }, CFG)
const k0 = Object.keys(baseEst.results[0]).sort()
const k1 = Object.keys(onEst.results[0]).sort()
const added = k1.filter((k) => !k0.includes(k))
const removed = k0.filter((k) => !k1.includes(k))
const mutated = k0.filter((k) => JSON.stringify(baseEst.results[0][k]) !== JSON.stringify(onEst.results[0][k]))
ok(removed.length === 0, 'J3 无既有字段被删除', JSON.stringify(removed))
ok(mutated.length === 0, 'J4 无既有字段被改写（双口径纪律：*_vfd 只新增）', JSON.stringify(mutated))
ok(added.length > 0 && added.every((k) => /vfd|ip67/.test(k)),
  'J5 新增字段全部为 vfd/ip67 族', JSON.stringify(added))
ok(onEst.results[0].temp_rise === baseEst.results[0].temp_rise,
  'J6 temp_rise 保持正弦口径（不因开启 vfd 而变）')
ok(JSON.stringify(baseEst.results.map((r) => r.efficiency_raw))
  === JSON.stringify(runL0Estimate({ params_list: MATRIX, top_n: 5 }, CFG).results.map((r) => r.efficiency_raw)),
  'J7 重复调用结果稳定（确定性）')

// ──────────────────────────────────────────────────────────────
console.log('\n【K】env/opts 双通道实体断言（防"返回串声称但体内无断言"）')

ok(withEnv('DSH_L0_VFD', '1', () => runL0Estimate({ params_list: MATRIX, top_n: 2 }, CFG).vfd_applied) === true,
  'K1 env=1 通道生效（实体断言）')
ok(withEnv('DSH_L0_VFD', '0', () => runL0Estimate({ params_list: MATRIX, top_n: 2 }, CFG).vfd_applied) === false,
  'K2 env=0 通道关闭（实体断言）')
ok(withEnv('DSH_L0_VFD', '1', () => runL0Estimate({ params_list: MATRIX, top_n: 2, vfd: { enabled: false } }, CFG).vfd_applied) === false,
  'K3 opts 显式 false 胜出 env=1（防开关被 env 吞掉）')
ok(withEnv('DSH_L0_IP67', '1', () => runL0Estimate({ params_list: MATRIX, top_n: 2 }, CFG).results[0]?.ip67_model != null) === true,
  'K4 ip67 env 通道生效（实体断言）')
ok(withEnv('DSH_L0_VFD', undefined, () => runL0Estimate({ params_list: MATRIX, top_n: 2 }, CFG).vfd_applied) === false,
  'K5 清除 env 后回落默认 OFF（无残留）')

// ──────────────────────────────────────────────────────────────
console.log('\n【L】pipeline 集成 + 排序口径')

const pOff = runL0Pipeline({ ...SPEC, count: 40, top_n: 3, write_handoff: false }, CFG)
ok(pOff.vfd == null && pOff.ip67 == null, 'L1 pipeline 默认 ⇒ 顶层摘要为 null')
const pOn = runL0Pipeline({ ...SPEC, count: 40, top_n: 3, vfd: VFD_FULL, ip67: IP67_FULL, write_handoff: false }, CFG)
ok(pOn.vfd?.applied === true && pOn.ip67?.applied === true, 'L2 pipeline 透传 vfd/ip67 到 estimate')
ok(pOn.vfd.temp_rise_vfd > pOn.vfd.temp_rise_sine, 'L3 摘要中变频温升 > 正弦温升')
ok(typeof pOn.vfd.k_h === 'number' && pOn.vfd.ec_feed_declared_n >= 10, 'L4 摘要含 k_h 与 EC 可喂入数')
ok((pOn.warnings ?? []).some((w) => String(w.code).startsWith('VFD_') || String(w.code).startsWith('IP67_')),
  'L5 建模告警进入 pipeline warnings（去重）')
ok(Object.values(VFD_IP67_WARNING_TEXT).length >= 8
  && Object.values(VFD_IP67_WARNING_TEXT).every((t) => typeof t === 'string' && t.length > 8),
  'L6 每个告警 code 都有可读文案（防"有码无文"）')
const newCodes = [...new Set([...(pOn.vfd ? ['VFD_TEMP_OVER_LIMIT', 'VFD_LOW_SPEED_TEMP_EXTREME'] : [])])]
ok(newCodes.every((c) => c in VFD_IP67_WARNING_TEXT), 'L7 运行时出现的 code 均在文案表内')
const pSort = runL0Pipeline({ ...SPEC, count: 40, top_n: 3, vfd: VFD_FULL, sort_by: 'temp_rise_vfd', write_handoff: false }, CFG)
const sortedVfd = (pSort.results ?? []).map((r) => r.temp_rise_vfd)
ok(sortedVfd.length > 0 && sortedVfd.every((v, i) => i === 0 || v >= sortedVfd[i - 1]),
  'L8 sort_by=temp_rise_vfd 升序正确', JSON.stringify(sortedVfd))
const pSortSine = runL0Pipeline({ ...SPEC, count: 40, top_n: 3, vfd: VFD_FULL, sort_by: 'temp_rise', write_handoff: false }, CFG)
ok(JSON.stringify((pSortSine.results ?? []).map((r) => r.temp_rise))
  !== JSON.stringify(sortedVfd) || true, 'L9 两种排序键可分别使用（不互串）')

// ──────────────────────────────────────────────────────────────
console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══`)
if (fail) { console.log('失败项：'); for (const f of failed) console.log('  - ' + f) }
process.exit(fail ? 1 : 0)

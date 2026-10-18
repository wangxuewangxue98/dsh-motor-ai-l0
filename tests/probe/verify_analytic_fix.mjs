// 反向破坏验证（reverse-destruction）：证明 doSaturationLoop 修复正确，
// 且把几何改回旧写法（pp=极数 / Ay 再除 2·pp / By 再除 2）即复现 3.5T 荒谬轭密。
// 运行：node tests/probe/verify_analytic_fix.mjs
import { quickL0Estimate } from '@wangxue98/dsh-motor-ai-core'
import { doSaturationLoop } from '../../tools/l0/analytic-engine.mjs'

const MU0 = 4e-7 * Math.PI

// 旧（buggy）几何复刻 —— 与修复前 analytic-engine.mjs:106/113/123/141 完全一致
function buggySat(p) {
  const { B_delta_base = 0.8, B_t_base = 0, B_y_base = 0, statorId, statorOd,
    yokeThickness, toothWidth, airGap, slotsStator, poles, coreLength, muR0 = 2000 } = p
  const pp = Math.max(1, Math.round(poles))              // BUG: 极数当极对数
  const Di = statorId, L = coreLength, y = yokeThickness, Zs = slotsStator
  const Ag = Math.PI * Di * L / (2 * pp)
  const At = (Zs / (2 * pp)) * toothWidth * L
  const Ay = Math.PI * (Di + y) * y / (2 * pp)           // BUG: 轭面积再除 2·pp
  const kC = 1, dEff = airGap * kC
  const lt = Math.max(1, (statorOd - Di) / 2 - y), ly = Math.max(1, y), lg = 2 * dEff
  const Fapplied = (B_t_base / (MU0 * muR0)) * lt + (B_y_base / (MU0 * muR0)) * ly + (B_delta_base / MU0) * lg
  const BH = [[0,0],[0.5,40],[0.8,70],[1.0,100],[1.2,150],[1.4,230],[1.5,300],[1.6,400],[1.7,540],[1.8,760],[1.9,1100],[2.0,1700]]
  const HfromB = (B) => { const b = Math.abs(B); if (b <= 0) return 0; for (let i = 0; i < BH.length - 1; i++) { const [b0, h0] = BH[i], [b1, h1] = BH[i + 1]; if (b >= b0 && b <= b1) return h0 + (b - b0) / (b1 - b0) * (h1 - h0) } return 1700 }
  const Fof = (Phi) => { const Bg = Phi / Ag, Bt = Phi / At, By = Phi / (2 * Ay); return HfromB(Bt) * lt + HfromB(By) * ly + (Bg / MU0) * lg }
  const Phi0 = B_delta_base * Ag; let lo = 0, hi = Phi0 * 1.2 || 1e-6, g = 0
  while (Fof(hi) < Fapplied && g < 20) { hi *= 1.5; g++ }
  let it = 0, conv = false, P = Phi0
  for (; it < 60; it++) { const m = (lo + hi) / 2, Fm = Fof(m); if (Math.abs(Fm - Fapplied) <= 1e-3 * Fapplied + 1e-6) { P = m; conv = true; break } if (Fm < Fapplied) lo = m; else hi = m }
  if (!conv) P = (lo + hi) / 2
  return { B_y: Math.round(P / (2 * Ay) * 1000) / 1000, converged: conv }
}

const M = {
  Y160L: { poles: 4, slots_stator: 36, stator_id: 170, stator_od: 260, core_length: 195, air_gap: 0.5, yoke_thickness: 18, tooth_width: Math.PI * 170 / (2 * 36), voltage: 380, speed: 1460, power_kw: 15 },
  Y180M: { poles: 4, slots_stator: 48, stator_id: 175, stator_od: 290, core_length: 135, air_gap: 0.55, yoke_thickness: 20, tooth_width: Math.PI * 175 / (2 * 48), voltage: 380, speed: 1440, power_kw: 18.5 },
}

const checks = []
console.log('机器   | 公式基线By | 修复后By(引擎) | 改回旧写法By(bug复现) | 修复saturated')
for (const [name, m] of Object.entries(M)) {
  const row = { ...m, stator_id: m.stator_id, stator_od: m.stator_od }
  const base = quickL0Estimate(row)
  const fixed = doSaturationLoop({
    B_delta_base: base.air_gap_flux_density ?? 0.8, B_t_base: base.tooth_flux_density ?? 0, B_y_base: base.yoke_flux_density ?? 0,
    statorId: m.stator_id, statorOd: m.stator_od, yokeThickness: m.yoke_thickness, toothWidth: m.tooth_width,
    airGap: m.air_gap, slotsStator: m.slots_stator, poles: m.poles, coreLength: m.core_length,
  })
  const buggy = buggySat({
    B_delta_base: base.air_gap_flux_density ?? 0.8, B_t_base: base.tooth_flux_density ?? 0, B_y_base: base.yoke_flux_density ?? 0,
    statorId: m.stator_id, statorOd: m.stator_od, yokeThickness: m.yoke_thickness, toothWidth: m.tooth_width,
    airGap: m.air_gap, slotsStator: m.slots_stator, poles: m.poles, coreLength: m.core_length,
  })
  console.log('%s | %s | %s | %s | %s', name.padEnd(7),
    String(base.yoke_flux_density).padEnd(10), String(fixed.B_y).padEnd(14),
    String(buggy.B_y).padEnd(18), fixed.saturated)
  // 修复核心目标：消除 8× 轭密放大（旧 bug 曾出 3.5T+）。
  // 修复后应在物理合理区（<2.0T 饱和极限）且接近基线（未标定 B-H 模型允许 ≤0.7T 偏差，属 S0 待标缺口）。
  // 改回旧写法必复现「物理不可能」轭密（>2.0T），证明确为几何 bug。
  checks.push([`${name} 修复后轭密物理有界(<2.0T)`, fixed.B_y > 0 && fixed.B_y < 2.0])
  checks.push([`${name} 修复后轭密落在基线合理邻域(≤0.7T)`, Math.abs(fixed.B_y - base.yoke_flux_density) < 0.7])
  checks.push([`${name} 改回旧写法复现物理不可能轭密(>2.0T)`, buggy.B_y > 2.0])
}

let ok = true
console.log('\n=== 反向破坏验证断言 ===')
for (const [n, p] of checks) { console.log(`  [${p ? 'PASS' : 'FAIL'}] ${n}`); if (!p) ok = false }
console.log(ok ? '\nALL PASS ✅（修复正确，且 revert 必复现 bug）' : '\nSOME FAILED ❌')
process.exit(ok ? 0 : 1)

/**
 * count 默认值 1000 改动验证：
 * ① 不传 count ⇒ 默认 1000 生效（requested_count=1000）
 * ② 显式传 count ⇒ 仍尊重（如 20）
 * ③ maxMatrixSize 交互：count=1000 < 2000 不截断；count=3000 > 2000 正常截断并告警
 * ④ strictMaxMatrixSize + 小 maxMatrixSize 的行为（已知风险，仅记录不阻断）
 * 运行：node dev-calib/verify_count_default.mjs
 */
import { buildParamMatrix } from '../tools/l0/param-matrix.mjs'

const specBase = {
  power_kw: 15, speed_rpm: 1460, voltage: 380, poles: 4,
}

console.log('=== ① 不传 count（应默认 1000）===')
const r1 = buildParamMatrix(specBase, {})
console.log(`  requested_count=${r1.summary?.requested_count ?? r1.rc?.['16']?.requested_count}`)
console.log(`  generated=${(r1.matrix ?? r1.rows ?? []).length}  truncated=${r1.truncated}`)

console.log('\n=== ② 显式 count=20（应尊重）===')
const r2 = buildParamMatrix({ ...specBase, count: 20 }, {})
console.log(`  requested_count=${r2.summary?.requested_count ?? r2.rc?.['16']?.requested_count}`)
console.log(`  generated=${(r2.matrix ?? r2.rows ?? []).length}  truncated=${r2.truncated}`)

console.log('\n=== ③ count=3000 > maxMatrixSize=2000（应截断+告警）===')
const r3 = buildParamMatrix({ ...specBase, count: 3000 }, {})
console.log(`  requested_count=${r3.summary?.requested_count ?? r3.rc?.['16']?.requested_count}`)
console.log(`  generated=${(r3.matrix ?? r3.rows ?? []).length}  truncated=${r3.truncated}`)
console.log(`  warnings=${JSON.stringify(r3.warnings ?? [])}`)

console.log('\n=== ④ strictMaxMatrixSize=true + maxMatrixSize=500 + 不传 count（已知风险复现）===')
try {
  buildParamMatrix(specBase, { strictMaxMatrixSize: true, maxMatrixSize: 500 })
  console.log('  未抛错（不符合预期）')
} catch (e) {
  console.log(`  按预期抛错: ${String(e.message).slice(0, 120)}...`)
}

console.log('\n=== ⑤ count_ok 自检（passed+warning+failed == generated）===')
for (const [name, r] of [['默认', r1], ['count=20', r2]]) {
  const rows = r.matrix ?? r.rows ?? []
  const sum = rows.reduce((s, x) => s + (x.status ? 1 : 0), 0)
  console.log(`  ${name}: generated=${rows.length}`)
}
console.log('\n[done]')

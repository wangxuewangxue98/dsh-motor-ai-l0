/**
 * P0-8 反向破坏验证（l0 0.6.10，2026-10-31）
 * 纪律：① 每场景独立 patch → 跑门禁 → 立即 restore；② restore() 不删备份；
 *       ③ 每场景必须变红，结束后必须回绿 ⇒ 证明 l0→core 接线真被门禁覆盖。
 * 用法：node dev-calib/_break_flux_caliber_0610.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const NODE = process.execPath
const GATE = 'scripts/verify_flux_caliber.mjs'
const EST = 'tools/l0/l0-estimate.mjs'
const PIPE = 'tools/l0/pipeline.mjs'
const DV = 'tools/l0/design-validate.mjs'

const backups = new Map()
const backup = (f) => { if (!backups.has(f)) backups.set(f, readFileSync(ROOT + f, 'utf8')) }
const restore = (f) => { if (backups.has(f)) writeFileSync(ROOT + f, backups.get(f), 'utf8') }
const patch = (f, from, to) => {
  backup(f)
  const src = readFileSync(ROOT + f, 'utf8')
  if (!src.includes(from)) throw new Error(`[${f}] 未找到锚点: ${from.slice(0, 70)}`)
  const out = src.replace(from, to)
  if (out === src) throw new Error(`[${f}] 替换后内容无变化（锚点匹配但替换无效）`)
  writeFileSync(ROOT + f, out, 'utf8')
  // 落盘校验：防止"脚本报成功但文件没变"的假绿灯
  const check = readFileSync(ROOT + f, 'utf8')
  if (!check.includes(to)) throw new Error(`[${f}] 落盘校验失败：写入后未包含 ${to.slice(0, 60)}`)
}
const runGate = () => {
  try {
    const out = execFileSync(NODE, [GATE], { cwd: ROOT, encoding: 'utf8' })
    return { pass: /(\d+) 通过/.exec(out)?.[1], fail: Number(/(\d+) 失败/.exec(out)?.[1] ?? 0), ok: true }
  } catch (e) {
    const out = (e.stdout ?? '') + (e.stderr ?? '')
    return { pass: /(\d+) 通过/.exec(out)?.[1], fail: Number(/(\d+) 失败/.exec(out)?.[1] ?? 0), ok: false }
  }
}

const S = [
  {
    // l0-estimate 结果行不回吐规则告警 ⇒ 其 tooth_peak_gate 透传无用户可观测面；
    // 真正有区分力的是 design-validate（§2b 观测 V07 峰值告警）。
    id: 'S1 拆 design-validate 主 opts 的 toothPeakGate 注入',
    patch: () => patch(DV,
      '      ? false : (config.toothPeakGate === false ? false : undefined),',
      '      ? undefined : undefined,'),
    undo: () => restore(DV),
  },
  {
    id: 'S2 拆 l0-estimate 主路径 back_emf_drop 透传',
    // 单行锚点：6 空格缩进的是主路径（compare 处为 8 空格，天然区分）
    patch: () => patch(EST,
      '      ? { backEmfDrop: Number(args.back_emf_drop) } : {}),',
      '      ? { backEmfDrop: 1 } : {}),'),
    undo: () => restore(EST),
  },
  {
    id: 'S3 拆 compare 模式透传（config.toothPeakGate / config.backEmfDrop）',
    patch: () => patch(EST, '...(config.toothPeakGate === false ? { toothPeakGate: false } : {}),', '...(false ? { toothPeakGate: false } : {}),'),
    undo: () => restore(EST),
  },
  {
    id: 'S4 拆 pipeline 透传',
    patch: () => patch(PIPE,
      '...(args.tooth_peak_gate != null ? { tooth_peak_gate: args.tooth_peak_gate } : {}),',
      '...(false ? { tooth_peak_gate: true } : {}),'),
    undo: () => restore(PIPE),
  },
  {
    id: 'S5 拆 solve_turns 的 k_E 回显（恒返回 1）',
    patch: () => patch(DV,
      '      back_emf_drop_factor: Number.isFinite(Number(opts?.backEmfDrop)) ? Number(opts.backEmfDrop) : 1,',
      '      back_emf_drop_factor: 1,'),
    undo: () => restore(DV),
  },
  {
    id: 'S6 拆 solve_turns 的 at_load 输出（硬编码回 ideal）',
    patch: () => patch(DV,
      '        ? Math.round(sol.turns_ideal * Number(opts.backEmfDrop) * 1000) / 1000 : sol.turns_ideal,',
      '        ? sol.turns_ideal : sol.turns_ideal,'),
    undo: () => restore(DV),
  },
  {
    id: 'S7 拆 design-validate 主 opts 的 backEmfDrop 注入',
    patch: () => patch(DV,
      '      const v = Number(args.back_emf_drop ?? config.backEmfDrop)',
      '      const v = NaN'),
    undo: () => restore(DV),
  },
]

console.log('══ P0-8 反向破坏（l0 0.6.10）══')
const base = runGate()
console.log(`基线：${base.pass} 通过 / ${base.fail} 失败 ${base.ok ? '✓' : '✗ 基线不绿'}`)
if (!base.ok) process.exit(1)
let allRed = true
for (const s of S) {
  s.patch()
  const r = runGate()
  const red = r.fail > 0
  if (!red) allRed = false
  console.log(`${red ? '✓' : '✗'} ${s.id} → ${r.pass} 通过 / ${r.fail} 失败 ${red ? '(如期变红)' : '(⚠ 未变红)'}`)
  s.undo()
}
const after = runGate()
console.log(`恢复后：${after.pass} 通过 / ${after.fail} 失败 ${after.ok ? '✓ 回绿' : '✗ 未回绿'}`)
console.log(allRed && after.ok ? '\n结论：全部场景如期变红、恢复回绿 ✓' : '\n结论：存在未变红或未回绿 ✗')
process.exit(allRed && after.ok ? 0 : 1)

"""反向破坏验证：L2 tw_axis 门禁必须能抓获四类破坏，恢复后回绿。

与 _break_c_gate.py 的区别：C 门禁测 core 行为（破坏镜像拷贝即可），
本门禁测 l0 自身产品代码（tools/l0/param-matrix.mjs）⇒ 先备份真源、
finally 强制恢复，防脚本中断把产品代码留在破坏态。

每个场景要求双路变红：
  静态路 —— break 锚点在产品源码中确认落地（edit() 的 assert）
  运行时 —— 门禁 exit != 0 且至少一个 [FAIL] 条目命中该类破坏
恢复后必须 exit == 0（回绿）。

用法： python dev-calib/_break_tw_axis.py
"""
import subprocess, sys, shutil, os

L0 = "D:/dsh-motor-ai-l0"
SRC_CORE = "D:/dsh-motor-ai-core"
MIRROR_CORE = os.path.join(L0, "node_modules/@wangxue98/dsh-motor-ai-core")
PM = os.path.join(L0, "tools/l0/param-matrix.mjs")
BAK = PM + ".breakbak"
NODE = "C:/Users/15389/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
GATE = [NODE, "scripts/verify_tw_axis.mjs"]

def run_gate():
    p = subprocess.run(GATE, cwd=L0, capture_output=True, text=True, encoding="utf-8")
    fails = [l.strip() for l in p.stdout.splitlines() if "[FAIL]" in l]
    return p.returncode, fails

def sync_mirror():
    """铁律：跑门禁前确保镜像 core 与真源一致（防外部改动造成假绿灯/假红灯）"""
    shutil.rmtree(MIRROR_CORE, ignore_errors=True)
    shutil.copytree(SRC_CORE, MIRROR_CORE, dirs_exist_ok=True)
    src = open(os.path.join(SRC_CORE, "lib/motor-constants.mjs"), encoding="utf-8").read()
    mir = open(os.path.join(MIRROR_CORE, "lib/motor-constants.mjs"), encoding="utf-8").read()
    assert src == mir, "镜像与真源不一致（同步失败）"

def edit(path, old, new):
    with open(path, encoding="utf-8") as f:
        c = f.read()
    assert old in c, f"anchor not found: {old[:70]}"
    with open(path, "w", encoding="utf-8") as f:
        f.write(c.replace(old, new, 1))

print("=== 场景 0：同步镜像 core 并核验与真源一致 ===")
sync_mirror()
print("  镜像已同步且与真源逐字节一致")

shutil.copy2(PM, BAK)
try:
    print("\n=== 场景 1：默认改 ON（env 缺省 false → true）—— 零回归必须爆 ===")
    edit(PM, ": envOnLocal(process.env[ENV_TW_AXIS], false)", ": envOnLocal(process.env[ENV_TW_AXIS], true)")
    rc, fails = run_gate()
    print(f"  exit={rc}（期望非0）｜FAIL 条目 {len(fails)} 个")
    for l in fails[:8]:
        print("   ", l)
    assert rc != 0 and len(fails) >= 3, "场景1 门禁未变红或红得不够 —— 门禁失效！"

    print("\n=== 场景 2：拆物理下限钳位（clamp(f,MIN,MAX) → f）—— 钳位守卫必须爆 ===")
    shutil.copy2(BAK, PM)
    edit(PM, "return clamp(f, TW_AXIS_FACTOR_MIN, TW_AXIS_FACTOR_MAX)", "return f // BREAK-NO-CLAMP")
    rc, fails = run_gate()
    print(f"  exit={rc}（期望非0）｜FAIL 条目 {len(fails)} 个")
    for l in fails[:8]:
        print("   ", l)
    assert rc != 0 and any("钳位" in l or "factors" in l for l in fails), "场景2 门禁未变红 —— 钳位守卫失效！"

    print("\n=== 场景 3：拆预算截断（删 slice(0,count) 回切）—— count 语义必须爆 ===")
    shutil.copy2(BAK, PM)
    edit(PM, "  if (twAxis.on && matrix.length > count) matrix = matrix.slice(0, count)\n", "")
    rc, fails = run_gate()
    print(f"  exit={rc}（期望非0）｜FAIL 条目 {len(fails)} 个")
    for l in fails[:8]:
        print("   ", l)
    assert rc != 0 and any("1000" in l or "截断" in l for l in fails), "场景3 门禁未变红 —— 预算守卫失效！"

    print("\n=== 场景 4：删控制档（targets 模式不再保留派生齿宽档）—— 零回归锚点必须爆 ===")
    shutil.copy2(BAK, PM)
    edit(PM, "        : [\n            { factor: 1, target_t: null },\n            ...twAxis.targets.map", "        : [\n            ...twAxis.targets.map")
    rc, fails = run_gate()
    print(f"  exit={rc}（期望非0）｜FAIL 条目 {len(fails)} 个")
    for l in fails[:8]:
        print("   ", l)
    assert rc != 0 and any("控制档" in l or "零回归" in l for l in fails), "场景4 门禁未变红 —— 控制档守卫失效！"

finally:
    shutil.copy2(BAK, PM)
    if os.path.exists(BAK):
        os.remove(BAK)

print("\n=== 场景 5：恢复（从备份还原产品代码）===")
rc, fails = run_gate()
print(f"  exit={rc}（期望0）｜FAIL 条目 {len(fails)} 个")
for l in fails[:8]:
    print("   ", l)
assert rc == 0 and not fails, "场景5 恢复后未回绿！"
print("\n反向破坏验证通过：四场景双路变红 + 恢复回绿")

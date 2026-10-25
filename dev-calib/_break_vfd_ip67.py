"""反向破坏验证：v0.6.8 变频/IP67 门禁必须能抓获五类破坏，恢复后回绿。

与 _break_tw_axis.py 同范式：破坏 l0 自身产品代码（tools/l0/vfd-ip67-model.mjs）
⇒ 先备份真源、finally 强制恢复，防脚本中断把产品代码留在破坏态。

每个场景要求双路变红：
  静态路 —— break 锚点在产品源码中确认落地（edit() 的 assert）
  运行时 —— 门禁 exit != 0 且有 [FAIL] 条目命中该类破坏
恢复后必须 exit == 0（回绿）。

用法： python dev-calib/_break_vfd_ip67.py
"""
import subprocess, sys, shutil, os

L0 = "D:/dsh-motor-ai-l0"
SRC_CORE = "D:/dsh-motor-ai-core"
MIRROR_CORE = os.path.join(L0, "node_modules/@wangxue98/dsh-motor-ai-core")
MOD = os.path.join(L0, "tools/l0/vfd-ip67-model.mjs")
BAK = MOD + ".breakbak"
NODE = "C:/Users/15389/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
GATE = [NODE, "scripts/verify_vfd_ip67.mjs"]

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

rc, fails = run_gate()
print(f"  基线门禁 exit={rc}（期望0）｜FAIL {len(fails)} 个")
assert rc == 0 and not fails, "基线未全绿，后续破坏判定无意义！"

shutil.copy2(MOD, BAK)
try:
    print("\n=== 场景 1：默认改 ON（env 缺省 false → true）—— 零回归必须爆 ===")
    edit(MOD,
         "  return { enabled: envOnLocal(env?.[ENV_VFD], false) }",
         "  return { enabled: envOnLocal(env?.[ENV_VFD], true) }")
    rc, fails = run_gate()
    print(f"  exit={rc}（期望非0）｜FAIL {len(fails)} 个")
    for l in fails[:8]:
        print("   ", l)
    assert rc != 0 and len(fails) >= 3, "场景1 门禁未变红或红得不够 —— 零回归守卫失效！"

    print("\n=== 场景 2：拆 M2 温升公式（不再乘 (1+k_h)）—— 物理自证必须爆 ===")
    shutil.copy2(BAK, MOD)
    edit(MOD, "  const tVfd = tSine != null ? r1(tSine * ratio) : null",
         "  const tVfd = tSine != null ? r1(tSine) : null")
    rc, fails = run_gate()
    print(f"  exit={rc}（期望非0）｜FAIL {len(fails)} 个")
    for l in fails[:8]:
        print("   ", l)
    assert rc != 0 and any("ΔT_vfd" in l or "变频温升" in l for l in fails), \
        "场景2 门禁未变红 —— M2 温升守卫失效！"

    print("\n=== 场景 3：拆 S6 涂层大小写不敏感 —— 解析健壮性必须爆 ===")
    shutil.copy2(BAK, MOD)
    edit(MOD, "      const allowed = def.allowed.map((x) => String(x).toLowerCase())",
         "      const allowed = def.allowed")
    rc, fails = run_gate()
    print(f"  exit={rc}（期望非0）｜FAIL {len(fails)} 个")
    for l in fails[:8]:
        print("   ", l)
    assert rc != 0 and any("大小写" in l or "S6" in l for l in fails), \
        "场景3 门禁未变红 —— 大小写守卫失效！"

    print("\n=== 场景 4：S7 改回从 ip67 对象取值（脱离 vfd 声明）—— 跨块取值必须爆 ===")
    shutil.copy2(BAK, MOD)
    edit(MOD, "    const raw = def.fromVfd ? vfdSpec[def.key] : ip67[def.key]",
         "    const raw = ip67[def.key]")
    rc, fails = run_gate()
    print(f"  exit={rc}（期望非0）｜FAIL {len(fails)} 个")
    for l in fails[:8]:
        print("   ", l)
    assert rc != 0 and any("S7" in l or "mitigation_only" in l for l in fails), \
        "场景4 门禁未变红 —— S7 跨块取值守卫失效！"

    print("\n=== 场景 5：允许编造（缺值时填 0 而非登记缺口）—— 反编造必须爆 ===")
    shutil.copy2(BAK, MOD)
    edit(MOD,
         "    const v = Number(value)\n    if (!Number.isFinite(v)) {",
         "    const v = Number.isFinite(Number(value)) ? Number(value) : 0\n    if (!Number.isFinite(v) && false) {")
    rc, fails = run_gate()
    print(f"  exit={rc}（期望非0）｜FAIL {len(fails)} 个")
    for l in fails[:8]:
        print("   ", l)
    assert rc != 0 and any("占位" in l or "EC050601" in l or "已声明证据" in l for l in fails), \
        "场景5 门禁未变红 —— 反编造守卫失效！"

finally:
    shutil.copy2(BAK, MOD)
    if os.path.exists(BAK):
        os.remove(BAK)

print("\n=== 场景 6：恢复（从备份还原产品代码）===")
rc, fails = run_gate()
print(f"  exit={rc}（期望0）｜FAIL {len(fails)} 个")
for l in fails[:8]:
    print("   ", l)
assert rc == 0 and not fails, "场景6 恢复后未回绿！"
print("\n反向破坏验证通过：五场景双路变红 + 恢复回绿")

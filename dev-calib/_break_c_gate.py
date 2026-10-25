"""反向破坏验证：C 门禁必须能抓获三类破坏，恢复后回绿。改镜像拷贝，不动真源。"""
import subprocess, sys, shutil, os

L0_CORE = "D:/dsh-motor-ai-l0/node_modules/@wangxue98/dsh-motor-ai-core"
SRC = "D:/dsh-motor-ai-core"
GATE = ["node", "scripts/verify_bg_bins_calib.mjs"]
CWD = "D:/dsh-motor-ai-l0"

def run_gate():
    p = subprocess.run(GATE, cwd=CWD, capture_output=True, text=True, encoding="utf-8")
    tail = [l for l in p.stdout.splitlines() if l.startswith("  PASS=") or "[FAIL]" in l]
    return p.returncode, tail

def sync_mirror():
    """铁律：跑门禁前必须确保镜像与真源一致（防外部改动造成假绿灯/假红灯）"""
    shutil.rmtree(L0_CORE, ignore_errors=True)
    shutil.copytree(SRC, L0_CORE, dirs_exist_ok=True)
    src = open(os.path.join(SRC, "lib/motor-constants.mjs"), encoding="utf-8").read()
    mir = open(MC, encoding="utf-8").read()
    assert src == mir, "镜像与真源不一致（同步失败）"

def edit(path, old, new):
    with open(path, encoding="utf-8") as f:
        c = f.read()
    assert old in c, f"anchor not found in {path}: {old[:60]}"
    with open(path, "w", encoding="utf-8") as f:
        f.write(c.replace(old, new, 1))

MC = os.path.join(L0_CORE, "lib/motor-constants.mjs")
FE = os.path.join(L0_CORE, "lib/formula-engine.mjs")

print("=== 场景 0：同步镜像并核验与真源一致 ===")
sync_mirror()
print("  镜像已同步且与真源逐字节一致")

print("=== 场景 1：表值篡改（4 极 0.621 → 0.80，退回钢印） ===")
edit(MC, "induction: { 2: 0.624, 4: 0.621, 6: 0.575, 8: 0.557 },", "induction: { 2: 0.624, 4: 0.80, 6: 0.575, 8: 0.557 },")
rc, tail = run_gate()
print(f"  exit={rc} (期望非0)")
for l in tail[:6]:
    print(" ", l)
assert rc != 0, "场景1 门禁未变红 —— 门禁失效！"

print("\n=== 场景 2：消费旁路（airGapFluxForDesign 恒返回默认） ===")
edit(FE, "  if (!bgBinsOn(opts)) return AIR_GAP_FLUX_DEFAULT", "  return AIR_GAP_FLUX_DEFAULT // BREAK")
rc, tail = run_gate()
print(f"  exit={rc} (期望非0)")
for l in tail[:6]:
    print(" ", l)
assert rc != 0, "场景2 门禁未变红 —— 门禁失效！"

print("\n=== 场景 3：恢复（从真源重新拷贝） ===")
sync_mirror()
rc, tail = run_gate()
print(f"  exit={rc} (期望0)")
for l in tail:
    print(" ", l)
assert rc == 0, "场景3 恢复后未回绿！"
print("\n反向破坏验证通过：双场景变红 + 恢复回绿")

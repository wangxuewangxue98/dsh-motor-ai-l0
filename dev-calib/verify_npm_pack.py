"""tarball 解包 + 包内自检（P2 发布前铁律：工作树门禁全绿 ≠ 包内行为正确）"""
import json, os, tarfile, sys

TGZ = r"D:/tmp_l0_pack/dsh-motor-ai-l0-0.6.4.tgz"
DEST = r"D:/tmp_l0_pack/x"
fails = []

with tarfile.open(TGZ, "r:gz") as t:
    t.extractall(DEST)

r = os.path.join(DEST, "package")
print("解包根目录:", r, "存在:", os.path.isdir(r))

# 1 版本号
v = json.load(open(os.path.join(r, "package.json"), encoding="utf-8"))["version"]
print(f"[1] package.json version = {v}", "OK" if v == "0.6.4" else "FAIL")
if v != "0.6.4":
    fails.append("version")

# 2 P1 新增文件必须在包内
for f in ["index.mjs", "lib/issue-resolved.mjs", "tools/l0/issue-resolved-tool.mjs",
          "tools/l0/analytic-engine.mjs", "scripts/verify.mjs", "CHANGELOG.md"]:
    ok = os.path.exists(os.path.join(r, f))
    print(f"[2] {'OK  ' if ok else 'FAIL'} {f}")
    if not ok:
        fails.append(f)

# 3 P1-1 齿磁密口径修复确实进了包（关键：防"工作树改了但包内没带"）
ae = open(os.path.join(r, "tools/l0/analytic-engine.mjs"), encoding="utf-8").read()
has_kw, has_sf = "K_WAVE" in ae, "STACKING_FACTOR" in ae
print(f"[3] P1-1 在包内: K_WAVE={has_kw} STACKING_FACTOR={has_sf}",
      "OK" if (has_kw and has_sf) else "FAIL")
if not (has_kw and has_sf):
    fails.append("P1-1 缺失")

# 4 无关产物不得混入（用 listdir 判定，避免 Windows 保留设备名 nul 的 exists 假阳性）
top = set(os.listdir(r))
for bad in ["output", "dev-calib", "nul"]:
    mixed = bad in top
    print(f"[4] {'FAIL 混入 ' if mixed else 'OK  未混入 '}{bad}")
    if mixed:
        fails.append("mixed " + bad)
print(f"[4b] 包内顶层条目数={len(top)}: {sorted(top)[:12]}")

# 5 版本三重一致性（包内）
chg = open(os.path.join(r, "CHANGELOG.md"), encoding="utf-8").read()
skill = open(os.path.join(r, "skills/motor-l0-estimate/SKILL.md"), encoding="utf-8").read()
c1, c2 = "[0.6.4]" in chg, "version: 0.6.4" in skill
print(f"[5] 三重一致: package.json={v} CHANGELOG[0.6.4]={c1} SKILL.md={c2}",
      "OK" if (c1 and c2) else "FAIL")
if not (c1 and c2):
    fails.append("三重不一致")

# 6 运行时抽查：包内 P1-B 模块可被 import 且导出预期符号
sys.path.insert(0, r)
print("[6] 运行时 import 抽查（Python 侧仅做静态符号扫描，避免 node 依赖）")
iss = open(os.path.join(r, "lib/issue-resolved.mjs"), encoding="utf-8").read()
exported = "export" in iss and ("submitResolvedCase" in iss or "submit_resolved_case" in iss)
print("    lib/issue-resolved.mjs 导出符号:", "OK" if exported else "FAIL")
if not exported:
    fails.append("issue-resolved 无导出")

print("\n==== 自检结论 ====")
print("✅ 全部通过" if not fails else "❌ 失败项: " + ", ".join(fails))
sys.exit(0 if not fails else 1)

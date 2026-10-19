# -*- coding: utf-8 -*-
"""diag_y160l_winding.py — 单机诊断：导出 RMxprt .res 全文，读取实际构建的绕组数据。

目的：Y160L-4（Zs=9, wire 1.25×4）求解后电流 160.9A（铭牌 30.3A 的 5.3 倍）、
pf=0.27、eff=51.9%。等效电路取证学推断「有效匝数只有设计一半」，需 .res
全文中的绕组/等效电路真值证实或证伪。

用法：python diag_y160l_winding.py [conductors_per_slot] [wire_dia] [n_strands]
"""
import json
import os
import re
import sys

sys.path.insert(0, r"D:/MotorDesign/Scripts")
import rmxprt_tools as rt  # noqa: E402

PARAMS = r"D:/dsh-motor-ai-l0/output/y160_y180_rmxprt_params.json"
DUMP = r"D:/dsh-motor-ai-l0/output/rmxprt_res_diag.txt"


def main():
    zs = int(sys.argv[1]) if len(sys.argv) > 1 else 9
    wd = float(sys.argv[2]) if len(sys.argv) > 2 else 1.25
    ns = int(sys.argv[3]) if len(sys.argv) > 3 else 4
    params = json.load(open(PARAMS, encoding="utf-8"))
    p = [x for x in params if x.get("tag") == "Y160L-4"][0]
    p["conductors_per_slot"] = zs
    p["wire_dia"] = wd
    p["n_strands"] = ns
    os.environ["RMXPRT_DUMP_RES"] = DUMP
    print(f"[diag] Y160L-4: Zs={zs} wire={wd}x{ns} → dump {DUMP}")

    if not rt.is_available():
        print("[FATAL] RMxprt 不可用")
        return 2
    results = rt.solve_batch([p], verbose=False, machine_type="induction")
    r = results[0]
    for k in ("power", "efficiency", "stator_current", "power_factor",
              "stator_tooth_flux_density", "stator_yoke_flux_density",
              "air_gap_flux_density", "copper_loss", "slot_fill_rate", "slip"):
        print(f"  {k:30s} {r.get(k)}")

    if not os.path.exists(DUMP):
        print("[diag] ⚠ .res dump 未生成（env 未透传或求解失败）")
        return 3
    txt = open(DUMP, encoding="utf-8", errors="ignore").read()
    print(f"\n[diag] .res 全文 {len(txt)} 字符；关键行检索：")
    # 绕组/匝数/等效电路相关标签
    keys = [
        r"Turns?", r"Turn", r"Winding", r"Conductor", r"Coil", r"Wire",
        r"Resistance", r"Reactance", r"Magnetiz", r"Leakage",
        r"Stator.*Current", r"Slot", r"Fill", r"Phase", r"Connection",
    ]
    seen = set()
    for line in txt.splitlines():
        s = line.strip()
        if not s or s in seen:
            continue
        if any(re.search(k, s, re.I) for k in keys) and (":" in s or "=" in s):
            if len(s) < 160:
                seen.add(s)
                print("   ", s)
    return 0


if __name__ == "__main__":
    sys.exit(main())

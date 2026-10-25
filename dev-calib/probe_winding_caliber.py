#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
口径实验：固定 Y801-2 几何/槽形，只变绕组口径，观测 RMxprt 的 Bg 响应。
目的：定死 turns_per_coil / conductors_per_slot / 频率 的口径归属（E 平衡 ⇒ Bg∝1/N）。
预期：若 Bg∝1/N ⇒ 确认 E 平衡主导；量化 cps=turns 与 cps=2×turns 两种口径的差。
"""
import json, math, os, sys, time

sys.path.insert(0, r"D:/MotorDesign/Scripts")
import rmxprt_tools as rt  # noqa: E402

CAT = r"D:/dsh-motor-ai-l0/dev-calib/real_slot_catalogue.json"
OUT = r"D:/dsh-motor-ai-l0/output/p2_winding_caliber_probe.json"

base = json.load(open(CAT, encoding="utf-8"))["rows"][0]  # Y801-2
KEYS = ["stator_tooth_flux_density", "stator_yoke_flux_density", "air_gap_flux_density",
        "efficiency", "slip", "stator_current", "power_factor"]

# (标签, turns_per_coil, conductors_per_slot, frequency)
CASES = [
    ("turns144_cps144_f50",  144, 144, 50.0),
    ("turns72_cps144_f50",    72, 144, 50.0),   # cps=2×turns 口径
    ("turns288_cps288_f50",  288, 288, 50.0),
    ("turns144_cps144_f47",  144, 144, 47.2),   # 解析按转速推频口径
    ("turns144_cps72_f50",   144,  72, 50.0),   # cps=turns/2
]

rows = []
for label, tpc, cps, f in CASES:
    p = dict(base["params"])
    p["turns_per_coil"] = float(tpc)
    p["conductors_per_slot"] = cps
    p["frequency"] = f
    try:
        res = rt.solve_batch([p], verbose=False, machine_type="induction")
        x = res[0] if isinstance(res, list) else res
    except Exception as e:
        x = {"solve_failed_reason": str(e)}
    rec = {"label": label, "turns_per_coil": tpc, "cps": cps, "frequency": f,
           "rmxprt": {k: x.get(k) for k in KEYS} if isinstance(x, dict) else {},
           "ok": isinstance(x, dict) and x.get("solve_mode") == "rmxprt"}
    rows.append(rec)
    print("%-22s tpc=%3d cps=%3d f=%.1f | Bg=%s Bt=%s By=%s I=%s" % (
        label, tpc, cps, f,
        rec["rmxprt"].get("air_gap_flux_density"), rec["rmxprt"].get("stator_tooth_flux_density"),
        rec["rmxprt"].get("stator_yoke_flux_density"), rec["rmxprt"].get("stator_current")), flush=True)

json.dump({"generated_by": "dev-calib/probe_winding_caliber.py", "base_tag": base["tag"], "rows": rows},
          open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("[done] →", OUT)

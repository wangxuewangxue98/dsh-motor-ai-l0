#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
run_p2_real_truth.py — 批跑「真机型谱 + 显式自洽槽形」catalogue，取 RMxprt 磁密真值

与 run_p2_tooth_truth.py 的区别：
  · 后者喂 designs.db 的**派生齿宽**（0.5×槽距，平行齿假设）→ 属"类比设计域"，
    解析与求解器天然同源 ⇒ K≈0.991，不能用来定标等效宽模型；
  · 本脚本**显式给定自洽梨形槽**（Slot__Bs*/Hs*），齿宽沿径向按 tau 铺开，
    解析侧吃同一槽形反算的齿顶/齿根宽 ⇒ 可真正检验 toothShapeK() 的等效宽模型形式。

用法：
  python dev-calib/run_p2_real_truth.py --limit 6            # 探针
  python dev-calib/run_p2_real_truth.py                      # 全量 65 台
"""
import argparse
import json
import math
import os
import sys
import time

sys.path.insert(0, r"D:/MotorDesign/Scripts")
import rmxprt_tools as rt  # noqa: E402

CAT = r"D:/dsh-motor-ai-l0/dev-calib/real_slot_catalogue.json"
OUT = r"D:/dsh-motor-ai-l0/output/p2_real_truth.json"
LOG = r"D:/dsh-motor-ai-l0/output/p2_real_truth.log"

TRUTH_KEYS = [
    "stator_tooth_flux_density", "stator_yoke_flux_density", "air_gap_flux_density",
    "rotor_tooth_flux_density", "rotor_yoke_flux_density",
    "efficiency", "power", "torque", "slip", "stator_current", "power_factor",
    "current_density", "slot_fill_rate",
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--chunk", type=int, default=12)
    ap.add_argument("--cat", default=CAT)
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args()

    if not rt.is_available():
        print("[FATAL] RMxprt 不可用")
        return 2
    doc = json.load(open(a.cat, encoding="utf-8"))
    rows = doc["rows"]
    if a.limit:
        rows = rows[:a.limit]
    print(f"[select] {len(rows)} 台", flush=True)

    t0 = time.time()
    out, log_lines = [], []

    def emit(s):
        print(s, flush=True)
        log_lines.append(s)

    for i in range(0, len(rows), a.chunk):
        batch = rows[i:i + a.chunk]
        params = [r["params"] for r in batch]
        emit(f"[batch {i//a.chunk+1}] {len(params)} 台 …")
        try:
            res = rt.solve_batch(params, verbose=False, machine_type="induction")
        except Exception as e:
            emit(f"  [ERR] solve_batch: {e}")
            res = [None] * len(params)
        for r, p, x in zip(batch, params, res):
            rec = {"tag": r["tag"], "geom": r["geom"], "inputs": p, "rmxprt": {}}
            ok = False
            if isinstance(x, dict):
                for k in TRUTH_KEYS:
                    if k in x:
                        rec["rmxprt"][k] = x[k]
                bt = x.get("stator_tooth_flux_density")
                ok = bool(bt and float(bt) > 0.05) and (x.get("solve_mode") == "rmxprt")
                rec["solve_ok"] = ok
                rec["solve_failed_reason"] = x.get("solve_failed_reason")
            out.append(rec)
            g = r["geom"]
            rm = rec["rmxprt"]
            emit("  %s %-12s tau=%.2f k=%.3f tw_top=%.2f tw_root=%.2f | Bt=%s By=%s Bg=%s" % (
                "OK " if ok else "FAIL", r["tag"], g["tau_effective"], g["k_shape_avg_over_min"],
                g["tw_top_mm"], g["tw_root_mm"],
                rm.get("stator_tooth_flux_density"), rm.get("stator_yoke_flux_density"),
                rm.get("air_gap_flux_density")))
            if not ok:
                emit("       reason=%s" % str(rec.get("solve_failed_reason"))[:120])

    n_ok = sum(1 for r in out if r["solve_ok"])
    bys = [float(r["rmxprt"]["stator_yoke_flux_density"]) for r in out
           if r["solve_ok"] and r["rmxprt"].get("stator_yoke_flux_density")]
    payload = {
        "generated_by": "dev-calib/run_p2_real_truth.py",
        "catalogue": a.cat,
        "yoke_ratio": doc.get("yoke_ratio"),
        "total": len(out), "solve_ok": n_ok,
        "elapsed_s": round(time.time() - t0, 1),
        "By_stats": {
            "n": len(bys),
            "median": round(sorted(bys)[len(bys) // 2], 4) if bys else None,
            "min": round(min(bys), 4) if bys else None,
            "max": round(max(bys), 4) if bys else None,
            "n_gt_2p0": sum(1 for b in bys if b > 2.0),
        } if bys else {},
        "rows": out,
    }
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write("\n".join(log_lines) + "\n")
    emit(f"\n[done] {n_ok}/{len(out)} 台真值可用，用时 {payload['elapsed_s']}s → {a.out}")
    if bys:
        emit(f"[By] n={len(bys)} median={payload['By_stats']['median']} "
             f"range=[{payload['By_stats']['min']},{payload['By_stats']['max']}] "
             f">2.0T 共 {payload['By_stats']['n_gt_2p0']} 台")
    return 0


if __name__ == "__main__":
    sys.exit(main())

# -*- coding: utf-8 -*-
"""run_p2_y2_batch.py — ② 扩样: Y 系列 catalog(65台) 派生几何+EMF匝数+auto-wire 求解,
带 slip 合理性过滤器, 与已有 v1 真值(37台 designs.db) 合并为 p2_torque_truth_v2.json。

诚实边界:
  - Y 系列绕组为 EMF 方程按目标 Bg=0.75T 合成(非真机绕组), 绝对 Tst/Tmax/Ist 近似;
    其价值在跨功率(0.55~90kW)/跨极数(2/4/6/8)的 *结构信号*, 供回归用。
  - 小机座(≈≤1.1kW)合成绕组退化(slip≫5% 且 Tst≈Tmax), 由过滤器剔除, 仅保留 plausible 行。
  - 逐行标注 provenance / slip / plausible, 供下游回归按权重/过滤使用。
"""
import argparse
import json
import math
import os
import sqlite3
import sys
import time

SCRIPTS = r"D:/MotorDesign/Scripts"
CAT = r"D:/MotorDesign/Knowledge/y_series_physics.json"
V1 = r"D:/dsh-motor-ai-l0/output/p2_torque_truth.json"
OUT = r"D:/dsh-motor-ai-l0/output/p2_torque_truth_v2.json"
sys.path.insert(0, SCRIPTS)
import rmxprt_tools as rt  # noqa: E402

# 合理性过滤阈值
SLIP_MIN, SLIP_MAX = 0.005, 0.08          # 0.5% ~ 8%
TST_TMAX_MIN_DELTA = 0.05                  # Tst_pu 与 Tmax_pu 至少差 0.05 (剔除退化 Tst==Tmax)
EFF_MIN, EFF_MAX = 50.0, 96.0

TRUTH_KEYS = [
    "efficiency", "torque", "rated_torque", "breakdown_torque", "starting_torque",
    "starting_current_ratio", "stator_current", "power_factor", "slip",
    "stator_tooth_flux_density", "stator_yoke_flux_density",
    "rotor_tooth_flux_density", "rotor_yoke_flux_density", "air_gap_flux_density",
    "current_density", "copper_loss", "iron_loss", "total_loss", "max_temp", "slot_fill_rate",
]


def estimate_turns(poles, Dsi, L, Qs, a, V, f=50.0, Bg=0.75):
    Vph = V / math.sqrt(3); phi = Bg * (Dsi / 1000) * (L / 1000) / poles; kw1 = 0.955
    Nph = Vph / (4.44 * f * kw1 * phi) if phi > 0 else 0
    return max(1, int(round(Nph * 6 * a / (2 * Qs))))


def build_y2(m):
    Dso = float(m["stator_od_mm"]); Dsi = float(m["stator_inner_dia_mm"])
    ag = float(m["air_gap_mm"]); L = float(m["core_length_mm"])
    Qs = int(m["slots_stator"]); p = int(m["poles"]); V = float(m["voltage_v"])
    a = 1 if p <= 2 else 2
    rotor_od = round(Dsi - 2 * ag, 2)
    shaft_dia = round(max(14.0, 0.12 * Dso), 2)
    tooth_width = round((math.pi * Dsi / Qs) * 0.5, 2)
    yoke_thickness = round((Dso - Dsi) / 2 * 0.45, 2)
    tpc = estimate_turns(p, Dsi, L, Qs, a, V)
    return {
        "tag": f"Y2_{m['model']}", "model": m["model"],
        "stator_od": Dso, "stator_id": Dsi, "air_gap": ag, "slots_stator": Qs,
        "slots_rotor": int(m["slots_rotor"]), "poles": p, "voltage": V,
        "speed": float(m["speed_rpm"]), "frequency": 50.0, "core_length": L,
        "power": float(m["power_kw"]),
        "turns_per_coil": float(tpc), "conductors_per_slot": int(round(tpc)),
        "wire_dia": None, "n_strands": None, "parallel_circuits": a,
        "winding_connection": "star", "motor_type": "induction",
        "shaft_dia": shaft_dia, "rotor_od": rotor_od,
        "tooth_width": tooth_width, "yoke_thickness": yoke_thickness,
    }


def plausible(x, Tst_pu, Tmax_pu):
    slip = float(x.get("slip") or 0)
    eff = float(x.get("efficiency") or 0)
    if not (SLIP_MIN <= slip <= SLIP_MAX):
        return False, f"slip={slip:.4f} 越界[{SLIP_MIN},{SLIP_MAX}]"
    if not (EFF_MIN <= eff <= EFF_MAX):
        return False, f"eff={eff:.2f} 越界[{EFF_MIN},{EFF_MAX}]"
    if Tst_pu is not None and Tmax_pu is not None and abs(Tst_pu - Tmax_pu) < TST_TMAX_MIN_DELTA:
        return False, f"Tst_pu≈Tmax_pu({Tst_pu}) 退化"
    return True, ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="仅前 N 台(0=全量)")
    ap.add_argument("--chunk", type=int, default=10)
    ap.add_argument("--sample", type=int, default=0, help="跨功率分层抽样 N 台做表征(0=关闭)")
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()

    if not rt.is_available():
        print("[FATAL] RMxprt 不可用"); return 2

    cat = json.load(open(CAT, encoding="utf-8"))["catalog"]
    print(f"[catalog] 共 {len(cat)} 台 Y 系列")

    models = cat
    if args.sample > 0:
        step = max(1, len(cat) // args.sample)
        models = cat[::step][:args.sample]
        print(f"[sample] 分层抽样 {len(models)} 台")
    if args.limit > 0:
        models = models[:args.limit]

    params = [build_y2(m) for m in models]
    t0 = time.time()
    out_rows = []
    for ci in range(0, len(params), args.chunk):
        batch = params[ci:ci + args.chunk]
        res = rt.solve_batch(batch, verbose=False, machine_type="induction")
        for p, x in zip(batch, res):
            ok = (x.get("solve_mode") == "rmxprt") and (float(x.get("power") or 0) > 0)
            rm = {k: x[k] for k in TRUTH_KEYS if k in x}
            rt_ = float(rm.get("rated_torque") or (9550.0 * p["power"] / p["speed"]))
            Tst = float(rm.get("starting_torque") or 0.0)
            Tmax = float(rm.get("breakdown_torque") or 0.0)
            Ist = float(rm.get("starting_current_ratio") or 0.0)
            Tst_pu = round(Tst / rt_, 4) if (ok and rt_ > 0) else None
            Tmax_pu = round(Tmax / rt_, 4) if (ok and rt_ > 0) else None
            Ist_pu = round(Ist, 4) if (ok and Ist > 0) else None
            rm["Tst_pu"] = Tst_pu; rm["Tmax_pu"] = Tmax_pu; rm["Ist_pu"] = Ist_pu
            is_plau, why = (plausible(x, Tst_pu, Tmax_pu) if ok else (False, "solve_fail"))
            rec = {
                "tag": p["tag"], "model": p.get("model"), "inputs": p,
                "solve_ok": bool(ok), "solve_mode": x.get("solve_mode"),
                "solve_failed_reason": x.get("solve_failed_reason"),
                "provenance": "synthesized_y2", "slip": float(x.get("slip") or 0),
                "plausible": bool(is_plau), "plausible_reason": why,
                "rmxprt": rm,
            }
            out_rows.append(rec)
            if ok:
                flag = "OK " if is_plau else "WARN"
                print(f"  [{flag}] {p['tag']}: eff={rm.get('efficiency')} slip={x.get('slip')} "
                      f"Tst={Tst_pu} Tmax={Tmax_pu} Ist={Ist_pu} {'' if is_plau else why}")
            else:
                print(f"  [FAIL] {p['tag']}: {str(x.get('solve_failed_reason'))[:80]}")
    elapsed = time.time() - t0

    # 合并 v1 (designs.db 37 台, provenance=reliable_db)
    v1 = json.load(open(V1, encoding="utf-8"))
    v1_rows = v1.get("rows", [])
    for r in v1_rows:
        r.setdefault("provenance", "reliable_db")
        r.setdefault("plausible", True)
        r.setdefault("plausible_reason", "designs.db 真实绕组求解")
        r.setdefault("slip", None)

    merged = v1_rows + out_rows
    n_ok = sum(1 for r in out_rows if r["solve_ok"])
    n_plau = sum(1 for r in out_rows if r["plausible"])
    payload = {
        "generated_by": "P2 转矩真值集 v2 (designs.db 37 + Y系列catalog 合成绕组)",
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "sources": {
            "reliable_db": "D:/MotorDesign/KnowledgeBase/designs.db (55kW/660V 35 + Y160L/Y180M 2, 真实绕组)",
            "synthesized_y2": "D:/MotorDesign/Knowledge/y_series_physics.json (EMF合成绕组, 近似)",
        },
        "filters": {"slip": [SLIP_MIN, SLIP_MAX], "Tst_Tmax_delta_min": TST_TMAX_MIN_DELTA,
                    "eff": [EFF_MIN, EFF_MAX]},
        "caveats": [
            "Y系列绕组为 EMF(Bg=0.75T)合成, 非真机绕组, 绝对 Tst/Tmax/Ist 近似;",
            "小机座(≈≤1.1kW)合成退化已被 slip 过滤器剔除;",
            "仅 plausible=True 行建议用于回归; reliable_db 行始终可信。",
        ],
        "stats": {
            "v1_reliable_db": len(v1_rows),
            "y2_total": len(out_rows), "y2_solved": n_ok, "y2_plausible": n_plau,
            "merged_total": len(merged),
            "merged_plausible": sum(1 for r in merged if r["plausible"]),
            "elapsed_s": round(elapsed, 1),
        },
        "rows": merged,
    }
    json.dump(payload, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"\n[done] 写出 {args.out}")
    print(f"[stats] y2 solved={n_ok}/{len(out_rows)} plausible={n_plau}; "
          f"merged plausible={payload['stats']['merged_plausible']}/{len(merged)}; {elapsed:.0f}s")


if __name__ == "__main__":
    sys.exit(main())

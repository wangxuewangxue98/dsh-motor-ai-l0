# -*- coding: utf-8 -*-
"""append_y160_y180_p2.py — 把 Y160L-4 / Y180M-4 两台真实机补进 P2 真值集,
并借新加的 starting_current_ratio 字段验证 Ist 提取, 同时与已知锚 (Y160L Tmax2.915/Tst2.257/Ist6.377,
Y180M Tmax3.201/Tst2.286/Ist7.099) 对照。

来源: output/y160_y180_rmxprt_params.json (build_y160_y180_rmxprt_params.mjs 生成, 真实机几何)
通道: rt.solve_batch(machine_type="induction") —— 与 55kW 家族同通道, 故 Ist 字段可用。
"""
import json
import os
import sys
import time

sys.path.insert(0, r"D:/MotorDesign/Scripts")
import rmxprt_tools as rt  # noqa: E402

PARAMS = r"D:/dsh-motor-ai-l0/output/y160_y180_rmxprt_params.json"
TRUTH = r"D:/dsh-motor-ai-l0/output/p2_torque_truth.json"


def main():
    if not rt.is_available():
        print("[FATAL] RMxprt 不可用")
        return 2
    params = json.load(open(PARAMS, encoding="utf-8"))
    # 映射 connection -> winding_connection (worker 需 winding_connection)
    for p in params:
        p["winding_connection"] = p.pop("connection", "star")
        p["motor_type"] = "induction"
    t0 = time.time()
    res = rt.solve_batch(params, verbose=True, machine_type="induction")
    print(f"[solve] 2 台真实机耗时 {time.time()-t0:.1f}s")

    # 已知锚 (来自前序 Y160L/Y180M RMxprt 实跑)
    ANCHOR = {
        "Y160L-4": {"Tmax": 2.915, "Tst": 2.257, "Ist": 6.377},
        "Y180M-4": {"Tmax": 3.201, "Tst": 2.286, "Ist": 7.099},
    }

    append_rows = []
    for p, x in zip(params, res):
        tag = p["tag"]
        ok = (x.get("solve_mode") == "rmxprt") and (float(x.get("power") or 0) > 0)
        rm = {}
        for k in ["efficiency", "torque", "rated_torque", "breakdown_torque",
                  "starting_torque", "starting_current_ratio", "stator_current",
                  "power_factor", "stator_tooth_flux_density", "stator_yoke_flux_density",
                  "air_gap_flux_density", "current_density"]:
            if k in x:
                rm[k] = x[k]
        rt_ = float(rm.get("rated_torque") or (9550.0 * p["power"] / p["speed"]))
        tst = float(rm.get("starting_torque") or 0.0)
        tmax = float(rm.get("breakdown_torque") or 0.0)
        ist = float(rm.get("starting_current_ratio") or 0.0)
        rm["Tst_pu"] = round(tst / rt_, 4) if rt_ > 0 else None
        rm["Tmax_pu"] = round(tmax / rt_, 4) if rt_ > 0 else None
        rm["Ist_pu"] = round(ist, 4) if ist > 0 else None
        rec = {"db_id": f"y160_y180:{tag}", "tag": tag, "inputs": p,
               "solve_ok": bool(ok), "solve_mode": x.get("solve_mode"),
               "solve_failed_reason": x.get("solve_failed_reason"), "rmxprt": rm}
        append_rows.append(rec)
        a = ANCHOR.get(tag, {})
        print(f"  {tag}: ok={ok} eff={rm.get('efficiency')}% Tst={rm.get('Tst_pu')} "
              f"(锚{a.get('Tst')}) Tmax={rm.get('Tmax_pu')} (锚{a.get('Tmax')}) "
              f"Ist={rm.get('Ist_pu')} (锚{a.get('Ist')})")

    # 合并进真值集
    d = json.load(open(TRUTH, encoding="utf-8"))
    existing_ids = {r["db_id"] for r in d["rows"]}
    added = 0
    for r in append_rows:
        if r["db_id"] not in existing_ids:
            d["rows"].append(r)
            added += 1
    # 更新统计
    rows = d["rows"]
    d["stats"] = {
        "total": len(rows),
        "solve_ok": sum(1 for r in rows if r["solve_ok"]),
        "with_Tst": sum(1 for r in rows if r["rmxprt"].get("Tst_pu")),
        "with_Tmax": sum(1 for r in rows if r["rmxprt"].get("Tmax_pu")),
        "with_Ist": sum(1 for r in rows if r["rmxprt"].get("Ist_pu")),
        "elapsed_s": round(d["stats"].get("elapsed_s", 0), 1),
    }
    d["note_y160_y180"] = "已并入 Y160L-4 / Y180M-4 真实机 (15/18.5kW, 380V) 作为跨功率锚点"
    json.dump(d, open(TRUTH, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"[merge] 并入 {added} 台, 真值集现共 {len(rows)} 行, 真解 {d['stats']['solve_ok']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

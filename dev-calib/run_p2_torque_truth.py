# -*- coding: utf-8 -*-
"""run_p2_torque_truth.py — 路径 A: 补跑 ≥30 台异步机 RMxprt 真值集 (Tst/Tmax/Ist)。

口径与假设 (写真值集 JSON 的 winding_assumptions, 供校准方核对):
  - 真值源: D:/MotorDesign/KnowledgeBase/designs.db 中 solve_mode='rmxprt' 且几何齐全的行
    (这些行是此前 RMxprt 真实求解过的几何, 仅缺失 breakdown/starting 转矩与启动电流字段)。
  - 绕组重建 (与原始 rmxprt 求解同口径, 非 2×turns):
      conductors_per_slot = turns_per_coil       (worker 旧回退行为; 2× 会使功率=0 求解失效, 已证伪)
      winding_connection  = 'star'               (designs.db 未存接法, 默认星接; 标幺转矩/电流与接法无关)
      wire_dia / n_strands / parallel_circuits 取 designs.db 行 params JSON 的 _physics 值
  - 频率按物理一致推导: f = poles * speed / 120  (避免 designs.db 个别行 51.5Hz 噪声)
  - 输出: output/p2_torque_truth.json (inputs + RMxprt Tst/Tmax/Ist + 标幺派生) + 报告摘要

用法:
  python run_p2_torque_truth.py --limit 6 --out output/p2_torque_truth_sample.json   # 验证
  python run_p2_torque_truth.py --limit 44 --out output/p2_torque_truth.json         # 正式 ≥30
"""
import argparse
import json
import os
import sqlite3
import sys
import time

DB = r"D:/MotorDesign/KnowledgeBase/designs.db"
SCRIPTS = r"D:/MotorDesign/Scripts"

# 默认不回灌 stored 线径, 改由 RMxprt 按槽满率自动选线 (规避 designs.db 个别线径/cps 失配)
OMIT_WIRE = True

sys.path.insert(0, SCRIPTS)
import rmxprt_tools as rt  # noqa: E402


def _freq_from(poles, speed):
    try:
        return round(poles * float(speed) / 120.0, 2)
    except Exception:
        return 50.0


def select_rows(limit=44, per_group=2, reliable_only=False):
    """选 diverse 的 rmxprt 全几何行: 按 (poles, power_kw, voltage_v) 分组各取 per_group。

    reliable_only=True 时只取经验可解家族 (4极55kW@660V 全 35 行 + 2极@3000rpm),
    规避 designs.db 中几何/cps 不可解的过小类比设计。
    """
    con = sqlite3.connect(DB)
    cur = con.cursor()
    extra = ""
    if reliable_only:
        extra = (" AND ((poles=4 AND power_kw=55 AND voltage_v=660) "
                 "OR (poles=2 AND speed_rpm=3000)) ")
    q = f"""
        SELECT id, poles, power_kw, voltage_v, speed_rpm, stator_od, stator_id,
               core_length, air_gap, slots_stator, slots_rotor, turns_per_coil,
               rotor_od, tooth_width, yoke_thickness, shaft_dia, params
        FROM designs
        WHERE solve_mode='rmxprt'
          AND stator_od IS NOT NULL AND stator_id IS NOT NULL AND core_length IS NOT NULL
          AND air_gap IS NOT NULL AND slots_stator IS NOT NULL AND slots_rotor IS NOT NULL
          AND turns_per_coil IS NOT NULL
          AND rotor_od IS NOT NULL AND tooth_width IS NOT NULL AND yoke_thickness IS NOT NULL
          AND shaft_dia IS NOT NULL
          AND speed_rpm <= 5000            -- 排除 15000rpm 异常行 (250Hz, 非标电机)
          {extra}
        ORDER BY poles, power_kw, voltage_v, id
    """
    cur.execute(q)
    rows = cur.fetchall()
    con.close()
    cols = ["id", "poles", "power_kw", "voltage_v", "speed_rpm", "stator_od", "stator_id",
            "core_length", "air_gap", "slots_stator", "slots_rotor", "turns_per_coil",
            "rotor_od", "tooth_width", "yoke_thickness", "shaft_dia", "params"]
    recs = [dict(zip(cols, r)) for r in rows]

    # 分组去重取样
    groups = {}
    picked = []
    for r in recs:
        g = (r["poles"], r["power_kw"], r["voltage_v"])
        groups.setdefault(g, 0)
        if groups[g] < per_group:
            picked.append(r)
            groups[g] += 1
        if len(picked) >= limit:
            break
    return picked


def build_param(r):
    pj = {}
    try:
        pj = json.loads(r["params"]) if r["params"] else {}
    except Exception:
        pj = {}
    phys = pj.get("_physics", {}) or {}
    turns = float(r["turns_per_coil"])
    wire = phys.get("wire_diameter")
    strands = phys.get("num_strands")
    if wire is None:
        w = pj.get("Winding__WireDiameter")
        if isinstance(w, str):
            wire = float(w.replace("mm", "").replace("'", "").strip())
    if strands is None:
        s = pj.get("Winding__NumberOfStrands")
        try:
            strands = int(str(s).replace("'", "").strip())
        except Exception:
            strands = None
    freq = _freq_from(r["poles"], r["speed_rpm"])
    # 绕组重建: 与原始 rmxprt 求解同口径 (worker 旧回退行为 conductors_per_slot = turns_per_coil)
    cps = int(round(turns))
    # wire/n_strands: 默认交给 RMxprt 按槽满率自动选线 (避免 designs.db 个别线径与 cps 失配导致槽满溢/功率=0);
    # 仅当 --use-wire 时回灌 stored 线径。
    wd = None if OMIT_WIRE else (float(wire) if wire is not None else None)
    ns = None if OMIT_WIRE else (int(strands) if strands is not None else None)
    return {
        "tag": f"P{int(r['poles'])}_{r['power_kw']}kW_V{int(r['voltage_v'])}",
        "db_id": r["id"],
        "stator_od": float(r["stator_od"]),
        "stator_id": float(r["stator_id"]),
        "air_gap": float(r["air_gap"]),
        "slots_stator": int(r["slots_stator"]),
        "slots_rotor": int(r["slots_rotor"]),
        "poles": int(r["poles"]),
        "voltage": float(r["voltage_v"]),
        "speed": float(r["speed_rpm"]),
        "frequency": freq if freq == 50.0 or freq == 60.0 else 50.0,
        "core_length": float(r["core_length"]),
        "power": float(r["power_kw"]),
        "turns_per_coil": turns,
        "conductors_per_slot": cps,
        "wire_dia": wd,
        "n_strands": ns,
        "parallel_circuits": int(pj.get("parallel_circuits") or 1),
        "winding_connection": "star",
        "motor_type": "induction",
        "shaft_dia": float(r["shaft_dia"]),
        "rotor_od": float(r["rotor_od"]),
        "tooth_width": float(r["tooth_width"]),
        "yoke_thickness": float(r["yoke_thickness"]),
    }


TRUTH_KEYS = [
    "efficiency", "torque", "rated_torque", "breakdown_torque", "starting_torque",
    "starting_current_ratio", "stator_current", "power_factor", "slip",
    "stator_tooth_flux_density", "stator_yoke_flux_density",
    "rotor_tooth_flux_density", "rotor_yoke_flux_density", "air_gap_flux_density",
    "current_density", "copper_loss", "iron_loss", "total_loss", "max_temp",
    "slot_fill_rate",
]


def run(rows, out_path, chunk=12):
    if not rt.is_available():
        print("[FATAL] RMxprt 不可用 (is_available=False)")
        return 2
    params = [build_param(r) for r in rows]
    print(f"[run] {len(params)} 台异步机, 分片 {chunk}/批")
    out_rows = []
    t0 = time.time()
    for ci in range(0, len(params), chunk):
        batch = params[ci:ci + chunk]
        print(f"\n=== 分片 {ci // chunk + 1}: 机型 {[p['tag'] for p in batch]} ===")
        res = rt.solve_batch(batch, verbose=True, machine_type="induction")
        for p, x in zip(batch, res):
            rec = {"db_id": p["db_id"], "tag": p["tag"], "inputs": p}
            ok = (x.get("solve_mode") == "rmxprt") and (float(x.get("power") or 0) > 0)
            rec["solve_ok"] = bool(ok)
            rec["solve_mode"] = x.get("solve_mode")
            rec["solve_failed_reason"] = x.get("solve_failed_reason")
            rm = {}
            for k in TRUTH_KEYS:
                if k in x:
                    rm[k] = x[k]
            # 标幺派生
            try:
                rt_ = float(rm.get("rated_torque") or (9550.0 * p["power"] / p["speed"]))
                tst = float(rm.get("starting_torque") or 0.0)
                tmax = float(rm.get("breakdown_torque") or 0.0)
                ist = float(rm.get("starting_current_ratio") or 0.0)
                rm["Tst_pu"] = round(tst / rt_, 4) if rt_ > 0 else None
                rm["Tmax_pu"] = round(tmax / rt_, 4) if rt_ > 0 else None
                rm["Ist_pu"] = round(ist, 4) if ist > 0 else None
            except Exception:
                pass
            rec["rmxprt"] = rm
            out_rows.append(rec)
            if ok:
                print(f"  [OK] {p['tag']}: eff={rm.get('efficiency')}% Tst={rm.get('Tst_pu')} "
                      f"Tmax={rm.get('Tmax_pu')} Ist={rm.get('Ist_pu')}")
            else:
                print(f"  [FAIL] {p['tag']}: mode={x.get('solve_mode')} reason={str(x.get('solve_failed_reason'))[:120]}")
    elapsed = time.time() - t0

    n_ok = sum(1 for r in out_rows if r["solve_ok"])
    n_tst = sum(1 for r in out_rows if r["rmxprt"].get("Tst_pu"))
    n_tmax = sum(1 for r in out_rows if r["rmxprt"].get("Tmax_pu"))
    n_ist = sum(1 for r in out_rows if r["rmxprt"].get("Ist_pu"))
    payload = {
        "generated_by": "P2 转矩真值集 (RMxprt induction batch, 路径 A)",
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source": DB,
        "solve_mode": "rmxprt",
        "winding_assumptions": {
            "conductors_per_slot": "turns_per_coil (worker 旧回退/原始 db 求解同口径; 2×turns 会导致功率=0 求解失效, 已剔除)",
            "winding_connection": "star (designs.db 未存接法, 默认星接; 标幺转矩/电流与接法无关)",
            "frequency": "f = poles * speed / 120 (物理一致, 规避 designs.db 个别 51.5Hz 噪声)",
            "wire_dia_n_strands": "取 designs.db 行 params JSON _physics 值",
        },
        "stats": {
            "total": len(out_rows), "solve_ok": n_ok,
            "with_Tst": n_tst, "with_Tmax": n_tmax, "with_Ist": n_ist,
            "elapsed_s": round(elapsed, 1),
        },
        "rows": out_rows,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"\n[run] 写出 {out_path} | 真解 {n_ok}/{len(out_rows)}, "
          f"Tst {n_tst}, Tmax {n_tmax}, Ist {n_ist} | 耗时 {elapsed:.1f}s")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=44)
    ap.add_argument("--per-group", type=int, default=2)
    ap.add_argument("--out", default=r"D:/dsh-motor-ai-l0/output/p2_torque_truth.json")
    ap.add_argument("--chunk", type=int, default=12)
    ap.add_argument("--use-wire", action="store_true",
                    help="回灌 designs.db stored 线径 (默认否, 由 RMxprt 自动选线)")
    ap.add_argument("--reliable-only", action="store_true",
                    help="只取经验可解家族 (4极55kW@660V + 2极@3000rpm)")
    args = ap.parse_args()
    global OMIT_WIRE
    OMIT_WIRE = not args.use_wire
    rows = select_rows(limit=args.limit, per_group=args.per_group,
                       reliable_only=args.reliable_only)
    print(f"[select] 选中 {len(rows)} 行 (OMIT_WIRE={OMIT_WIRE}, reliable_only={args.reliable_only})")
    return run(rows, args.out, chunk=args.chunk)


if __name__ == "__main__":
    sys.exit(main())

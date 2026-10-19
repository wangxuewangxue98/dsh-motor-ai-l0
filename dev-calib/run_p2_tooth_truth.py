#!/usr/bin/env python3
"""
run_p2_tooth_truth.py — 补 ≥30 台「带齿宽」异步机的 RMxprt 磁密真值集
目的：标定 analytic-engine doSaturationLoop 齿磁密 Bt 的残余 +24% 高估（P1-1 后）

背景（2026-10-19 审计结论）：
  1. designs.db designs 表 81 行含 tooth_width + stator_tooth_flux_density，但：
     - 齿宽实为派生值：|tooth_width − 0.5×槽距| ≤ 0.005mm（= core toothWidth() 同口径，平行齿假设）
     - 存量磁密字段部分被污染：By_true 最大 9.807T（物理荒谬），19 行 >2.0T
     ⇒ 存量字段**不可直接用于标定**，必须重跑 RMxprt 取可信真值。
  2. 生产链路 doSaturationLoop 输入：B_*_base 来自 core quickL0Estimate，
     toothWidth/yokeThickness 来自 core 派生函数 ⇒ 标定系数吸收的是
     "平行齿派生齿宽 vs 真机梯形齿等效宽" 的系统偏差（即 P1-1 注释所述残余源）。

本脚本：从 designs.db 取几何+齿宽+轭厚+绕组 → rt.solve_batch(induction) →
        收集 .res 磁密真值（Stator-Teeth/Yoke、Air-Gap）→ 与 db 存量字段对照存档。

用法：
  python dev-calib/run_p2_tooth_truth.py --limit 5            # 探针
  python dev-calib/run_p2_tooth_truth.py --out output/xxx.json # 全量
"""
import argparse, json, math, os, sqlite3, sys, time

sys.path.insert(0, r"D:/MotorDesign/Scripts")
import rmxprt_tools as rt  # noqa: E402

DB = r"D:/MotorDesign/KnowledgeBase/designs.db"
OMIT_WIRE = True  # 默认交 RMxprt 按槽满率自动选线（P2 实证：回灌 stored 线径易致 power=0）

FLUX_KEYS = [
    "stator_tooth_flux_density", "stator_yoke_flux_density",
    "rotor_tooth_flux_density", "rotor_yoke_flux_density", "air_gap_flux_density",
]
TRUTH_KEYS = FLUX_KEYS + [
    "efficiency", "power", "torque", "rated_torque", "slip",
    "stator_current", "power_factor", "current_density",
]


def _freq_from(poles, speed):
    """f = poles × n / 120；非 50/60Hz 回落 50（designs.db 有 15000rpm 异常行 → 250Hz）"""
    try:
        f = float(poles) * float(speed) / 120.0
    except Exception:
        return 50.0
    for cand in (50.0, 60.0):
        if abs(f - cand) < 0.6:
            return cand
    return 50.0


def select_rows(limit=10**9, per_group=10**9):
    con = sqlite3.connect(DB)
    cur = con.cursor()
    q = """
        SELECT id, poles, power_kw, voltage_v, speed_rpm, stator_od, stator_id,
               core_length, air_gap, slots_stator, slots_rotor, turns_per_coil,
               rotor_od, tooth_width, yoke_thickness, shaft_dia, params,
               stator_tooth_flux_density, stator_yoke_flux_density, air_gap_flux_density
        FROM designs
        WHERE solve_mode='rmxprt'
          AND stator_od IS NOT NULL AND stator_id IS NOT NULL AND core_length IS NOT NULL
          AND air_gap IS NOT NULL AND slots_stator IS NOT NULL AND slots_rotor IS NOT NULL
          AND turns_per_coil IS NOT NULL
          AND rotor_od IS NOT NULL AND tooth_width IS NOT NULL AND yoke_thickness IS NOT NULL
          AND shaft_dia IS NOT NULL
          AND speed_rpm <= 5000
        ORDER BY poles, power_kw, voltage_v, id
    """
    cur.execute(q)
    rows = cur.fetchall()
    con.close()
    cols = ["id", "poles", "power_kw", "voltage_v", "speed_rpm", "stator_od", "stator_id",
            "core_length", "air_gap", "slots_stator", "slots_rotor", "turns_per_coil",
            "rotor_od", "tooth_width", "yoke_thickness", "shaft_dia", "params",
            "db_Bt", "db_By", "db_Bg"]
    recs = [dict(zip(cols, r)) for r in rows]
    groups, picked = {}, []
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
            try:
                wire = float(w.replace("mm", "").replace("'", "").strip())
            except Exception:
                wire = None
    if strands is None:
        s = pj.get("Winding__NumberOfStrands")
        try:
            strands = int(str(s).replace("'", "").strip())
        except Exception:
            strands = None
    wd = None if OMIT_WIRE else (float(wire) if wire is not None else None)
    ns = None if OMIT_WIRE else (int(strands) if strands is not None else None)
    return {
        "tag": f"P{int(r['poles'])}_{r['power_kw']}kW_V{int(r['voltage_v'])}_id{r['id']}",
        "db_id": r["id"],
        "stator_od": float(r["stator_od"]),
        "stator_id": float(r["stator_id"]),
        "air_gap": float(r["air_gap"]),
        "slots_stator": int(r["slots_stator"]),
        "slots_rotor": int(r["slots_rotor"]),
        "poles": int(r["poles"]),
        "voltage": float(r["voltage_v"]),
        "speed": float(r["speed_rpm"]),
        "frequency": _freq_from(r["poles"], r["speed_rpm"]),
        "core_length": float(r["core_length"]),
        "power": float(r["power_kw"]),
        "turns_per_coil": turns,
        "conductors_per_slot": int(round(turns)),
        "wire_dia": wd, "n_strands": ns,
        "parallel_circuits": int(pj.get("parallel_circuits") or 1),
        "winding_connection": "star",
        "motor_type": "induction",
        "shaft_dia": float(r["shaft_dia"]),
        "rotor_od": float(r["rotor_od"]),
        "tooth_width": float(r["tooth_width"]),
        "yoke_thickness": float(r["yoke_thickness"]),
    }


def run(rows, out_path, chunk=12):
    t0 = time.time()
    out = []
    for i in range(0, len(rows), chunk):
        batch = rows[i:i + chunk]
        params = [build_param(r) for r in batch]
        print(f"[batch {i//chunk+1}] {len(params)} 台 …", flush=True)
        try:
            res = rt.solve_batch(params, verbose=False, machine_type="induction")
        except Exception as e:
            print("  [ERR] solve_batch:", e)
            res = [None] * len(params)
        for r, p, s in zip(batch, params, res):
            rec = {
                "tag": p["tag"], "db_id": r["id"],
                "inputs": {k: p[k] for k in p if k != "params"},
                "db_stored": {"Bt": r["db_Bt"], "By": r["db_By"], "Bg": r["db_Bg"]},
                "rmxprt": {},
            }
            ok = False
            if isinstance(s, dict):
                for k in TRUTH_KEYS:
                    if k in s:
                        rec["rmxprt"][k] = s[k]
                bt = s.get("stator_tooth_flux_density")
                pw = s.get("power")
                ok = bool(bt and float(bt) > 0.05)
                rec["solve_ok"] = ok
                rec["power_solved"] = pw
            else:
                rec["solve_ok"] = False
            out.append(rec)
            flag = "OK " if ok else "FAIL"
            bt = rec["rmxprt"].get("stator_tooth_flux_density")
            by = rec["rmxprt"].get("stator_yoke_flux_density")
            bg = rec["rmxprt"].get("air_gap_flux_density")
            print(f"  {flag} {rec['tag']:<34} Bt={bt} By={by} Bg={bg} "
                  f"(db存量 Bt={r['db_Bt']} By={r['db_By']})", flush=True)
    n_ok = sum(1 for r in out if r["solve_ok"])
    doc = {
        "generated_by": "dev-calib/run_p2_tooth_truth.py",
        "purpose": "标定 analytic-engine doSaturationLoop 齿磁密 Bt 残余高估 (P1-1 后 +24%)",
        "source_db": DB,
        "total": len(out), "solve_ok": n_ok,
        "elapsed_s": round(time.time() - t0, 1),
        "caveats": [
            "齿宽 tooth_width 为派生值(= core toothWidth() = 0.5×槽距)，非真机梯形齿实测宽；"
            "标定系数吸收的是『派生齿宽 vs 真机等效齿宽』的系统偏差。",
            "designs.db 存量磁密字段部分被污染(By 最大 9.807T)，本集以重跑 .res 为准，"
            "db_stored 仅作对照存档。",
            "绕组默认交 RMxprt 自动选线(OMIT_WIRE)，与 P2 真值集同口径。",
        ],
        "rows": out,
    }
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    print(f"\n[done] 总 {len(out)} 台，真值可用 {n_ok} 台，用时 {doc['elapsed_s']}s → {out_path}")
    return doc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=10**9)
    ap.add_argument("--per-group", type=int, default=10**9)
    ap.add_argument("--chunk", type=int, default=12)
    ap.add_argument("--out", default=r"D:/dsh-motor-ai-l0/output/p2_tooth_truth.json")
    a = ap.parse_args()
    if not rt.is_available():
        print("[FATAL] RMxprt 不可用")
        return 2
    rows = select_rows(a.limit, a.per_group)
    print(f"[select] 选中 {len(rows)} 行")
    run(rows, a.out, a.chunk)
    return 0


if __name__ == "__main__":
    sys.exit(main())

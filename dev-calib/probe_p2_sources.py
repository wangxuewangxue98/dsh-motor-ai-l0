# -*- coding: utf-8 -*-
"""probe_p2_sources.py — 探针: 验证 ① designs.db 非55kW家族(内嵌真实绕组) ② Y系列catalog(借最近邻绕组) 可解。
目的: 全量批跑前先确认两源求解可用, 避免 10min 空跑。
不写入任何交付物, 仅打印结果。
"""
import json
import os
import sqlite3
import sys

DB = r"D:/MotorDesign/KnowledgeBase/designs.db"
SCRIPTS = r"D:/MotorDesign/Scripts"
CAT = r"D:/MotorDesign/Knowledge/y_series_physics.json"
sys.path.insert(0, SCRIPTS)
import rmxprt_tools as rt  # noqa: E402


def freq_from(poles, speed):
    try:
        return round(poles * float(speed) / 120.0, 2)
    except Exception:
        return 50.0


def db_winding_refs():
    """取 designs.db 中几何完整 rmxprt 行的真实绕组参考 (极数, 功率)->(turns,wire,strands,parallel)。"""
    con = sqlite3.connect(DB)
    cur = con.cursor()
    q = """SELECT poles, power_kw, voltage_v, turns_per_coil, params
           FROM designs WHERE solve_mode='rmxprt'
           AND stator_od IS NOT NULL AND turns_per_coil IS NOT NULL AND speed_rpm<=5000"""
    cur.execute(q)
    refs = []
    for poles, pw, volt, tpc, params in cur.fetchall():
        pj = json.loads(params) if params else {}
        phys = pj.get("_physics", {}) or {}
        wire = phys.get("wire_diameter")
        strands = phys.get("num_strands")
        pc = pj.get("parallel_circuits") or 1
        refs.append(dict(poles=poles, power=pw, voltage=volt,
                         turns=tpc, wire=wire, strands=strands, parallel=pc))
    con.close()
    return refs


def borrow(refs, poles, power):
    """最近邻(极数优先, 其次功率差)借绕组。"""
    cand = [r for r in refs if r["poles"] == poles]
    if not cand:
        cand = refs
    cand.sort(key=lambda r: abs(r["power"] - power))
    return cand[0]


def estimate_turns(poles, Dsi_mm, L_mm, Qs, a, Vline, f=50.0, Bg=0.75):
    """EMF 方程按目标气隙磁密 Bg 反推每线圈匝数 (星形接法)。"""
    import math
    Vph = Vline / math.sqrt(3)
    phi = Bg * (Dsi_mm / 1000.0) * (L_mm / 1000.0) / poles  # 韦伯
    kw1 = 0.955
    Nph = Vph / (4.44 * f * kw1 * phi) if phi > 0 else 0
    Nc = Nph * 6.0 * a / (2.0 * Qs)
    return max(1, int(round(Nc)))


def db_param(rowid):
    con = sqlite3.connect(DB)
    cur = con.cursor()
    cur.execute("""SELECT id,poles,power_kw,voltage_v,speed_rpm,stator_od,stator_id,core_length,
                          air_gap,slots_stator,slots_rotor,turns_per_coil,rotor_od,tooth_width,
                          yoke_thickness,shaft_dia,params
                   FROM designs WHERE id=?""", (rowid,))
    r = cur.fetchone()
    con.close()
    cols = ["id","poles","power_kw","voltage_v","speed_rpm","stator_od","stator_id","core_length",
            "air_gap","slots_stator","slots_rotor","turns_per_coil","rotor_od","tooth_width",
            "yoke_thickness","shaft_dia","params"]
    return dict(zip(cols, r))


def build_db(row, use_wire=True):
    pj = json.loads(row["params"]) if row["params"] else {}
    phys = pj.get("_physics", {}) or {}
    turns = float(row["turns_per_coil"])
    wire = phys.get("wire_diameter") or pj.get("Winding__WireDiameter")
    strands = phys.get("num_strands") or pj.get("Winding__NumberOfStrands")
    cps = int(round(turns))
    wd = float(str(wire).replace("mm","").replace("'","").strip()) if (use_wire and wire) else None
    ns = int(str(strands).replace("'","").strip()) if (use_wire and strands) else None
    return {
        "tag": f"P{int(row['poles'])}_{row['power_kw']}kW_V{int(row['voltage_v'])}_db{row['id']}",
        "db_id": row["id"],
        "stator_od": float(row["stator_od"]), "stator_id": float(row["stator_id"]),
        "air_gap": float(row["air_gap"]), "slots_stator": int(row["slots_stator"]),
        "slots_rotor": int(row["slots_rotor"]), "poles": int(row["poles"]),
        "voltage": float(row["voltage_v"]), "speed": float(row["speed_rpm"]),
        "frequency": 50.0, "core_length": float(row["core_length"]),
        "power": float(row["power_kw"]), "turns_per_coil": turns, "conductors_per_slot": cps,
        "wire_dia": wd, "n_strands": ns,
        "parallel_circuits": int(pj.get("parallel_circuits") or 1),
        "winding_connection": "star", "motor_type": "induction",
        "shaft_dia": float(row["shaft_dia"]), "rotor_od": float(row["rotor_od"]),
        "tooth_width": float(row["tooth_width"]), "yoke_thickness": float(row["yoke_thickness"]),
    }


def build_y2(m, refs=None):
    import math
    Dso = float(m["stator_od_mm"]); Dsi = float(m["stator_inner_dia_mm"])
    ag = float(m["air_gap_mm"]); L = float(m["core_length_mm"])
    Qs = int(m["slots_stator"]); p = int(m["poles"]); V = float(m["voltage_v"])
    a = 1 if p <= 2 else 2  # 并联支路: 2极1路, ≥4极2路(≤p/2 且偶)
    # 派生转子几何 (catalog 缺, 必须补, 否则模板转子几何非法)
    rotor_od = round(Dsi - 2 * ag, 2)
    shaft_dia = round(max(14.0, 0.12 * Dso), 2)
    tooth_width = round((math.pi * Dsi / Qs) * 0.5, 2)
    yoke_thickness = round((Dso - Dsi) / 2 * 0.45, 2)
    # EMF 反推匝数 (目标 Bg=0.75T) + auto-wire
    tpc = estimate_turns(p, Dsi, L, Qs, a, V)
    return {
        "tag": f"Y2_{m['model']}",
        "db_id": None, "model": m["model"],
        "stator_od": Dso, "stator_id": Dsi,
        "air_gap": ag, "slots_stator": Qs,
        "slots_rotor": int(m["slots_rotor"]), "poles": p,
        "voltage": V, "speed": float(m["speed_rpm"]),
        "frequency": 50.0, "core_length": L,
        "power": float(m["power_kw"]),
        "turns_per_coil": float(tpc), "conductors_per_slot": int(round(tpc)),
        "wire_dia": None, "n_strands": None,  # auto-wire (同 55kW 家族成功路径)
        "parallel_circuits": a,
        "winding_connection": "star", "motor_type": "induction",
        "shaft_dia": shaft_dia, "rotor_od": rotor_od,
        "tooth_width": tooth_width, "yoke_thickness": yoke_thickness,
    }


def solve_and_print(params):
    res = rt.solve_batch(params, verbose=False, machine_type="induction")
    for p, x in zip(params, res):
        ok = (x.get("solve_mode") == "rmxprt") and (float(x.get("power") or 0) > 0)
        tst = x.get("starting_torque"); tmax = x.get("breakdown_torque"); ist = x.get("starting_current_ratio")
        rt_ = float(x.get("rated_torque") or (9550.0 * p["power"] / p["speed"]))
        print(f"  [{'OK ' if ok else 'FAIL'}] {p['tag']}: eff={x.get('efficiency')} "
              f"Tst_pu={round(tst/rt_,4) if (ok and rt_>0) else None} "
              f"Tmax_pu={round(tmax/rt_,4) if (ok and rt_>0) else None} "
              f"Ist_pu={round(ist,4) if (ok and ist) else None} | {p.get('borrowed_from','')}")


def main():
    if not rt.is_available():
        print("[FATAL] RMxprt 不可用"); return 2
    cat = json.load(open(CAT, encoding="utf-8"))["catalog"]
    # 每极数取首台做跨极探针
    seen = set(); targets = []
    for m in cat:
        p = m["poles"]
        if p not in seen:
            seen.add(p); targets.append(m)
        if len(targets) >= 4:
            break
    print(f"[catalog] 跨极探针机型: {[t['model'] for t in targets]}")
    y2ps = [build_y2(m) for m in targets]
    for p in y2ps:
        print(f"  build {p['tag']}: Dso={p['stator_od']} Dsi={p['stator_id']} "
              f"rotor_od={p['rotor_od']} shaft={p['shaft_dia']} tpc={p['turns_per_coil']} a={p['parallel_circuits']}")
    print(f"\n=== Y系列catalog (派生几何+EMF匝数+auto-wire) {len(y2ps)} 台 ===")
    solve_and_print(y2ps)
    return 0


if __name__ == "__main__":
    sys.exit(main())

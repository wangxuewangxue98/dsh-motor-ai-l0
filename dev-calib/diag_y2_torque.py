# -*- coding: utf-8 -*-
"""diag_y2_torque.py — 诊断 Y 系列合成绕组的 Tst==Tmax 异常: dump 原始转矩字段。"""
import json
import math
import os
import sys

SCRIPTS = r"D:/MotorDesign/Scripts"
CAT = r"D:/MotorDesign/Knowledge/y_series_physics.json"
sys.path.insert(0, SCRIPTS)
import rmxprt_tools as rt  # noqa: E402

# 复用 probe 的派生逻辑(内联, 避免引用死代码)
def estimate_turns(poles, Dsi, L, Qs, a, V, f=50.0, Bg=0.75):
    Vph = V / math.sqrt(3); phi = Bg*(Dsi/1000)*(L/1000)/poles; kw1=0.955
    Nph = Vph/(4.44*f*kw1*phi) if phi>0 else 0
    return max(1, int(round(Nph*6*a/(2*Qs))))

def build(model):
    cat = json.load(open(CAT, encoding="utf-8"))["catalog"]
    m = next(x for x in cat if x["model"] == model)
    Dso=float(m["stator_od_mm"]); Dsi=float(m["stator_inner_dia_mm"]); ag=float(m["air_gap_mm"])
    L=float(m["core_length_mm"]); Qs=int(m["slots_stator"]); p=int(m["poles"]); V=float(m["voltage_v"])
    a = 1 if p<=2 else 2
    return {
        "tag": f"Y2_{model}", "stator_od":Dso, "stator_id":Dsi, "air_gap":ag,
        "slots_stator":Qs, "slots_rotor":int(m["slots_rotor"]), "poles":p, "voltage":V,
        "speed":float(m["speed_rpm"]), "frequency":50.0, "core_length":L, "power":float(m["power_kw"]),
        "turns_per_coil":float(estimate_turns(p,Dsi,L,Qs,a,V)), "conductors_per_slot":int(round(estimate_turns(p,Dsi,L,Qs,a,V))),
        "wire_dia":None, "n_strands":None, "parallel_circuits":a, "winding_connection":"star",
        "motor_type":"induction", "shaft_dia":round(max(14.0,0.12*Dso),2),
        "rotor_od":round(Dsi-2*ag,2), "tooth_width":round((math.pi*Dsi/Qs)*0.5,2),
        "yoke_thickness":round((Dso-Dsi)/2*0.45,2),
    }

def main():
    for model in ["Y801-4", "Y132S-8"]:
        p = build(model)
        res = rt.solve_batch([p], verbose=False, machine_type="induction")
        x = res[0]
        print(f"\n===== {model} =====")
        print("solved power:", x.get("power"), "efficiency:", x.get("efficiency"))
        for k in ["rated_torque","starting_torque","breakdown_torque","starting_current_ratio",
                  "stator_current","rotor_bar_resistance","rotor_resistance","torque","slip","power_factor"]:
            if k in x:
                print(f"  {k} = {x[k]}")
        # 也打印 res 里所有含 torque/current 的键
        print("  -- all torque/current keys --")
        for k,v in x.items():
            if any(t in k.lower() for t in ("torque","current","slip","resist")):
                print(f"     {k} = {v}")

if __name__ == "__main__":
    sys.exit(main())

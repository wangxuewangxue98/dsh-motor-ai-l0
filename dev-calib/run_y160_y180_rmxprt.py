# -*- coding: utf-8 -*-
"""run_y160_y180_rmxprt.py — 用生产通道 solve_batch 补 Y160L-4 / Y180M-4 的 RMxprt 真值。

口径：
  - params 来自 output/y160_y180_rmxprt_params.json（build_y160_y180_rmxprt_params.mjs 生成，
    几何锚 y160_y180_rewind_v3.mjs 标准机，派生值走 core 同源函数）
  - machine_type="induction"（异步机，base output_map 全字段覆盖）
  - 结果写 output/y160_y180_rmxprt_results.json，含 S0 回填所需的全部真值字段
"""
import json
import sys
import time

sys.path.insert(0, r"D:/MotorDesign/Scripts")
import rmxprt_tools as rt  # noqa: E402

PARAMS = r"D:/dsh-motor-ai-l0/output/y160_y180_rmxprt_params.json"
OUT = r"D:/dsh-motor-ai-l0/output/y160_y180_rmxprt_results.json"

TRUTH_KEYS = [
    "power", "efficiency", "torque", "slip", "breakdown_torque", "starting_torque",
    "stator_tooth_flux_density", "stator_yoke_flux_density", "air_gap_flux_density",
    "rotor_tooth_flux_density", "rotor_yoke_flux_density",
    "copper_loss", "iron_loss", "total_loss", "harmonic_loss",
    "stator_current", "current_density", "power_factor", "slot_fill_rate", "max_temp",
]


def main():
    if not rt.is_available():
        print("[FATAL] RMxprt 不可用（is_available=False）")
        return 2
    params = json.load(open(PARAMS, encoding="utf-8"))
    print(f"[run] 开始 RMxprt 求解 {len(params)} 机型: {[p['tag'] for p in params]}")
    t0 = time.time()
    results = rt.solve_batch(params, verbose=True, machine_type="induction")
    elapsed = time.time() - t0

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"[run] 结果已写出 → {OUT}（耗时 {elapsed:.1f}s）")

    n_ok = 0
    for i, x in enumerate(results):
        tag = params[i].get("tag", f"#{i}")
        print("=" * 64)
        print(f"{tag}: solve_failed={x.get('solve_failed')} solve_mode={x.get('solve_mode')}")
        if x.get("solve_failed"):
            print(f"  error: {str(x.get('error'))[:300]}")
            continue
        n_ok += 1
        for k in TRUTH_KEYS:
            print(f"  {k:30s} {x.get(k)}")
    print("=" * 64)
    print(f"[run] 成功 {n_ok}/{len(results)}，总耗时 {elapsed:.1f}s")
    return 0 if n_ok == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())

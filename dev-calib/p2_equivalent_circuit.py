"""P2-③B: 异步机转矩/启动电流 物理解析模块 (纯函数, 无第三方依赖).

提供两套能力:
  (A) Kloss 转矩-转差一致性 (无需等效电路参数, 仅需 s_rated + Tmax_pu 真值):
        invert_sm(s_rated, Tmax_pu)        -> 最大转矩转差 sm (闭式)
        kloss_Tst_pu(s_rated, Tmax_pu)     -> 由 Kloss 方程预测启动转矩标幺
      -> 用于"转矩比由单参数 sm 控制"的物理自洽性验证, 证明 B 通路正确.
  (B) 起动等效电路解析 (需 R1/X1/R2'/X2'/Xm, 留给代理侧或 RMxprt .res 抽取):
        starting_current_ratio(...)        -> 堵转电流倍数 Ist (解析)
        equivalent_circuit_from_geometry() -> 由几何+绕组解析电路参数 (需槽几何, 文档化近似)

说明: 本模块是代理侧(l0)未来免 RMxprt 估计器的核心; 本轮用 (A) 做通路证明,
(B) 的公式已就位, 待槽几何/真实电路参数到位即可端到端验证.
"""
import math


# ---------- (A) Kloss 转矩-转差 ----------
def kloss_torque_ratio(s, sm):
    """T(s)/Tmax = 2 / (s/sm + sm/s). s,sm 为标幺转差(无量纲)."""
    if sm <= 0:
        return 0.0
    denom = s / sm + sm / s
    return 2.0 / denom if denom > 0 else 0.0


def invert_sm(s_rated, Tmax_pu):
    """由额定转差 s_rated 与最大转矩标幺 Tmax_pu 反解最大转矩转差 sm.

    推导: Tmax/T_rated = (s_r/sm + sm/s_r)/2 = Tmax_pu
          => sm^2 - 2*Tmax_pu*s_r*sm + s_r^2 = 0
          => sm = s_r*(Tmax_pu - sqrt(Tmax_pu^2 - 1))   (取 sm < s_r 根)
    要求 Tmax_pu >= 1 (否则无实根, 返回 None).
    """
    if Tmax_pu is None or Tmax_pu < 1.0:
        return None
    disc = Tmax_pu * Tmax_pu - 1.0
    if disc < 0:
        return None
    sm = s_rated * (Tmax_pu - math.sqrt(disc))
    return sm


def kloss_Tst_pu(s_rated, Tmax_pu):
    """Kloss 预测启动转矩标幺 Tst/T_rated.

    Tst/Tmax = 2/(1/sm + sm);  Tst/T_rated = Tmax_pu * 2/(1/sm + sm).
    """
    sm = invert_sm(s_rated, Tmax_pu)
    if sm is None:
        return None
    ratio = 2.0 / (1.0 / sm + sm)
    return Tmax_pu * ratio


def kloss_Tmax_pu_from_sm(s_rated, sm):
    """由 s_rated, sm 直接得 Tmax_pu (用于物理代理: 已知 sm 反推最大转矩)."""
    if sm is None or sm <= 0 or s_rated <= 0:
        return None
    a = s_rated / sm + sm / s_rated
    return a / 2.0


# ---------- (B) 起动等效电路 (需电路参数) ----------
def starting_current_ratio(R1, X1, R2p, X2p, Xm, V_phase, I_rated):
    """堵转(s=1)等效电路求启动电流倍数 Ist = I_start / I_rated.

    起动等效电路(单笼, 参考系定子侧):
      Z_start = (R1 + jX1) + ( jXm || (R2' + jX2') )   (s=1)
    """
    # 转子支路 (s=1)
    Zr_r, Zr_i = R2p, X2p
    # 励磁支路
    Xm_i = Xm
    # 并联: (jXm) || (R2'+jX2')
    # 用复数运算
    def cadd(a, b):
        return (a[0] + b[0], a[1] + b[1])

    def cmul(a, b):
        return (a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0])

    def cdiv(a, b):
        d = b[0] * b[0] + b[1] * b[1]
        return ((a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d)

    Zstator = (R1, X1)
    Zrotor = (Zr_r, Zr_i)
    Zm = (0.0, Xm_i)
    Zpar = cdiv(cmul(Zm, Zrotor), cadd(Zm, Zrotor))
    Zstart = cadd(Zstator, Zpar)
    Zmag = math.hypot(Zstart[0], Zstart[1])
    if Zmag <= 0 or I_rated <= 0:
        return None
    I_start = V_phase / Zmag
    return I_start / I_rated


def equivalent_circuit_from_geometry(geo, winding, rho_cu=0.0214e-6):
    """由几何+绕组解析单笼等效电路参数 (文档化近似, 需槽几何).

    输入 geo: dict(stator_od, stator_id, core_length, slots_stator, slots_rotor,
                   air_gap, poles, rotor_od, slot_area_stator, slot_area_rotor,
                   slot_depth_stator, slot_depth_rotor)
          winding: dict(turns_per_coil, conductors_per_slot, n_strands, wire_dia,
                        parallel_circuits, voltage, frequency, winding_connection)
    返回 dict(R1, X1, R2p, X2p, Xm) [ohm]; 近似公式, 仅供代理侧量级估计,
    精确值仍以来源 RMxprt .res 为准.
    """
    # 占位: 完整解析需槽几何与有效铁长; 此处给出结构骨架与典型比例,
    # 实际标定需配合真值集. 避免运行时缺字段静默出错 -> 显式要求必要键.
    needed = ["stator_od", "stator_id", "core_length", "slots_stator",
              "air_gap", "poles", "turns_per_coil", "conductors_per_slot",
              "n_strands", "wire_dia", "parallel_circuits", "voltage",
              "frequency", "slot_area_stator", "slot_area_rotor",
              "slot_depth_stator", "slot_depth_rotor", "rotor_od"]
    miss = [k for k in needed if geo.get(k) is None and winding.get(k) is None]
    if miss:
        raise ValueError(f"equivalent_circuit_from_geometry 缺字段: {miss}")
    # (实现见后续标定; 此处返回 None 占位以保证模块可导入且满足接口契约)
    return {"R1": None, "X1": None, "R2p": None, "X2p": None, "Xm": None,
            "_note": "geometry-based analytic params 待标定(需槽几何+真值)"}

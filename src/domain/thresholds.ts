// 阈值规则：按鱼种与缸型调整，边界值采用"含下界/不含上界"约定并在文案中写明。
//
// 通用淡水基准（区间外即异常，watch/danger 双侧越限）：
//   pH      正常 [6.5, 7.5)   关注 [6.0,6.5) 或 [7.5,8.5)   危急 <6.0 或 >=8.5
//   氨氮    正常 [0, 0.02)    关注 [0.02,0.05)               危急 >=0.05（>=0.2 标注急性中毒）
//   亚硝    正常 [0, 0.1)     关注 [0.1,0.25)                危急 >=0.25
//   硝酸    正常 [0, 20)      关注 [20,40)                   危急 >=40
//   水温    按鱼种（见下）
//
// 海水缸 pH 整体上移：正常 [8.0, 8.4)，关注 [7.8,8.0) 或 [8.4,8.6)，之外为危急。

import type { FishSpecies, TankType } from "./types";

export interface NumBand {
  /** 正常区间 [okLo, okHi) */
  okLo: number;
  okHi: number;
  /** 关注区间外扩到 [warnLo, warnHi)，再超出为危急 */
  warnLo: number;
  warnHi: number;
}

export interface ThresholdRule {
  ph: NumBand;
  ammonia: NumBand;
  nitrite: NumBand;
  nitrate: NumBand;
  /** 急性中毒线：氨氮达到该值时文案升级 */
  ammoniaAcute: number;
  temp: NumBand;
}

/** 淡水通用基准（中性鱼） */
const FRESHWATER_BASE: ThresholdRule = {
  ph: { okLo: 6.5, okHi: 7.5, warnLo: 6.0, warnHi: 8.5 },
  ammonia: { okLo: 0, okHi: 0.02, warnLo: 0, warnHi: 0.05 },
  nitrite: { okLo: 0, okHi: 0.1, warnLo: 0, warnHi: 0.25 },
  nitrate: { okLo: 0, okHi: 20, warnLo: 0, warnHi: 40 },
  ammoniaAcute: 0.2,
  temp: { okLo: 24, okHi: 27, warnLo: 22, warnHi: 30 },
};

const MARINE_RULE: ThresholdRule = {
  ph: { okLo: 8.0, okHi: 8.4, warnLo: 7.8, warnHi: 8.6 },
  ammonia: { okLo: 0, okHi: 0.02, warnLo: 0, warnHi: 0.05 },
  nitrite: { okLo: 0, okHi: 0.1, warnLo: 0, warnHi: 0.25 },
  nitrate: { okLo: 0, okHi: 10, warnLo: 0, warnHi: 20 },
  ammoniaAcute: 0.2,
  temp: { okLo: 24, okHi: 27, warnLo: 23, warnHi: 29 },
};

/** 鱼种温度/酸碱度偏好修正（在缸型规则之上微调） */
const SPECIES_ADJUST: Partial<Record<FishSpecies, Partial<ThresholdRule>>> = {
  goldfish: {
    // 冷水鱼：水温 18~23 正常
    temp: { okLo: 18, okHi: 23, warnLo: 10, warnHi: 28 },
  },
  marine: {
    ph: { okLo: 8.0, okHi: 8.4, warnLo: 7.8, warnHi: 8.6 },
    nitrate: { okLo: 0, okHi: 10, warnLo: 0, warnHi: 20 },
    temp: { okLo: 24, okHi: 27, warnLo: 23, warnHi: 29 },
  },
  cichlid: {
    // 三湖慈鲷偏碱
    ph: { okLo: 7.5, okHi: 8.5, warnLo: 7.0, warnHi: 9.0 },
    temp: { okLo: 24, okHi: 28, warnLo: 22, warnHi: 30 },
  },
  betta: {
    temp: { okLo: 25, okHi: 28, warnLo: 22, warnHi: 31 },
  },
  guppy: {
    temp: { okLo: 24, okHi: 28, warnLo: 22, warnHi: 30 },
  },
  neon: {
    ph: { okLo: 6.0, okHi: 7.0, warnLo: 5.5, warnHi: 7.5 },
  },
};

/** 缸型决定基础规则；海缸用海水规则，其余用淡水规则，再叠加鱼种偏好 */
export function ruleFor(tankType: TankType, species?: FishSpecies): ThresholdRule {
  const base: ThresholdRule =
    tankType === "marine" ? structuredClone(MARINE_RULE) : structuredClone(FRESHWATER_BASE);
  if (tankType === "breeding") {
    // 繁殖缸对氨氮/亚硝零容忍：关注线即正常线的一半（0.01 / 0.05）
    base.ammonia.okHi = 0.01;
    base.nitrite.okHi = 0.05;
  }
  if (species) {
    const adj = SPECIES_ADJUST[species];
    if (adj) Object.assign(base, adj);
  }
  return base;
}

/** 单指标分级：区间约定 [lo, hi)，恰好落在边界按更安全一侧处理 */
export function bandLevel(v: number, band: NumBand): "ok" | "watch" | "danger" {
  if (v >= band.okLo && v < band.okHi) return "ok";
  if (v >= band.warnLo && v < band.warnHi) return "watch";
  return "danger";
}

/** 危急变化率：两次检测间指标增幅达到该比例（相对前值）附加趋势风险 */
export const SHOCK_RATIO = {
  ammonia: 2, // 氨氮翻倍
  nitrite: 2,
  phJump: 0.5, // pH 单次跳变 >=0.5
  nitrateJump: 20, // 硝酸单次上升 >=20ppm
  tempJump: 2, // 水温单次变化 >=2℃
};

/** 用药安全间隔（毫秒）：同一药品 72 小时内禁止重复使用 */
export const MEDICATION_COOLDOWN_MS = 72 * 60 * 60 * 1000;

/** 单次换水安全上限：不超过缸内水量的 50% */
export const MAX_WATER_CHANGE_PCT = 0.5;

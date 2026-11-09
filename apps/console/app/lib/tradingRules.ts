/** 交易规则里与 UI、引擎都要共享的常量放在这里，避免从较大的模块（automation/liveContext）
 *  反向引入，把整套浏览器侧代码拖进不该依赖它们的组件里。 */

/** 只交易支持 ≥20x 杠杆的标的：低杠杆（如 3x）保证金要求太高，一开单就会被 sequencer 2006 拒掉。 */
export const MIN_LEVERAGE = 20;

/** 点差至少要留几 tick 才打自成交。maker 挂在点差内沿，而实测「读盘口 → 提交」要 2–3.6s，
 *  这段时间里 1 个 tick 的移动就能让 post-only 单跨价（sequencer 2008），所以要求点差 ≥3 tick：
 *  这样 maker 距对手价还剩 ≥2 tick 余量，扛得住 1 tick 抖动。
 *  左侧 Market 列表在打开时也据此排除点差不足的标的。 */
export const MIN_SPREAD_TICKS = 3;

/**
 * 前后端共用的唯一解析权威。
 *
 * 为什么要有这个包：帧形状、rid 过滤判据、轮次聚合规则、错误分类这四件事，
 * 后端拉历史时要用一遍，前端渲染在途流时要用一遍。两处各写一份必然漂移
 * （尤其 mock 回放与真实链路共用同一个 reducer 这件事，只有在同一个包里才成立）。
 */

export * from './constants.js';
export * from './errors.js';
export * from './frames.js';
export * from './marker.js';
export * from './protocol.js';
export * from './rest.js';
export * from './rid.js';
export * from './turn.js';

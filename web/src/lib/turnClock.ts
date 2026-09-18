/**
 * "这一轮跑了多久"该用哪个时钟。
 *
 * 剥成纯函数是因为这里有两个**互不兼容**的时钟源，选错的那一种是界面上最难发现的谎：
 *
 *  · 服务端 Timestamp（首帧 / 末帧）—— 准，但它只在收到帧时才前进。
 *    拿它做实时计时，帧一停数字就冻住，而"帧停了"恰恰是最需要计时的处境
 *    （断流、上游挂起）：一个冻住的秒数会被读成"这一轮就用了这么久"。
 *  · 本地时钟（startedAt = 代理进程发起调用那一刻）—— 会一直走，但含网络与排队，
 *    比服务端那一段偏大，所以它只能说"已经等了多久"，不能说"这一轮耗时多少"。
 *
 * 结论：**在途用本地、结束用服务端**，而且两个数字在界面上必须挂不同的标签
 * （「已运行」/「耗时」），否则收尾那一刻数字往回跳会被当成 bug。
 */

/** 计时结果。`source` 决定界面上写「已运行」还是「耗时」，也决定 title 怎么解释这个数。 */
export interface Elapsed {
  ms: number;
  source: 'local' | 'server';
}

export interface ElapsedInput {
  /** 这一轮此刻还在收流吗。 */
  streaming: boolean;
  /** 代理进程发起调用的本地时刻。 */
  startedAt?: number;
  /** 首帧上的服务端 Timestamp。 */
  firstTimestamp?: number;
  /** 末帧上的服务端 Timestamp。 */
  lastTimestamp?: number;
  /** 本地时钟的"现在"，由调用方的心跳喂进来（这样它才每秒前进一次）。 */
  now: number;
}

export function elapsedOf(input: ElapsedInput): Elapsed | undefined {
  if (input.streaming) {
    if (input.startedAt === undefined) return undefined;
    // 负数不可能出现（startedAt 一定早于 now），但时钟被系统改过时会；夹到 0 免得显示 "-3s"。
    return { ms: Math.max(0, input.now - input.startedAt), source: 'local' };
  }

  if (input.firstTimestamp === undefined || input.lastTimestamp === undefined) return undefined;
  return { ms: Math.max(0, input.lastTimestamp - input.firstTimestamp), source: 'server' };
}

/** 界面上的说法。两个标签必须不同——见文件头关于"数字往回跳"的说明。 */
export function elapsedLabel(elapsed: Elapsed): string {
  return elapsed.source === 'local' ? '已运行' : '耗时';
}

/** title 里的解释：说清这个数是哪个时钟量出来的、含不含网络与排队。 */
export function elapsedTitle(elapsed: Elapsed): string {
  return elapsed.source === 'local'
    ? '本地时钟：从代理进程发起调用到现在，含网络与排队；帧停了它也继续走，所以能看出还在等'
    : '服务端 Timestamp：末帧减首帧，不含发起调用之前的网络与排队';
}

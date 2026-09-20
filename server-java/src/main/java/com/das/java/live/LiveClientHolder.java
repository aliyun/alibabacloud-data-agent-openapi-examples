package com.das.java.live;

/**
 * LIVE 模式持有 LiveClient；MOCK 模式为 null。
 *
 * 不用条件装配的原因：路由层的"mock 还是 live"分派本身就是契约的一部分
 * （与 Node `client ? live : mock` 一处判断同源），Wrapper 让那一处判断保持显式。
 */
public record LiveClientHolder(LiveClient client) {
    public boolean isLive() {
        return client != null;
    }
}

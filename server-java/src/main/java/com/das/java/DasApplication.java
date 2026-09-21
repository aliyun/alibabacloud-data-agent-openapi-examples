package com.das.java;

import com.das.java.config.AppConfig;
import com.das.java.live.LiveClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.annotation.Bean;

/**
 * DataAgent OpenAPI 示例工程 · Java server。与 Node server、Python server 同一 HTTP/NDJSON 契约。
 *
 * 启动：MOCK=1 mvn spring-boot:run（或 java -jar target/das-server-java-*.jar）。
 * 配置加载（含 .env / DAS_ENV 规则）在 Spring 上下文之前完成——加载失败直接退出，
 * 不落进 Spring 的异常包装里，这样三个 server 的启动失败文案可以对齐。
 */
@SpringBootApplication
public class DasApplication {
    private static final Logger log = LoggerFactory.getLogger(DasApplication.class);

    @Bean
    public AppConfig appConfig() {
        return AppConfigHolder.CFG;
    }

    /** MOCK 模式**绝不**构造 Client：那是"以为在测真实链路、其实在看录像"的唯一屏障。 */
    @Bean(destroyMethod = "close")
    public com.das.java.live.LiveClientHolder liveClientHolder(AppConfig cfg) throws Exception {
        if (!cfg.mock()) {
            log.info("SDK Client 已构造（LIVE 模式；官方异步 SDK 9.0.9，流式走 *WithResponseIterable SSE）");
        }
        return new com.das.java.live.LiveClientHolder(cfg.mock() ? null : new LiveClient(cfg));
    }

    private static final class AppConfigHolder {
        private static final AppConfig CFG = AppConfig.load();
    }

    public static void main(String[] args) {
        // 先装载配置（含 .env / DAS_ENV；失败直接退出），再进 Spring。
        AppConfig cfg = AppConfigHolder.CFG;

        Path webDist = Path.of(cfg.webDist());
        if (Files.isDirectory(webDist)) {
            log.info("同源托管前端构建产物（SPA 回退已开启）：{}", webDist);
        }

        Map<String, Object> props = new HashMap<>();
        props.put("server.port", cfg.port());
        props.put("server.address", cfg.serverHost());
        // 长轮响应不被容器异步超时掐断（330s 硬上限由本工程的流管道执行，容器只负责放行）。
        props.put("spring.mvc.async.request-timeout", "-1");
        new SpringApplicationBuilder(DasApplication.class)
            .properties(props)
            .run(args);

        System.out.println("\n" + cfg.describe() + "\n");
    }
}

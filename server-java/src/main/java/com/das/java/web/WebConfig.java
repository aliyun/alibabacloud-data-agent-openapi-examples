package com.das.java.web;

import com.das.java.config.AppConfig;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;

/**
 * CORS、Host 白名单、SPA 回退。与 Node 实现的 server-node/index.ts 同源同语义。
 */
@Configuration
public class WebConfig implements WebMvcConfigurer {
    private static final Logger log = LoggerFactory.getLogger(WebConfig.class);

    private final AppConfig cfg;

    public WebConfig(AppConfig cfg) {
        this.cfg = cfg;
    }

    /**
     * application/x-ndjson 不是简单类型，浏览器会先发预检；
     * 这里不放开 credentials，前端不带 cookie，AK/SK 只在后端进程里。
     */
    @Override
    public void addCorsMappings(CorsRegistry registry) {
        for (String prefix : new String[] {"/api/**", "/d/**"}) {
            registry.addMapping(prefix)
                .allowedOrigins(cfg.corsOrigin().toArray(new String[0]))
                .allowedMethods("GET", "POST", "PATCH", "DELETE", "OPTIONS")
                .allowedHeaders("content-type", "authorization", "last-event-id",
                    "x-qwen-client-id", "x-qwen-event-epoch")
                .exposedHeaders("retry-after", "x-qwen-event-epoch", "x-qwen-sse-stream-id");
        }
    }

    /**
     * Host 白名单——**只在本地开发模式生效**（SERVER_HOST 为默认 127.0.0.1）。
     *
     * 只绑 127.0.0.1 **挡不住 DNS rebinding**：攻击者把自己的域名解析到 127.0.0.1，
     * 受害者浏览器就会带着 `Host: attacker.example` 向这个进程发请求，而进程手里
     * 握着 AK/SK、能代用户建会话、发 prompt（写操作）。校验 Host 是最便宜的一道闸。
     *
     * 容器/内网部署（SERVER_HOST=0.0.0.0）时跳过：探活与流量来自 pod IP/集群域名，
     * Host 无法枚举；此时信任边界是部署网络本身，白名单失去意义。
     */
    @Bean
    @Order(Ordered.HIGHEST_PRECEDENCE)
    public FilterRegistrationBean<OncePerRequestFilter> hostGuardFilter() {
        FilterRegistrationBean<OncePerRequestFilter> registration = new FilterRegistrationBean<>();
        registration.setFilter(new HostGuard(cfg));
        registration.addUrlPatterns("/*");
        registration.setOrder(Ordered.HIGHEST_PRECEDENCE);
        return registration;
    }

    private static final class HostGuard extends OncePerRequestFilter {
        private static final Set<String> ALLOWED_HOSTS = Set.of("localhost", "127.0.0.1", "[::1]", "::1");

        private final AppConfig cfg;

        HostGuard(AppConfig cfg) {
            this.cfg = cfg;
        }

        @Override
        protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
            if (!cfg.serverHost().equals("127.0.0.1")) {
                chain.doFilter(request, response);
                return;
            }
            String raw = request.getHeader("host") == null ? "" : request.getHeader("host");
            // IPv6 字面量形如 [::1]:3000，先去掉端口再比
            String hostname = raw.replaceAll(":\\d+$", "");
            if (!ALLOWED_HOSTS.contains(hostname)) {
                log.warn("拒绝：Host 不在白名单内（可能是 DNS rebinding）：{}", raw);
                response.setStatus(403);
                response.setContentType("application/json; charset=utf-8");
                String message = "拒绝处理 Host 为 " + (raw.isEmpty() ? "(缺失)" : raw)
                    + " 的请求。这个代理持有云凭证并能发起写操作，只接受 localhost / 127.0.0.1 / [::1] / ::1 的 Host；"
                    + "请通过 http://127.0.0.1:" + cfg.port() + " 访问。";
                java.util.Map<String, Object> errorMap = new java.util.LinkedHashMap<>();
                errorMap.put("kind", "transport");
                errorMap.put("message", message);
                errorMap.put("retryable", true);
                errorMap.put("fatalForSession", false);
                java.util.Map<String, Object> body = new java.util.LinkedHashMap<>();
                body.put("ok", false);
                body.put("error", errorMap);
                try {
                    response.getOutputStream().write(
                        new com.fasterxml.jackson.databind.ObjectMapper()
                            .writeValueAsString(body).getBytes(StandardCharsets.UTF_8));
                } catch (Exception serializationFailure) {
                    response.getOutputStream().write("{\"ok\":false}".getBytes(StandardCharsets.UTF_8));
                }
                return;
            }
            chain.doFilter(request, response);
        }
    }
}

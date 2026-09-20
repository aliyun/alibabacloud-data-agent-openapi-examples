package com.das.java.web;

import com.das.java.config.AppConfig;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 同源托管前端构建产物（单容器交付 UI+API）。与 Node 实现的 server-node/index.ts 同源同语义。
 *
 * 只在 web/dist 存在时提供内容；SPA 回退：非 /api 的 GET 一律回 index.html，
 * 刷新 /session/xxx 这类深链不 404。API 404 仍是 JSON。
 *
 * `/{*path}` 是 Spring Boot 3 路径模式的兜底匹配：已注册的 /api/** 精确路由
 * 优先级更高，永远不会落到这；落进来的只有静态文件、深链与未知路径。
 */
@RestController
public class SpaFallbackController {
    private final Path webDist;
    private final boolean enabled;

    public SpaFallbackController(AppConfig cfg) {
        Path dist = Path.of(cfg.webDist());
        this.enabled = Files.isDirectory(dist);
        this.webDist = dist;
    }

    @GetMapping("/{*path}")
    public Object spa(HttpServletRequest request) throws IOException {
        String uri = request.getRequestURI();
        if (uri.startsWith("/api/")) {
            // 未知 API 路径：回 JSON 404，别把它当成 SPA 深链。
            return notFound(uri);
        }
        if (!enabled) {
            return notFound(uri);
        }
        // 候选文件存在就直接给，不存在回退 index.html（深链）。
        String relative = uri.startsWith("/") ? uri.substring(1) : uri;
        if (!relative.isEmpty()) {
            Path candidate = webDist.resolve(relative).normalize();
            if (candidate.startsWith(webDist.normalize()) && Files.isRegularFile(candidate)) {
                return serveFile(candidate);
            }
        }
        Path index = webDist.resolve("index.html");
        if (Files.isRegularFile(index)) return serveFile(index);
        return notFound(uri);
    }

    private Object serveFile(Path file) {
        Resource resource = new FileSystemResource(file);
        String type = null;
        try {
            type = Files.probeContentType(file);
        } catch (IOException ignored) {
        }
        if (type == null) type = fallbackContentType(file.getFileName().toString());
        try {
            return ResponseEntity.ok().contentType(MediaType.parseMediaType(type)).body(resource);
        } catch (Exception e) {
            return ResponseEntity.ok().body(resource);
        }
    }

    private static String fallbackContentType(String name) {
        if (name.endsWith(".html")) return "text/html";
        if (name.endsWith(".js") || name.endsWith(".mjs")) return "text/javascript";
        if (name.endsWith(".css")) return "text/css";
        if (name.endsWith(".svg")) return "image/svg+xml";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".map")) return "application/json";
        if (name.endsWith(".woff2")) return "font/woff2";
        if (name.endsWith(".ico")) return "image/x-icon";
        return "application/octet-stream";
    }

    private Object notFound(String uri) {
        Map<String, Object> error = new LinkedHashMap<>();
        error.put("kind", "transport");
        error.put("message", "not found: " + uri);
        error.put("retryable", true);
        error.put("fatalForSession", false);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ok", false);
        body.put("error", error);
        return ResponseEntity.status(404).body(body);
    }
}

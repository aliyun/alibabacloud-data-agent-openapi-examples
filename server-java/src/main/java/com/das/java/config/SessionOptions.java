package com.das.java.config;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Creation-only options: POP has no operation for changing an existing session's configuration. */
public record SessionOptions(String model, String approvalMode, String reasoningEffort, String agentName) {
    public SessionOptions(String model, String approvalMode, String reasoningEffort) {
        this(model, approvalMode, reasoningEffort, null);
    }

    public SessionOptions {
        agentName = validateAgentName(agentName);
    }

    /** Null means use the configured default; explicit names never change process configuration. */
    public static String validateAgentName(Object raw) {
        if (raw == null) return null;
        if (!(raw instanceof String name) || name.isBlank() || name.trim().length() > 128
            || name.codePoints().anyMatch(Character::isISOControl))
            throw new IllegalArgumentException("agentName must be a non-empty string of at most 128 characters without controls");
        return name.trim();
    }

    private static final Set<String> MODES = Set.of("plan", "default", "auto-edit", "auto", "yolo");

    public static SessionOptions resolve(AppConfig cfg, Map<String, Object> body) {
        Map<String, Object> input = body == null ? Map.of() : body;
        String model = text(input, "modelServiceId", cfg.model());
        if ("data-agent".equals(model)) model = cfg.model();
        if ("data-agent".equals(model)) model = null;
        String mode = input.containsKey("approvalMode") ? text(input, "approvalMode", cfg.approvalMode())
            : text(input, "mode", cfg.approvalMode());
        if (mode == null) mode = "yolo";
        if (!MODES.contains(mode)) throw new IllegalArgumentException("Unsupported approvalMode: " + mode);
        return new SessionOptions(model, mode, text(input, "reasoningEffort", cfg.reasoningEffort()), validateAgentName(input.get("agentName")));
    }

    private static String text(Map<String, Object> input, String key, String fallback) {
        Object raw = input.get(key);
        if (raw == null) return fallback;
        if (!(raw instanceof String s) || s.isBlank())
            throw new IllegalArgumentException(key + " must be a non-empty string");
        return s.trim();
    }

    public static Map<String, Object> describe(AppConfig cfg) {
        SessionOptions options = resolve(cfg, null);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("agentName", cfg.agentName());
        if (options.model != null) out.put("model", options.model);
        out.put("approvalMode", options.approvalMode);
        if (options.reasoningEffort != null) out.put("reasoningEffort", options.reasoningEffort);
        out.put("models", cfg.models() == null ? List.of() : cfg.models().stream().filter(model -> !"data-agent".equals(model)).toList());
        return out;
    }
}

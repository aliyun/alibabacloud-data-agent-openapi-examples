package com.das.java.config;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class SessionOptionsTest {
    @Test void envDefaultsAndExplicitCreationOverridesStaySeparate() {
        AppConfig cfg = mock(AppConfig.class);
        when(cfg.model()).thenReturn("env-model");
        when(cfg.approvalMode()).thenReturn("yolo");
        when(cfg.reasoningEffort()).thenReturn("medium");
        when(cfg.agentName()).thenReturn("custom-agent");
        when(cfg.models()).thenReturn(List.of("env-model", "other-model"));
        assertEquals(new SessionOptions("env-model", "yolo", "medium"), SessionOptions.resolve(cfg, null));
        assertEquals(new SessionOptions("other-model", "plan", "high"), SessionOptions.resolve(cfg,
            Map.of("modelServiceId", "other-model", "approvalMode", "plan", "reasoningEffort", "high")));
        assertEquals("env-model", SessionOptions.describe(cfg).get("model"));
        assertEquals("custom-agent", SessionOptions.describe(cfg).get("agentName"));
        assertEquals(List.of("env-model", "other-model"), SessionOptions.describe(cfg).get("models"));
        assertEquals(List.of("a", "b", "env-model"), AppConfig.parseModels(" a, ,b,a, ", "env-model"));
    }
    @Test void legacyModelSentinelUsesDefaultAndIsNeverSentAsRealModel() {
        AppConfig cfg = mock(AppConfig.class);
        when(cfg.model()).thenReturn("env-model");
        assertEquals("env-model", SessionOptions.resolve(cfg, Map.of("modelServiceId", "data-agent")).model());
        when(cfg.model()).thenReturn("data-agent");
        when(cfg.agentName()).thenReturn("custom-agent");
        when(cfg.models()).thenReturn(List.of("data-agent", "real-model"));
        assertNull(SessionOptions.resolve(cfg, Map.of("modelServiceId", "data-agent")).model());
        assertFalse(SessionOptions.describe(cfg).containsKey("model"));
        assertEquals(List.of("real-model"), SessionOptions.describe(cfg).get("models"));
    }

    @Test void validatedModesAndTypesAndOptionalFields() {
        AppConfig cfg = mock(AppConfig.class);
        when(cfg.agentName()).thenReturn("agent");
        assertEquals("yolo", SessionOptions.resolve(cfg, null).approvalMode());
        assertFalse(SessionOptions.describe(cfg).containsKey("model"));
        assertFalse(SessionOptions.describe(cfg).containsKey("reasoningEffort"));
        for (String mode : List.of("plan", "default", "auto-edit", "auto", "yolo"))
            assertEquals(mode, SessionOptions.resolve(cfg, Map.of("approvalMode", mode)).approvalMode());
        for (String key : List.of("modelServiceId", "approvalMode", "reasoningEffort")) {
            assertThrows(IllegalArgumentException.class, () -> SessionOptions.resolve(cfg, Map.of(key, 42)));
            assertThrows(IllegalArgumentException.class, () -> SessionOptions.resolve(cfg, Map.of(key, " ")));
        }
        assertThrows(IllegalArgumentException.class, () -> SessionOptions.resolve(cfg, Map.of("approvalMode", "unknown")));
    }
    @Test void agentNameIsOptionalTrimmedValidatedAndNeverChangesConfig() {
        AppConfig cfg = mock(AppConfig.class);
        when(cfg.agentName()).thenReturn("env-agent");
        assertNull(SessionOptions.resolve(cfg, null).agentName());
        assertNull(new SessionOptions(null, "yolo", null).agentName());
        assertEquals("ui-agent", SessionOptions.resolve(cfg, Map.of("agentName", " ui-agent ")).agentName());
        assertEquals("env-agent", SessionOptions.describe(cfg).get("agentName"));
        assertEquals("a".repeat(128), SessionOptions.validateAgentName(" a" + "a".repeat(127) + " "));
        for (Object invalid : List.of(42, true, "", " ", "a".repeat(129), "a\nb", "a\tb", "a\u007fb", "\nag")) {
            assertThrows(IllegalArgumentException.class,
                () -> SessionOptions.resolve(cfg, Map.of("agentName", invalid)));
        }
        assertEquals("dataworks_data_agent", com.das.java.core.Constants.DEFAULT_AGENT_NAME);
    }

}

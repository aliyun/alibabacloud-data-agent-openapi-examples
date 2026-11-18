package com.das.java.config;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ProjectIdConfigTest {
    @Test void acceptsOptionalPositiveId() {
        assertNull(AppConfig.parseProjectId(null));
        assertNull(AppConfig.parseProjectId("  "));
        assertEquals("12345", AppConfig.parseProjectId(" 12345 "));
    }
    @Test void rejectsInvalidIdsWithoutEchoingInput() {
        for (String value : new String[]{"0", "-1", "1.0", "true", "001", "1e3", "9223372036854775808"}) {
            assertThrows(IllegalArgumentException.class, () -> AppConfig.parseProjectId(value));
        }
    }
}

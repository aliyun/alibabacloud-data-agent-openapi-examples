package com.das.java.live;

import com.das.java.config.AppConfig;
import com.das.java.config.SessionOptions;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class CreateSessionProjectIdTest {
    @Test
    void projectContextIsOptionalAndUsesInitialConfigOptions() {
        for (String projectId : new String[] {null, "12345"}) {
            AppConfig cfg = mock(AppConfig.class);
            when(cfg.regionId()).thenReturn("cn-hangzhou");
            when(cfg.accessKeyId()).thenReturn("test-id");
            when(cfg.accessKeySecret()).thenReturn("test-secret");
            when(cfg.agentName()).thenReturn("dataworks_data_agent");
            when(cfg.sessionSource()).thenReturn("test-source");
            when(cfg.resourceGroupId()).thenReturn("test-resource-group");
            when(cfg.projectId()).thenReturn(projectId);
            try (LiveClient client = new LiveClient(cfg)) {
                var request = client.buildCreateSessionRequest(new SessionOptions(null, "default", null));
                var options = request.getParams().getMeta().getInitialConfigOptions();
                assertEquals(projectId, options.getProjectId());
                assertEquals("default", options.getMode());
                assertEquals("test-resource-group", options.getResourceGroupId());
                var serialized = new ObjectMapper().valueToTree(request.getParams());
                if (projectId != null) assertEquals(projectId, serialized.path("meta").path("initialConfigOptions").path("projectId").asText());
            }
        }
    }
}

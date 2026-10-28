package com.das.java.live;

import com.aliyun.sdk.service.dataworks_public20240518.models.CreateAgentRequest;
import com.aliyun.sdk.service.dataworks_public20240518.models.GetAgentRequest;
import com.das.java.config.AppConfig;
import com.das.java.core.ApiError;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Explicitly invoked, standalone administrator example. No Spring bean, route or startup hook.
 * Supply the administrator's own AppConfig; this class never assumes a role or logs credentials.
 * Results retain the POP {Agent, RequestId} shape and published reference version fields.
 */
public final class AgentManagementExample implements AutoCloseable {
    private static final Set<String> FIELDS = Set.of("DisplayName", "Description", "Model", "SystemPrompt",
        "Tools", "Skills", "ExpertSuites", "CallableAgents", "PublishImmediately", "Metadata", "Visibility", "VisibilityScope");
    private final PopAdapter client;

    public AgentManagementExample(AppConfig administratorConfig) { this(PopAdapter.create(administratorConfig)); }
    AgentManagementExample(PopAdapter client) { this.client = client; }

    /** PublishImmediately defaults to false; pass true explicitly to publish the new definition. */
    public Map<String, Object> createAgent(String name, Map<String, Object> definition) throws Exception {
        return call("CreateAgent", fields(name, definition));
    }

    /** A null version reads the current definition; a positive version reads that pinned version. */
    public Map<String, Object> getAgent(String name, Integer agentVersion) throws Exception {
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("Name", name(name));
        if (agentVersion != null) fields.put("AgentVersion", version(agentVersion));
        return call("GetAgent", fields);
    }

    /** Use Agent.AgentVersion from GetAgent for optimistic concurrency; never automatically retry writes. */
    public Map<String, Object> updateAgent(String name, int expectedVersion, Map<String, Object> patch) throws Exception {
        Map<String, Object> fields = fields(name, patch);
        fields.put("ExpectedVersion", version(expectedVersion));
        return call("UpdateAgent", fields);
    }

    private static Map<String, Object> fields(String name, Map<String, Object> values) {
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("Name", name(name));
        fields.put("PublishImmediately", false);
        if (values != null) for (var entry : values.entrySet()) {
            if (!FIELDS.contains(entry.getKey())) throw new IllegalArgumentException("Unsupported Agent field: " + entry.getKey());
            if (entry.getValue() != null) fields.put(entry.getKey(), entry.getValue());
        }
        if (!(fields.get("PublishImmediately") instanceof Boolean))
            throw new IllegalArgumentException("PublishImmediately must be boolean");
        return fields;
    }

    private static String name(String name) {
        if (name == null || name.isBlank()) throw new IllegalArgumentException("Agent Name is required");
        return name.trim();
    }
    private static int version(int value) {
        if (value <= 0) throw new IllegalArgumentException("Agent version must be positive");
        return value;
    }

    @SuppressWarnings("unchecked")
    private static CreateAgentRequest createRequest(Map<String, Object> fields) {
        var request = CreateAgentRequest.builder().name((String) fields.get("Name"))
            .publishImmediately((Boolean) fields.get("PublishImmediately"));
        if (fields.containsKey("DisplayName")) request.displayName((String) fields.get("DisplayName"));
        if (fields.containsKey("Description")) request.description((String) fields.get("Description"));
        if (fields.containsKey("SystemPrompt")) request.systemPrompt((String) fields.get("SystemPrompt"));
        if (fields.containsKey("Visibility")) request.visibility((String) fields.get("Visibility"));
        if (fields.containsKey("Model")) request.model((Map<String, ?>) fields.get("Model"));
        if (fields.containsKey("Metadata")) request.metadata((Map<String, ?>) fields.get("Metadata"));
        if (fields.containsKey("VisibilityScope")) {
            if (!(fields.get("VisibilityScope") instanceof Map<?, ?> scope) || !Set.of("UserIds", "ProjectIds").containsAll(scope.keySet()))
                throw new IllegalArgumentException("Unsupported VisibilityScope fields");
            request.visibilityScope(CreateAgentRequest.VisibilityScope.builder()
                .userIds((List<String>) scope.get("UserIds")).projectIds((List<String>) scope.get("ProjectIds")).build());
        }
        if (fields.containsKey("Skills")) {
            List<CreateAgentRequest.Skills> values = new ArrayList<>();
            for (var item : references(fields.get("Skills"), Set.of("Name", "SkillId", "Source", "Version"))) values.add(
                CreateAgentRequest.Skills.builder().name((String) item.get("Name")).skillId((String) item.get("SkillId"))
                    .source((String) item.get("Source")).version(integer(item.get("Version"))).build());
            request.skills(values);
        }
        if (fields.containsKey("ExpertSuites")) {
            List<CreateAgentRequest.ExpertSuites> values = new ArrayList<>();
            for (var item : references(fields.get("ExpertSuites"), Set.of("SuiteId", "Source", "Version"))) values.add(
                CreateAgentRequest.ExpertSuites.builder().suiteId((String) item.get("SuiteId"))
                    .source((String) item.get("Source")).version(integer(item.get("Version"))).build());
            request.expertSuites(values);
        }
        if (fields.containsKey("Tools")) {
            List<CreateAgentRequest.Tools> values = new ArrayList<>();
            for (var item : references(fields.get("Tools"), Set.of("Name")))
                values.add(CreateAgentRequest.Tools.builder().name((String) item.get("Name")).build());
            request.tools(values);
        }
        if (fields.containsKey("CallableAgents")) {
            List<CreateAgentRequest.CallableAgents> values = new ArrayList<>();
            for (var item : references(fields.get("CallableAgents"), Set.of("Name")))
                values.add(CreateAgentRequest.CallableAgents.builder().name((String) item.get("Name")).build());
            request.callableAgents(values);
        }
        return request.build();
    }

    private static Integer integer(Object value) {
        if (value == null) return null;
        if (!(value instanceof Integer number)) throw new IllegalArgumentException("Reference Version must be an integer");
        return number;
    }

    private static List<Map<?, ?>> references(Object value, Set<String> allowed) {
        if (!(value instanceof List<?> list)) throw new IllegalArgumentException("Agent references must be arrays");
        List<Map<?, ?>> result = new ArrayList<>();
        for (Object item : list) {
            if (!(item instanceof Map<?, ?> fields) || !allowed.containsAll(fields.keySet()))
                throw new IllegalArgumentException("Unsupported Agent reference fields");
            result.add(fields);
        }
        return result;
    }

    private Map<String, Object> call(String action, Map<String, Object> fields) throws Exception {
        try {
            var pending = switch (action) {
                case "CreateAgent" -> client.callRequest(action, createRequest(fields));
                case "GetAgent" -> client.callRequest(action, GetAgentRequest.builder().name((String) fields.get("Name"))
                    .agentVersion((Integer) fields.get("AgentVersion")).build());
                default -> client.callForm(action, fields); // 9.0.17 has no UpdateAgent request/API.
            };
            var response = pending.join();
            Map<String, Object> body = response.body;
            if (body == null || Boolean.FALSE.equals(body.get("Success")) || Boolean.FALSE.equals(body.get("success"))
                || body.get("Error") != null || body.get("error") != null || !(body.get("Agent") instanceof Map<?, ?>))
                throw new Normalize.DasApiException(ApiError.apiError("rpc_error", action + " returned an error or no Agent"));
            return java.util.Collections.unmodifiableMap(new LinkedHashMap<>(body));
        } catch (Exception error) {
            throw new Normalize.DasApiException(Normalize.toApiError(error, action), error);
        }
    }

    @Override public void close() { client.close(); }
}

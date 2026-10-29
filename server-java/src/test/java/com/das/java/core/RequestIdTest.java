package com.das.java.core;

import com.das.java.live.Normalize;
import com.das.java.web.Pipeline;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class RequestIdTest {
    @Test void legacyConstructionAndOptionalSerializationRemainCompatible() {
        var old = new ApiError("rpc_error", 403, null, "denied", false, false, 200);
        assertFalse(old.toMap().containsKey("requestId"));
        for (Object invalid : List.of("", " ", "bad\nID", "bad\u007fID", "bad\u0085ID", "unicode-你好", "inner space", "\r\nvalid\r\n", "valid\t", "x".repeat(257), 123, Map.of()))
            assertFalse(old.withRequestId(invalid).toMap().containsKey("requestId"));
        assertEquals("x".repeat(256), old.withRequestId("x".repeat(256)).requestId());
        assertEquals("trimmed-pop", old.withRequestId("  trimmed-pop  ").requestId());
        assertEquals("x".repeat(256), old.withRequestId("  " + "x".repeat(256) + "  ").requestId());
    }

    @Test void redactionAndBothApiPrefixesPreserveRequestIdAndRetryPolicy() {
        var original = ApiError.classify("denied LTAIsecret123", 403, "Forbidden", 403).withRequestId("pop-id");
        var normalized = Normalize.toApiError(new java.util.concurrent.CompletionException(
            new Normalize.DasApiException(original)), "CreateAgentSession");
        assertEquals("pop-id", normalized.toMap().get("requestId"));
        assertTrue(normalized.message().startsWith("CreateAgentSession:"));
        assertFalse(normalized.message().contains("LTAIsecret123"));
        assertEquals(original.retryable(), normalized.retryable());
        assertEquals(original.fatalForSession(), normalized.fatalForSession());
        var event = new Pipeline("s", false, 0).onError(new Normalize.DasApiException(normalized), "LoadAgentSession");
        var error = (Map<?, ?>) event.get("error");
        assertEquals("pop-id", error.get("requestId"));
        assertTrue(((String) error.get("message")).startsWith("LoadAgentSession:"));
    }

    @Test void onlyPopOnlyAcknowledgementsQualifyAndNoMessageParsingOrAcpFallbackOccurs() {
        assertEquals("ack", Frames.popAckRequestId(Map.of("RequestId", "ack")));
        for (Map<String, Object> body : List.<Map<String, Object>>of(
            Map.of("RequestId", "rid", "Params", Map.of("data", Map.of("requestId", "permission"))),
            Map.of("RequestId", "rid", "Error", Map.of("message", "denied")),
            Map.of("RequestId", "rid", "Result", Map.of()),
            Map.of("RequestId", "event-rid", "Event", Map.of("id", "event-id")),
            Map.of("RequestId", "turn-rid", "Id", "rpc-id")))
            assertNull(Frames.popAckRequestId(body));
        assertNull(Normalize.toApiError(new RuntimeException("requestId=fake"), "LoadAgentSession").requestId());
        var pipeline = new Pipeline("s", false, 0);
        var errors = pipeline.onFrame(Map.of("RequestId", "rid", "Error", Map.of("message", "denied")));
        var error = (Map<?, ?>) errors.get(errors.size() - 1).get("error");
        assertFalse(error.containsKey("requestId"));
    }

    @Test void sdkExceptionsUseStructuredFieldsThroughWrappersWithoutDumpingSdkDetails() {
        var client = new com.aliyun.sdk.gateway.pop.exception.PopClientException("private headers and body");
        client.setStatusCode(403);
        client.setErrMessage("denied LTAIsecret123");
        client.setErrCode("Forbidden");
        client.setRequestId("sdk-client");
        client.setData(Map.of("headers", Map.of("Authorization", "private")));
        var server = new com.aliyun.sdk.gateway.pop.exception.PopServerException("private headers and body");
        server.setStatusCode(503);
        server.setErrMessage("service unavailable");
        server.setRequestId("sdk-server");
        for (var sdk : List.of(client, server)) {
            var error = Normalize.toApiError(new java.util.concurrent.CompletionException(
                new RuntimeException("wrapper private dump", sdk)), "CreateAgentSession");
            assertEquals(sdk == client ? "sdk-client" : "sdk-server", error.requestId());
            assertEquals(sdk == client ? 403 : 503, error.upstreamStatus());
            assertFalse(error.message().contains("private"));
            assertFalse(error.message().contains("LTAIsecret123"));
        }
        for (var sdk : List.of(new com.aliyun.sdk.gateway.pop.exception.PopClientException("private raw SDK dump"),
            new com.aliyun.sdk.gateway.pop.exception.PopServerException("private raw SDK dump"),
            new darabonba.core.exception.ClientException("private raw SDK dump"),
            new darabonba.core.exception.ServerException("private raw SDK dump"))) {
            var error = Normalize.toApiError(new RuntimeException("private wrapper dump", sdk), "LoadAgentSession");
            assertFalse(error.message().contains("private"));
            assertFalse(error.toMap().containsKey("requestId"));
        }
    }

    @Test void explicitMissingMetadataDoesNotReuseEarlierPromptAckOnRecoveryFailure() {
        var pipeline = new Pipeline("s", false, 0);
        pipeline.requestId("prompt-pop");
        pipeline.requestId(null); // New Load attempt supplied no POP metadata.
        var event = pipeline.finish(List.of("prompt-pop"));
        assertFalse(((Map<?, ?>) event.get("error")).containsKey("requestId"));
    }

    @Test void strictAsciiAndPreferredHeaderNeverExposeUnsafeIds() {
        for (String invalid : List.of("\ufeffpop", "\u00a0pop", "\u0085pop", "pop\u2028", "pop\u0000", "pop\t", " \rpop "))
            assertNull(ApiError.validRequestId(invalid));
        var error = ApiError.transport("same message").withRequestId("exception-id");
        assertEquals("header-id", error.withPreferredRequestId("  header-id  ").requestId());
        assertEquals("exception-id", error.withPreferredRequestId("bad\nheader").requestId());
        assertEquals(error.message(), error.withPreferredRequestId("header-id").message());
    }

    @Test void sdkDataRequestIdAndHeaderAreReadWithoutExposingTheDataObject() {
        for (var data : List.of(Map.<String, Object>of("RequestId", "data-pop", "credentials", "private"),
            Map.<String, Object>of("requestId", "data-pop"),
            Map.<String, Object>of("headers", Map.of("X-Acs-Request-Id", "data-pop", "Authorization", "private")))) {
            var sdk = new com.aliyun.sdk.gateway.pop.exception.PopClientException("private raw SDK dump");
            sdk.setData(Map.of("data", data)); sdk.setRequestId(null);
            sdk.setStatusCode(403); sdk.setErrMessage("denied");
            var error = Normalize.toApiError(new RuntimeException("private wrapper", sdk), "CreateAgentSession");
            assertEquals("data-pop", error.requestId());
            assertFalse(error.message().contains("private"));
        }
    }

    @Test void sdkCoercionCannotTurnNonStringWireDataIntoAnExposedId() {
        for (Object invalid : List.of(123, Map.of("credentials", "private"))) {
            var sdk = new com.aliyun.sdk.gateway.pop.exception.PopClientException("private raw dump");
            sdk.setData(Map.of("data", Map.of("RequestId", invalid)));
            sdk.setStatusCode(403); sdk.setErrMessage("denied");
            var error = Normalize.toApiError(sdk, "CreateAgentSession");
            assertNull(error.requestId());
            assertFalse(error.message().contains("private"));
        }
    }
}

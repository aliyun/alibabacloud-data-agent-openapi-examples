package com.das.java.live;

import com.aliyun.auth.credentials.Credential;
import com.aliyun.auth.credentials.provider.StaticCredentialProvider;
import com.aliyun.sdk.gateway.pop.Configuration;
import com.aliyun.sdk.gateway.pop.auth.SignatureAlgorithm;
import com.aliyun.sdk.gateway.pop.auth.SignatureVersion;
import com.aliyun.sdk.service.dataworks_public20240518.DefaultAsyncClientBuilder;
import com.aliyun.sdk.service.dataworks_public20240518.models.PromptAgentSessionRequest;
import com.sun.net.httpserver.HttpServer;
import darabonba.core.client.ClientOverrideConfiguration;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import static org.junit.jupiter.api.Assertions.*;

class SdkIdleTimeoutTest {
    private int consume(Duration responseTimeout) throws Exception {
        AtomicInteger requests = new AtomicInteger();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            requests.incrementAndGet();
            exchange.getRequestBody().readAllBytes();
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0);
            try (var output = exchange.getResponseBody()) {
                output.write("data: {\"Jsonrpc\":\"2.0\",\"Method\":\"session/update\",\"Params\":{}}\n\n".getBytes(StandardCharsets.UTF_8));
                output.flush();
                Thread.sleep(22_000);
                output.write("data: {\"Jsonrpc\":\"2.0\",\"Result\":{\"stopReason\":\"end_turn\"}}\n\n".getBytes(StandardCharsets.UTF_8));
            } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            catch (java.io.IOException expectedOnAbort) { /* client may have timed out */ }
        });
        server.start();
        var config = ClientOverrideConfiguration.create().setConnectTimeout(Duration.ofSeconds(10))
            .setProtocol("HTTP").setEndpointOverride("127.0.0.1:" + server.getAddress().getPort());
        if (responseTimeout != null) config.setResponseTimeout(responseTimeout);
        try (var client = new DefaultAsyncClientBuilder()
            .credentialsProvider(StaticCredentialProvider.create(Credential.builder().accessKeyId("synthetic").accessKeySecret("synthetic").build()))
            .region("cn-hangzhou").overrideConfiguration(config)
            .serviceConfiguration(Configuration.create().setSignatureVersion(SignatureVersion.V3)
                .setSignatureAlgorithmV3(SignatureAlgorithm.ACS3_HMAC_SHA256)).build()) {
            int count = 0;
            for (var frame : client.promptAgentSessionWithResponseIterable(PromptAgentSessionRequest.builder()
                .id("test").jsonrpc("2.0").params(PromptAgentSessionRequest.Params.builder().sessionId("synthetic").build()).build())) count++;
            return count;
        } finally {
            server.stop(0);
            assertEquals(1, requests.get());
        }
    }

    @Test @Timeout(35)
    void currentSseConfigurationSurvivesTwentyTwoSecondIdleGap() throws Exception {
        assertEquals(2, consume(null));
    }
}

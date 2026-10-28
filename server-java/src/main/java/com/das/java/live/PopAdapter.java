package com.das.java.live;

import com.aliyun.auth.credentials.Credential;
import com.aliyun.auth.credentials.provider.StaticCredentialProvider;
import com.aliyun.core.annotation.NameInMap;
import com.aliyun.core.http.BodyType;
import com.aliyun.core.http.HttpHeaders;
import com.aliyun.core.http.HttpMethod;
import com.aliyun.sdk.gateway.pop.BaseClientBuilder;
import com.aliyun.sdk.gateway.pop.Configuration;
import com.aliyun.sdk.gateway.pop.auth.SignatureAlgorithm;
import com.aliyun.sdk.gateway.pop.auth.SignatureVersion;
import com.aliyun.sdk.service.dataworks_public20240518.models.CancelAgentSessionRequest;
import com.das.java.config.AppConfig;
import darabonba.core.RequestModel;
import darabonba.core.RequestStyle;
import darabonba.core.TeaAsyncHandler;
import darabonba.core.TeaModel;
import darabonba.core.TeaRequest;
import darabonba.core.client.ClientExecutionParams;
import darabonba.core.client.ClientOverrideConfiguration;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/** SDK 9.0.17 extensions for unmodeled actions/responses and raw Events; no custom signing. */
final class PopAdapter implements AutoCloseable {
    private final TeaAsyncHandler handler;
    private final TeaRequest template;

    static final class Builder extends BaseClientBuilder<Builder, PopAdapter> {
        @Override protected String serviceName() { return "dataworks_public20240518"; }
        @Override protected PopAdapter buildClient() {
            return new PopAdapter(new TeaAsyncHandler(super.applyClientConfiguration()));
        }
    }

    static PopAdapter create(AppConfig cfg) {
        ClientOverrideConfiguration override = ClientOverrideConfiguration.create()
            .setConnectTimeout(Duration.ofSeconds(10));
        if (cfg.endpoint() != null) override.setEndpointOverride(cfg.endpoint());
        return new Builder().region(cfg.regionId()).overrideConfiguration(override)
            .credentialsProvider(StaticCredentialProvider.create(Credential.builder()
                .accessKeyId(cfg.accessKeyId()).accessKeySecret(cfg.accessKeySecret())
                .securityToken(cfg.securityToken()).build()))
            .serviceConfiguration(Configuration.create().setSignatureVersion(SignatureVersion.V3)
                .setSignatureAlgorithmV3(SignatureAlgorithm.ACS3_HMAC_SHA256)).build();
    }

    private PopAdapter(TeaAsyncHandler handler) {
        this.handler = handler;
        this.template = TeaRequest.create().setProduct("dataworks-public").setVersion("2024-05-18")
            .setEndpointRule("regional").setEndpointMap(ENDPOINTS);
    }

    public static final class Output extends TeaModel {
        @NameInMap("statusCode") public Integer statusCode;
        @NameInMap("body") public Map<String, Object> body;
        @NameInMap("headers") public Map<String, String> headers;
    }

    CompletableFuture<Output> call(String action, String id, Map<String, Object> params) throws Exception {
        if ("CancelAgentSession".equals(action)) {
            // The request is modeled, but its generated response drops Error/Delivered/Noop.
            return callRequest(action, CancelAgentSessionRequest.builder().id(id).jsonrpc("2.0")
                .params(CancelAgentSessionRequest.Params.builder().sessionId((String) params.get("SessionId")).build()).build());
        }
        return callForm(action, Map.of("Id", id, "Jsonrpc", "2.0", "Params", params));
    }

    /** Use generated request serialization while retaining fields omitted by generated response models. */
    CompletableFuture<Output> callRequest(String action, RequestModel input) {
        handler.validateRequestModel(input);
        TeaRequest request = template.copy().setStyle(RequestStyle.RPC).setAction(action)
            .setMethod(HttpMethod.POST).setPathRegex("/").setBodyType(BodyType.JSON)
            .setBodyIsForm(true).setReqBodyType(BodyType.FORM).formModel(input)
            .setRequestConfiguration(darabonba.core.RequestConfiguration.create().setResponseTimeout(Duration.ofMinutes(10)));
        return handler.execute(new ClientExecutionParams<RequestModel, Output>()
            .withInput(input).withRequest(request).withOutput(new Output()));
    }

    /** Management APIs use top-level form fields, without the session JSON-RPC envelope. */
    CompletableFuture<Output> callForm(String action, Map<String, Object> fields) throws Exception {
        Map<String, Object> encoded = new java.util.LinkedHashMap<>();
        var json = new com.fasterxml.jackson.databind.ObjectMapper();
        for (var entry : fields.entrySet()) {
            Object value = entry.getValue();
            if (value != null) encoded.put(entry.getKey(), value instanceof Map<?, ?> || value instanceof java.util.List<?>
                ? json.writeValueAsString(value) : value);
        }
        var input = CancelAgentSessionRequest.create();
        TeaRequest request = template.copy().setStyle(RequestStyle.RPC).setAction(action)
            .setMethod(HttpMethod.POST).setPathRegex("/").setBodyType(BodyType.JSON)
            .setBodyIsForm(true).setReqBodyType(BodyType.FORM).formModel(input).setBody(encoded)
            .setRequestConfiguration(darabonba.core.RequestConfiguration.create().setResponseTimeout(Duration.ofMinutes(10)));
        return handler.execute(new ClientExecutionParams<CancelAgentSessionRequest, Output>()
            .withInput(input).withRequest(request).withOutput(new Output()));
    }

    RemoteEventStream events(String sessionId, String cursor) {
        var input = CancelAgentSessionRequest.create();
        HttpHeaders headers = new HttpHeaders();
        headers.set("Accept", "text/event-stream");
        if (cursor != null && !cursor.isBlank()) headers.set("Last-Event-Id", cursor);
        TeaRequest request = template.copy().setStyle(RequestStyle.RPC).setAction("GetAgentSessionEvents")
            // Match generated SSE calls: raw bytes belong to the response handler.
            // "binary" makes the SDK post-processor dereference the reactive response's null body.
            .setMethod(HttpMethod.GET).setPathRegex("/").setBodyType(BodyType.JSON)
            .formModel(input).setQuery(Map.of("SessionCode", sessionId)).setHeaders(headers);
        RemoteEventStream stream = new RemoteEventStream();
        var future = handler.execute(new ClientExecutionParams<CancelAgentSessionRequest, Output>()
            .withInput(input).withRequest(request).withOutput(new Output()).withHttpResponseHandler(stream));
        future.whenComplete((ignored, error) -> { if (error != null) stream.onError(error); });
        return stream;
    }

    @Override public void close() { handler.close(); }

    // Same endpoint map as the pinned generated SDK, including financial/government regions.
    private static final Map<String, String> ENDPOINTS = Map.ofEntries(
        Map.entry("ap-northeast-1", "dataworks.ap-northeast-1.aliyuncs.com"),
        Map.entry("ap-northeast-2-pop", "dataworks.aliyuncs.com"),
        Map.entry("ap-south-1", "dataworks.aliyuncs.com"),
        Map.entry("ap-southeast-1", "dataworks.ap-southeast-1.aliyuncs.com"),
        Map.entry("ap-southeast-2", "dataworks.aliyuncs.com"),
        Map.entry("ap-southeast-3", "dataworks.ap-southeast-3.aliyuncs.com"),
        Map.entry("ap-southeast-5", "dataworks.ap-southeast-5.aliyuncs.com"),
        Map.entry("cn-beijing", "dataworks.cn-beijing.aliyuncs.com"),
        Map.entry("cn-beijing-finance-1", "dataworks.cn-beijing-finance-1.aliyuncs.com"),
        Map.entry("cn-beijing-finance-pop", "dataworks.aliyuncs.com"),
        Map.entry("cn-beijing-gov-1", "dataworks.aliyuncs.com"),
        Map.entry("cn-beijing-nu16-b01", "dataworks.aliyuncs.com"),
        Map.entry("cn-chengdu", "dataworks.cn-chengdu.aliyuncs.com"),
        Map.entry("cn-edge-1", "dataworks.aliyuncs.com"),
        Map.entry("cn-fujian", "dataworks.aliyuncs.com"),
        Map.entry("cn-haidian-cm12-c01", "dataworks.aliyuncs.com"),
        Map.entry("cn-hangzhou", "dataworks.cn-hangzhou.aliyuncs.com"),
        Map.entry("cn-hangzhou-bj-b01", "dataworks.aliyuncs.com"),
        Map.entry("cn-hangzhou-finance", "dataworks.aliyuncs.com"),
        Map.entry("cn-hangzhou-internal-prod-1", "dataworks.aliyuncs.com"),
        Map.entry("cn-hangzhou-internal-test-1", "dataworks.aliyuncs.com"),
        Map.entry("cn-hangzhou-internal-test-2", "dataworks.aliyuncs.com"),
        Map.entry("cn-hangzhou-internal-test-3", "dataworks.aliyuncs.com"),
        Map.entry("cn-hangzhou-test-306", "dataworks.aliyuncs.com"),
        Map.entry("cn-hongkong", "dataworks.cn-hongkong.aliyuncs.com"),
        Map.entry("cn-hongkong-finance-pop", "dataworks.aliyuncs.com"),
        Map.entry("cn-huhehaote", "dataworks.aliyuncs.com"),
        Map.entry("cn-huhehaote-nebula-1", "dataworks.aliyuncs.com"),
        Map.entry("cn-north-2-gov-1", "dataworks.cn-north-2-gov-1.aliyuncs.com"),
        Map.entry("cn-qingdao", "dataworks.aliyuncs.com"),
        Map.entry("cn-qingdao-nebula", "dataworks.aliyuncs.com"),
        Map.entry("cn-shanghai", "dataworks.cn-shanghai.aliyuncs.com"),
        Map.entry("cn-shanghai-et15-b01", "dataworks.aliyuncs.com"),
        Map.entry("cn-shanghai-et2-b01", "dataworks.aliyuncs.com"),
        Map.entry("cn-shanghai-finance-1", "dataworks.cn-shanghai-finance-1.aliyuncs.com"),
        Map.entry("cn-shanghai-inner", "dataworks.aliyuncs.com"),
        Map.entry("cn-shanghai-internal-test-1", "dataworks.aliyuncs.com"),
        Map.entry("cn-shenzhen", "dataworks.cn-shenzhen.aliyuncs.com"),
        Map.entry("cn-shenzhen-finance-1", "dataworks.cn-shenzhen-finance-1.aliyuncs.com"),
        Map.entry("cn-shenzhen-inner", "dataworks.aliyuncs.com"),
        Map.entry("cn-shenzhen-st4-d01", "dataworks.aliyuncs.com"),
        Map.entry("cn-shenzhen-su18-b01", "dataworks.aliyuncs.com"),
        Map.entry("cn-wuhan", "dataworks.aliyuncs.com"),
        Map.entry("cn-wulanchabu", "dataworks.cn-wulanchabu.aliyuncs.com"),
        Map.entry("cn-yushanfang", "dataworks.aliyuncs.com"),
        Map.entry("cn-zhangbei", "dataworks.aliyuncs.com"),
        Map.entry("cn-zhangbei-na61-b01", "dataworks.aliyuncs.com"),
        Map.entry("cn-zhangjiakou", "dataworks.cn-zhangjiakou.aliyuncs.com"),
        Map.entry("cn-zhangjiakou-na62-a01", "dataworks.aliyuncs.com"),
        Map.entry("cn-zhengzhou-nebula-1", "dataworks.aliyuncs.com"),
        Map.entry("eu-central-1", "dataworks.eu-central-1.aliyuncs.com"),
        Map.entry("eu-west-1", "dataworks.eu-west-1.aliyuncs.com"),
        Map.entry("eu-west-1-oxs", "dataworks.aliyuncs.com"),
        Map.entry("me-east-1", "dataworks.me-east-1.aliyuncs.com"),
        Map.entry("rus-west-1-pop", "dataworks.aliyuncs.com"),
        Map.entry("us-east-1", "dataworks.us-east-1.aliyuncs.com"),
        Map.entry("us-west-1", "dataworks.us-west-1.aliyuncs.com"),
        Map.entry("ap-northeast-2", "dataworks.ap-northeast-2.aliyuncs.com"),
        Map.entry("me-central-1", "dataworks.me-central-1.aliyuncs.com")
    );
}

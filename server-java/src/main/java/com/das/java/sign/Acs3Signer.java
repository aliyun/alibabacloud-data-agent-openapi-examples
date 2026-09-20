package com.das.java.sign;

import java.nio.charset.StandardCharsets;
import java.security.InvalidKeyException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * ACS3-HMAC-SHA256 请求签名。与 Node 工具链 @alicloud/openapi-util 的 getAuthorization
 * 逐字节对齐（server-java 用它对 PromptAgentSession / LoadAgentSession 发起签名 POST，
 * 因为 Java SDK 9.8.0 没有 *WithSSE 流式变体；正确性由 Acs3SignerTest 的已知答案向量保证，
 * 向量由仓库内 Node 工具链实际生成）。
 */
public final class Acs3Signer {
    private Acs3Signer() {}

    public static final String ALGORITHM = "ACS3-HMAC-SHA256";

    private static final DateTimeFormatter DATE_FORMAT =
        DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'").withZone(ZoneOffset.UTC);

    public static String newNonce() {
        return UUID.randomUUID().toString();
    }

    public static String nowDate() {
        return DATE_FORMAT.format(Instant.now());
    }

    /**
     * Node querystring.escape / openapi-util encode 同款百分号编码：
     * 保留 A-Z a-z 0-9 - _ . ! ~ * ' ( )，其余一律 %XX（UTF-8，大写十六进制）。
     */
    public static String percentEncode(String value) {
        StringBuilder out = new StringBuilder();
        for (byte b : value.getBytes(StandardCharsets.UTF_8)) {
            char c = (char) (b & 0xFF);
            boolean unreserved = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                || c == '-' || c == '_' || c == '.' || c == '!' || c == '~' || c == '*' || c == '\'' || c == '(' || c == ')';
            if (unreserved) {
                out.append(c);
            } else {
                out.append('%');
                String hex = Integer.toHexString(b & 0xFF).toUpperCase();
                if (hex.length() < 2) out.append('0');
                out.append(hex);
            }
        }
        return out.toString();
    }

    /** 与 openapi-util toFormString（= Node querystring.stringify）对齐：key=value&…，各自百分号编码。 */
    public static String toFormString(Map<String, String> fields) {
        List<String> parts = new ArrayList<>();
        for (Map.Entry<String, String> e : fields.entrySet()) {
            parts.add(percentEncode(e.getKey()) + "=" + percentEncode(e.getValue()));
        }
        return String.join("&", parts);
    }

    public static String sha256Hex(byte[] data) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(data));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * 计算 Authorization 头。
     *
     * @param method   HTTP 方法（POST）
     * @param pathname 请求路径（"/"）
     * @param query    查询参数（本工程的 SSE 调用为空）
     * @param headers  全量请求头（内部只挑 x-acs-* / host / content-type 参与签名，按名排序）
     * @param payloadHashHex 请求体 SHA-256 十六进制（小写）
     */
    public static String authorization(
        String method,
        String pathname,
        Map<String, String> query,
        Map<String, String> headers,
        String payloadHashHex,
        String accessKeyId,
        String accessKeySecret
    ) {
        // 规范化查询串：键排序，值百分号编码。
        StringBuilder canonicalQuery = new StringBuilder();
        if (query != null && !query.isEmpty()) {
            List<String> keys = new ArrayList<>(query.keySet());
            java.util.Collections.sort(keys);
            List<String> parts = new ArrayList<>();
            for (String key : keys) {
                String value = query.get(key);
                parts.add(key + "=" + (value == null ? "" : percentEncode(value)));
            }
            canonicalQuery.append(String.join("&", parts));
        }

        // 参与签名的头：x-acs-* / host / content-type，名字小写排序，值 trim 后拼接。
        TreeMap<String, List<String>> picked = new TreeMap<>();
        for (Map.Entry<String, String> e : headers.entrySet()) {
            String lower = e.getKey().toLowerCase();
            if (lower.startsWith("x-acs-") || lower.equals("host") || lower.equals("content-type")) {
                picked.computeIfAbsent(lower, k -> new ArrayList<>()).add(e.getValue() == null ? "" : e.getValue().trim());
            }
        }
        StringBuilder canonicalHeaders = new StringBuilder();
        List<String> signedHeaders = new ArrayList<>();
        for (Map.Entry<String, List<String>> e : picked.entrySet()) {
            List<String> values = e.getValue();
            java.util.Collections.sort(values);
            canonicalHeaders.append(e.getKey()).append(':').append(String.join(",", values)).append('\n');
            signedHeaders.add(e.getKey());
        }

        String canonicalUri = (pathname == null ? "" : pathname)
            .replace("+", "%20").replace("*", "%2A").replace("%7E", "~");

        String canonicalRequest = method + "\n"
            + canonicalUri + "\n"
            + canonicalQuery + "\n"
            + canonicalHeaders + "\n"
            + String.join(";", signedHeaders) + "\n"
            + payloadHashHex;

        String stringToSign = ALGORITHM + "\n" + sha256Hex(canonicalRequest.getBytes(StandardCharsets.UTF_8));

        String signature;
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(accessKeySecret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            signature = HexFormat.of().formatHex(mac.doFinal(stringToSign.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException | InvalidKeyException e) {
            throw new IllegalStateException(e);
        }

        return ALGORITHM + " Credential=" + accessKeyId
            + ",SignedHeaders=" + String.join(";", signedHeaders)
            + ",Signature=" + signature;
    }
}

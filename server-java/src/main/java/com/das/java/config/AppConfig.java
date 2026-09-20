package com.das.java.config;

import com.das.java.core.Constants;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 环境配置。与 Node 实现的 server-node/config.ts、Python 实现的 config.py 同源同语义
 * （.env 兼容同一份文件，DAS_ENV 多环境切换规则一致）。
 */
public record AppConfig(
    boolean mock,
    /** mock 回放是否用真实时间间隔（默认压平，见 MOCK_MAX_GAP_MS）。 */
    boolean mockRealtime,
    /** 压平之后的播放倍速；mockRealtime 为真时不生效。 */
    double mockSpeed,
    int port,
    List<String> corsOrigin,
    String regionId,
    /** 显式上游域名。留空 ⇒ SDK 按 regionId 走内置映射；预发/日常网关必须显式覆盖。 */
    String endpoint,
    String agentName,
    String sessionSource,
    String resourceGroupId,
    String accessKeyId,
    String accessKeySecret,
    /** 默认 127.0.0.1：进程持有 AK/SK，暴露到局域网等于把凭证使用权一起暴露。 */
    String serverHost,
    /** 前端构建产物目录；存在则由本进程同源托管（单容器交付 UI+API）。 */
    String webDist,
    Path repoRoot
) {
    private static final Set<String> TRUTHY = Set.of("1", "true", "yes", "on");

    /** JVM 内无法改写真实环境变量；用进程级覆盖表实现 dotenv override:false 语义。 */
    private static final Map<String, String> ENV_OVERRIDES = new LinkedHashMap<>();

    /** 全部取值统一走这里：先查进程环境，再查 .env 补齐的覆盖表。 */
    private static String env(String key) {
        String v = System.getenv(key);
        return v != null ? v : ENV_OVERRIDES.get(key);
    }

    private static boolean bool(String raw) {
        return raw != null && TRUTHY.contains(raw.trim().toLowerCase());
    }

    private static String nonEmpty(String raw) {
        String v = raw == null ? "" : raw.trim();
        return v.isEmpty() ? null : v;
    }

    private static int integer(String raw, int fallback) {
        try {
            int n = Integer.parseInt(raw == null ? "" : raw.trim());
            return n > 0 ? n : fallback;
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static double number(String raw, double fallback) {
        try {
            double n = Double.parseDouble(raw == null ? "" : raw.trim());
            return n > 0 ? n : fallback;
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    /**
     * 仓库根：进程内 class 资源是 jar 时不可靠，所以从 cwd 向上找
     * `server-node/test/fixtures/prompt-short.jsonl`——这个文件只在仓库根存在。
     * 找不到就退回 cwd（不依赖 fixture 的 LIVE 进程仍然可以起来）。
     */
    public static Path findRepoRoot(Path start) {
        Path dir = start.toAbsolutePath().normalize();
        while (dir != null) {
            if (Files.isRegularFile(dir.resolve("server-node/test/fixtures/prompt-short.jsonl"))) return dir;
            dir = dir.getParent();
        }
        return start.toAbsolutePath().normalize();
    }

    public static AppConfig load() {
        Path repoRoot = findRepoRoot(Path.of("").toAbsolutePath());
        loadEnvFile(repoRoot);

        boolean mock = bool(env("MOCK"));
        String accessKeyId = nonEmpty(env("ALIBABA_CLOUD_ACCESS_KEY_ID"));
        String accessKeySecret = nonEmpty(env("ALIBABA_CLOUD_ACCESS_KEY_SECRET"));

        List<String> cors = new ArrayList<>();
        String corsRaw = nonEmpty(env("CORS_ORIGIN"));
        for (String s : (corsRaw != null ? corsRaw : "http://localhost:5173").split(",")) {
            if (!s.trim().isEmpty()) cors.add(s.trim());
        }

        String region = nonEmpty(env("DATAAGENT_REGION_ID"));
        String agent = nonEmpty(env("DATAAGENT_AGENT_NAME"));
        String source = nonEmpty(env("SESSION_SOURCE"));
        String host = nonEmpty(env("SERVER_HOST"));
        String webDist = nonEmpty(env("WEB_DIST"));
        if (webDist == null) webDist = repoRoot.resolve("web/dist").toString();

        AppConfig cfg = new AppConfig(
            mock,
            bool(env("MOCK_REALTIME")),
            number(env("MOCK_SPEED"), Constants.MOCK_DEFAULT_SPEED),
            integer(env("PORT"), 3000),
            cors,
            region != null ? region : "cn-hangzhou",
            nonEmpty(env("END_POINT")),
            agent != null ? agent : Constants.DEFAULT_AGENT_NAME,
            source != null ? source : Constants.DEFAULT_SESSION_SOURCE,
            nonEmpty(env("RESOURCE_GROUP_ID")),
            accessKeyId,
            accessKeySecret,
            host != null ? host : "127.0.0.1",
            webDist,
            repoRoot
        );

        if (!cfg.mock && (cfg.accessKeyId == null || cfg.accessKeySecret == null)) {
            printMissingCredentials(repoRoot);
            System.exit(1);
        }
        return cfg;
    }

    /**
     * 选择要加载的 env 文件（与 Node/Python 同一套规则，读同一份文件）。
     *
     * 默认读 `.env`；设了 `DAS_ENV=<name>` 就改读 `.env.<name>`。每个 env 文件都是
     * **自包含**的，选中谁就只用谁，不做叠加。指定了 DAS_ENV 却找不到文件就**直接退出**：
     * 回落等于让你以为在跑预发、其实打到生产。
     * 已经注入进程的环境变量优先于文件（override:false 语义）。
     */
    private static void loadEnvFile(Path repoRoot) {
        String name = nonEmpty(env("DAS_ENV"));
        String fileName = name != null ? ".env." + name : ".env";
        List<Path> candidates = List.of(
            repoRoot.resolve(fileName),
            Path.of("").toAbsolutePath().resolve(fileName)
        );
        Path found = null;
        for (Path c : candidates) {
            if (Files.isRegularFile(c)) {
                found = c;
                break;
            }
        }

        if (found != null) {
            for (Map.Entry<String, String> e : parseDotenv(found).entrySet()) {
                if (System.getenv(e.getKey()) == null) {
                    ENV_OVERRIDES.put(e.getKey(), e.getValue());
                }
            }
            return;
        }

        if (name != null) {
            StringBuilder sb = new StringBuilder();
            sb.append('\n').append("指定了 DAS_ENV=").append(name).append("，但找不到 ").append(fileName).append("。找过这些位置：\n");
            for (Path c : candidates) sb.append("  - ").append(c).append('\n');
            sb.append('\n')
                .append("不会回落到 .env：那会让你以为在跑这个环境、其实打到别处。\n")
                .append("先 cp .env.example ").append(fileName).append(" 填好，或去掉 DAS_ENV 用默认 .env。\n\n");
            System.err.print(sb);
            System.exit(1);
        }
        // 没有 DAS_ENV、也没有 .env：不在这里报错，交给凭证检查给出"缺凭证"的指引。
    }

    /** 极简 .env 解析：# 注释、`KEY=VALUE`、可选引号。与 python-dotenv 的常用形态对齐。 */
    static Map<String, String> parseDotenv(Path file) {
        Map<String, String> out = new LinkedHashMap<>();
        try {
            for (String line : Files.readAllLines(file)) {
                String t = line.trim();
                if (t.isEmpty() || t.startsWith("#")) continue;
                int eq = t.indexOf('=');
                if (eq <= 0) continue;
                String key = t.substring(0, eq).trim().replaceFirst("^export\\s+", "");
                String value = t.substring(eq + 1).trim();
                if (value.length() >= 2
                    && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) {
                    value = value.substring(1, value.length() - 1);
                }
                if (!key.isEmpty()) out.put(key, value);
            }
        } catch (IOException e) {
            throw new IllegalStateException("读 env 文件失败：" + file + "（" + e.getMessage() + "）", e);
        }
        return out;
    }

    private static void printMissingCredentials(Path repoRoot) {
        String text = "\n缺少凭证，服务没有启动。\n\n"
            + "本工程只从环境变量读 AK/SK：不读 ~/.aliyun/config.json，也不调用 aliyun CLI。\n\n"
            + "两条路选一条：\n\n"
            + "  A. 只想先看界面和流程（推荐先走这条）\n"
            + "       cp .env.example .env      # 或者不改文件，直接：MOCK=1 ./scripts/dev-server.sh java\n"
            + "     MOCK 模式下完全不调真实接口，回放本仓库录制的真实帧流，无需任何凭证。\n\n"
            + "  B. 要调真实接口\n"
            + "     1) cp .env.example .env\n"
            + "     2) 填 ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET\n"
            + "        建议单独建 RAM 用户，不要用主账号 AK/SK。\n"
            + "     3) 填 DATAAGENT_REGION_ID（DataWorks 实例所在 region）\n"
            + "     4) 账号下 DataWorks 运行实例为零的话，还要填 RESOURCE_GROUP_ID\n"
            + "     5) 要接预发/日常等内置映射不认识的上游，再填 END_POINT（域名，留空按 region 推导）\n\n"
            + "  .env 应该放在仓库根：" + repoRoot.resolve(".env") + "\n"
            + "  要在多个环境间切换：每个环境放一份自包含的 .env.<name>，用 DAS_ENV=<name> 选。\n\n"
            + "  填好之后做三步自检，再启动。\n\n";
        System.err.print(text);
    }

    /**
     * 打印启动信息。
     *
     * 只打印凭证"有没有"，绝不打印凭证本身，也不打印任何前缀/掩码形式——
     * 日志会被贴进 issue、CI 产物和聊天记录里。
     */
    public String describe() {
        List<String> lines = new ArrayList<>();
        lines.add("mode          : " + (mock ? "MOCK（回放录制帧流，不调真实接口）" : "LIVE（调用真实 OpenAPI）"));
        if (mock) {
            lines.add("replay        : " + (mockRealtime
                ? "真实时间间隔（MOCK_REALTIME=1）"
                : "压平至 " + Constants.MOCK_MAX_GAP_MS + "ms + " + mockSpeed + "x 倍速"));
        }
        lines.add("region        : " + regionId);
        lines.add("endpoint      : " + (endpoint != null ? endpoint : "(未设置，按 region 走 SDK 内置映射)"));
        lines.add("agent         : " + agentName);
        lines.add("sessionSource : " + sessionSource);
        lines.add("resourceGroup : " + (resourceGroupId != null ? resourceGroupId : "(未配置)"));
        lines.add("credentials   : " + (accessKeyId != null && accessKeySecret != null ? "present" : "missing"));
        lines.add("host          : " + serverHost + (serverHost.equals("127.0.0.1") ? "" : "（容器/内网模式：Host 白名单已关闭）"));
        lines.add("webDist       : " + webDist);
        return String.join("\n", lines);
    }
}

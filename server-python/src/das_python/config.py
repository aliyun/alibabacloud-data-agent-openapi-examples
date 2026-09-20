"""环境配置。与 Node 实现的 server-node/config.ts 同源同语义（.env 兼容同一份文件）。"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

from .constants import DEFAULT_AGENT_NAME, DEFAULT_SESSION_SOURCE, MOCK_DEFAULT_SPEED, MOCK_MAX_GAP_MS

TRUTHY = {"1", "true", "yes", "on"}

# 仓库根：本文件位于 server-python/src/das_python/，向上四级。
REPO_ROOT = Path(__file__).resolve().parents[3]


@dataclass
class AppConfig:
    mock: bool
    mockRealtime: bool  # noqa: N815
    mockSpeed: float  # noqa: N815
    port: int
    corsOrigin: list[str]  # noqa: N815
    regionId: str  # noqa: N815
    endpoint: str | None
    agentName: str  # noqa: N815
    sessionSource: str  # noqa: N815
    resourceGroupId: str | None  # noqa: N815
    accessKeyId: str | None  # noqa: N815
    accessKeySecret: str | None  # noqa: N815
    serverHost: str  # noqa: N815
    webDist: str | None  # noqa: N815


def _bool(raw: str | None) -> bool:
    return raw is not None and raw.strip().lower() in TRUTHY


def _non_empty(raw: str | None) -> str | None:
    value = raw.strip() if raw else ""
    return value or None


def _int(raw: str | None, fallback: int) -> int:
    try:
        n = int((raw or "").strip())
        return n if n > 0 else fallback
    except ValueError:
        return fallback


def _num(raw: str | None, fallback: float) -> float:
    try:
        n = float((raw or "").strip())
        return n if n > 0 else fallback
    except ValueError:
        return fallback


def _load_env_file() -> None:
    """选择要加载的 env 文件（与 Node 版同一套规则，读同一份文件）。

    默认读 `.env`；设了 `DAS_ENV=<name>` 就改读 `.env.<name>`。每个 env 文件都是
    **自包含**的，选中谁就只用谁，不做叠加。指定了 DAS_ENV 却找不到文件就**直接退出**：
    回落等于让你以为在跑预发、其实打到了生产。
    """
    name = _non_empty(os.environ.get("DAS_ENV"))
    file_name = f".env.{name}" if name else ".env"
    candidates = [REPO_ROOT / file_name, Path.cwd() / file_name]
    found = next((c for c in candidates if c.exists()), None)
    if found:
        load_dotenv(found, override=False)
        return

    if name:
        print(
            f"\n指定了 DAS_ENV={name}，但找不到 {file_name}。找过这些位置：\n"
            + "\n".join(f"  - {c}" for c in candidates)
            + "\n\n不会回落到 .env：那会让你以为在跑这个环境、其实打到别处。\n"
            f"先 cp .env.example {file_name} 填好，或去掉 DAS_ENV 用默认 .env。\n",
            file=sys.stderr,
        )
        sys.exit(1)
    # 没有 DAS_ENV、也没有 .env：不在这里报错，交给凭证检查给出"缺凭证"的指引。


def load_config() -> AppConfig:
    _load_env_file()

    access_key_id = _non_empty(os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_ID"))
    access_key_secret = _non_empty(os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_SECRET"))

    cfg = AppConfig(
        mock=_bool(os.environ.get("MOCK")),
        mockRealtime=_bool(os.environ.get("MOCK_REALTIME")),  # noqa: N815
        mockSpeed=_num(os.environ.get("MOCK_SPEED"), MOCK_DEFAULT_SPEED),  # noqa: N815
        port=_int(os.environ.get("PORT"), 3000),
        corsOrigin=[
            s.strip()
            for s in (_non_empty(os.environ.get("CORS_ORIGIN")) or "http://localhost:5173").split(",")
            if s.strip()
        ],
        regionId=_non_empty(os.environ.get("DATAAGENT_REGION_ID")) or "cn-hangzhou",  # noqa: N815
        endpoint=_non_empty(os.environ.get("END_POINT")),
        agentName=_non_empty(os.environ.get("DATAAGENT_AGENT_NAME")) or DEFAULT_AGENT_NAME,  # noqa: N815
        sessionSource=_non_empty(os.environ.get("SESSION_SOURCE")) or DEFAULT_SESSION_SOURCE,  # noqa: N815
        resourceGroupId=_non_empty(os.environ.get("RESOURCE_GROUP_ID")),  # noqa: N815
        accessKeyId=access_key_id,  # noqa: N815
        accessKeySecret=access_key_secret,  # noqa: N815
        serverHost=_non_empty(os.environ.get("SERVER_HOST")) or "127.0.0.1",  # noqa: N815
        webDist=_non_empty(os.environ.get("WEB_DIST")) or str(REPO_ROOT / "web" / "dist"),  # noqa: N815
    )

    if not cfg.mock and (not cfg.accessKeyId or not cfg.accessKeySecret):
        _print_missing_credentials()
        sys.exit(1)

    return cfg


def _print_missing_credentials() -> None:
    print(
        "\n缺少凭证，服务没有启动。\n\n"
        "本工程只从环境变量读 AK/SK：不读 ~/.aliyun/config.json，也不调用 aliyun CLI。\n\n"
        "两条路选一条：\n\n"
        "  A. 要调真实接口\n"
        "     1) cp .env.example .env\n"
        "     2) 填 ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET\n"
        "        建议单独建 RAM 用户，不要用主账号 AK/SK。\n"
        "     3) 填 DATAAGENT_REGION_ID（DataWorks 实例所在 region）\n"
        "     4) 账号下 DataWorks 运行实例为零的话，还要填 RESOURCE_GROUP_ID\n"
        "     5) 要接预发/日常等内置映射不认识的上游，再填 END_POINT（域名，留空按 region 推导）\n\n"
        f"  .env 应该放在仓库根：{REPO_ROOT / '.env'}\n"
        "  要在多个环境间切换：每个环境放一份自包含的 .env.<name>，用 `DAS_ENV=<name>` 选。\n\n"
        "  填好之后做三步自检，再启动。\n",
        file=sys.stderr,
    )


def describe_config(cfg: AppConfig) -> str:
    """打印启动信息。只打印凭证"有没有"，绝不打印凭证本身或任何前缀/掩码形式。"""
    lines = [f"mode          : {'MOCK（回放合成样例帧流，不调真实接口）' if cfg.mock else 'LIVE（调用真实 OpenAPI）'}"]
    if cfg.mock:
        lines.append(
            f"replay        : {'真实时间间隔（MOCK_REALTIME=1）' if cfg.mockRealtime else f'压平至 {MOCK_MAX_GAP_MS}ms + {cfg.mockSpeed}x 倍速'}"
        )
    lines.extend(
        [
            f"region        : {cfg.regionId}",
            f"endpoint      : {cfg.endpoint or '(未设置，按 region 走 SDK 内置映射)'}",
            f"agent         : {cfg.agentName}",
            f"sessionSource : {cfg.sessionSource}",
            f"resourceGroup : {cfg.resourceGroupId or '(未配置)'}",
            f"credentials   : {'present' if cfg.accessKeyId and cfg.accessKeySecret else 'missing'}",
            f"host          : {cfg.serverHost}{'' if cfg.serverHost == '127.0.0.1' else '（容器/内网模式：Host 白名单已关闭）'}",
            f"webDist       : {cfg.webDist or '(未配置，UI 不由本进程托管)'}",
        ]
    )
    return "\n".join(lines)

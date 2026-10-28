"""Standalone administrator examples, never imported by server startup.

Pass an independently constructed administrator SDK client. These helpers perform
writes only when explicitly called; they do not implement role assumption.
Wire schema: CloudSpec expert-suite-release, DataWorks 2024-05-18.
"""
from __future__ import annotations

import json
from typing import Any

from alibabacloud_tea_openapi.utils_models import OpenApiRequest
from das_python.live import runtime_for
from das_python.pop import descriptor


async def _call(client: Any, action: str, fields: dict[str, Any]) -> dict[str, Any]:
    # Agent management uses top-level form fields, unlike session JSON-RPC Params.
    # Keep arbitrary Model/Metadata map keys and nested reference keys unchanged.
    form = {key: json.dumps(value, ensure_ascii=False, separators=(",", ":"))
            if isinstance(value, (dict, list, bool)) else value for key, value in fields.items()}
    response = await client.call_api_async(descriptor(action), OpenApiRequest(body=form), runtime_for())
    body = response.get("body")
    if not isinstance(body, dict) or not isinstance(body.get("Agent"), dict):
        raise ValueError(f"{action} did not return Agent; inspect the upstream failure before retrying")
    return body


async def get_agent(client: Any, name: str, agent_version: int | None = None) -> dict[str, Any]:
    """Omit AgentVersion to read the current definition; Version is POP API version."""
    return await _call(client, "GetAgent", {"Name": name,
        **({"AgentVersion": agent_version} if agent_version is not None else {})})


async def create_agent(client: Any, name: str, *, system_prompt: str,
                       skills: list[dict[str, Any]], expert_suites: list[dict[str, Any]],
                       publish_immediately: bool = False) -> dict[str, Any]:
    """References use public keys, e.g. {Source: OFFICIAL, SkillId: catalog-id}.

    DB skills use Name and optional Version; DB suites use SuiteId and optional
    Version. Official references omit Version. Use verified catalog IDs only.
    A publish failure can leave a draft: GetAgent before attempting another create.
    """
    return await _call(client, "CreateAgent", {"Name": name, "SystemPrompt": system_prompt,
        "Skills": skills, "ExpertSuites": expert_suites, "PublishImmediately": publish_immediately})


async def update_agent(client: Any, name: str, *, expected_version: int,
                       display_name: str, publish_immediately: bool = False) -> dict[str, Any]:
    """Use current GetAgent.Agent.AgentVersion; on mismatch, read and merge again.

    Omit resource lists to preserve references. This example updates the display
    name only; it never constructs an empty list to imply resource removal.
    """
    if isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version < 1:
        raise ValueError("expected_version must be a positive AgentVersion")
    return await _call(client, "UpdateAgent", {"Name": name, "ExpectedVersion": expected_version,
        "DisplayName": display_name, "PublishImmediately": publish_immediately})

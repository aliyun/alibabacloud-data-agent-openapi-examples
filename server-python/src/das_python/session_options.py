"""Shared creation validation for /api and daemon protocols."""
import unicodedata
from typing import Any

from .config import AppConfig

MODES = ("plan", "default", "auto-edit", "auto", "yolo")


def validate_agent_name(value: Any) -> str:
    if not isinstance(value, str) or any(unicodedata.category(ch) in ("Cc", "Cf") for ch in value):
        raise ValueError("agentName must be a non-empty string without control characters (max 128)")
    name = value.strip()
    if not name or len(name) > 128:
        raise ValueError("agentName must be a non-empty string without control characters (max 128)")
    return name


def creation_options(cfg: AppConfig, body: dict[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {"agentName": validate_agent_name(body.get("agentName", cfg.agentName))}
    for key, aliases, default in (
        ("mode", ("approvalMode", "mode"), cfg.mode),
        ("model", ("modelServiceId", "model"), cfg.model),
        ("reasoningEffort", ("reasoningEffort",), cfg.reasoningEffort),
    ):
        value = next((body[a] for a in aliases if a in body), default)
        if value is None and not any(alias in body for alias in aliases):
            continue
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{aliases[0]} must be a non-empty string")
        value = value.strip()
        if key == "model" and value == "data-agent":
            value = cfg.model.strip() if isinstance(cfg.model, str) else ""
            if not value or value == "data-agent":
                continue
        if key == "mode" and value not in MODES:
            raise ValueError(f"approvalMode must be one of {', '.join(MODES)}")
        out[key] = value
    return out


def public_options(cfg: AppConfig) -> dict[str, Any]:
    options = creation_options(cfg, {})
    models = list(dict.fromkeys((*cfg.models, *([cfg.model] if cfg.model else []))))
    return {"agentName": cfg.agentName, "approvalMode": options["mode"], "models": models,
            **({"model": options["model"]} if "model" in options else {}),
            **({"reasoningEffort": options["reasoningEffort"]} if "reasoningEffort" in options else {})}

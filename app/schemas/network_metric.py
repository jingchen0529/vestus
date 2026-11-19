from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.device import normalize_device_id

Route = Literal["management", "vpn", "browser"]
NetworkMode = Literal["direct", "proxy", "unavailable"]
TargetKind = Literal["api", "proxy_probe", "cdp"]
Status = Literal["ok", "error"]
ErrorCode = Literal[
    "timeout", "dns", "connect", "tls", "http_status", "proxy_disabled",
    "proxy_unavailable", "proxy_auth", "cdp_unavailable", "browser_closed",
    "session_changed", "cancelled",
]

MAX_DURATION_MS = 8000
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_DOWNLOAD_KBPS = 1024 * 1024


class NetworkMetricSample(BaseModel):
    sample_id: str = Field(alias="sampleId", min_length=16, max_length=16, pattern=r"^[0-9a-fA-F]{16}$")
    route: Route
    target_kind: TargetKind = Field(alias="targetKind")
    network_mode: NetworkMode = Field(alias="networkMode")
    platform_id: Optional[str] = Field(default=None, alias="platformId", max_length=128)
    browser_id: Optional[str] = Field(default=None, alias="browserId", max_length=128)
    started_at_ms: int = Field(alias="startedAtMs", ge=0)
    duration_ms: Optional[int] = Field(default=None, alias="durationMs", ge=0, le=MAX_DURATION_MS)
    connect_ms: Optional[int] = Field(default=None, alias="connectMs", ge=0, le=MAX_DURATION_MS)
    ttfb_ms: Optional[int] = Field(default=None, alias="ttfbMs", ge=0, le=MAX_DURATION_MS)
    total_ms: Optional[int] = Field(default=None, alias="totalMs", ge=0, le=MAX_DURATION_MS)
    response_bytes: Optional[int] = Field(default=None, alias="responseBytes", ge=0, le=MAX_RESPONSE_BYTES)
    download_kbps: Optional[int] = Field(default=None, alias="downloadKbps", ge=0, le=MAX_DOWNLOAD_KBPS)
    status: Status
    error_code: Optional[ErrorCode] = Field(default=None, alias="errorCode")
    client_version: Optional[str] = Field(default=None, alias="clientVersion", max_length=50)
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    @field_validator("platform_id", "browser_id")
    @classmethod
    def clean_ids(cls, value: Optional[str]) -> Optional[str]:
        return value.strip() if value and value.strip() else None

    @model_validator(mode="after")
    def validate_route_mode(self) -> "NetworkMetricSample":
        if self.route == "management" and self.network_mode != "direct":
            raise ValueError("management route must use direct network mode")
        if self.route == "vpn" and self.network_mode == "direct":
            raise ValueError("vpn route cannot use direct network mode")
        if self.status == "ok" and self.error_code is not None:
            raise ValueError("successful sample cannot include errorCode")
        if self.status == "error" and self.error_code is None:
            raise ValueError("failed sample requires errorCode")
        return self


class NetworkDiagnosticsReport(BaseModel):
    protocol_version: Literal[1] = Field(alias="protocolVersion")
    samples: List[NetworkMetricSample] = Field(min_length=1, max_length=20)
    device_id: Optional[str] = Field(default=None, alias="deviceId", max_length=64)
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    @field_validator("device_id")
    @classmethod
    def canonical_device(cls, value: Optional[str]) -> Optional[str]:
        return normalize_device_id(value) if value else None


"""Proxy management request bodies and the direct-connect host rules."""

from __future__ import annotations

import ipaddress
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

MAX_BYPASS_HOSTS = 32
MAX_BYPASS_HOST_LENGTH = 253
MAX_BYPASS_LABEL_LENGTH = 63


def validate_bypass_hosts(values: List[str]) -> List[str]:
    """Normalize the direct-connect exception list.

    The rules mirror ``desktop/src-tauri/src/bypass.rs`` exactly: the desktop
    client re-validates whatever it receives and refuses the whole configuration
    on any bad entry, so accepting something here that Rust rejects would only
    break the client.  ``host`` matches that host, ``*.host`` (or ``.host``)
    matches its subdomains and is stored in the ``*.`` form.

    IP literals and ``localhost`` are refused because a direct-connect entry
    bypasses the proxy entirely; a name that resolves to loopback is rejected
    again at connect time on the client.
    """
    if len(values) > MAX_BYPASS_HOSTS:
        raise ValueError(f"at most {MAX_BYPASS_HOSTS} direct-connect hosts are allowed")
    normalized: List[str] = []
    for raw in values:
        if not isinstance(raw, str):
            raise ValueError("direct-connect host must be a string")
        text = raw.strip()
        if not text:
            raise ValueError("direct-connect host must not be empty")
        if not text.isascii():
            raise ValueError(f"direct-connect host must be ASCII (use punycode): {text}")
        lowered = text.lower()
        if (
            "://" in lowered
            or "/" in lowered
            or "@" in lowered
            or ":" in lowered
            or any(character.isspace() or not character.isprintable() for character in lowered)
        ):
            raise ValueError(f"direct-connect host must be a bare hostname: {text}")

        subdomain_only = False
        if lowered.startswith("*."):
            host, subdomain_only = lowered[2:], True
        elif lowered.startswith("."):
            host, subdomain_only = lowered[1:], True
        else:
            host = lowered
        host = host.rstrip(".")

        if not host or len(host) > MAX_BYPASS_HOST_LENGTH:
            raise ValueError(f"direct-connect host length is invalid: {text}")
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise ValueError(f"direct-connect list accepts hostnames, not IP addresses: {text}")
        if host == "localhost" or host.endswith(".localhost"):
            raise ValueError("direct-connect list must not contain localhost")
        if "." not in host:
            raise ValueError(f"direct-connect host must contain a dot: {text}")
        for label in host.split("."):
            if (
                not label
                or len(label) > MAX_BYPASS_LABEL_LENGTH
                or label.startswith("-")
                or label.endswith("-")
                or any(
                    not (character.isascii() and (character.isalnum() or character in "-_"))
                    for character in label
                )
            ):
                raise ValueError(f"direct-connect host is malformed: {text}")

        entry = f"*.{host}" if subdomain_only else host
        if entry not in normalized:
            normalized.append(entry)
    return normalized


class ProxyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(ge=1, le=65535)
    username: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=1, max_length=1024)
    bypass_hosts: List[str] = Field(default_factory=list, alias="bypassHosts")
    status: str = Field(default="active", pattern="^(active|disabled)$")
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    @field_validator("name")
    @classmethod
    def trim_proxy_name(cls, value: str) -> str:
        value = value.strip()
        if not value or any(not character.isprintable() for character in value):
            raise ValueError("value must not be empty")
        return value

    @field_validator("host")
    @classmethod
    def validate_proxy_host(cls, value: str) -> str:
        value = value.strip()
        if (
            not value
            or "://" in value
            or "/" in value
            or "@" in value
            or any(character.isspace() for character in value)
        ):
            raise ValueError("proxy host must be a bare IP address or hostname")
        return value

    @field_validator("username")
    @classmethod
    def trim_proxy_username(cls, value: str) -> str:
        value = value.strip()
        if not value or ":" in value:
            raise ValueError("proxy username must not be empty or contain a colon")
        return value

    @field_validator("bypass_hosts")
    @classmethod
    def normalize_bypass_hosts(cls, value: List[str]) -> List[str]:
        return validate_bypass_hosts(value)


class ProxyUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    host: Optional[str] = Field(default=None, min_length=1, max_length=255)
    port: Optional[int] = Field(default=None, ge=1, le=65535)
    username: Optional[str] = Field(default=None, min_length=1, max_length=255)
    password: Optional[str] = Field(default=None, min_length=1, max_length=1024)
    bypass_hosts: Optional[List[str]] = Field(default=None, alias="bypassHosts")
    status: Optional[str] = Field(default=None, pattern="^(active|disabled)$")
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    @field_validator("name")
    @classmethod
    def trim_proxy_optional_name(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        if not value or any(not character.isprintable() for character in value):
            raise ValueError("value must not be empty")
        return value

    @field_validator("host")
    @classmethod
    def validate_proxy_optional_host(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        if (
            not value
            or "://" in value
            or "/" in value
            or "@" in value
            or any(character.isspace() for character in value)
        ):
            raise ValueError("proxy host must be a bare IP address or hostname")
        return value

    @field_validator("username")
    @classmethod
    def trim_proxy_optional_username(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        if not value or ":" in value:
            raise ValueError("proxy username must not be empty or contain a colon")
        return value

    @field_validator("bypass_hosts")
    @classmethod
    def normalize_optional_bypass_hosts(cls, value: Optional[List[str]]) -> Optional[List[str]]:
        if value is None:
            return None
        return validate_bypass_hosts(value)

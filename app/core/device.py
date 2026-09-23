"""Device-identifier normalization.

The desktop client reads the machine identifier its operating system exposes --
``IOPlatformUUID`` on macOS, ``MachineGuid`` on Windows, ``/etc/machine-id`` on
Linux -- and reports it on login and with every activity batch.  The three
sources disagree on formatting: macOS returns an upper-case UUID, Windows a
lower-case hex string that may be wrapped in braces, Linux 32 lower-case hex
characters.  Normalizing here is what makes "same machine" comparable across
platforms.

The function never raises.  A value that does not fit is dropped, because
collecting a device id must never be the reason a login or an activity upload
fails: a machine whose registry is locked down by policy, or a Linux container
without a machine-id, still has to be usable.  The same rule is why the two
request schemas take the field as optional -- desktop builds already in the
field simply do not send it.
"""

from __future__ import annotations

import re
from typing import Any, Optional

#: Longest identifier we accept.  The three platforms produce 32-36 characters;
#: the cap only exists to keep a forged value out of the table.
MAX_DEVICE_ID_LENGTH = 64

#: Canonical shape after normalization: lower-case hex, optionally hyphenated.
_DEVICE_ID_PATTERN = re.compile(r"^[0-9a-f][0-9a-f-]*$")


def normalize_device_id(value: Any) -> Optional[str]:
    """Return the canonical form of a reported device id, or ``None``.

    ``None`` means "no usable identifier": not a string, empty, over-long, or
    containing anything outside hex digits and hyphens.
    """

    if not isinstance(value, str):
        return None
    # ``strip`` twice on purpose: the braces Windows tooling wraps around the
    # MachineGuid may themselves be padded.
    text = value.strip().strip("{}").strip().lower()
    if not text or len(text) > MAX_DEVICE_ID_LENGTH:
        return None
    if not _DEVICE_ID_PATTERN.match(text):
        return None
    if text.strip("-") == "":
        return None
    return text


__all__ = ["MAX_DEVICE_ID_LENGTH", "normalize_device_id"]

"""Language packs contain text only; English messages are their own fallback."""

import re
from contextvars import ContextVar

messages = ContextVar("messages", default={})


def t(message: str, *values) -> str:
    return re.sub(r"\{(\d+)\}", lambda match: str(values[int(match[1])]), messages.get().get(message, message))

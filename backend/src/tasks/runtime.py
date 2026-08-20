"""Process-local asyncio runtime for synchronous Celery worker tasks.

Celery prefork workers reuse a child process for many tasks. Creating a fresh
event loop with ``asyncio.run`` for every task leaves asyncpg/Redis pools bound
to a closed loop. Keep one loop per worker thread so pooled async resources
always execute on the loop that created them.
"""

from __future__ import annotations

import asyncio
import os
import threading
from collections.abc import Coroutine
from typing import Any, TypeVar

T = TypeVar("T")
_runtime = threading.local()


def run_async(coro: Coroutine[Any, Any, T]) -> T:
    loop: asyncio.AbstractEventLoop | None = getattr(_runtime, "loop", None)
    if loop is None or loop.is_closed() or getattr(_runtime, "pid", None) != os.getpid():
        loop = asyncio.new_event_loop()
        _runtime.loop = loop
        _runtime.pid = os.getpid()
    if loop.is_running():
        coro.close()
        raise RuntimeError("Celery async runtime cannot be nested")
    return loop.run_until_complete(coro)

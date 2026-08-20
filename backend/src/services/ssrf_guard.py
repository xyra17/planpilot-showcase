import asyncio
import ipaddress
import socket
from collections.abc import Awaitable, Callable, Iterable
from urllib.parse import SplitResult, urlsplit, urlunsplit


class UnsafeUrlError(ValueError):
    pass


Resolver = Callable[[str, int], Awaitable[Iterable[str]]]
BLOCKED_HOST_SUFFIXES = (".localhost", ".local", ".internal", ".home.arpa", ".onion")
BLOCKED_HOSTS = {
    "localhost",
    "metadata.google.internal",
    "metadata.amazonaws.com",
}


def _public_ip(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return address.is_global


async def resolve_host_addresses(host: str, port: int) -> set[str]:
    loop = asyncio.get_running_loop()
    try:
        rows = await asyncio.wait_for(
            loop.getaddrinfo(host, port, type=socket.SOCK_STREAM),
            timeout=3.0,
        )
    except (TimeoutError, OSError, socket.gaierror) as exc:
        raise UnsafeUrlError("URL 主机无法安全解析") from exc
    return {row[4][0] for row in rows}


async def normalize_public_http_url(
    value: str,
    *,
    resolver: Resolver = resolve_host_addresses,
) -> str:
    if not value or len(value) > 2048 or any(ord(char) < 32 for char in value):
        raise UnsafeUrlError("URL 无效或过长")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise UnsafeUrlError("URL 格式无效") from exc
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"} or not parsed.hostname:
        raise UnsafeUrlError("仅支持有效的 HTTP/HTTPS URL")
    if parsed.username is not None or parsed.password is not None:
        raise UnsafeUrlError("URL 不允许包含用户名或密码")
    expected_port = 443 if scheme == "https" else 80
    if port not in {None, expected_port}:
        raise UnsafeUrlError("URL 仅允许标准 HTTP/HTTPS 端口")

    try:
        host = parsed.hostname.rstrip(".").encode("idna").decode("ascii").lower()
    except UnicodeError as exc:
        raise UnsafeUrlError("URL 主机名无效") from exc
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        if host in BLOCKED_HOSTS or host.endswith(BLOCKED_HOST_SUFFIXES) or "." not in host:
            raise UnsafeUrlError("URL 指向受限主机")
        addresses = set(await resolver(host, expected_port))
        if not addresses or any(not _public_ip(address) for address in addresses):
            raise UnsafeUrlError("URL 主机解析到非公网地址")
    else:
        if not literal.is_global:
            raise UnsafeUrlError("URL 指向非公网地址")

    netloc = f"[{host}]" if ":" in host else host
    canonical = SplitResult(
        scheme=scheme,
        netloc=netloc,
        path=parsed.path or "/",
        query=parsed.query,
        fragment="",
    )
    return urlunsplit(canonical)

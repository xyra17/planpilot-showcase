import asyncio
import ipaddress
import socket
from collections.abc import Awaitable, Callable, Iterable
from urllib.parse import SplitResult, urlsplit, urlunsplit

import httpx


class UnsafeUrlError(ValueError):
    pass


Resolver = Callable[[str, int], Awaitable[Iterable[str]]]
FallbackResolver = Callable[[str], Awaitable[Iterable[str]]]
BLOCKED_HOST_SUFFIXES = (".localhost", ".local", ".internal", ".home.arpa", ".onion")
BLOCKED_HOSTS = {
    "localhost",
    "metadata.google.internal",
    "metadata.amazonaws.com",
}
PROXY_FAKE_IP_NETWORKS = (ipaddress.ip_network("198.18.0.0/15"),)
PUBLIC_DNS_JSON_ENDPOINTS = (
    "https://1.1.1.1/dns-query",
    "https://dns.alidns.com/resolve",
    "https://dns.google/resolve",
)


def _public_ip(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return address.is_global


def _proxy_fake_ip(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return any(address in network for network in PROXY_FAKE_IP_NETWORKS)


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


async def resolve_public_dns_addresses(host: str) -> set[str]:
    """Resolve proxy Fake-IP hostnames through a fixed public DoH endpoint."""

    async def query(
        client: httpx.AsyncClient,
        endpoint: str,
        record_type: str,
    ) -> set[str]:
        try:
            response = await client.get(
                endpoint,
                params={"name": host, "type": record_type},
                headers={"Accept": "application/dns-json"},
            )
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError):
            return set()
        if not isinstance(payload, dict) or payload.get("Status") != 0:
            return set()
        answers = payload.get("Answer", [])
        if not isinstance(answers, list):
            return set()
        expected_type = 1 if record_type == "A" else 28
        return {
            str(answer.get("data", ""))
            for answer in answers
            if isinstance(answer, dict) and answer.get("type") == expected_type
        }

    async with httpx.AsyncClient(
        timeout=4.0,
        follow_redirects=False,
        trust_env=False,
    ) as client:
        for endpoint in PUBLIC_DNS_JSON_ENDPOINTS:
            results = await asyncio.gather(
                query(client, endpoint, "A"),
                query(client, endpoint, "AAAA"),
            )
            addresses = set().union(*results)
            if addresses:
                return addresses
    raise UnsafeUrlError("URL 主机无法通过公共 DNS 安全解析")


async def normalize_public_http_url(
    value: str,
    *,
    resolver: Resolver = resolve_host_addresses,
    fallback_resolver: FallbackResolver = resolve_public_dns_addresses,
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
        if addresses and all(_proxy_fake_ip(address) for address in addresses):
            try:
                addresses = set(await fallback_resolver(host))
            except UnsafeUrlError:
                raise
            except Exception as exc:
                raise UnsafeUrlError("URL 主机无法通过公共 DNS 安全解析") from exc
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

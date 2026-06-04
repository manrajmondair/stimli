from __future__ import annotations

import ipaddress
import http.client
import re
import socket
import ssl
from html.parser import HTMLParser
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

MAX_RESPONSE_BYTES = 1_000_000
MAX_REDIRECTS = 5
SAFE_CONTENT_TYPES = ("text/html", "text/plain", "application/xhtml+xml")
BLOCKED_HOSTS = {"localhost", "localhost.localdomain", "metadata.google.internal"}
BLOCKED_SUFFIXES = (".localhost", ".local", ".internal")


class VisibleTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._skip_depth = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "svg", "noscript"}:
            self._skip_depth += 1
            return
        attrs_dict = dict(attrs)
        if tag in {"meta"} and attrs_dict.get("content"):
            key = f"{attrs_dict.get('name', '')} {attrs_dict.get('property', '')}".lower()
            if any(token in key for token in ["description", "title", "og:description"]):
                self.parts.append(attrs_dict["content"] or "")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "svg", "noscript"} and self._skip_depth:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if not self._skip_depth:
            cleaned = data.strip()
            if cleaned:
                self.parts.append(cleaned)


def extract_landing_page_text(url: str, limit: int = 2400) -> tuple[str, dict[str, str]]:
    try:
        normalized_url = normalize_public_url(url)
        text, final_url = _fetch_visible_html(normalized_url)
    except BlockedLandingPageURL as exc:
        fallback = _fallback_text(url)
        return fallback, {"extraction_status": "blocked", "extraction_error": str(exc)[:180]}
    except Exception as exc:
        fallback = _fallback_text(url)
        return fallback, {"extraction_status": "fallback", "extraction_error": str(exc)[:180]}

    parser = VisibleTextParser()
    parser.feed(text)
    text = _normalize(" ".join(parser.parts))
    if not text:
        return _fallback_text(final_url), {"extraction_status": "empty", "final_url": final_url}
    return text[:limit], {"extraction_status": "fetched", "final_url": final_url}


class BlockedLandingPageURL(ValueError):
    pass


def normalize_public_url(raw_url: str) -> str:
    raw_url = (raw_url or "").strip()
    if not raw_url:
        raise BlockedLandingPageURL("Landing page URL is required.")
    if not raw_url.startswith(("http://", "https://")):
        raw_url = f"https://{raw_url}"
    parsed = urlparse(raw_url)
    if parsed.scheme not in {"http", "https"}:
        raise BlockedLandingPageURL("Landing page URL must use http or https.")
    if not parsed.hostname:
        raise BlockedLandingPageURL("Landing page URL must include a hostname.")
    if parsed.username or parsed.password:
        raise BlockedLandingPageURL("Landing page URL credentials are not allowed.")
    _assert_public_host(parsed.hostname)
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path or "/", parsed.params, _public_query_string(parsed.query), ""))


def _fetch_visible_html(initial_url: str) -> tuple[str, str]:
    current_url = initial_url
    headers = {"User-Agent": "Stimli/0.1 creative-analysis"}
    for _ in range(MAX_REDIRECTS + 1):
        response = _request_once_pinned(current_url, headers)
        if 300 <= response["status"] < 400:
            location = response["headers"].get("location")
            if not location:
                raise ValueError("Redirect response missing Location header.")
            current_url = normalize_public_url(urljoin(current_url, location))
            continue
        if response["status"] >= 400:
            raise ValueError(f"Landing page returned HTTP {response['status']}.")
        content_type = response["headers"].get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type and content_type not in SAFE_CONTENT_TYPES:
            raise ValueError(f"Unsupported landing page content type: {content_type}")
        return response["body"].decode(response["encoding"], errors="replace"), current_url
    raise ValueError("Landing page redirected too many times.")


def _request_once_pinned(url: str, headers: dict[str, str]) -> dict[str, object]:
    parsed = urlparse(url)
    host = parsed.hostname or ""
    addresses = _public_ip_addresses(host)
    pinned_ip = addresses[0]
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    path = urlunparse(("", "", parsed.path or "/", parsed.params, parsed.query, ""))
    connection_headers = {**headers, "Host": parsed.netloc}
    if parsed.scheme == "https":
        connection = _PinnedHTTPSConnection(host, pinned_ip, port=port, timeout=8)
    elif parsed.scheme == "http":
        connection = _PinnedHTTPConnection(pinned_ip, port=port, timeout=8)
    else:
        raise BlockedLandingPageURL("Landing page URL must use http or https.")
    try:
        connection.request("GET", path, headers=connection_headers)
        response = connection.getresponse()
        body = bytearray()
        while True:
            chunk = response.read(64 * 1024)
            if not chunk:
                break
            body.extend(chunk)
            if len(body) > MAX_RESPONSE_BYTES:
                raise ValueError("Landing page response is too large.")
        content_type = response.getheader("content-type", "")
        encoding = "utf-8"
        if "charset=" in content_type:
            encoding = content_type.rsplit("charset=", 1)[-1].split(";", 1)[0].strip() or "utf-8"
        return {
            "status": response.status,
            "headers": {key.lower(): value for key, value in response.getheaders()},
            "body": bytes(body),
            "encoding": encoding,
        }
    finally:
        connection.close()


def _assert_public_host(host: str) -> None:
    cleaned = host.rstrip(".").lower()
    if not cleaned:
        raise BlockedLandingPageURL("Landing page URL must include a hostname.")
    if cleaned in BLOCKED_HOSTS or any(cleaned.endswith(suffix) for suffix in BLOCKED_SUFFIXES):
        raise BlockedLandingPageURL("Landing page host is not allowed.")
    try:
        ip = ipaddress.ip_address(cleaned.strip("[]"))
    except ValueError:
        _public_ip_addresses(cleaned)
        return
    if not ip.is_global:
        raise BlockedLandingPageURL("Landing page IP address is not public.")


def _public_ip_addresses(host: str) -> list[str]:
    cleaned = host.rstrip(".").lower()
    try:
        ip = ipaddress.ip_address(cleaned.strip("[]"))
    except ValueError:
        pass
    else:
        if not ip.is_global:
            raise BlockedLandingPageURL("Landing page IP address is not public.")
        return [str(ip)]
    try:
        addresses = socket.getaddrinfo(cleaned, None, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError(f"Could not resolve landing page host: {cleaned}") from exc
    resolved: list[str] = []
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise BlockedLandingPageURL("Landing page host resolves to a private address.")
        resolved.append(str(ip))
    if not resolved:
        raise ValueError(f"Could not resolve landing page host: {cleaned}")
    return resolved


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, pinned_ip: str, *args, **kwargs) -> None:
        super().__init__(pinned_ip, *args, **kwargs)
        self._pinned_ip = pinned_ip

    def connect(self) -> None:
        self.sock = socket.create_connection((self._pinned_ip, self.port), self.timeout, self.source_address)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, server_hostname: str, pinned_ip: str, *args, **kwargs) -> None:
        super().__init__(pinned_ip, *args, context=ssl.create_default_context(), **kwargs)
        self._server_hostname = server_hostname
        self._pinned_ip = pinned_ip

    def connect(self) -> None:
        sock = socket.create_connection((self._pinned_ip, self.port), self.timeout, self.source_address)
        self.sock = self._context.wrap_socket(sock, server_hostname=self._server_hostname)


def _public_query_string(query: str) -> str:
    public_params = [(key, value) for key, value in parse_qsl(query, keep_blank_values=True) if not _is_sensitive_query_param(key)]
    return urlencode(public_params, doseq=True)


def _is_sensitive_query_param(name: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]", "", name.lower())
    return (
        normalized
        in {
            "auth",
            "apikey",
            "code",
            "jwt",
            "key",
            "session",
            "sessionid",
            "sid",
            "sig",
        }
        or "accesskey" in normalized
        or "authorization" in normalized
        or "credential" in normalized
        or "password" in normalized
        or "passwd" in normalized
        or "secret" in normalized
        or "signature" in normalized
        or "token" in normalized
    )


def _normalize(text: str) -> str:
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"Cookie Preferences|Privacy Policy|Terms of Service", " ", text, flags=re.I)
    return text.strip()


def _fallback_text(url: str) -> str:
    raw_url = (url or "").strip()
    if raw_url and not raw_url.startswith(("http://", "https://")):
        raw_url = f"https://{raw_url}"
    parsed = urlparse(raw_url)
    host = parsed.hostname or "submitted landing page"
    if parsed.port:
        host = f"{host}:{parsed.port}"
    cleaned = _normalize(f"{host} {parsed.path.replace('/', ' ')}")
    return f"Landing page submitted from {cleaned}. Add page copy for stronger analysis. Shop now."

from app.extractor import extract_landing_page_text, normalize_public_url


def test_private_landing_page_url_is_blocked_before_http(monkeypatch):
    def fail_client(*args, **kwargs):
        raise AssertionError("blocked URLs must not open a network connection")

    monkeypatch.setattr("app.extractor._request_once_pinned", fail_client)

    text, metadata = extract_landing_page_text("http://127.0.0.1:8000/admin")

    assert metadata["extraction_status"] == "blocked"
    assert "127.0.0.1:8000" in text


def test_ipv6_mapped_private_landing_page_url_is_blocked_before_http(monkeypatch):
    def fail_client(*args, **kwargs):
        raise AssertionError("blocked URLs must not open a network connection")

    monkeypatch.setattr("app.extractor._request_once_pinned", fail_client)

    text, metadata = extract_landing_page_text("http://[::ffff:172.16.0.1]/admin")

    assert metadata["extraction_status"] == "blocked"
    assert "172.16.0.1" in text


def test_landing_page_url_strips_sensitive_query_params():
    normalized = normalize_public_url(
        "example.com/offer?utm_source=paid&token=private-token&api_key=secret&x-amz-signature=signed#fragment"
    )

    assert normalized == "https://example.com/offer?utm_source=paid"


def test_landing_page_redirect_to_private_url_is_blocked(monkeypatch):
    calls = []

    def fake_request(url, headers):
        calls.append(("GET", url))
        return {"status": 302, "headers": {"location": "http://127.0.0.1/private"}, "body": b"", "encoding": "utf-8"}

    monkeypatch.setattr("app.extractor._request_once_pinned", fake_request)

    text, metadata = extract_landing_page_text("example.com")

    assert metadata["extraction_status"] == "blocked"
    assert "example.com" in text
    assert calls == [("GET", "https://example.com/")]


def test_landing_page_response_size_is_capped(monkeypatch):
    def fake_request(url, headers):
        raise ValueError("Landing page response is too large.")

    monkeypatch.setattr("app.extractor._request_once_pinned", fake_request)

    text, metadata = extract_landing_page_text("example.com")

    assert metadata["extraction_status"] == "fallback"
    assert "too large" in metadata["extraction_error"]
    assert "example.com" in text


def test_credentialed_landing_page_fallback_does_not_echo_secret(monkeypatch):
    def fail_client(*args, **kwargs):
        raise AssertionError("credentialed URLs must not open a network connection")

    monkeypatch.setattr("app.extractor._request_once_pinned", fail_client)

    text, metadata = extract_landing_page_text("https://user:secret@example.com/path?token=abc")

    assert metadata["extraction_status"] == "blocked"
    assert "credentials" in metadata["extraction_error"].lower()
    assert "user:secret" not in text
    assert "token=abc" not in text
    assert "example.com" in text


def test_landing_page_request_uses_validated_pinned_ip(monkeypatch):
    calls = []

    def fake_getaddrinfo(host, *args, **kwargs):
        assert host == "example.com"
        return [(None, None, None, None, ("93.184.216.34", 0))]

    class FakeHTTPResponse:
        status = 200

        def __init__(self):
            self._reads = [b"<html><title>Offer</title><body>Shop now.</body></html>", b""]

        def read(self, size):
            return self._reads.pop(0)

        def getheader(self, name, default=""):
            return "text/html; charset=utf-8" if name == "content-type" else default

        def getheaders(self):
            return [("content-type", "text/html; charset=utf-8")]

    class FakePinnedHTTPSConnection:
        def __init__(self, server_hostname, pinned_ip, port, timeout):
            calls.append({"server_hostname": server_hostname, "pinned_ip": pinned_ip, "port": port, "timeout": timeout})

        def request(self, method, path, headers):
            calls[-1].update({"method": method, "path": path, "host": headers["Host"]})

        def getresponse(self):
            return FakeHTTPResponse()

        def close(self):
            calls[-1]["closed"] = True

    monkeypatch.setattr("app.extractor.socket.getaddrinfo", fake_getaddrinfo)
    monkeypatch.setattr("app.extractor._PinnedHTTPSConnection", FakePinnedHTTPSConnection)

    text, metadata = extract_landing_page_text("https://example.com/offer?utm=paid")

    assert metadata["extraction_status"] == "fetched"
    assert "Shop now" in text
    assert calls == [
        {
            "server_hostname": "example.com",
            "pinned_ip": "93.184.216.34",
            "port": 443,
            "timeout": 8,
            "method": "GET",
            "path": "/offer?utm=paid",
            "host": "example.com",
            "closed": True,
        }
    ]

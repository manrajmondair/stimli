from __future__ import annotations

import re
from html.parser import HTMLParser

import httpx


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
    if not url.startswith(("http://", "https://")):
        url = f"https://{url}"
    try:
        response = httpx.get(
            url,
            timeout=8,
            follow_redirects=True,
            headers={"User-Agent": "Stimli/0.1 creative-analysis"},
        )
        response.raise_for_status()
    except Exception as exc:
        fallback = _fallback_text(url)
        return fallback, {"extraction_status": "fallback", "extraction_error": str(exc)[:180]}

    parser = VisibleTextParser()
    parser.feed(response.text)
    text = _normalize(" ".join(parser.parts))
    if not text:
        return _fallback_text(str(response.url)), {"extraction_status": "empty", "final_url": str(response.url)}
    return text[:limit], {"extraction_status": "fetched", "final_url": str(response.url)}


def _normalize(text: str) -> str:
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"Cookie Preferences|Privacy Policy|Terms of Service", " ", text, flags=re.I)
    return text.strip()


def _fallback_text(url: str) -> str:
    cleaned = url.replace("https://", "").replace("http://", "").replace("/", " ")
    return f"Landing page submitted from {cleaned}. Add page copy for stronger analysis. Shop now."

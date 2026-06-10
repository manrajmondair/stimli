from uuid import uuid4

from fastapi.testclient import TestClient

from app.main import app
from app.storage import UPLOAD_DIR


client = TestClient(app)


def test_demo_seed_and_compare():
    providers = client.get("/brain/providers")
    assert providers.status_code == 200
    assert any(item["provider"] == "fixture-brain-response" for item in providers.json())

    seeded = client.post("/demo/seed")
    assert seeded.status_code == 200
    assets = seeded.json()
    assert len(assets) >= 2

    response = client.post(
        "/comparisons",
        json={"asset_ids": [assets[0]["id"], assets[1]["id"]], "objective": "Pick the better DTC creative."},
    )
    assert response.status_code == 200
    comparison = response.json()
    assert comparison["status"] == "complete"
    assert comparison["recommendation"]["winner_asset_id"]
    assert comparison["suggestions"]

    report = client.get(f"/reports/{comparison['id']}")
    assert report.status_code == 200
    assert report.json()["title"] == "Stimli Creative Decision Report"

    markdown = client.get(f"/reports/{comparison['id']}/markdown")
    assert markdown.status_code == 200
    assert "## Recommendation" in markdown.text


def test_demo_seed_replaces_prior_demo_assets():
    first = client.post("/demo/seed")
    assert first.status_code == 200
    first_ids = {asset["id"] for asset in first.json()}

    second = client.post("/demo/seed")
    assert second.status_code == 200
    second_ids = {asset["id"] for asset in second.json()}
    assert len(second_ids) == 3
    assert first_ids.isdisjoint(second_ids)

    listed = client.get("/assets")
    assert listed.status_code == 200
    demo_assets = [asset for asset in listed.json() if asset["metadata"].get("demo") is True]
    assert {asset["id"] for asset in demo_assets} == second_ids


def test_text_asset_upload():
    response = client.post(
        "/assets",
        data={
            "asset_type": "script",
            "name": "Uploaded script",
            "text": "Stop guessing. Try the new kit today.",
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["asset"]["type"] == "script"
    assert "Stop guessing" in payload["asset"]["extracted_text"]
    assert "file_path" not in payload["asset"]


def test_json_asset_upload_matches_serverless_shape():
    response = client.post(
        "/assets",
        json={
            "asset_type": "script",
            "name": "JSON script",
            "text": "Compare variants before buying media.",
            "duration_seconds": 12,
        },
    )

    assert response.status_code == 200
    asset = response.json()["asset"]
    assert asset["type"] == "script"
    assert asset["name"] == "JSON script"
    assert asset["extracted_text"] == "Compare variants before buying media."
    assert asset["duration_seconds"] == 12
    assert "file_path" not in asset


def test_json_asset_upload_preserves_zero_duration():
    response = client.post(
        "/assets",
        json={
            "asset_type": "video",
            "name": "Zero duration JSON",
            "text": "Zero should remain explicit.",
            "duration_seconds": 0,
        },
    )

    assert response.status_code == 200
    assert response.json()["asset"]["duration_seconds"] == 0


def test_workspace_header_scopes_assets_comparisons_and_learning():
    suffix = uuid4().hex[:8]
    headers_a = {"x-stimli-workspace": f"backend_ws_a_{suffix}"}
    headers_b = {"x-stimli-workspace": f"backend_ws_b_{suffix}"}

    asset_a1 = client.post(
        "/assets",
        json={"asset_type": "script", "name": "A1", "text": "Stop weak hooks. Try the kit today."},
        headers=headers_a,
    )
    asset_a2 = client.post(
        "/assets",
        json={"asset_type": "script", "name": "A2", "text": "Compare variants before launch."},
        headers=headers_a,
    )
    asset_b = client.post(
        "/assets",
        json={"asset_type": "script", "name": "B1", "text": "A separate workspace asset."},
        headers=headers_b,
    )
    assert asset_a1.status_code == 200
    assert asset_a2.status_code == 200
    assert asset_b.status_code == 200

    listed_a = client.get("/assets", headers=headers_a)
    listed_b = client.get("/assets", headers=headers_b)
    assert {asset["id"] for asset in listed_a.json()} == {asset_a1.json()["asset"]["id"], asset_a2.json()["asset"]["id"]}
    assert {asset["id"] for asset in listed_b.json()} == {asset_b.json()["asset"]["id"]}

    cross_compare = client.post(
        "/comparisons",
        json={"asset_ids": [asset_a1.json()["asset"]["id"], asset_a2.json()["asset"]["id"]]},
        headers=headers_b,
    )
    assert cross_compare.status_code == 404

    comparison = client.post(
        "/comparisons",
        json={"asset_ids": [asset_a1.json()["asset"]["id"], asset_a2.json()["asset"]["id"]]},
        headers=headers_a,
    )
    assert comparison.status_code == 200
    comparison_id = comparison.json()["id"]

    assert client.get(f"/comparisons/{comparison_id}", headers=headers_b).status_code == 404
    assert client.get(f"/reports/{comparison_id}", headers=headers_b).status_code == 404

    winner_id = comparison.json()["recommendation"]["winner_asset_id"]
    outcome = client.post(
        f"/comparisons/{comparison_id}/outcomes",
        json={"asset_id": winner_id, "spend": 10, "impressions": 100, "clicks": 10, "conversions": 1, "revenue": 50},
        headers=headers_a,
    )
    assert outcome.status_code == 200
    assert client.get(f"/comparisons/{comparison_id}/outcomes", headers=headers_b).status_code == 404

    learning_a = client.get("/learning/summary", headers=headers_a)
    learning_b = client.get("/learning/summary", headers=headers_b)
    assert learning_a.json()["outcome_count"] == 1
    assert learning_b.json()["outcome_count"] == 0

    assert client.delete(f"/assets/{asset_a1.json()['asset']['id']}", headers=headers_b).status_code == 404


def test_upload_limits_reject_and_cleanup(monkeypatch):
    monkeypatch.setenv("STIMLI_MAX_DIRECT_UPLOAD_BYTES", "8")
    filename = "oversized-stimli-upload.txt"
    before = {path.name for path in UPLOAD_DIR.glob(f"*_{filename}")}

    response = client.post(
        "/assets",
        data={"asset_type": "script", "name": "Too large"},
        files={"file": (filename, b"123456789", "text/plain")},
    )

    assert response.status_code == 413
    after = {path.name for path in UPLOAD_DIR.glob(f"*_{filename}")}
    assert after == before


def test_script_upload_text_limit_rejects_and_cleanup(monkeypatch):
    monkeypatch.setenv("STIMLI_MAX_DIRECT_UPLOAD_BYTES", "64")
    monkeypatch.setenv("STIMLI_MAX_SCRIPT_UPLOAD_TEXT_BYTES", "4")
    filename = "oversized-stimli-script.txt"
    before = {path.name for path in UPLOAD_DIR.glob(f"*_{filename}")}

    response = client.post(
        "/assets",
        data={"asset_type": "script", "name": "Script too large"},
        files={"file": (filename, b"hello", "text/plain")},
    )

    assert response.status_code == 413
    after = {path.name for path in UPLOAD_DIR.glob(f"*_{filename}")}
    assert after == before


def test_markdown_report_escapes_pipes_in_variant_names():
    suffix = uuid4().hex[:8]
    headers = {"x-stimli-workspace": f"md_escape_{suffix}"}
    a = client.post(
        "/assets",
        data={"asset_type": "script", "name": "Variant | A", "text": "Stop weak hooks. Try the kit today."},
        headers=headers,
    )
    b = client.post(
        "/assets",
        data={"asset_type": "script", "name": "Variant B", "text": "Compare the strongest variant before spend."},
        headers=headers,
    )
    comparison = client.post(
        "/comparisons",
        json={"asset_ids": [a.json()["asset"]["id"], b.json()["asset"]["id"]], "objective": "Markdown stays well-formed."},
        headers=headers,
    )
    markdown = client.get(f"/reports/{comparison.json()['id']}/markdown", headers=headers)
    assert markdown.status_code == 200
    # The pipe in the name must be escaped so it can't split the table row.
    assert "Variant \\| A" in markdown.text
    assert "| Variant | A |" not in markdown.text


def test_non_numeric_duration_is_rejected_with_400():
    # A bad duration_seconds form field must not crash the request with a 500 —
    # it should be a clean 400, matching the serverless API.
    response = client.post(
        "/assets",
        data={"asset_type": "script", "name": "Bad duration", "text": "Try it.", "duration_seconds": "soon"},
    )
    assert response.status_code == 400
    assert "duration_seconds" in response.json()["detail"]


def test_public_payloads_never_expose_file_paths():
    asset_a = client.post(
        "/assets",
        data={"asset_type": "script", "name": "File-backed A"},
        files={"file": ("public-path-a.txt", b"Stop guessing. Try the kit today.", "text/plain")},
    )
    asset_b = client.post(
        "/assets",
        data={"asset_type": "script", "name": "File-backed B"},
        files={"file": ("public-path-b.txt", b"Compare variants before buying media.", "text/plain")},
    )
    assert asset_a.status_code == 200
    assert asset_b.status_code == 200
    assert "file_path" not in asset_a.json()["asset"]

    listed = client.get("/assets")
    assert listed.status_code == 200
    listed_asset = next(asset for asset in listed.json() if asset["id"] == asset_a.json()["asset"]["id"])
    assert "file_path" not in listed_asset

    comparison = client.post(
        "/comparisons",
        json={
            "asset_ids": [asset_a.json()["asset"]["id"], asset_b.json()["asset"]["id"]],
            "objective": "Public payload should not leak server paths.",
        },
    )
    assert comparison.status_code == 200
    assert "file_path" not in str(comparison.json())

    report = client.get(f"/reports/{comparison.json()['id']}")
    assert report.status_code == 200
    assert "file_path" not in str(report.json())


def test_delete_asset_removes_library_row_and_uploaded_file():
    filename = "delete-stimli-upload.txt"
    before = {path.name for path in UPLOAD_DIR.glob(f"*_{filename}")}
    created = client.post(
        "/assets",
        data={"asset_type": "script", "name": "Delete file-backed asset"},
        files={"file": (filename, b"Delete this uploaded creative.", "text/plain")},
    )
    assert created.status_code == 200
    asset_id = created.json()["asset"]["id"]
    matches = [path for path in UPLOAD_DIR.glob(f"*_{filename}") if path.name not in before]
    assert len(matches) == 1
    upload_path = matches[0]
    assert upload_path.exists()

    deleted = client.delete(f"/assets/{asset_id}")

    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": asset_id}
    assert not upload_path.exists()
    listed = client.get("/assets")
    assert listed.status_code == 200
    assert all(asset["id"] != asset_id for asset in listed.json())
    assert client.delete(f"/assets/{asset_id}").status_code == 404


def test_comparison_requires_two_distinct_assets():
    seeded = client.post("/demo/seed").json()
    response = client.post(
        "/comparisons",
        json={"asset_ids": [seeded[0]["id"], seeded[0]["id"]], "objective": "Duplicate asset should not compare."},
    )

    assert response.status_code == 400
    assert "two distinct" in response.json()["detail"]


def test_blank_landing_page_text_uses_url_extraction(monkeypatch):
    def fake_extract(url: str):
        return f"Fetched landing page copy from {url}. Shop today.", {"extraction_status": "fetched"}

    monkeypatch.setattr("app.main.extract_landing_page_text", fake_extract)

    response = client.post(
        "/assets",
        data={
            "asset_type": "landing_page",
            "name": "Offer page",
            "text": "   ",
            "url": "example.com/offer",
        },
    )

    assert response.status_code == 200
    asset = response.json()["asset"]
    assert asset["extracted_text"].startswith("Fetched landing page copy")
    assert asset["metadata"]["extraction_status"] == "fetched"


def test_asset_url_and_duration_validation():
    sanitized = client.post(
        "/assets",
        data={
            "asset_type": "script",
            "url": "example.com/creative?utm=paid&token=private-token&api_key=secret#fragment",
            "text": "Compare variants before launch.",
            "duration_seconds": "12",
        },
    )
    assert sanitized.status_code == 200
    assert sanitized.json()["asset"]["source_url"] == "https://example.com/creative?utm=paid"
    assert sanitized.json()["asset"]["duration_seconds"] == 12
    assert "private-token" not in str(sanitized.json())
    assert "api_key" not in str(sanitized.json())

    credentialed = client.post(
        "/assets",
        data={
            "asset_type": "script",
            "url": "https://user:secret@example.com/creative",
            "text": "Credentialed URLs should be rejected.",
        },
    )
    assert credentialed.status_code == 400
    assert "credentials" in credentialed.json()["detail"].lower()

    negative_duration = client.post(
        "/assets",
        data={
            "asset_type": "script",
            "name": "Bad duration",
            "text": "Try the starter kit today.",
            "duration_seconds": "-1",
        },
    )
    assert negative_duration.status_code == 400
    assert "non-negative" in negative_duration.json()["detail"]

    private_landing = client.post(
        "/assets",
        data={
            "asset_type": "landing_page",
            "url": "http://127.0.0.1:8000/admin",
        },
    )
    assert private_landing.status_code == 200
    assert private_landing.json()["asset"]["source_url"] is None


def test_unresolved_source_url_returns_client_error(monkeypatch):
    def fail_resolution(url: str):
        raise ValueError("Could not resolve landing page host: missing.example")

    monkeypatch.setattr("app.main.normalize_public_url", fail_resolution)
    response = client.post(
        "/assets",
        data={
            "asset_type": "script",
            "url": "missing.example",
            "text": "DNS failures should not become 500s.",
        },
    )

    assert response.status_code == 400
    assert "could not resolve" in response.json()["detail"].lower()


def test_unresolved_landing_page_uses_extraction_fallback(monkeypatch):
    def fail_resolution(url: str):
        raise ValueError("Could not resolve landing page host: missing.example")

    def fake_extract(url: str):
        return "Landing page fallback copy. Shop now.", {"extraction_status": "fallback"}

    monkeypatch.setattr("app.main.normalize_public_url", fail_resolution)
    monkeypatch.setattr("app.main.extract_landing_page_text", fake_extract)
    response = client.post(
        "/assets",
        data={
            "asset_type": "landing_page",
            "url": "missing.example",
        },
    )

    assert response.status_code == 200
    asset = response.json()["asset"]
    assert asset["source_url"] is None
    assert asset["metadata"]["extraction_status"] == "fallback"


def test_brief_history_outcome_and_learning_summary():
    seeded = client.post("/demo/seed").json()
    response = client.post(
        "/comparisons",
        json={
            "asset_ids": [seeded[0]["id"], seeded[1]["id"]],
            "objective": "Pick the creative for paid social.",
            "brief": {
                "brand_name": "Lumina",
                "audience": "busy women with dry skin",
                "product_category": "skincare hydration system",
                "primary_offer": "starter kit with free shipping",
                "required_claims": ["24 hour hydration"],
                "forbidden_terms": ["miracle cure"],
            },
        },
    )
    assert response.status_code == 200
    comparison = response.json()
    assert comparison["brief"]["brand_name"] == "Lumina"
    assert "offer_strength" in comparison["variants"][0]["analysis"]["scores"]

    history = client.get("/comparisons")
    assert history.status_code == 200
    assert any(item["id"] == comparison["id"] for item in history.json())

    winner_id = comparison["recommendation"]["winner_asset_id"]
    outcome = client.post(
        f"/comparisons/{comparison['id']}/outcomes",
        json={
            "asset_id": winner_id,
            "spend": 250,
            "impressions": 10000,
            "clicks": 300,
            "conversions": 20,
            "revenue": 1000,
            "notes": "Test launch",
        },
    )
    assert outcome.status_code == 200
    assert outcome.json()["asset_id"] == winner_id

    challenger = client.post(
        f"/comparisons/{comparison['id']}/challengers",
        json={"source_asset_id": winner_id, "focus": "hook"},
    )
    assert challenger.status_code == 200
    assert challenger.json()["asset"]["metadata"]["challenger"] is True

    learning = client.get("/learning/summary")
    assert learning.status_code == 200
    learning_payload = learning.json()
    assert learning_payload["outcome_count"] >= 1
    evaluation = next(row for row in learning_payload["calibration"]["recent"] if row["comparison_id"] == comparison["id"])
    assert evaluation["predicted_asset_id"] == winner_id
    assert evaluation["actual_best_asset_id"] == winner_id
    assert evaluation["aligned"] is True
    assert evaluation["predicted_profit"] == 750

    report = client.get(f"/reports/{comparison['id']}")
    assert report.status_code == 200
    report_calibration = report.json()["learning_summary"]["calibration"]
    assert report_calibration["evaluated_comparisons"] == 1
    assert report_calibration["aligned_predictions"] == 1


def test_outcome_metrics_must_be_non_negative():
    seeded = client.post("/demo/seed").json()
    response = client.post(
        "/comparisons",
        json={"asset_ids": [seeded[0]["id"], seeded[1]["id"]], "objective": "Validate outcome metrics."},
    )
    assert response.status_code == 200
    comparison = response.json()

    outcome = client.post(
        f"/comparisons/{comparison['id']}/outcomes",
        json={
            "asset_id": comparison["recommendation"]["winner_asset_id"],
            "spend": -1,
            "impressions": 100,
            "clicks": 10,
            "conversions": 1,
            "revenue": 20,
        },
    )

    assert outcome.status_code == 400
    assert "spend must be a non-negative number" in outcome.json()["detail"]


def test_core_workbench_routes_exist_locally():
    # The Workbench's delete / cancel / share / outcomes buttons all work against
    # the serverless API; the local backend must implement the same subset so
    # Path B (Vite + FastAPI) dev doesn't dead-end with 404/405s.
    seeded = client.post("/demo/seed").json()
    comparison = client.post(
        "/comparisons",
        json={"asset_ids": [seeded[0]["id"], seeded[1]["id"]], "objective": "Exercise core routes."},
    ).json()

    # Cancel is a no-op on a terminal comparison and returns the current state.
    cancelled = client.post(f"/comparisons/{comparison['id']}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "complete"

    # Share link mints a token that resolves to the report without auth headers.
    share = client.post(f"/reports/{comparison['id']}/share")
    assert share.status_code == 200
    link = share.json()
    assert link["path"] == f"/share/{link['token']}"
    shared = client.get(f"/share/{link['token']}")
    assert shared.status_code == 200
    assert shared.json()["comparison_id"] == comparison["id"]

    # Workspace-wide outcomes list joins comparison + asset context in.
    outcome = client.post(
        f"/comparisons/{comparison['id']}/outcomes",
        json={
            "asset_id": comparison["recommendation"]["winner_asset_id"],
            "spend": 100,
            "impressions": 1000,
            "clicks": 50,
            "conversions": 5,
            "revenue": 250,
        },
    )
    assert outcome.status_code == 200
    workspace_outcomes = client.get("/outcomes")
    assert workspace_outcomes.status_code == 200
    rows = workspace_outcomes.json()
    row = next(item for item in rows if item["comparison_id"] == comparison["id"])
    assert row["comparison_objective"] == "Exercise core routes."
    assert row["asset_name"]
    assert row["profit"] == 150.0

    # Delete cascades: comparison, its outcomes, and its share link all go.
    deleted = client.delete(f"/comparisons/{comparison['id']}")
    assert deleted.status_code == 200
    assert client.get(f"/comparisons/{comparison['id']}").status_code == 404
    assert client.get(f"/share/{link['token']}").status_code == 404
    remaining = client.get("/outcomes").json()
    assert all(item["comparison_id"] != comparison["id"] for item in remaining)

    # Deleting again is a clean 404, not a 405.
    assert client.delete(f"/comparisons/{comparison['id']}").status_code == 404

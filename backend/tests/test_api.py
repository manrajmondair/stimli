from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_demo_seed_and_compare():
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
    assert learning.json()["outcome_count"] >= 1

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


from app.models import Asset
from app.storage import Store


def test_clear_demo_assets_preserves_non_demo_assets(tmp_path):
    store = Store(tmp_path / "stimli.db")
    demo = Asset(
        id="asset_demo",
        type="script",
        name="Demo",
        extracted_text="Try the demo.",
        metadata={"demo": True},
        created_at="2026-05-06T00:00:00+00:00",
    )
    manual = Asset(
        id="asset_manual",
        type="script",
        name="Manual",
        extracted_text="Try the manual asset.",
        metadata={"demo": False},
        created_at="2026-05-06T00:00:01+00:00",
    )
    store.save_asset(demo)
    store.save_asset(manual)

    store.clear_demo_assets()

    assert store.get_asset("asset_demo") is None
    assert store.get_asset("asset_manual") == manual


def test_delete_asset_returns_deleted_asset_and_removes_row(tmp_path):
    store = Store(tmp_path / "stimli.db")
    asset = Asset(
        id="asset_delete",
        type="script",
        name="Delete me",
        extracted_text="Try the delete flow.",
        created_at="2026-05-06T00:00:00+00:00",
    )
    store.save_asset(asset)

    deleted = store.delete_asset(asset.id)

    assert deleted == asset
    assert store.get_asset(asset.id) is None
    assert store.delete_asset(asset.id) is None

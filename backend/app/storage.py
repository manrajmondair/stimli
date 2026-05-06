from __future__ import annotations

import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.models import Asset, Comparison, Outcome


BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.getenv("STIMLI_DATA_DIR", BASE_DIR / ".data"))
UPLOAD_DIR = DATA_DIR / "uploads"
DB_PATH = Path(os.getenv("STIMLI_DB_PATH", DATA_DIR / "stimli.db"))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class Store:
    def __init__(self, db_path: Path = DB_PATH):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        self._init()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS assets (
                    id TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS comparisons (
                    id TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS outcomes (
                    id TEXT PRIMARY KEY,
                    comparison_id TEXT NOT NULL,
                    asset_id TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )

    def save_asset(self, asset: Asset) -> Asset:
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO assets (id, payload, created_at) VALUES (?, ?, ?)",
                (asset.id, asset.model_dump_json(), asset.created_at),
            )
        return asset

    def list_assets(self) -> list[Asset]:
        with self._connect() as conn:
            rows = conn.execute("SELECT payload FROM assets ORDER BY created_at DESC").fetchall()
        return [Asset.model_validate_json(row["payload"]) for row in rows]

    def get_asset(self, asset_id: str) -> Asset | None:
        with self._connect() as conn:
            row = conn.execute("SELECT payload FROM assets WHERE id = ?", (asset_id,)).fetchone()
        return Asset.model_validate_json(row["payload"]) if row else None

    def save_comparison(self, comparison: Comparison) -> Comparison:
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO comparisons (id, payload, created_at) VALUES (?, ?, ?)",
                (comparison.id, comparison.model_dump_json(), comparison.created_at),
            )
        return comparison

    def get_comparison(self, comparison_id: str) -> Comparison | None:
        with self._connect() as conn:
            row = conn.execute("SELECT payload FROM comparisons WHERE id = ?", (comparison_id,)).fetchone()
        return Comparison.model_validate_json(row["payload"]) if row else None

    def list_comparisons(self) -> list[Comparison]:
        with self._connect() as conn:
            rows = conn.execute("SELECT payload FROM comparisons ORDER BY created_at DESC").fetchall()
        return [Comparison.model_validate_json(row["payload"]) for row in rows]

    def save_outcome(self, outcome: Outcome) -> Outcome:
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO outcomes (id, comparison_id, asset_id, payload, created_at) VALUES (?, ?, ?, ?, ?)",
                (outcome.id, outcome.comparison_id, outcome.asset_id, outcome.model_dump_json(), outcome.created_at),
            )
        return outcome

    def list_outcomes(self, comparison_id: str | None = None) -> list[Outcome]:
        with self._connect() as conn:
            if comparison_id:
                rows = conn.execute(
                    "SELECT payload FROM outcomes WHERE comparison_id = ? ORDER BY created_at DESC",
                    (comparison_id,),
                ).fetchall()
            else:
                rows = conn.execute("SELECT payload FROM outcomes ORDER BY created_at DESC").fetchall()
        return [Outcome.model_validate_json(row["payload"]) for row in rows]

    def clear_demo_assets(self) -> None:
        with self._connect() as conn:
            rows = conn.execute("SELECT payload FROM assets").fetchall()
            keep = []
            for row in rows:
                payload: dict[str, Any] = json.loads(row["payload"])
                if payload.get("metadata", {}).get("demo") is not True:
                    keep.append(payload["id"])
            conn.execute("DELETE FROM assets")
            for asset_id in keep:
                asset = self.get_asset(asset_id)
                if asset:
                    self.save_asset(asset)

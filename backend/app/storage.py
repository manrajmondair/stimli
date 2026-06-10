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
                    workspace_id TEXT NOT NULL DEFAULT 'public',
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS comparisons (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL DEFAULT 'public',
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS outcomes (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL DEFAULT 'public',
                    comparison_id TEXT NOT NULL,
                    asset_id TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS share_links (
                    token TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL DEFAULT 'public',
                    comparison_id TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            self._ensure_column(conn, "assets", "workspace_id", "TEXT NOT NULL DEFAULT 'public'")
            self._ensure_column(conn, "comparisons", "workspace_id", "TEXT NOT NULL DEFAULT 'public'")
            self._ensure_column(conn, "outcomes", "workspace_id", "TEXT NOT NULL DEFAULT 'public'")

    def save_asset(self, asset: Asset, workspace_id: str = "public") -> Asset:
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO assets (id, workspace_id, payload, created_at) VALUES (?, ?, ?, ?)",
                (asset.id, workspace_id, asset.model_dump_json(), asset.created_at),
            )
        return asset

    def list_assets(self, workspace_id: str = "public") -> list[Asset]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT payload FROM assets WHERE workspace_id = ? ORDER BY created_at DESC",
                (workspace_id,),
            ).fetchall()
        return [Asset.model_validate_json(row["payload"]) for row in rows]

    def get_asset(self, asset_id: str, workspace_id: str = "public") -> Asset | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM assets WHERE id = ? AND workspace_id = ?",
                (asset_id, workspace_id),
            ).fetchone()
        return Asset.model_validate_json(row["payload"]) if row else None

    def delete_asset(self, asset_id: str, workspace_id: str = "public") -> Asset | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM assets WHERE id = ? AND workspace_id = ?",
                (asset_id, workspace_id),
            ).fetchone()
            if row is None:
                return None
            conn.execute("DELETE FROM assets WHERE id = ? AND workspace_id = ?", (asset_id, workspace_id))
        return Asset.model_validate_json(row["payload"])

    def save_comparison(self, comparison: Comparison, workspace_id: str = "public") -> Comparison:
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO comparisons (id, workspace_id, payload, created_at) VALUES (?, ?, ?, ?)",
                (comparison.id, workspace_id, comparison.model_dump_json(), comparison.created_at),
            )
        return comparison

    def get_comparison(self, comparison_id: str, workspace_id: str = "public") -> Comparison | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM comparisons WHERE id = ? AND workspace_id = ?",
                (comparison_id, workspace_id),
            ).fetchone()
        return Comparison.model_validate_json(row["payload"]) if row else None

    def list_comparisons(self, workspace_id: str = "public") -> list[Comparison]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT payload FROM comparisons WHERE workspace_id = ? ORDER BY created_at DESC",
                (workspace_id,),
            ).fetchall()
        return [Comparison.model_validate_json(row["payload"]) for row in rows]

    def save_outcome(self, outcome: Outcome, workspace_id: str = "public") -> Outcome:
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO outcomes (id, workspace_id, comparison_id, asset_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (outcome.id, workspace_id, outcome.comparison_id, outcome.asset_id, outcome.model_dump_json(), outcome.created_at),
            )
        return outcome

    def delete_outcome(self, outcome_id: str, workspace_id: str = "public") -> bool:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT id FROM outcomes WHERE id = ? AND workspace_id = ?",
                (outcome_id, workspace_id),
            ).fetchone()
            if row is None:
                return False
            conn.execute("DELETE FROM outcomes WHERE id = ? AND workspace_id = ?", (outcome_id, workspace_id))
        return True

    def list_outcomes(self, comparison_id: str | None = None, workspace_id: str = "public") -> list[Outcome]:
        with self._connect() as conn:
            if comparison_id:
                rows = conn.execute(
                    "SELECT payload FROM outcomes WHERE comparison_id = ? AND workspace_id = ? ORDER BY created_at DESC",
                    (comparison_id, workspace_id),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT payload FROM outcomes WHERE workspace_id = ? ORDER BY created_at DESC",
                    (workspace_id,),
                ).fetchall()
        return [Outcome.model_validate_json(row["payload"]) for row in rows]

    def delete_comparison(self, comparison_id: str, workspace_id: str = "public") -> bool:
        # Cascade outcomes and share links with the parent so nothing dangles —
        # mirrors the serverless deleteComparison.
        with self._connect() as conn:
            row = conn.execute(
                "SELECT id FROM comparisons WHERE id = ? AND workspace_id = ?",
                (comparison_id, workspace_id),
            ).fetchone()
            if row is None:
                return False
            conn.execute("DELETE FROM comparisons WHERE id = ? AND workspace_id = ?", (comparison_id, workspace_id))
            conn.execute("DELETE FROM outcomes WHERE comparison_id = ?", (comparison_id,))
            conn.execute("DELETE FROM share_links WHERE comparison_id = ?", (comparison_id,))
        return True

    def save_share_link(self, token: str, comparison_id: str, workspace_id: str, expires_at: str) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO share_links (token, workspace_id, comparison_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
                (token, workspace_id, comparison_id, expires_at, now_iso()),
            )

    def get_share_link(self, token: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT token, workspace_id, comparison_id, expires_at FROM share_links WHERE token = ?",
                (token,),
            ).fetchone()
        return dict(row) if row else None

    def clear_demo_assets(self, workspace_id: str = "public") -> None:
        with self._connect() as conn:
            rows = conn.execute("SELECT payload FROM assets WHERE workspace_id = ?", (workspace_id,)).fetchall()
            for row in rows:
                payload: dict[str, Any] = json.loads(row["payload"])
                if payload.get("metadata", {}).get("demo") is True:
                    conn.execute("DELETE FROM assets WHERE id = ? AND workspace_id = ?", (payload["id"], workspace_id))

    @staticmethod
    def _ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
        columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in columns:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

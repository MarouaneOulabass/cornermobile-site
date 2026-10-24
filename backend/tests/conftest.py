from __future__ import annotations

import os
import tempfile
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="auditflow-test-"))
os.environ.setdefault("AUDITFLOW_ENV", "test")
os.environ.setdefault("AUDITFLOW_SECRET_KEY", "test-secret-key-not-for-production-0123456789")
os.environ["AUDITFLOW_STORAGE_DIR"] = str(_TMP / "storage")
os.environ["AUDITFLOW_JOB_BACKEND"] = "inline"
os.environ["AUDITFLOW_LLM_PROVIDER"] = "none"
os.environ.setdefault("AUDITFLOW_DEMO_PASSWORD", "demo-test")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app import db as dbmod  # noqa: E402
from app.models import Base  # noqa: E402

DEMO_PASSWORD = os.environ["AUDITFLOW_DEMO_PASSWORD"]
TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "sqlite://")


@pytest.fixture(scope="session")
def engine():
    engine = dbmod.configure(TEST_DATABASE_URL)
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


@pytest.fixture
def db(engine):
    session = dbmod.session_factory()()
    yield session
    session.close()
    # Clean slate for the next test.
    with engine.begin() as conn:
        if engine.dialect.name == "postgresql":
            names = ", ".join(f'"{t.name}"' for t in Base.metadata.sorted_tables)
            conn.execute(text(f"TRUNCATE {names} CASCADE"))
        else:
            for table in reversed(Base.metadata.sorted_tables):
                conn.execute(table.delete())


@pytest.fixture
def client(db):
    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture
def seeded(db):
    from app.seed import seed

    return seed(db, password=DEMO_PASSWORD)


def login(client: TestClient, email: str) -> dict[str, str]:
    resp = client.post("/api/auth/login", json={"email": email, "password": DEMO_PASSWORD})
    assert resp.status_code == 200, resp.text
    client.cookies.clear()
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


@pytest.fixture
def consultant(client, seeded):
    return login(client, "consultant@auditflow.demo")

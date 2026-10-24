"""RQ worker entry point: `python -m app.worker`."""

from __future__ import annotations

from redis import Redis
from rq import Queue, Worker

from app.config import get_settings
from app.security import configure_logging


def main() -> None:
    configure_logging()
    connection = Redis.from_url(get_settings().redis_url)
    Worker([Queue("auditflow", connection=connection)], connection=connection).work()


if __name__ == "__main__":
    main()

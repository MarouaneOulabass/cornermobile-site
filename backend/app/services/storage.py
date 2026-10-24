"""Object storage for original files and exports. Local filesystem or any S3-compatible service."""

from __future__ import annotations

import shutil
from functools import lru_cache
from pathlib import Path
from typing import Protocol

from app.config import get_settings


class Storage(Protocol):
    def put(self, key: str, data: bytes, content_type: str | None = None) -> None: ...
    def get(self, key: str) -> bytes: ...
    def delete_prefix(self, prefix: str) -> int: ...
    def exists(self, key: str) -> bool: ...


def _safe_key(key: str) -> str:
    parts = [p for p in key.split("/") if p not in ("", ".", "..")]
    if not parts:
        raise ValueError("empty storage key")
    return "/".join(parts)


class LocalStorage:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        return self.root / _safe_key(key)

    def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def get(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def exists(self, key: str) -> bool:
        return self._path(key).exists()

    def delete_prefix(self, prefix: str) -> int:
        path = self._path(prefix)
        if not path.exists():
            return 0
        count = sum(1 for p in path.rglob("*") if p.is_file()) if path.is_dir() else 1
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
        return count


class S3Storage:
    def __init__(self) -> None:
        import boto3

        s = get_settings()
        self.bucket = s.s3_bucket
        self.client = boto3.client(
            "s3",
            endpoint_url=s.s3_endpoint_url,
            aws_access_key_id=s.s3_access_key,
            aws_secret_access_key=s.s3_secret_key,
            region_name=s.s3_region,
        )

    def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
        extra = {"ServerSideEncryption": "AES256"}
        if content_type:
            extra["ContentType"] = content_type
        self.client.put_object(Bucket=self.bucket, Key=_safe_key(key), Body=data, **extra)

    def get(self, key: str) -> bytes:
        return self.client.get_object(Bucket=self.bucket, Key=_safe_key(key))["Body"].read()

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=_safe_key(key))
            return True
        except self.client.exceptions.ClientError:
            return False

    def delete_prefix(self, prefix: str) -> int:
        count = 0
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=_safe_key(prefix) + "/"):
            keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
            if keys:
                self.client.delete_objects(Bucket=self.bucket, Delete={"Objects": keys})
                count += len(keys)
        return count


@lru_cache
def get_storage() -> Storage:
    s = get_settings()
    if s.storage_backend == "s3":
        return S3Storage()
    return LocalStorage(s.storage_dir)


def mission_prefix(org_id, mission_id) -> str:
    return f"orgs/{org_id}/missions/{mission_id}"

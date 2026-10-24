from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import auth, missions, orgs
from app.config import get_settings
from app.security import configure_logging

UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging()
    app = FastAPI(
        title="AuditFlow API", version="0.1.0", docs_url="/api/docs", openapi_url="/api/openapi.json"
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def csrf_guard(request: Request, call_next):
        # Cookie-authenticated writes must carry a custom header, which a cross-site form cannot set.
        if (
            request.method in UNSAFE_METHODS
            and "af_session" in request.cookies
            and not request.headers.get("authorization")
            and request.headers.get("x-requested-with") != "auditflow"
        ):
            return JSONResponse({"detail": "En-tête X-Requested-With manquant"}, status_code=403)
        return await call_next(request)

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok"}

    for module in (auth, orgs, missions):
        app.include_router(module.router, prefix="/api")
    return app


app = create_app()

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import func, select

from app.api.deps import DB, SESSION_COOKIE, CurrentUser
from app.config import get_settings
from app.models import User
from app.schemas.common import LoginIn, MembershipOut, MeOut, TokenOut, UserOut
from app.security import create_access_token, verify_password
from app.services import audit_log

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenOut)
def login(body: LoginIn, response: Response, db: DB) -> TokenOut:
    user = db.scalar(select(User).where(func.lower(User.email) == body.email.lower()))
    if user is None or not user.is_active or not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Identifiants invalides")
    token = create_access_token(user.id)
    s = get_settings()
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        secure=s.cookie_secure,
        samesite="lax",
        max_age=s.access_token_minutes * 60,
        path="/",
    )
    audit_log.record(db, "auth.login", user_id=user.id, organization_id=None)
    db.commit()
    return TokenOut(access_token=token, user=UserOut.model_validate(user))


@router.post("/logout", status_code=204)
def logout(response: Response) -> Response:
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.status_code = 204
    return response


@router.get("/me", response_model=MeOut)
def me(user: CurrentUser) -> MeOut:
    return MeOut(
        user=UserOut.model_validate(user),
        memberships=[
            MembershipOut(
                organization_id=m.organization_id,
                organization_name=m.organization.name,
                role=m.role,
                department_scope=m.department_scope,
            )
            for m in user.memberships
        ],
    )

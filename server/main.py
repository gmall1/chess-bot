"""FastAPI site that gates access to the chess-bot DevTools snippet.

Users register with an invite code, log in, and get access to /dashboard where
they can copy the bot script (optionally with a baked-in ELO setting).

Routes
------
GET  /                 -> redirect to dashboard if logged in, else /login
GET  /register         -> registration page
POST /register         -> create account (requires INVITE_CODE)
GET  /login            -> login page
POST /login            -> authenticate
POST /logout           -> clear session
GET  /dashboard        -> copy-script UI (auth required)
GET  /api/script.js    -> returns chess-bot.js with ELO prefix (auth required)
GET  /healthz          -> liveness probe
"""
from __future__ import annotations

import os
import secrets
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, Form, HTTPException, Request, status
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import bcrypt
from starlette.middleware.sessions import SessionMiddleware

ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parent
DB_PATH = Path(os.environ.get("CHESS_BOT_DB", "/tmp/chess-bot.sqlite"))
BOT_SCRIPT = REPO_ROOT / "src" / "chess-bot.js"

SECRET_KEY = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
INVITE_CODE = os.environ.get("INVITE_CODE", "mittens")  # default for class demo

def _hash(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()

def _verify(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), hashed.encode())
    except ValueError:
        return False

templates = Jinja2Templates(directory=str(ROOT / "templates"))


# --------------------------------------------------------------------- db
def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as c:
        c.execute(
            """CREATE TABLE IF NOT EXISTS users (
                id       INTEGER PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                pwd_hash TEXT NOT NULL,
                created  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )"""
        )


init_db()  # run at import so the DB is ready before the first request


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


# ----------------------------------------------------------------- helpers
def current_user(request: Request) -> Optional[sqlite3.Row]:
    uid = request.session.get("user_id")
    if not uid:
        return None
    with db() as c:
        row = c.execute("SELECT id, username FROM users WHERE id = ?", (uid,)).fetchone()
    return row


def require_user(request: Request) -> sqlite3.Row:
    u = current_user(request)
    if not u:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="not logged in")
    return u


# --------------------------------------------------------------------- app
app = FastAPI(title="chess-bot gate", docs_url=None, redoc_url=None)
app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY, max_age=7 * 24 * 3600)
app.mount("/static", StaticFiles(directory=str(ROOT / "static")), name="static")


@app.get("/healthz", response_class=PlainTextResponse)
def healthz() -> str:
    return "ok"


@app.get("/", include_in_schema=False)
def index(request: Request):
    if current_user(request):
        return RedirectResponse("/dashboard", status_code=302)
    return RedirectResponse("/login", status_code=302)


# ------------------------- register
@app.get("/register", response_class=HTMLResponse)
def register_get(request: Request):
    return templates.TemplateResponse(
        request, "register.html", {"error": None, "user": current_user(request)}
    )


@app.post("/register", response_class=HTMLResponse)
def register_post(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    invite: str = Form(...),
):
    err = None
    uname = username.strip().lower()
    if not uname or len(uname) < 3:
        err = "Username must be at least 3 characters."
    elif len(password) < 6:
        err = "Password must be at least 6 characters."
    elif invite.strip() != INVITE_CODE:
        err = "Invalid invite code."
    else:
        try:
            with db() as c:
                c.execute(
                    "INSERT INTO users (username, pwd_hash) VALUES (?, ?)",
                    (uname, _hash(password)),
                )
                row = c.execute("SELECT id FROM users WHERE username = ?", (uname,)).fetchone()
                request.session["user_id"] = row["id"]
            return RedirectResponse("/dashboard", status_code=302)
        except sqlite3.IntegrityError:
            err = "Username already taken."
    return templates.TemplateResponse(
        request, "register.html", {"error": err, "user": None}
    )


# ------------------------- login / logout
@app.get("/login", response_class=HTMLResponse)
def login_get(request: Request):
    return templates.TemplateResponse(
        request, "login.html", {"error": None, "user": current_user(request)}
    )


@app.post("/login", response_class=HTMLResponse)
def login_post(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
):
    uname = username.strip().lower()
    with db() as c:
        row = c.execute(
            "SELECT id, pwd_hash FROM users WHERE username = ?", (uname,)
        ).fetchone()
    if not row or not _verify(password, row["pwd_hash"]):
        return templates.TemplateResponse(
            request, "login.html",
            {"error": "Invalid username or password.", "user": None},
        )
    request.session["user_id"] = row["id"]
    return RedirectResponse("/dashboard", status_code=302)


@app.post("/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=302)


# ------------------------- dashboard
@app.get("/dashboard", response_class=HTMLResponse)
def dashboard(request: Request, user=Depends(require_user)):
    return templates.TemplateResponse(
        request, "dashboard.html", {"user": dict(user)}
    )


# ------------------------- script delivery
@app.get("/api/script.js")
def script(request: Request, elo: int = 600, user=Depends(require_user)):
    """Return chess-bot.js with the requested ELO baked in."""
    elo = max(400, min(2400, int(elo)))
    body = BOT_SCRIPT.read_text(encoding="utf-8")
    prefix = f"/* chess-bot gate: {user['username']} — elo={elo} */\n"
    prefix += f"window.__chessBotElo = {elo};\n"
    return Response(
        content=prefix + body,
        media_type="application/javascript",
        headers={"Cache-Control": "no-store"},
    )

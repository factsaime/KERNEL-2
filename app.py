import hashlib
import json
import os
import re
import secrets
import sqlite3
from functools import wraps

from flask import Flask, g, jsonify, render_template, request, session
from werkzeug.security import check_password_hash, generate_password_hash

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE, "kernel.db")
KEY_PATH = os.path.join(BASE, ".secret_key")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body         TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, recipient_id, id);
"""

USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,20}$")


def secret_key():
    if os.path.exists(KEY_PATH):
        with open(KEY_PATH) as f:
            return f.read().strip()
    key = secrets.token_hex(32)
    with open(KEY_PATH, "w") as f:
        f.write(key)
    os.chmod(KEY_PATH, 0o600)
    return key


app = Flask(__name__)
app.config.update(
    SECRET_KEY=secret_key(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Strict",
)


def asset_version() -> str:
    """Short hash of the static assets, so a new build busts browser caches."""
    h = hashlib.sha1()
    for name in sorted(os.listdir(os.path.join(BASE, "static"))):
        path = os.path.join(BASE, "static", name)
        if os.path.isfile(path):
            h.update(name.encode())
            h.update(str(os.path.getmtime(path)).encode())
    return h.hexdigest()[:10]


ASSET_VERSION = asset_version()


@app.context_processor
def inject_asset_version():
    return {"asset_version": ASSET_VERSION}


@app.after_request
def add_cache_headers(response):
    """Static files are versioned by ?v=, so cache them hard; pages never."""
    if request.path.startswith("/static/"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    else:
        response.headers["Cache-Control"] = "no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
    return response


def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_):
    conn = g.pop("db", None)
    if conn:
        conn.close()


def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        conn.executescript(SCHEMA)
        cols = {r[1] for r in conn.execute("PRAGMA table_info(users)")}
        for col in ("about", "address"):
            if col not in cols:
                conn.execute(f"ALTER TABLE users ADD COLUMN {col} TEXT NOT NULL DEFAULT ''")
        if "theme" not in cols:
            conn.execute("ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT ''")


def api(fn):
    """Login required + CSRF guard (custom header can't be set cross-site)."""
    @wraps(fn)
    def wrapper(*a, **kw):
        if request.method != "GET" and request.headers.get("X-Requested-With") != "kernel":
            return jsonify(error="bad request"), 400
        if "uid" not in session:
            return jsonify(error="unauthorized"), 401
        return fn(*a, **kw)
    return wrapper


def public_post(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        if request.headers.get("X-Requested-With") != "kernel":
            return jsonify(error="bad request"), 400
        return fn(*a, **kw)
    return wrapper


@app.get("/")
def index():
    return render_template("index.html")


@app.post("/api/register")
@public_post
def register():
    d = request.get_json(silent=True) or {}
    name, pw = str(d.get("username", "")).strip(), str(d.get("password", ""))
    if not USERNAME_RE.match(name):
        return jsonify(error="username: 3-20 chars, a-z 0-9 _"), 400
    if len(pw) < 6:
        return jsonify(error="password: min 6 chars"), 400
    try:
        cur = db().execute(
            "INSERT INTO users (username, password_hash) VALUES (?, ?)",
            (name, generate_password_hash(pw)),
        )
        db().commit()
    except sqlite3.IntegrityError:
        return jsonify(error="username taken"), 409
    session.clear()
    session["uid"] = cur.lastrowid
    return jsonify(id=cur.lastrowid, username=name)


@app.post("/api/login")
@public_post
def login():
    d = request.get_json(silent=True) or {}
    row = db().execute(
        "SELECT * FROM users WHERE username = ?", (str(d.get("username", "")).strip(),)
    ).fetchone()
    if not row or not check_password_hash(row["password_hash"], str(d.get("password", ""))):
        return jsonify(error="wrong login or password"), 401
    session.clear()
    session["uid"] = row["id"]
    return jsonify(id=row["id"], username=row["username"])


@app.post("/api/logout")
@api
def logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/me")
@api
def me():
    row = db().execute(
        "SELECT id, username, about, address, theme, created_at FROM users WHERE id = ?",
        (session["uid"],),
    ).fetchone()
    if not row:
        session.clear()
        return jsonify(error="unauthorized"), 401
    return jsonify(dict(row))


THEME_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
THEME_GRAD_RE = re.compile(r"^(linear|radial|conic)-gradient\([^;{}<>]{1,300}\)$")
STOP_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
MAX_MY_THEMES = 60


def clean_theme(raw):
    """Validate one user-built theme coming from the client."""
    if not isinstance(raw, dict):
        return None, "bad theme"
    tid = str(raw.get("id", "")).strip().lower()
    name = str(raw.get("name", "")).strip()
    grad = str(raw.get("grad", "")).strip()
    fam = str(raw.get("fam", "Моя")).strip() or "Моя"
    angle = raw.get("angle", 135)
    stops = raw.get("stops", [])

    if not THEME_ID_RE.match(tid):
        return None, "bad theme id"
    if not name or len(name) > 40:
        return None, "theme name: 1-40 chars"
    if len(fam) > 24:
        return None, "theme family: max 24 chars"
    if not THEME_GRAD_RE.match(grad):
        return None, "bad gradient"
    if isinstance(angle, bool) or not isinstance(angle, (int, float)) or not 0 <= angle <= 360:
        return None, "bad angle"
    if not isinstance(stops, list) or not 2 <= len(stops) <= 6:
        return None, "stops: 2-6 items"
    for s in stops:
        if (
            not isinstance(s, list)
            or len(s) != 2
            or not STOP_RE.match(str(s[0]))
            or isinstance(s[1], bool)
            or not isinstance(s[1], (int, float))
            or not 0 <= s[1] <= 100
        ):
            return None, "bad stop"

    return {
        "id": tid,
        "name": name,
        "fam": fam,
        "angle": int(angle),
        "stops": [[str(c).lower(), int(p)] for c, p in stops],
        "grad": grad,
    }, None


@app.get("/api/themes")
@api
def my_themes():
    row = db().execute("SELECT theme FROM users WHERE id = ?", (session["uid"],)).fetchone()
    try:
        arr = json.loads(row["theme"]) if row and row["theme"] else []
    except (ValueError, TypeError):
        arr = []
    return jsonify(arr if isinstance(arr, list) else [])


@app.post("/api/themes")
@api
def save_themes():
    """Persist the signed-in user's custom themes (whole list, max 60)."""
    body = request.get_json(silent=True) or {}
    arr = body.get("themes")
    if not isinstance(arr, list):
        return jsonify(error="themes must be a list"), 400
    if len(arr) > MAX_MY_THEMES:
        return jsonify(error=f"too many themes (max {MAX_MY_THEMES})"), 400

    clean, seen = [], set()
    for item in arr:
        t, err = clean_theme(item)
        if err:
            return jsonify(error=err), 400
        if t["id"] in seen:
            continue
        seen.add(t["id"])
        clean.append(t)

    db().execute(
        "UPDATE users SET theme = ? WHERE id = ?",
        (json.dumps(clean, ensure_ascii=False), session["uid"]),
    )
    db().commit()
    return jsonify(ok=True, saved=len(clean))


@app.post("/api/profile")
@api
def update_profile():
    d = request.get_json(silent=True) or {}
    about, address = str(d.get("about", "")).strip(), str(d.get("address", "")).strip()
    if len(about) > 200 or len(address) > 100:
        return jsonify(error="too long"), 400
    db().execute(
        "UPDATE users SET about = ?, address = ? WHERE id = ?", (about, address, session["uid"])
    )
    db().commit()
    return jsonify(ok=True)


@app.get("/api/users")
@api
def users():
    q = request.args.get("q", "").strip().replace("%", "").replace("_", "")
    rows = db().execute(
        "SELECT id, username FROM users WHERE id != ? AND username LIKE ? ORDER BY username LIMIT 20",
        (session["uid"], f"%{q}%"),
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.get("/api/chats")
@api
def chats():
    """Chat history list: one row per peer with the latest message."""
    uid = session["uid"]
    rows = db().execute(
        """
        SELECT u.id, u.username, m.body, m.created_at, m.sender_id
        FROM messages m
        JOIN users u ON u.id = CASE WHEN m.sender_id = :uid THEN m.recipient_id ELSE m.sender_id END
        WHERE m.id IN (
            SELECT MAX(id) FROM messages
            WHERE sender_id = :uid OR recipient_id = :uid
            GROUP BY CASE WHEN sender_id = :uid THEN recipient_id ELSE sender_id END
        )
        ORDER BY m.id DESC
        """,
        {"uid": uid},
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.get("/api/messages/<int:peer>")
@api
def messages(peer):
    uid, after = session["uid"], request.args.get("after", 0, type=int)
    rows = db().execute(
        """
        SELECT id, sender_id, body, created_at FROM messages
        WHERE id > ? AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
        ORDER BY id LIMIT 500
        """,
        (after, uid, peer, peer, uid),
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/messages/<int:peer>")
@api
def send(peer):
    body = str((request.get_json(silent=True) or {}).get("body", "")).strip()
    if not body or len(body) > 4000:
        return jsonify(error="empty or too long"), 400
    if not db().execute("SELECT 1 FROM users WHERE id = ?", (peer,)).fetchone():
        return jsonify(error="no such user"), 404
    cur = db().execute(
        "INSERT INTO messages (sender_id, recipient_id, body) VALUES (?, ?, ?)",
        (session["uid"], peer, body),
    )
    db().commit()
    return jsonify(id=cur.lastrowid)


@app.post("/api/settings/password")
@api
def change_password():
    d = request.get_json(silent=True) or {}
    row = db().execute("SELECT password_hash FROM users WHERE id = ?", (session["uid"],)).fetchone()
    if not check_password_hash(row["password_hash"], str(d.get("old", ""))):
        return jsonify(error="wrong current password"), 403
    new = str(d.get("new", ""))
    if len(new) < 6:
        return jsonify(error="password: min 6 chars"), 400
    db().execute(
        "UPDATE users SET password_hash = ? WHERE id = ?",
        (generate_password_hash(new), session["uid"]),
    )
    db().commit()
    return jsonify(ok=True)


@app.post("/api/settings/clear")
@api
def clear_history():
    uid = session["uid"]
    db().execute("DELETE FROM messages WHERE sender_id = ? OR recipient_id = ?", (uid, uid))
    db().commit()
    return jsonify(ok=True)


init_db()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 5050)), debug=True)

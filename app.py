"""KERNEL — Flask messenger whose server cannot read message text.

How the secrecy works:

* Accounts on the "derived" scheme authenticate with a hash the browser derives
  from the password (PBKDF2 -> HKDF). The password itself never reaches the
  server, so the server cannot derive the user's keys.
* Every user has an ECDH P-256 key pair. The private half is stored wrapped with
  AES-GCM under a key derived from the password, so only the password holder can
  unwrap it.
* Message bodies and reaction emoji are stored as AES-GCM ciphertext under a key
  both participants derive from their ECDH shared secret.

Accounts created before this version still have `auth_scheme = 'legacy'`: they
log in with the plain password (as before) and are upgraded to the derived
scheme on that same login. Message rows written before this version keep
`legacy = 1` and hold plaintext; a participant's browser re-encrypts them in
place the first time the chat is opened.
"""

import base64
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

# scrypt parameters for stored verifiers, stated explicitly so a future change
# is a conscious decision rather than a library default.
SCRYPT_METHOD = "scrypt:32768:8:1"

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
CREATE TABLE IF NOT EXISTS reactions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji_ct   TEXT NOT NULL,
    emoji_iv   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, recipient_id, id);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);
"""

USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,20}$")
B64_RE = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")

MIN_PASSWORD = 6
MAX_PASSWORD = 200
MAX_BODY_BYTES = 4000
MAX_CT_BYTES = 12000          # AES-GCM ciphertext for a 4000-char message
IV_BYTES = 12                 # Web Crypto AES-GCM nonce
MIN_ITERATIONS = 50_000
MAX_ITERATIONS = 5_000_000


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
    # Set KERNEL_SECURE_COOKIE=1 when the app is served over HTTPS.
    SESSION_COOKIE_SECURE=os.environ.get("KERNEL_SECURE_COOKIE") == "1",
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
        # Key material and the auth scheme. Existing accounts stay on 'legacy'
        # and are upgraded by the client right after their next login.
        for col, decl in (
            ("auth_scheme", "TEXT NOT NULL DEFAULT 'legacy'"),
            ("salt", "TEXT NOT NULL DEFAULT ''"),
            ("iterations", "INTEGER NOT NULL DEFAULT 0"),
            ("pubkey", "TEXT NOT NULL DEFAULT ''"),
            ("wrapped_priv", "TEXT NOT NULL DEFAULT ''"),
            ("wrap_iv", "TEXT NOT NULL DEFAULT ''"),
        ):
            if col not in cols:
                conn.execute(f"ALTER TABLE users ADD COLUMN {col} {decl}")

        mcols = {r[1] for r in conn.execute("PRAGMA table_info(messages)")}
        if "body_ct" not in mcols:
            conn.execute("ALTER TABLE messages ADD COLUMN body_ct TEXT NOT NULL DEFAULT ''")
        if "body_iv" not in mcols:
            conn.execute("ALTER TABLE messages ADD COLUMN body_iv TEXT NOT NULL DEFAULT ''")
        if "legacy" not in mcols:
            # Everything already stored was written in the clear.
            conn.execute("ALTER TABLE messages ADD COLUMN legacy INTEGER NOT NULL DEFAULT 1")


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


# ---------------------------------------------------------------- validation

def b64_ok(value, expect=None, lo=None, hi=None):
    """True when value is base64 whose decoded length fits the given bounds."""
    s = str(value or "")
    if not s or len(s) > 4 * MAX_CT_BYTES or not B64_RE.match(s):
        return False
    try:
        raw = base64.b64decode(s, validate=True)
    except (ValueError, TypeError):
        return False
    if expect is not None and len(raw) != expect:
        return False
    if lo is not None and len(raw) < lo:
        return False
    if hi is not None and len(raw) > hi:
        return False
    return True


def envelope_ok(ct, iv):
    """A message body must look like AES-GCM output: >=17 bytes and a 12-byte IV."""
    return b64_ok(ct, lo=17, hi=MAX_CT_BYTES) and b64_ok(iv, expect=IV_BYTES)


def hash_secret(value, salt_hex):
    """Server-side verifier: scrypt over the value the client sent."""
    return generate_password_hash(f"{salt_hex}:{value}", method=SCRYPT_METHOD)


def verify_secret(stored, value, salt_hex):
    return bool(stored) and check_password_hash(stored, f"{salt_hex}:{value}")


# --------------------------------------------------------------------- pages

@app.get("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------- auth

@app.get("/api/auth/params")
def auth_params():
    """Public: what the client needs to derive its keys for a username.

    A missing username gets a random salt too, so the response does not reveal
    whether an account exists.
    """
    name = request.args.get("username", "").strip()
    row = db().execute(
        "SELECT auth_scheme, salt, iterations FROM users WHERE username = ?", (name,)
    ).fetchone()
    if not row or row["auth_scheme"] != "derived" or not row["salt"]:
        return jsonify(scheme="legacy", salt=base64.b64encode(secrets.token_bytes(16)).decode(),
                       iterations=0)
    return jsonify(scheme="derived", salt=row["salt"], iterations=row["iterations"])


@app.post("/api/register")
@public_post
def register():
    d = request.get_json(silent=True) or {}
    name = str(d.get("username", "")).strip()
    auth_hash = str(d.get("authHash", ""))
    salt, iters = str(d.get("salt", "")), d.get("iterations")
    pubkey, wrapped, wrap_iv = str(d.get("pubkey", "")), str(d.get("wrappedPriv", "")), str(d.get("wrapIv", ""))

    if not USERNAME_RE.match(name):
        return jsonify(error="username: 3-20 chars, a-z 0-9 _"), 400
    if not b64_ok(auth_hash, expect=32):
        return jsonify(error="bad auth hash"), 400
    if not b64_ok(salt, expect=16):
        return jsonify(error="bad salt"), 400
    if not isinstance(iters, int) or not MIN_ITERATIONS <= iters <= MAX_ITERATIONS:
        return jsonify(error="bad iterations"), 400
    if not b64_ok(pubkey, expect=65):          # uncompressed P-256 point
        return jsonify(error="bad public key"), 400
    if not b64_ok(wrapped, lo=48, hi=512) or not b64_ok(wrap_iv, expect=IV_BYTES):
        return jsonify(error="bad wrapped key"), 400

    try:
        cur = db().execute(
            """INSERT INTO users
               (username, password_hash, auth_scheme, salt, iterations, pubkey, wrapped_priv, wrap_iv)
               VALUES (?, ?, 'derived', ?, ?, ?, ?, ?)""",
            (name, hash_secret(auth_hash, salt), salt, iters, pubkey, wrapped, wrap_iv),
        )
        db().commit()
    except sqlite3.IntegrityError:
        return jsonify(error="username taken"), 409
    session.clear()
    session["uid"] = cur.lastrowid
    return jsonify(id=cur.lastrowid, username=name, scheme="derived")


@app.post("/api/login")
@public_post
def login():
    d = request.get_json(silent=True) or {}
    name = str(d.get("username", "")).strip()
    row = db().execute("SELECT * FROM users WHERE username = ?", (name,)).fetchone()
    if not row:
        return jsonify(error="wrong login or password"), 401

    if row["auth_scheme"] == "derived":
        auth_hash = str(d.get("authHash", ""))
        if not b64_ok(auth_hash, expect=32) or not verify_secret(row["password_hash"], auth_hash, row["salt"]):
            return jsonify(error="wrong login or password"), 401
        scheme = "derived"
    else:
        # Legacy account: plain password, then the browser upgrades the account.
        pw = str(d.get("password", ""))
        if not pw or len(pw) > MAX_PASSWORD or not check_password_hash(row["password_hash"], pw):
            return jsonify(error="wrong login or password"), 401
        scheme = "legacy"

    session.clear()
    session["uid"] = row["id"]
    has_keys = bool(row["pubkey"] and row["wrapped_priv"])
    return jsonify(id=row["id"], username=row["username"], scheme=scheme,
                   needsCryptoUpgrade=scheme == "legacy" or not has_keys)


@app.post("/api/crypto/setup")
@api
def crypto_setup():
    """Store (or rotate) the caller's key material.

    Used by legacy accounts on their first login, and again after a password
    change because the password is what wraps the private key.
    """
    d = request.get_json(silent=True) or {}
    auth_hash, salt = str(d.get("authHash", "")), str(d.get("salt", ""))
    iters = d.get("iterations")
    pubkey, wrapped, wrap_iv = str(d.get("pubkey", "")), str(d.get("wrappedPriv", "")), str(d.get("wrapIv", ""))

    if not b64_ok(auth_hash, expect=32):
        return jsonify(error="bad auth hash"), 400
    if not b64_ok(salt, expect=16):
        return jsonify(error="bad salt"), 400
    if not isinstance(iters, int) or not MIN_ITERATIONS <= iters <= MAX_ITERATIONS:
        return jsonify(error="bad iterations"), 400
    if not b64_ok(pubkey, expect=65):
        return jsonify(error="bad public key"), 400
    if not b64_ok(wrapped, lo=48, hi=512) or not b64_ok(wrap_iv, expect=IV_BYTES):
        return jsonify(error="bad wrapped key"), 400

    db().execute(
        """UPDATE users SET password_hash = ?, auth_scheme = 'derived', salt = ?,
                            iterations = ?, pubkey = ?, wrapped_priv = ?, wrap_iv = ?
           WHERE id = ?""",
        (hash_secret(auth_hash, salt), salt, iters, pubkey, wrapped, wrap_iv, session["uid"]),
    )
    db().commit()
    return jsonify(ok=True, scheme="derived")


@app.get("/api/crypto/key")
@api
def crypto_key():
    """The caller's own wrapped private key, to unwrap once per session."""
    row = db().execute(
        "SELECT salt, iterations, pubkey, wrapped_priv, wrap_iv FROM users WHERE id = ?",
        (session["uid"],),
    ).fetchone()
    return jsonify(salt=row["salt"], iterations=row["iterations"], pubkey=row["pubkey"],
                   wrappedPriv=row["wrapped_priv"], wrapIv=row["wrap_iv"])


@app.post("/api/logout")
@api
def logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/me")
@api
def me():
    row = db().execute(
        """SELECT id, username, about, address, theme, created_at, auth_scheme,
                  salt, iterations, pubkey
           FROM users WHERE id = ?""",
        (session["uid"],),
    ).fetchone()
    if not row:
        session.clear()
        return jsonify(error="unauthorized"), 401
    data = dict(row)
    data["hasKeys"] = bool(row["pubkey"])
    return jsonify(data)


# -------------------------------------------------------------------- themes

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


# ------------------------------------------------------------------- profile

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
    """Search people. Public keys come along so the client can encrypt to them."""
    q = request.args.get("q", "").strip().replace("%", "").replace("_", "")
    rows = db().execute(
        """SELECT id, username, pubkey FROM users
           WHERE id != ? AND username LIKE ? ORDER BY username LIMIT 20""",
        (session["uid"], f"%{q}%"),
    ).fetchall()
    return jsonify([dict(r) for r in rows])


# ------------------------------------------------------------------ messages

def peer_pubkey(peer_id):
    row = db().execute("SELECT pubkey FROM users WHERE id = ?", (peer_id,)).fetchone()
    return row["pubkey"] if row else ""


def message_row(row, include_body):
    """Shape one message for the client. Legacy rows carry plaintext."""
    out = {
        "id": row["id"],
        "sender_id": row["sender_id"],
        "created_at": row["created_at"],
        "ct": row["body_ct"],
        "iv": row["body_iv"],
        "legacy": bool(row["legacy"]),
    }
    if include_body and row["legacy"]:
        out["body"] = row["body"]
    return out


@app.get("/api/chats")
@api
def chats():
    """Chat history list: one row per peer with the latest message."""
    uid = session["uid"]
    rows = db().execute(
        """
        SELECT u.id, u.username, u.pubkey, m.body, m.body_ct, m.body_iv, m.legacy,
               m.created_at, m.sender_id, m.id AS mid
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
    out = []
    for r in rows:
        item = dict(r)
        item.pop("body", None)
        item["legacy"] = bool(r["legacy"])
        if r["legacy"]:
            item["body"] = r["body"]
        out.append(item)
    return jsonify(out)


@app.get("/api/messages/<int:peer>")
@api
def messages(peer):
    uid, after = session["uid"], request.args.get("after", 0, type=int)
    rows = db().execute(
        """
        SELECT id, sender_id, body, body_ct, body_iv, legacy, created_at FROM messages
        WHERE id > ? AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
        ORDER BY id LIMIT 500
        """,
        (after, uid, peer, peer, uid),
    ).fetchall()
    return jsonify({"pubkey": peer_pubkey(peer),
                    "messages": [message_row(r, True) for r in rows]})


@app.post("/api/messages/<int:peer>")
@api
def send(peer):
    """Store one encrypted message. Plaintext is refused outright."""
    d = request.get_json(silent=True) or {}
    ct, iv = str(d.get("ct", "")), str(d.get("iv", ""))
    if not envelope_ok(ct, iv):
        return jsonify(error="message must be encrypted"), 400
    if not db().execute("SELECT 1 FROM users WHERE id = ?", (peer,)).fetchone():
        return jsonify(error="no such user"), 404
    cur = db().execute(
        """INSERT INTO messages (sender_id, recipient_id, body, body_ct, body_iv, legacy)
           VALUES (?, ?, '', ?, ?, 0)""",
        (session["uid"], peer, ct, iv),
    )
    db().commit()
    return jsonify(id=cur.lastrowid)


@app.post("/api/messages/reencrypt")
@api
def reencrypt():
    """Replace legacy plaintext with client-side ciphertext, in place.

    Only rows the caller takes part in, and only while they are still legacy.
    """
    items = (request.get_json(silent=True) or {}).get("items")
    if not isinstance(items, list) or not items or len(items) > 500:
        return jsonify(error="items: 1-500"), 400
    uid, done = session["uid"], 0
    for item in items:
        if not isinstance(item, dict):
            continue
        mid, ct, iv = item.get("id"), str(item.get("ct", "")), str(item.get("iv", ""))
        if not isinstance(mid, int) or not envelope_ok(ct, iv):
            return jsonify(error="bad item"), 400
        cur = db().execute(
            """UPDATE messages SET body = '', body_ct = ?, body_iv = ?, legacy = 0
               WHERE id = ? AND legacy = 1 AND (sender_id = ? OR recipient_id = ?)""",
            (ct, iv, mid, uid, uid),
        )
        done += cur.rowcount
    db().commit()
    return jsonify(ok=True, updated=done)


# ----------------------------------------------------------------- reactions

MAX_REACTION_CT = 256


@app.get("/api/reactions")
@api
def reactions():
    """Reactions for the given messages. Emoji are ciphertext to the server."""
    raw = request.args.get("ids", "")
    ids = [int(x) for x in raw.split(",") if x.strip().isdigit()][:500]
    if not ids:
        return jsonify([])
    marks = ",".join("?" * len(ids))
    uid = session["uid"]
    rows = db().execute(
        f"""SELECT r.message_id, r.user_id, r.emoji_ct, r.emoji_iv
            FROM reactions r JOIN messages m ON m.id = r.message_id
            WHERE r.message_id IN ({marks})
              AND (m.sender_id = ? OR m.recipient_id = ?)""",
        (*ids, uid, uid),
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/messages/<int:mid>/reaction")
@api
def set_reaction(mid):
    """One reaction per person per message; an empty payload clears it."""
    uid = session["uid"]
    row = db().execute(
        "SELECT 1 FROM messages WHERE id = ? AND (sender_id = ? OR recipient_id = ?)",
        (mid, uid, uid),
    ).fetchone()
    if not row:
        return jsonify(error="no such message"), 404

    d = request.get_json(silent=True) or {}
    ct, iv = str(d.get("emoji_ct", "")), str(d.get("emoji_iv", ""))

    if d.get("remove"):
        db().execute("DELETE FROM reactions WHERE message_id = ? AND user_id = ?", (mid, uid))
        db().commit()
        return jsonify(ok=True, removed=True)

    if not b64_ok(ct, lo=17, hi=MAX_REACTION_CT) or not b64_ok(iv, expect=IV_BYTES):
        return jsonify(error="bad reaction"), 400
    db().execute(
        """INSERT INTO reactions (message_id, user_id, emoji_ct, emoji_iv) VALUES (?, ?, ?, ?)
           ON CONFLICT(message_id, user_id) DO UPDATE SET emoji_ct = excluded.emoji_ct,
                                                          emoji_iv = excluded.emoji_iv""",
        (mid, uid, ct, iv),
    )
    db().commit()
    return jsonify(ok=True)


# ------------------------------------------------------------------ settings

@app.post("/api/settings/password")
@api
def change_password():
    """Change the password.

    On a derived account the client re-wraps the private key under the new
    password, so it must send the new auth hash and key material together.
    """
    d = request.get_json(silent=True) or {}
    row = db().execute("SELECT * FROM users WHERE id = ?", (session["uid"],)).fetchone()

    if row["auth_scheme"] == "derived":
        old_hash = str(d.get("oldAuthHash", ""))
        if not b64_ok(old_hash, expect=32) or not verify_secret(row["password_hash"], old_hash, row["salt"]):
            return jsonify(error="wrong current password"), 403
        new_hash, salt = str(d.get("newAuthHash", "")), str(d.get("salt", ""))
        iters = d.get("iterations")
        wrapped, wrap_iv = str(d.get("wrappedPriv", "")), str(d.get("wrapIv", ""))
        if not b64_ok(new_hash, expect=32) or not b64_ok(salt, expect=16):
            return jsonify(error="bad auth hash"), 400
        if not isinstance(iters, int) or not MIN_ITERATIONS <= iters <= MAX_ITERATIONS:
            return jsonify(error="bad iterations"), 400
        if not b64_ok(wrapped, lo=48, hi=512) or not b64_ok(wrap_iv, expect=IV_BYTES):
            return jsonify(error="bad wrapped key"), 400
        db().execute(
            """UPDATE users SET password_hash = ?, salt = ?, iterations = ?,
                                wrapped_priv = ?, wrap_iv = ? WHERE id = ?""",
            (hash_secret(new_hash, salt), salt, iters, wrapped, wrap_iv, session["uid"]),
        )
        db().commit()
        return jsonify(ok=True, scheme="derived")

    # Legacy account that has not been upgraded yet.
    if not check_password_hash(row["password_hash"], str(d.get("old", ""))):
        return jsonify(error="wrong current password"), 403
    new = str(d.get("new", ""))
    if len(new) < MIN_PASSWORD or len(new) > MAX_PASSWORD:
        return jsonify(error=f"password: {MIN_PASSWORD}-{MAX_PASSWORD} chars"), 400
    db().execute(
        "UPDATE users SET password_hash = ? WHERE id = ?",
        (generate_password_hash(new, method=SCRYPT_METHOD), session["uid"]),
    )
    db().commit()
    return jsonify(ok=True, scheme="legacy")


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

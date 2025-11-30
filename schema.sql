DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS transactions;

CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password_hash TEXT,
    salt TEXT
);

CREATE TABLE transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    type TEXT CHECK(type IN ('credit', 'debit')),
    reason TEXT,
    amount REAL,
    created_at INTEGER,
    FOREIGN KEY(user_id) REFERENCES users(id)
);

-- Index for pagination performance
CREATE INDEX idx_user_trans ON transactions(user_id, created_at DESC);
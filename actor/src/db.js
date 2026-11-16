const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = process.env.DATABASE_PATH || path.resolve(__dirname, '../jobsearch.db');
let db = null;

function getDb() {
    if (!db) {
        db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error('[DB] Failed to open SQLite database at', dbPath, err.message);
            }
        });
        db.configure('busyTimeout', 10000);
    }
    return db;
}

function initDb() {
    return new Promise((resolve, reject) => {
        const database = getDb();
        database.serialize(() => {
            database.run("PRAGMA journal_mode = WAL;");
            database.run("PRAGMA foreign_keys = ON;", (err) => {
                if (err) return reject(err);
                resolve(database);
            });
        });
    });
}

function runQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        const database = getDb();
        database.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function getQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        const database = getDb();
        database.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function allQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        const database = getDb();
        database.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

function closeDb() {
    return new Promise((resolve) => {
        if (db) {
            db.close(() => {
                db = null;
                resolve();
            });
        } else {
            resolve();
        }
    });
}

module.exports = {
    getDb,
    initDb,
    runQuery,
    getQuery,
    allQuery,
    closeDb,
    get db() { return getDb(); }
};

CREATE TABLE IF NOT EXISTS libraries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    path TEXT,
    ip TEXT,
    enabled INTEGER DEFAULT 1,
    auto_scan INTEGER DEFAULT 1,
    auto_import INTEGER DEFAULT 1,
    generate_thumbnail INTEGER DEFAULT 1,
    calculate_hash INTEGER DEFAULT 1,
    extract_metadata INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    color TEXT DEFAULT '#ffffff'
);

CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id INTEGER,
    uuid TEXT UNIQUE NOT NULL,
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL,
    filesize INTEGER,
    duration REAL,
    width INTEGER,
    height INTEGER,
    fps REAL,
    video_codec TEXT,
    audio_codec TEXT,
    bitrate INTEGER,
    hash TEXT UNIQUE,
    thumbnail TEXT,
    status TEXT DEFAULT 'READY', /* READY, IMPORTING, MISSING, PROCESSING, ERROR */
    missing INTEGER DEFAULT 0,
    favorite INTEGER DEFAULT 0,
    rating INTEGER DEFAULT 0,
    notes TEXT,
    project_id INTEGER,
    origin TEXT,
    album TEXT,
    last_opened DATETIME,
    last_scan DATETIME DEFAULT CURRENT_TIMESTAMP,
    imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    recorded_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(library_id) REFERENCES libraries(id),
    FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS media_tags (
    media_id INTEGER,
    tag_id INTEGER,
    PRIMARY KEY(media_id, tag_id),
    FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE CASCADE,
    FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

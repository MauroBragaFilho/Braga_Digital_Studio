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
    status TEXT DEFAULT 'Ativo',
    color TEXT DEFAULT '#3b82f6',
    client TEXT,
    type TEXT,
    start_date DATETIME,
    deadline DATETIME,
    cover_path TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_bins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    parent_id INTEGER,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(parent_id) REFERENCES project_bins(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    bin_id INTEGER,
    media_id INTEGER,
    custom_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(bin_id) REFERENCES project_bins(id) ON DELETE CASCADE,
    FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE CASCADE
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

CREATE TABLE IF NOT EXISTS sync_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    hash TEXT,
    project_id INTEGER,
    media_id INTEGER,
    imported_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS download_queue (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    title TEXT,
    thumbnail TEXT,
    channel TEXT,
    platform TEXT,
    duration REAL,
    format TEXT,
    quality TEXT,
    status TEXT DEFAULT 'queued',
    progress REAL DEFAULT 0,
    downloaded_bytes INTEGER DEFAULT 0,
    total_bytes INTEGER DEFAULT 0,
    speed TEXT,
    eta TEXT,
    output_path TEXT,
    error TEXT,
    position INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    completed_at DATETIME
);


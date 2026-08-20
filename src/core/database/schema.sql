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

CREATE TABLE IF NOT EXISTS project_sequences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT 'Sequência Principal',
    timebase REAL DEFAULT 29.97,
    sample_rate INTEGER DEFAULT 48000,
    width INTEGER DEFAULT 1920,
    height INTEGER DEFAULT 1080,
    duration REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS timeline_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sequence_id INTEGER NOT NULL,
    track_type TEXT NOT NULL, /* 'video' ou 'audio' */
    track_index INTEGER NOT NULL, /* 1, 2, 3... */
    name TEXT,
    muted INTEGER DEFAULT 0,
    locked INTEGER DEFAULT 0,
    solo INTEGER DEFAULT 0,
    FOREIGN KEY(sequence_id) REFERENCES project_sequences(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS timeline_clips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id INTEGER NOT NULL,
    project_media_id INTEGER,
    media_id INTEGER,
    name TEXT,
    start_time REAL NOT NULL DEFAULT 0.0,
    end_time REAL NOT NULL DEFAULT 0.0,
    in_point REAL DEFAULT 0.0,
    out_point REAL DEFAULT 0.0,
    color TEXT,
    FOREIGN KEY(track_id) REFERENCES timeline_tracks(id) ON DELETE CASCADE,
    FOREIGN KEY(project_media_id) REFERENCES project_media(id) ON DELETE SET NULL,
    FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS project_markers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    sequence_id INTEGER,
    clip_id INTEGER,
    time REAL NOT NULL DEFAULT 0.0,
    type TEXT DEFAULT 'highlight', /* highlight, cut, important, note, music */
    color TEXT DEFAULT '#f59e0b',
    label TEXT,
    comment TEXT,
    target TEXT DEFAULT 'timeline', /* 'timeline' ou 'clip' */
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(sequence_id) REFERENCES project_sequences(id) ON DELETE CASCADE,
    FOREIGN KEY(clip_id) REFERENCES timeline_clips(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    master_media_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_group_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sync_group_id INTEGER NOT NULL,
    media_id INTEGER NOT NULL,
    offset_seconds REAL DEFAULT 0.0,
    FOREIGN KEY(sync_group_id) REFERENCES sync_groups(id) ON DELETE CASCADE,
    FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE CASCADE
);



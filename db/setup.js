import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Ruta a la BD: usar /data/database.db al mismo nivel que server.js ---
const DB_PATH = path.join(__dirname, '..', 'data', 'database.db');

// --- Rutas de semillas opcionales ---
const SEED_JSON_PATH = path.join(__dirname, 'data', 'seed.json'); // opcional (db/data/seed.json)
// OJO: ahora apuntamos a /public/images (carpeta real de imágenes públicas)
const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images');

const VALID_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);

async function ensureSchema(db) {
    await db.exec(`
    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL UNIQUE,
      url   TEXT NOT NULL
    );
  `);
}

async function upsertImage(db, title, url) {
    await db.run(
        `INSERT INTO images (title, url)
     VALUES (?, ?)
     ON CONFLICT(title) DO UPDATE SET url=excluded.url`,
        [title, url]
    );
}

async function seedFromJson(db) {
    try {
        const raw = await fs.readFile(SEED_JSON_PATH, 'utf8');
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return 0;

        let count = 0;
        for (const item of arr) {
            const title = String(item?.title ?? '').trim();
            const url = String(item?.url ?? '').trim();
            if (!title || !url) continue;

            await upsertImage(db, title, url);
            count++;
        }
        return count;
    } catch {
        return 0;
    }
}

async function seedFromFolder(db) {
    try {
        const files = await fs.readdir(IMAGES_DIR, { withFileTypes: true });
        let count = 0;

        for (const f of files) {
            if (!f.isFile()) continue;
            const ext = path.extname(f.name).toLowerCase();
            if (!VALID_EXT.has(ext)) continue;

            const base = path.basename(f.name, ext);
            const title = base.replace(/[_-]+/g, ' ').trim();
            // Ruta pública esperada por el front: /images/<archivo>
            const url = `/images/${encodeURIComponent(f.name)}`;

            await upsertImage(db, title, url);
            count++;
        }
        return count;
    } catch {
        return 0;
    }
}

async function main() {
    // Asegura carpeta /data
    const dataDir = path.join(__dirname, '..', 'data');
    await fs.mkdir(dataDir, { recursive: true });

    const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    await ensureSchema(db);

    let inserted = 0;
    inserted = await seedFromJson(db);

    if (inserted === 0) {
        inserted = await seedFromFolder(db);
    }

    const row = await db.get('SELECT COUNT(*) AS c FROM images');
    console.log(`[setup] DB: ${DB_PATH}`);
    console.log(`[setup] Semillas insertadas/actualizadas: ${inserted}`);
    console.log(`[setup] Total de filas en images: ${row.c}`);

    await db.close();
}

main().catch(err => {
    console.error('[setup] Error:', err);
    process.exit(1);
});
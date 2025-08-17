import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fs from 'fs';
import path from 'path';

const dbFile = path.join('.', 'db.sqlite');

async function setup() {
    const db = await open({
        filename: dbFile,
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL,
            imagen TEXT NOT NULL,
            precio REAL DEFAULT 0
        )
    `);

    // DEFAULT VALUES IN CASE OF EMPTY
    const count = await db.get('SELECT COUNT(*) as c FROM products');
    if (count.c === 0) {
        const imagesDir = path.join('.', 'public', 'images');
        const files = fs.readdirSync(imagesDir).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));
        for (const file of files) {
            const nombre = path.parse(file).name;
            await db.run('INSERT INTO products (nombre, imagen, precio) VALUES (?, ?, ?)', [nombre, file, Math.floor(Math.random()*100)+10]);
        }
        console.log('Datos iniciales agregados a la base de datos.');
    }

    await db.close();
    console.log('Setup completado.');
}

setup();

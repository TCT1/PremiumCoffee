import 'dotenv/config';
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import { google } from "googleapis";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ------ SERVE STATIC: DESACTIVA SERVIR index.html DESDE static ------
const publicPath = path.join(__dirname, "public");
app.use(
    express.static(publicPath, {
        index: false,
        etag: false,
        lastModified: false,
    })
);

// Crea HTTP server + Socket.IO
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: "*" } });

// DIAGNÓSTICO ENV
// console.log("[cwd]", process.cwd());
// console.log("[env] SHEET_ID:", process.env.SHEET_ID);
// console.log("[env] SHEET_RANGE:", process.env.SHEET_RANGE);
// console.log("[env] KEY(base64) length:", (process.env.GOOGLE_SA_KEY_BASE64 || "").length);

// === Google Sheets ENV ===
const SHEET_ID = process.env.SHEET_ID;
const SHEET_RANGE = process.env.SHEET_RANGE || "Products!A2:D";
const GOOGLE_SA_KEY_BASE64 = process.env.GOOGLE_SA_KEY_BASE64;
const PRODUCTS_CACHE_TTL_MS = Number(process.env.PRODUCTS_CACHE_TTL_MS || 60000);

// ---------- AUTH ROBUSTO: GoogleAuth + credentials ----------
async function getSheetsClient() {
    if (!GOOGLE_SA_KEY_BASE64) throw new Error("Missing GOOGLE_SA_KEY_BASE64");

    const raw = Buffer.from(GOOGLE_SA_KEY_BASE64, "base64").toString("utf8");
    const json = JSON.parse(raw);

    // Normaliza la private_key (\n escapados -> saltos reales)
    const private_key = (json.private_key || "").replace(/\\n/g, "\n");
    const client_email = json.client_email;

    // console.log("[env] SA client_email:", client_email);
    // console.log("[env] SA key length:", private_key.length);
    if (!private_key) throw new Error("Service Account private_key is empty");

    // Crea un GoogleAuth con credenciales explícitas (sin archivos externos)
    const auth = new google.auth.GoogleAuth({
        credentials: { client_email, private_key },
        scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });

    // Obtiene un cliente autenticado y construye la API de Sheets
    const authClient = await auth.getClient();
    return google.sheets({ version: "v4", auth: authClient });
}

// Caché en memoria
let productsCache = { data: null, ts: 0 };

// Lee la hoja de cálculo
async function fetchProductsFromSheet() {
    if (!SHEET_ID) throw new Error("Missing SHEET_ID");

    const sheets = await getSheetsClient();

    const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: SHEET_RANGE,
        valueRenderOption: "UNFORMATTED_VALUE"
    });

    const rows = resp.data.values || [];

    // Helper: asegura string siempre
    const toStr = (v) => {
        if (v === null || v === undefined) return "";
        return (typeof v === "string") ? v : String(v);
    };

    const products = rows
        .map(r => {
            const [imageRaw, nameRaw, priceRaw, descRaw] = r;

            // Imagen y nombre como texto seguro
            const image = toStr(imageRaw).trim();
            const name = toStr(nameRaw).trim();

            // Precio robusto: respeta números de Sheets y strings tipo "$5.50" o "5,50"
            let price = 0;
            if (typeof priceRaw === "number") {
                price = priceRaw;
            } else if (typeof priceRaw === "string") {
                const cleaned = priceRaw.trim().replace(/[^\d.,\-]/g, "").replace(",", ".");
                price = parseFloat(cleaned) || 0;
            } else if (priceRaw != null) {
                const cleaned = String(priceRaw).trim().replace(/[^\d.,\-]/g, "").replace(",", ".");
                price = parseFloat(cleaned) || 0;
            }

            // Descripción como texto seguro
            const description = toStr(descRaw).trim();

            return { image, name, price, description };
        })
        // Opcional: descarta filas totalmente vacías
        .filter(p => p.name || p.image || p.description);

    return products;
}

// Getter con caché
async function getProducts() {
    const now = Date.now();
    if (productsCache.data && now - productsCache.ts < PRODUCTS_CACHE_TTL_MS) {
        return productsCache.data;
    }
    try {
        const data = await fetchProductsFromSheet();
        productsCache = { data, ts: now };
        return data;
    } catch (err) {
        console.error("[products] sheet fetch failed:", err);
        return productsCache.data || [];
    }
}

// ------ SIRVE index.html SIEMPRE CON NO-STORE ------
app.get("/", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(publicPath, "index.html"));
});

// MIDDLEWARE JSON
app.use(express.json());

// DB (OPCIONAL: puedes eliminar todo esto si ya no usas SQLite)
let db;
async function initDB() {
    const dataDir = path.join(__dirname, "data");
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    db = await open({
        filename: path.join(dataDir, "database.db"),
        driver: sqlite3.Database
    });

    await db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      image TEXT
    )
  `);
}

// API: lista imágenes SIN caché (siempre JSON)
app.get("/images", async (req, res) => {
    const imagesFolder = path.join(publicPath, "images");
    console.log("[/images] reading folder:", imagesFolder);

    try {
        if (!fs.existsSync(imagesFolder)) {
            console.warn("[/images] folder does NOT exist");
            res.set("Cache-Control", "no-store");
            return res.json([]);
        }

        const files = await fs.promises.readdir(imagesFolder, { withFileTypes: true });
        const images = files
            .filter(f => f.isFile())
            .map(f => f.name)
            .filter(name => /\.(jpg|jpeg|png|gif|webp|avif)$/i.test(name));

        res.set("Cache-Control", "no-store");
        return res.json(images);
    } catch (err) {
        console.error("[/images] error:", err);
        res.set("Cache-Control", "no-store");
        return res.json([]);
    }
});

// API: productos desde Google Sheets
app.get("/products", async (req, res) => {
    try {
        const products = await getProducts();
        res.set("Cache-Control", "no-store");
        res.json(products);
        console.log(`[/products] returned ${products.length} items`);
    } catch {
        res.set("Cache-Control", "no-store");
        res.json([]);
    }
});

// === PROXY DE IMÁGENES DE GOOGLE DRIVE ===
// Uso: GET /img/:id  -> sirve https://drive.google.com/uc?export=view&id=:id
app.get("/img/:id", async (req, res) => {
    try {
        const id = String(req.params.id || "").trim();
        // ID de Drive suele ser letras, números, guiones y guiones bajos
        if (!/^[\w-]{10,}$/.test(id)) {
            return res.status(400).send("bad id");
        }
        const url = `https://drive.google.com/uc?export=view&id=${id}`;

        const r = await fetch(url, { redirect: "follow" });
        if (!r.ok) {
            console.error("[img] fetch failed:", r.status, url);
            return res.status(502).send("upstream error");
        }

        // Propaga content-type si viene; si no, default
        const ct = r.headers.get("content-type") || "image/jpeg";
        res.setHeader("Content-Type", ct);
        // Cachea 1 día en clientes/CDN (ajusta a tu gusto)
        res.setHeader("Cache-Control", "public, max-age=86400");

        // Responde el binario (simple y robusto)
        const buf = Buffer.from(await r.arrayBuffer());
        res.end(buf);
    } catch (e) {
        console.error("[img] error:", e);
        res.status(500).send("proxy error");
    }
});


// DEBUG opcional: inspeccionar pestañas y muestra de filas
app.get("/products/debug", async (req, res) => {
    try {
        const sheets = await getSheetsClient();

        const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
        const availableSheets = (meta.data.sheets || []).map(s => s.properties.title);

        const values = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: SHEET_RANGE,
            valueRenderOption: "UNFORMATTED_VALUE"
        });

        res.set("Cache-Control", "no-store");
        res.json({
            ok: true,
            sheetId: SHEET_ID,
            range: SHEET_RANGE,
            availableSheets,
            rows: values.data.values?.length || 0,
            sample: values.data.values?.slice(0, 3) || []
        });
    } catch (e) {
        res.set("Cache-Control", "no-store");
        res.status(500).json({
            ok: false,
            message: e.message,
            code: e.code,
            errors: e.errors
        });
    }
});

// Socket.IO
io.on("connection", (socket) => {
    console.log("[io] client connected:", socket.id);
    socket.on("disconnect", (reason) => {
        console.log("[io] client disconnected:", reason);
    });
});

// Notificar cambios
function notifyClients() {
    io.emit("update");
}

// Watch de la carpeta de imágenes (solo afecta a /images)
const imagesFolder = path.join(publicPath, "images");
if (fs.existsSync(imagesFolder)) {
    fs.watch(imagesFolder, { persistent: true }, (eventType, filename) => {
        if (filename) {
            console.log(`[watch] ${eventType}: ${filename}`);
            notifyClients();
        }
    });
} else {
    console.warn("WARNING: public/images no existe");
}

// Arranque del server (si no usas SQLite, puedes eliminar initDB() y llamar server.listen(...) directo)
initDB()
    .then(() => {
        server.listen(PORT, () => {
            console.log(`SERVER RUNNING ON http://localhost:${PORT}`);
        });
    })
    .catch(err => {
        console.error("FAILED TO INITIALIZE DATABASE:", err);
    });

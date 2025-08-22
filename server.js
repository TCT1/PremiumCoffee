import 'dotenv/config';
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
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

    // Normalizar private key
    const private_key = (json.private_key || "").replace(/\\n/g, "\n");
    const client_email = json.client_email;

    if (!private_key) throw new Error("Service Account private_key is empty");

    // Crea un GoogleAuth con credenciales explícitas
    const auth = new google.auth.GoogleAuth({
        credentials: { client_email, private_key },
        scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });

    // Obtener cliente autenticado y construye la API de Sheets
    const authClient = await auth.getClient();
    return google.sheets({ version: "v4", auth: authClient });
}

let productsCache = { data: null, ts: 0 };

// Lectura de hoja de cálculo
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

            const image = toStr(imageRaw).trim();
            const name = toStr(nameRaw).trim();

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

app.get("/", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(publicPath, "index.html"));
});

// MIDDLEWARE JSON
app.use(express.json());

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
app.get("/img/:id", async (req, res) => {
    try {
        const id = String(req.params.id || "").trim();

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

        res.setHeader("Cache-Control", "public, max-age=86400");

        const buf = Buffer.from(await r.arrayBuffer());
        res.end(buf);
    } catch (e) {
        console.error("[img] error:", e);
        res.status(500).send("proxy error");
    }
});

// Socket.IO
io.on("connection", (socket) => {
    console.log("[io] client connected:", socket.id);
    socket.on("disconnect", (reason) => {
        console.log("[io] client disconnected:", reason);
    });
});

server.listen(PORT, () => {
    console.log(`SERVER RUNNING ON http://localhost:${PORT}`);
});


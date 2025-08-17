// IMPORT MODULES
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import http from "http";
import { Server as WebSocketServer } from "socket.io";

// SETUP __FILENAME AND __DIRNAME
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CREATE EXPRESS APP
const app = express();
const PORT = process.env.PORT || 3000;

// MIDDLEWARE TO PARSE JSON
app.use(express.json());

// SERVE STATIC FILES
app.use(express.static(path.join(__dirname, "public")));

// CREATE HTTP SERVER
const server = http.createServer(app);

// CREATE WEBSOCKET SERVER
const io = new WebSocketServer(server);

// DATABASE VARIABLE
let db;

// INITIALIZE SQLITE DATABASE
async function initDB() {
    db = await open({
        filename: path.join(__dirname, "database.db"), // PERSISTENT DB FILE
        driver: sqlite3.Database
    });

    // CREATE TABLE IF NOT EXISTS
    await db.exec(`
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            image TEXT
        )
    `);
}

// MAIN ROUTE
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public/index.html"));
});

// GET IMAGES FROM FOLDER
app.get("/images", (req, res) => {
    const imagesFolder = path.join(__dirname, "public/images");
    fs.readdir(imagesFolder, (err, files) => {
        if (err) return res.status(500).json({ error: "FAILED TO READ IMAGES" });
        const images = files.filter(f => /\.(jpg|jpeg|png|gif)$/i.test(f));
        res.json(images);
    });
});

// WEBSOCKET CONNECTION
io.on("connection", (socket) => {
    console.log("CLIENT CONNECTED TO WEBSOCKET");

    socket.on("disconnect", () => {
        console.log("CLIENT DISCONNECTED");
    });
});

// NOTIFY CLIENTS ABOUT FILE CHANGES
function notifyClients() {
    io.emit("update");
}

// WATCH IMAGES FOLDER FOR CHANGES
const imagesFolder = path.join(__dirname, "public/images");
fs.watch(imagesFolder, { persistent: true }, (eventType, filename) => {
    if (filename) {
        console.log(`CHANGE DETECTED: ${filename}`);
        notifyClients();
    }
});

// START SERVER AFTER DB INIT
initDB()
    .then(() => {
        server.listen(PORT, () => {
            console.log(`SERVER RUNNING ON http://localhost:${PORT}`);
        });
    })
    .catch(err => {
        console.error("FAILED TO INITIALIZE DATABASE:", err);
    });

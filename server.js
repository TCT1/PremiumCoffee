import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import WebSocket, { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, "public")));

//MAIN ROUTE
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public/index.html"));
});

//GET IMAGES
app.get("/images", (req, res) => {
    const imagesFolder = path.join(__dirname, "public/images");
    fs.readdir(imagesFolder, (err, files) => {
        if (err) return res.status(500).json({ error: "No se pudieron leer las imágenes" });
        // Filtramos solo jpg, png, etc.
        const images = files.filter(f => /\.(jpg|jpeg|png|gif)$/i.test(f));
        res.json(images);
    });
});

const server = app.listen(PORT, () => {
    console.log(`Servidor escuchando en http://localhost:${PORT}`);
});

const wss = new WebSocketServer({ server });

wss.on("connection", ws => {
    console.log("Cliente conectado a WebSocket");
});

//NOTIFY CLIENTS ABOUT AN UPDATE
function notifyClients() {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send("update");
        }
    });
}

//LOOK FOR CHANGES
const imagesFolder = path.join(__dirname, "public/images");
fs.watch(imagesFolder, { persistent: true }, (eventType, filename) => {
    if (filename) {
        console.log(`Cambio detectado: ${filename}`);
        notifyClients();
    }
});

const { Client, LocalAuth } = require("whatsapp-web.js");
const express = require("express");
const qrcode = require("qrcode");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(cors());
app.use(bodyParser.json());

const sessions = new Map(); // sessionId => { client, qr, ready }

function createWhatsAppClient(sessionId) {
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: sessionId }),
        puppeteer: { headless: true },
    });

    sessions.set(sessionId, { client, qr: null, ready: false });

    client.on("qr", async (qr) => {
        const qrData = await qrcode.toDataURL(qr);
        sessions.get(sessionId).qr = qrData;
        sessions.get(sessionId).ready = false;
        io.to(sessionId).emit("qr", qrData);
        console.log(`🔄 QR untuk session ${sessionId}`);
    });

    client.on("ready", () => {
        sessions.get(sessionId).ready = true;
        sessions.get(sessionId).qr = null;
        io.to(sessionId).emit("ready");
        console.log(`✅ Session ${sessionId} siap`);
    });

    client.on("disconnected", () => {
        sessions.get(sessionId).ready = false;
        io.to(sessionId).emit("disconnected");
        console.log(`❌ Session ${sessionId} disconnected`);
    });

    client.initialize();
}

// Create session baru
app.post("/create-session", (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId wajib" });

    if (sessions.has(sessionId)) {
        return res.status(200).json({ message: "Session sudah ada" });
    }

    createWhatsAppClient(sessionId);
    res.json({ success: true, sessionId });
});

// Ambil QR untuk session
app.get("/qr/:sessionId", (req, res) => {
    const sess = sessions.get(req.params.sessionId);
    if (!sess)
        return res.status(404).json({ error: "Session tidak ditemukan" });
    if (!sess.qr) return res.status(404).json({ error: "QR belum tersedia" });
    res.json({ qr: sess.qr });
});

// Cek status login
app.get("/status/:sessionId", (req, res) => {
    const sess = sessions.get(req.params.sessionId);
    if (!sess)
        return res.status(404).json({ error: "Session tidak ditemukan" });
    res.json({ ready: sess.ready });
});

// Kirim pesan
app.post("/send-message/:sessionId", async (req, res) => {
    const { phone, message } = req.body;
    const sess = sessions.get(req.params.sessionId);
    if (!sess || !sess.ready)
        return res.status(403).json({ error: "Session tidak siap" });

    try {
        const chatId = phone + "@c.us";
        const response = await sess.client.sendMessage(chatId, message);
        res.json({ success: true, response });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Gagal kirim pesan" });
    }
});

// Logout session
app.get("/logout/:sessionId", async (req, res) => {
    const { sessionId } = req.params;
    const sess = sessions.get(sessionId);
    if (!sess)
        return res.status(404).json({ error: "Session tidak ditemukan" });

    try {
        await sess.client.logout();
        const authDir = path.join(
            __dirname,
            "session",
            `whatsapp-${sessionId}`
        );
        fs.rmSync(authDir, { recursive: true, force: true });
        sessions.delete(sessionId);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Gagal logout" });
    }
});

io.on("connection", (socket) => {
    console.log("🟢 Socket client terhubung");

    socket.on("join-session", (sessionId) => {
        socket.join(sessionId);
        console.log(`👤 Socket join ke session: ${sessionId}`);
    });

    socket.on("disconnect", () => {
        console.log("🔌 Socket disconnect");
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🟢 Server jalan di http://localhost:${PORT}`);
});

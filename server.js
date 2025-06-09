require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const express = require("express");
const qrcode = require("qrcode");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const BACK_END = process.env.BACK_END || "http://localhost:8005";

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(cors());
app.use(bodyParser.json());
app.use(morgan("combined"));

const qrLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 5,
    message: "Terlalu banyak request QR. Coba lagi nanti.",
});

const sessions = new Map(); // sessionId => { client, qr, ready }

async function updateLaravelSession(sessionId, status) {
    try {
        await axios.put(`${BACK_END}/api/sessions/${sessionId}/status`, {
            status,
        });
        console.log(`🔄 Laravel: Status session ${sessionId} => ${status}`);
    } catch (err) {
        console.error(
            `❌ Gagal update Laravel untuk session ${sessionId}:`,
            err.message
        );
    }
}

function createWhatsAppClient(sessionId) {
    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: sessionId,
            dataPath: path.join(__dirname, "session"),
        }),
        puppeteer: { headless: true },
    });

    sessions.set(sessionId, { client, qr: null, ready: false });

    client.on("qr", async (qr) => {
        const qrData = await qrcode.toDataURL(qr);
        sessions.get(sessionId).qr = qrData;
        sessions.get(sessionId).ready = false;
        io.to(sessionId).emit(`qr-${sessionId}`, qrData);
        console.log(`📤 QR dikirim ke qr-${sessionId}`);
        updateLaravelSession(sessionId, "pending");
    });

    client.on("ready", () => {
        sessions.get(sessionId).ready = true;
        sessions.get(sessionId).qr = null;
        io.to(sessionId).emit(`ready-${sessionId}`);
        console.log(`✅ Session ${sessionId} siap`);
        updateLaravelSession(sessionId, "connected");
    });

    client.on("auth_failure", () => {
        console.log(`🚫 Auth gagal untuk session ${sessionId}`);
        io.to(sessionId).emit("auth_failure");
        updateLaravelSession(sessionId, "auth_failed");
    });

    client.on("change_state", (state) => {
        console.log(`ℹ️ Session ${sessionId} state: ${state}`);
    });

    client.on("disconnected", () => {
        sessions.get(sessionId).ready = false;
        io.to(sessionId).emit(`disconnected-${sessionId}`);
        console.log(`❌ Session ${sessionId} disconnected`);
        updateLaravelSession(sessionId, "disconnected");
    });

    client.initialize();
}

app.post("/create-session", (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId wajib" });

    if (sessions.has(sessionId)) {
        return res.status(200).json({ message: "Session sudah ada" });
    }

    createWhatsAppClient(sessionId);
    res.json({ success: true, sessionId });
});

app.get("/qr/:sessionId", qrLimiter, (req, res) => {
    const sess = sessions.get(req.params.sessionId);
    if (!sess)
        return res.status(404).json({ error: "Session tidak ditemukan" });
    if (!sess.qr) return res.status(404).json({ error: "QR belum tersedia" });
    res.json({ qr: sess.qr });
});

app.get("/status/:sessionId", (req, res) => {
    const sess = sessions.get(req.params.sessionId);
    if (!sess)
        return res.status(404).json({ error: "Session tidak ditemukan" });
    res.json({ ready: sess.ready });
});

app.post("/send-message/:sessionId", async (req, res) => {
    const { phone, message } = req.body;
    const sess = sessions.get(req.params.sessionId);
    if (!sess || !sess.ready)
        return res.status(403).json({ error: "Session tidak siap" });
    if (!phone || !/^[0-9]+$/.test(phone))
        return res.status(400).json({ error: "Nomor tidak valid" });

    try {
        const chatId = phone + "@c.us";
        const response = await sess.client.sendMessage(chatId, message);
        res.json({ success: true, response });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Gagal kirim pesan" });
    }
});

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
        updateLaravelSession(sessionId, "disconnected");
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Gagal logout" });
    }
});

async function restoreSessionsFromLaravel() {
    try {
        const response = await axios.get(`${BACK_END}/api/sessions`);
        const sessionList = response.data;
        for (const s of sessionList) {
            if (s.status !== "disconnected") {
                createWhatsAppClient(s.session_id);
            }
        }
    } catch (e) {
        console.error("❌ Gagal restore session:", e.message);
    }
}

restoreSessionsFromLaravel();

io.on("connection", (socket) => {
    console.log("🟢 Socket client terhubung");

    socket.on("init-session", (sessionId) => {
        socket.join(sessionId);
        console.log(`👤 Socket join ke session: ${sessionId}`);

        if (!sessions.has(sessionId)) {
            createWhatsAppClient(sessionId);
        }
    });

    socket.on("disconnect", () => {
        console.log("🔌 Socket disconnect");
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🟢 Server jalan di http://localhost:${PORT}`);
});

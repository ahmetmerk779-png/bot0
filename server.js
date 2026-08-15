require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const pvp = require('mineflayer-pvp').plugin;
const { mineflayer: prismarineViewer } = require('prismarine-viewer');
const { SocksClient } = require('socks');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- AI AYARLARI ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY); 
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

app.use(express.static('public'));
const PORT = process.env.PORT || 3000;

const bots = {};

function proxyAyristir(proxyStr) {
    if (!proxyStr || !proxyStr.includes(':')) return null;
    let temizStr = proxyStr.trim();
    let type = 5;
    let host, port, userId, password;

    if (temizStr.startsWith('socks5://')) { temizStr = temizStr.replace('socks5://', ''); type = 5; }
    else if (temizStr.startsWith('socks4://')) { temizStr = temizStr.replace('socks4://', ''); type = 4; }

    const parcalar = temizStr.split(':');
    host = parcalar[0];
    port = parseInt(parcalar[1]);
    if (parcalar.length >= 4) { 
        userId = parcalar[2]; 
        password = parcalar[3]; 
    }

    return { host, port, type, userId, password };
}

function botBaslat(username, host, proxy) {
    if (bots[username]) return;

    const serverHost = host && host.trim() !== '' ? host.trim() : 'oyna.aesirmc.com';
    const serverPort = 25565;

    const botAyarlari = {
        host: serverHost,
        port: serverPort,
        username: username,
        version: '1.21.1'
    };

    const p = proxyAyristir(proxy);
    if (p) {
        botAyarlari.connect = client => {
            SocksClient.createConnection({
                proxy: p, 
                command: 'connect', 
                destination: { host: serverHost, port: serverPort }
            }).then(info => { 
                client.setSocket(info.socket); 
                client.emit('connect'); 
            }).catch(err => {
                io.emit('log', `❌ [${username}] Proxy bağlantı hatası: ${err.message}`);
            });
        };
    }

    const bot = mineflayer.createBot(botAyarlari);
    bot.loadPlugin(pathfinder);
    bot.loadPlugin(pvp);
    bots[username] = { instance: bot };

    bot.once('spawn', () => {
        io.emit('log', `✅ [${username}] Oyuna girdi (${serverHost}), 3D ve AI aktif.`);
        
        try {
            prismarineViewer(bot, { port: 3001, version: '1.21.1' });
            io.emit('log', `🌐 [${username}] 3D Görselleştirici 3001 portunda aktif.`);
        } catch (e) {
            io.emit('log', `⚠️ [${username}] 3D Viewer başlatılamadı: ${e.message}`);
        }

        // AI Otonom Karar Döngüsü (15 saniyede bir)
        setInterval(async () => {
            if (!bot.entity) return;
            const yakinOyuncu = bot.nearestEntity(e => e.type === 'player' && e.position.distanceTo(bot.entity.position) < 15);
            const durum = yakinOyuncu ? `Yakınımda ${yakinOyuncu.username} var.` : "Etrafım sakin.";

            const prompt = `Sen "${username}" adlı Minecraft oyuncususun. Sunucu: ${serverHost}. Durum: ${durum}. 
            Aksiyonun ne olacak? Sadece şu formatta cevap ver:
            "CHAT: [mesaj]" veya "SALDIR: [oyuncu_adı]" veya "YOKSAY".
            Agresif, oyuncu jargonlu ve kısa cevaplar ver.`;

            try {
                const result = await model.generateContent(prompt);
                const cevap = result.response.text();
                
                if (cevap.includes("CHAT:")) {
                    const mesajMetni = cevap.split("CHAT:")[1].trim();
                    bot.chat(mesajMetni);
                    io.emit('log', `💬 [${username} AI]: ${mesajMetni}`);
                } else if (cevap.includes("SALDIR:")) {
                    const hedef = cevap.split("SALDIR:")[1].trim();
                    const targetEntity = bot.players[hedef]?.entity;
                    if(targetEntity) {
                        bot.pvp.attack(targetEntity);
                        io.emit('log', `⚔️ [${username}] ${hedef} hedefine saldırıyor!`);
                    }
                }
            } catch (err) {
                io.emit('log', `⚠️ [${username}] AI hata: ${err.message}`);
            }
        }, 15000); 
    });

    bot.on('kicked', (reason) => {
        let sebepMetni = reason;
        try {
            if (typeof reason === 'object') {
                sebepMetni = JSON.stringify(reason);
            }
        } catch (e) {
            sebepMetni = String(reason);
        }
        io.emit('log', `⚠️ [${username}] Sunucudan atıldı: ${sebepMetni}`);
    });

    bot.on('error', (err) => io.emit('log', `❌ [${username}] Bot hatası: ${err.message}`));
}

io.on('connection', (socket) => {
    socket.on('yeniBotEkle', (data) => botBaslat(data.username, data.host, data.proxy));
    socket.on('terminalKomut', (komut) => {
        Object.values(bots).forEach(b => {
            if (b.instance && b.instance.chat) b.instance.chat(komut);
        });
    });
});

server.listen(PORT, () => console.log(`Sunucu ${PORT} portunda çalışıyor.`));

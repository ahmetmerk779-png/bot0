require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const pvp = require('mineflayer-pvp').plugin;
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

// Gelişmiş Proxy Ayrıştırma (Auth ve SOCKS4/5 Desteği)
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

function botBaslat(username, proxy) {
    if (bots[username]) return;

    const botAyarlari = {
        host: 'oyna.aesirmc.com',
        port: 25565,
        username: username,
        version: '1.21.1'
    };

    const p = proxyAyristir(proxy);
    if (p) {
        botAyarlari.connect = client => {
            SocksClient.createConnection({
                proxy: p, 
                command: 'connect', 
                destination: { host: 'oyna.aesirmc.com', port: 25565 }
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

    bot.on('spawn', () => {
        io.emit('log', `✅ [${username}] Oyuna girdi, zihin ve otonom AI aktif.`);
        
        // AI Otonom Karar Döngüsü (15 saniyede bir)
        setInterval(async () => {
            if (!bot.entity) return;
            const yakinOyuncu = bot.nearestEntity(e => e.type === 'player' && e.position.distanceTo(bot.entity.position) < 15);
            const durum = yakinOyuncu ? `Yakınımda ${yakinOyuncu.username} var.` : "Etrafım sakin.";

            const prompt = `Sen "${username}" adlı Minecraft oyuncususun. AesirMC BoxPvP sunucusundaysın. Durum: ${durum}. 
            Aksiyonun ne olacak? Sadece şu formatta cevap ver:
            "CHAT: [mesaj]" veya "SALDIR: [oyuncu_adı]" veya "YOKSAY".
            Agresif, oyuncu jargonlu (ez, ggs, bruh vb.) ve kısa cevaplar ver.`;

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
                        io.emit('log', `⚔️ [${username}] Otonom olarak ${hedef} hedefine saldırıyor!`);
                    }
                }
            } catch (err) {
                io.emit('log', `⚠️ [${username}] AI hata: ${err.message}`);
            }
        }, 15000); 
    });

    bot.on('kicked', (reason) => io.emit('log', `⚠️ [${username}] Sunucudan atıldı: ${reason}`));
    bot.on('error', (err) => io.emit('log', `❌ [${username}] Bot hatası: ${err.message}`));
}

io.on('connection', (socket) => {
    socket.on('yeniBotEkle', (data) => botBaslat(data.username, data.proxy));
    socket.on('terminalKomut', (komut) => {
        Object.values(bots).forEach(b => {
            if (b.instance && b.instance.chat) b.instance.chat(komut);
        });
    });
});

server.listen(PORT, () => console.log(`Sunucu ${PORT} portunda çalışıyor.`));

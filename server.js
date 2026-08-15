const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const pvp = require('mineflayer-pvp').plugin;
const minecraftData = require('minecraft-data');
const { SocksClient } = require('socks');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Statik dosyaları sunmak için public klasörü
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

const bots = {};
const madenModuAktif = {};
const botKonumlari = {};

// Akıllı Proxy Ayrıştırıcı (SOCKS4/5 & Auth Desteği)
function proxyAyristir(proxyStr) {
    if (!proxyStr || !proxyStr.includes(':')) return null;
    let temizStr = proxyStr.trim();
    let type = 5;
    let host, port, userId, password;

    if (temizStr.startsWith('socks5://')) {
        temizStr = temizStr.replace('socks5://', '');
        type = 5;
    } else if (temizStr.startsWith('socks4://')) {
        temizStr = temizStr.replace('socks4://', '');
        type = 4;
    }

    if (temizStr.includes('@')) {
        const [auth, endpoint] = temizStr.split('@');
        const [u, p] = auth.split(':');
        const [h, pt] = endpoint.split(':');
        host = h;
        port = parseInt(pt);
        userId = u;
        password = p;
    } else {
        const parcalar = temizStr.split(':');
        if (parcalar.length === 2) {
            host = parcalar[0];
            port = parseInt(parcalar[1]);
        } else if (parcalar.length >= 4) {
            host = parcalar[0];
            port = parseInt(parcalar[1]);
            userId = parcalar[2];
            password = parcalar[3];
        }
    }

    if (!host || isNaN(port)) return null;
    const proxyConfig = { host, port, type };
    if (userId && password) {
        proxyConfig.userId = userId;
        proxyConfig.password = password;
    }
    return proxyConfig;
}

function bekle(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Akıllı Alet Seçimi ve Blok Kırma
async function dogruAletleKaz(bot, blok) {
    if (!bot || !bot.canDig(blok)) return;
    let aletTuru = '';
    const isim = blok.name;

    if (isim.includes('ore') || isim.includes('stone') || isim.includes('brick') || isim.includes('obsidian')) {
        aletTuru = 'pickaxe';
    } else if (isim.includes('log') || isim.includes('wood') || isim.includes('planks') || isim.includes('bookshelf')) {
        aletTuru = 'axe';
    } else if (isim.includes('dirt') || isim.includes('sand') || isim.includes('gravel') || isim.includes('clay')) {
        aletTuru = 'shovel';
    }

    if (aletTuru) {
        const envanter = bot.inventory.items();
        const kaliteSirasi = ['netherite_', 'diamond_', 'iron_', 'stone_', 'wooden_'];
        let secilenAlet = null;
        for (const kalite of kaliteSirasi) {
            secilenAlet = envanter.find(i => i.name.includes(kalite + aletTuru));
            if (secilenAlet) break;
        }
        if (secilenAlet) {
            try {
                await bot.equip(secilenAlet, 'hand');
            } catch (err) {}
        }
    }

    try {
        await bot.dig(blok);
        io.emit('log', `⛏️ [${bot.username}] ${blok.name} bloğunu kırdı.`);
    } catch (err) {
        io.emit('log', `❌ Blok kırılamadı: ${err.message}`);
    }
}

// Bot Başlatma Fonksiyonu
function botBaslat(username, proxy, hedefHost = 'oyna.aesirmc.com', hedefPort = 25565) {
    if (bots[username]) {
        io.emit('log', `⚠️ [${username}] zaten oyunda!`);
        return;
    }

    io.emit('log', `🤖 [${username}] sunucuya bağlanıyor...`);

    const botAyarlari = {
        host: hedefHost,
        port: hedefPort,
        username: username,
        version: '1.21.11'
    };

    const yapilandirilmisProxy = proxyAyristir(proxy);
    if (yapilandirilmisProxy) {
        botAyarlari.connect = client => {
            SocksClient.createConnection({
                proxy: yapilandirilmisProxy,
                command: 'connect',
                destination: { host: botAyarlari.host, port: botAyarlari.port }
            }).then(info => {
                client.setSocket(info.socket);
                client.emit('connect');
            }).catch(err => {
                io.emit('log', `❌ [${username}] Proxy Bağlantı Hatası: ${err.message}`);
            });
        };
        io.emit('log', `🌐 [${username}] Proxy aktif: ${yapilandirilmisProxy.host}:${yapilandirilmisProxy.port}`);
    }

    const yeniBot = mineflayer.createBot(botAyarlari);
    yeniBot.loadPlugin(pathfinder);
    yeniBot.loadPlugin(pvp);

    bots[username] = { instance: yeniBot };

    yeniBot.on('spawn', () => {
        io.emit('log', `✅ [${username}] Oyuna başarıyla giriş yaptı!`);

        // Pathfinder Kalabalık Optimizasyonu
        const mcData = minecraftData(yeniBot.version);
        const optimalMovement = new Movements(yeniBot, mcData);
        optimalMovement.allowParkour = false;
        optimalMovement.canDig = false;
        optimalMovement.scaffoldingEnabled = false;
        optimalMovement.maxDropDown = 4;
        yeniBot.pathfinder.setMovements(optimalMovement);
    });

    // Menü Açıldığında Otomatik Tıklama
    yeniBot.on('windowOpen', async (window) => {
        io.emit('log', `🪟 [${username}] menü açıldı: ${window.title}`);
        const hedef = window.items().find(esya => esya.name.includes('sword') || esya.name.includes('diamond') || esya.name.includes('compass'));
        if (hedef) {
            try {
                await yeniBot.clickWindow(hedef.slot, 0, 0);
                io.emit('log', `✅ [${username}] menüden hedef eşyaya tıklandı.`);
            } catch (err) {}
        }
    });

    yeniBot.on('error', (err) => {
        io.emit('log', `❌ [${username}] Hata: ${err.message}`);
    });

    yeniBot.on('end', (reason) => {
        io.emit('log', `🔌 [${username}] Oyundan ayrıldı: ${reason}`);
        delete bots[username];
        delete madenModuAktif[username];
    });
}

// Acil Kaçış ve Sıkışma Önleyici Döngü (4 saniyede bir)
setInterval(async () => {
    if (!bots) return;
    Object.keys(bots).forEach(async (botName) => {
        const botObj = bots[botName].instance;
        if (!botObj || !botObj.entity) return;

        if (botObj.pathfinder.isMoving()) {
            const simdikiX = Math.floor(botObj.entity.position.x);
            const simdikiZ = Math.floor(botObj.entity.position.z);

            if (!botKonumlari[botName]) botKonumlari[botName] = { x: simdikiX, z: simdikiZ, sayac: 0 };

            if (botKonumlari[botName].x === simdikiX && botKonumlari[botName].z === simdikiZ) {
                botKonumlari[botName].sayac++;
                if (botKonumlari[botName].sayac >= 3) {
                    io.emit('log', `🚨 [${botName}] Tıkandı! Acil kaçış tetikleniyor...`);
                    botObj.pathfinder.setGoal(null);
                    botObj.clearControlStates();
                    botObj.chat('/spawn');

                    try {
                        botObj.setControlState('jump', true);
                        botObj.setControlState('sprint', true);
                        botObj.setControlState('forward', true);
                        const engelBlok = botObj.blockAtCursor(3);
                        if (engelBlok && engelBlok.name !== 'air' && engelBlok.name !== 'bedrock') {
                            await botObj.dig(engelBlok);
                        }
                    } catch (err) {}

                    setTimeout(() => { botObj.clearControlStates(); }, 4000);
                    botKonumlari[botName].sayac = 0;
                }
            } else {
                botKonumlari[botName] = { x: simdikiX, z: simdikiZ, sayac: 0 };
            }
        }
    });
}, 4000);

// Socket.io Olayları
io.on('connection', (socket) => {
    socket.on('yeniBotEkle', (data) => {
        const { username, proxy } = data;
        if (!username) return;
        botBaslat(username, proxy);
    });

    // Lobi / Sunucu Geçişi (Pusula)
    socket.on('lobiGecisTetikle', async () => {
        io.emit('log', `🚀 Tüm botlara Lobi geçiş komutu gönderildi!`);
        Object.keys(bots).forEach(async (botName) => {
            const bot = bots[botName].instance;
            if (!bot) return;
            const pusula = bot.inventory.items().find(item => item.name === 'compass');
            if (pusula) {
                try {
                    await bot.equip(pusula, 'hand');
                    bot.activateItem();
                } catch (err) {
                    io.emit('log', `❌ [${botName}] pusula kullanılamadı.`);
                }
            } else {
                io.emit('log', `⚠️ [${botName}] envanterinde pusula yok!`);
            }
        });
    });

    // Otonom Maden Başlat / Durdur
    socket.on('otonomMadenBaslat', () => {
        io.emit('log', `⛏️ Tüm botlar otonom maden moduna geçti!`);
        Object.keys(bots).forEach(botName => {
            const botObj = bots[botName].instance;
            if (!botObj) return;
            madenModuAktif[botName] = true;
            otonomMadeneDevamEt(botObj, botName);
        });
    });

    socket.on('otonomMadenDurdur', () => {
        io.emit('log', `🛑 Maden modu durduruldu.`);
        Object.keys(bots).forEach(botName => {
            madenModuAktif[botName] = false;
            const botObj = bots[botName].instance;
            if (botObj) botObj.pathfinder.setGoal(null);
        });
    });

    // PvP Hedef Kilitlenme
    socket.on('orduPvpBaslat', (hedefIsmi) => {
        io.emit('log', `⚔️ SAVAŞ ALARMI! Tüm botlar [${hedefIsmi}] oyuncusuna kilitlendi!`);
        Object.keys(bots).forEach(botName => {
            const botObj = bots[botName].instance;
            if (!botObj) return;
            if (botObj.health <= 4) {
                io.emit('log', `⚠️ [${botName}] canı kritik olduğu için savaşa katılamıyor!`);
                return;
            }
            const hedefOyuncu = botObj.players[hedefIsmi]?.entity;
            if (!hedefOyuncu) {
                io.emit('log', `⚠️ [${botName}], [${hedefIsmi}] oyuncusunu bulamadı.`);
                return;
            }
            const takipHedefi = new goals.GoalFollow(hedefOyuncu, 1);
            botObj.pathfinder.setGoal(takipHedefi, true);
            botObj.pvp.attack(hedefOyuncu);
            io.emit('log', `🗡️ [${botName}] saldırıya geçti!`);
        });
    });

    socket.on('pvpDurdur', () => {
        io.emit('log', `🛑 Tüm botlar savaş modunu kapattı.`);
        Object.keys(bots).forEach(botName => {
            const botObj = bots[botName].instance;
            if (!botObj) return;
            botObj.pvp.stop();
            botObj.pathfinder.setGoal(null);
            botObj.clearControlStates();
        });
    });

    // Terminal Komutları
    socket.on('terminalKomut', (komut) => {
        io.emit('log', `> [Panelden]: ${komut}`);
        Object.keys(bots).forEach(botName => {
            const botObj = bots[botName].instance;
            if (!botObj) return;
            try {
                botObj.chat(komut);
            } catch (err) {}
        });
    });
});

async function otonomMadeneDevamEt(bot, botName) {
    while (madenModuAktif[botName]) {
        if (bot.inventory.emptySlotCount() <= 2) {
            io.emit('log', `📦 [${botName}] Envanter doldu!`);
            break;
        }

        const hedefBlok = bot.findBlock({
            maxDistance: 10,
            matching: block => block && (block.name.includes('stone') || block.name.includes('ore') || block.name.includes('log'))
        });

        if (hedefBlok) {
            try {
                const blokHedefi = new goals.GoalGetToBlock(hedefBlok.position.x, hedefBlok.position.y, hedefBlok.position.z);
                await bot.pathfinder.goto(blokHedefi);
                await dogruAletleKaz(bot, hedefBlok);
                await bekle(500);
            } catch (err) {
                await bekle(1000);
            }
        } else {
            const rastgeleX = bot.entity.position.x + (Math.random() * 10 - 5);
            const rastgeleZ = bot.entity.position.z + (Math.random() * 10 - 5);
            try {
                await bot.pathfinder.goto(new goals.GoalNearXZ(Math.floor(rastgeleX), Math.floor(rastgeleZ), 1));
            } catch (err) {}
            await bekle(2000);
        }
    }
}

server.listen(PORT, () => {
    console.log(`🚀 Sunucu http://localhost:${PORT} adresinde çalışıyor.`);
});

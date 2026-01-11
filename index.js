require('dotenv').config();
const ccxt = require('ccxt');
const { StochasticRSI } = require('technicalindicators');
const nodemailer = require('nodemailer');
const express = require('express');
const webpush = require('web-push');

const app = express();
const port = process.env.PORT || 3000;
const DAKIKA = 1000 * 60;
app.use(express.json());
app.use(express.static('public'));

// VAPID Ayarları
webpush.setVapidDetails(
    'mailto:' + process.env.EMAIL_USER,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
);

let subscriptions = [];
const SYMBOLS = process.env.CRYPTO_SYMBOLS.split(',');
const TIMEFRAME = '1h'; // PERİYOT BURADAN AYARLANIR (1 Saat)
let marketData = {};
let sentAlerts = {};

const exchange = new ccxt.binance({ 'enableRateLimit': true });

// Yandex Mail Yapılandırması
const transporter = nodemailer.createTransport({
    host: 'smtp.yandex.com.tr',
    port: 465,
    secure: true,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// Bildirim Fonksiyonları
async function sendPushNotification(symbol, stochK) {
    const payload = JSON.stringify({
        title: `🚨 ${symbol} SİNYALİ!`,
        body: `Stoch RSI: ${stochK} (${TIMEFRAME}) yönü yukarı döndü!`
    });
    subscriptions.forEach(sub => {
        webpush.sendNotification(sub, payload).catch(e => console.error("Push Hatası:", e.message));
    });
}

async function sendAlertEmail(symbol, stochK, price) {
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: process.env.EMAIL_TO,
        subject: `🚨 ${symbol} Dipte!`,
        text: `${symbol} şu an ${price} TRY seviyesinde. Stoch RSI (${TIMEFRAME}) değeri ${stochK} ile aşırı satım bölgesinde.`    };
    try {
        await transporter.sendMail(mailOptions);
        console.log(`E-posta gönderildi: ${symbol}`);
    } catch (error) { console.error("Mail Hatası:", error); }
}

async function checkMarkets() {
    try {
        marketData = {};
        const tickers = await exchange.fetchTickers(SYMBOLS).catch(() => null);
        if (!tickers) return;

        for (const symbol of SYMBOLS) {
            await new Promise(resolve => setTimeout(resolve, 500)); // her sembol arası 0.5 sn bekle
            // 1 saatlik mumları çekiyoruz
            const ohlcv = await exchange.fetchOHLCV(symbol, TIMEFRAME, undefined, 100);
            const closes = ohlcv.map(c => c[4]);
            const results = StochasticRSI.calculate({ values: closes, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3 });

            if (results.length < 2) continue;

            const currentK = results[results.length - 1].k;
            const prevK = results[results.length - 2].k;
            const ticker = tickers[symbol];

// Yön tayini
            const trendDirection = currentK >= prevK ? 'up' : 'down';

            // YÖN BAZLI RENKLER
            // Yukarı ivme (Yeşil tonu), Aşağı ivme (Kırmızı tonu)
            const activeColor = trendDirection === 'up' ? '#00e676' : '#ff4b2b';

            // Arka plan için çok şeffaf hali
            const boxBgColor = trendDirection === 'up' ? 'rgba(0, 230, 118, 0.12)' : 'rgba(255, 75, 43, 0.12)';
            const trendArrow = trendDirection === 'up' ? '↗' : '↘';

            // Bildirim Mantığı (15'in altı ve 30 dk arayla)


            marketData[symbol] = {
                price: ticker ? ticker.last : 'N/A',
                change: ticker ? ticker.percentage : 0,
                stochK: currentK.toFixed(2),
                trendArrow,
                boxBg: boxBgColor,
                time: new Date().toLocaleTimeString('tr-TR'),
                status: currentK < 15 ? "⚠️ AŞIRI SATIM" : (currentK > 85 ? "🚀 AŞIRI ALIM" : "Normal"),
                // RAKAM VE BADGE RENGİ ARTIK YÖNE GÖRE BELİRLENİYOR
                stochColor: activeColor,
                changeColor: (ticker && ticker.percentage >= 0) ? "#00e676" : "#ff4b2b"
            };
            if (currentK < 15) {
                const now = Date.now();
                // 1 saatlik periyot daha hızlı olduğu için bildirim aralığını 30 dk tutmak mantıklı
                if (!sentAlerts[symbol] || (now - sentAlerts[symbol] > 30 * DAKIKA)) {
                    await sendPushNotification(symbol, currentK.toFixed(2));
                    await sendAlertEmail(symbol, currentK.toFixed(2), ticker ? ticker.last : 'N/A');
                    sentAlerts[symbol] = now;
                }
            }

        }
    } catch (e) { console.error("Döngü hatası:", e.message); }
}
function  responseHtml(res){
    let cardsHtml = '';
    SYMBOLS.forEach(symbol => {
        const data = marketData[symbol] || { price: '...', change: 0, stochK: '...', boxBg: '#1c1c1c', stochColor: '#666', changeColor: '#666', trendArrow: '' };

        // Sembolü link formatına çevir (Örn: OG/TRY -> OG_TRY)
        const symbolCode = symbol.replace('/', '_');
        const tradeUrl = `https://www.trbinance.com/trade/${symbolCode}`;

        cardsHtml += `
            <div class="card ${data.stochK < 15 ? 'alert-border' : ''}">
                <div class="symbol-header">
                    <a href="${tradeUrl}" target="_blank" style="color: #888; text-decoration: none; border-bottom: 1px dashed #444;">
                        ${symbol}
                    </a>
                </div>
                <div class="price">${data.price} <small>TRY</small></div>
                <div class="change" style="color: ${data.changeColor}">${data.change >= 0 ? '▲' : '▼'} %${Number(data.change).toFixed(2)}</div>
                
                <div class="indicator-box" style="background-color: ${data.boxBg}; border: 1px solid ${data.stochColor}44;">
                    <div class="stoch-label" style="color: #666;">STOCH RSI (${TIMEFRAME}) ${data.trendArrow}</div>
                    <div class="value" style="color: ${data.stochColor}; transition: all 0.5s;">${data.stochK}</div>
                    <div class="status-badge" style="border-color: ${data.stochColor}; color: ${data.stochColor}; background: rgba(0,0,0,0.3);">
                        ${data.status}
                    </div>
                </div>
                
                <div class="footer">Son: ${data.time}</div>
            </div>`;
    });
    res.send(`<!DOCTYPE html><html lang="tr"><head><title>Crypto Bot 1H</title><meta http-equiv="refresh" content="30"><style>body{font-family:sans-serif;background:#050505;color:white;display:flex;flex-direction:column;align-items:center;padding:20px;}.container{display:flex;gap:15px;flex-wrap:wrap;justify-content:center;}.card{background:#111;padding:20px;border-radius:20px;border:1px solid #222;width:230px;text-align:center;}.alert-border{border:1px solid #ff4b2b;box-shadow:0 0 15px rgba(255,75,43,0.3);}.indicator-box{padding:15px;border-radius:15px;margin-top:10px;transition:0.3s;}.value{font-size:2.8rem;font-weight:900;}.status-badge{font-size:0.6rem;border:1px solid;padding:2px 6px;border-radius:10px;}button{background:#f3ba2f;border:none;padding:10px;border-radius:8px;font-weight:bold;cursor:pointer;margin-bottom:20px;}</style></head><body><h1>MARKET INTELLIGENCE (1H)</h1><button onclick="subscribe()">🔔 Bildirimleri Etkinleştir</button><div class="container">${cardsHtml}</div><script>async function subscribe(){const r=await navigator.serviceWorker.register('/sw.js');const s=await r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:'${process.env.VAPID_PUBLIC_KEY}'});await fetch('/subscribe',{method:'POST',body:JSON.stringify(s),headers:{'content-type':'application/json'}});alert('Aktif!')}</script></body></html>`);

}
// 1 saatlik periyotta veriler daha sık değiştiği için kontrolü yine 2 dakikada bir yapıyoruz
setInterval(checkMarkets, 2 * DAKIKA);
checkMarkets();

app.post('/subscribe', (req, res) => {
    subscriptions.push(req.body);
    res.status(201).json({});
});

app.get('/', (req, res) => {
    responseHtml(res);
});

app.listen(port, () => console.log(`1 Saatlik Periyot Aktif: http://localhost:${port}`));
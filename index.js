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
let marketData = {};
let sentAlerts = {};
const TIMEFRAMES = ['1h', '4h']; // Takip edilecek periyotlar

const exchange = new ccxt.binance({ 'enableRateLimit': true });

// Yandex Mail Yapılandırması
const transporter = nodemailer.createTransport({
    host: 'smtp.yandex.com.tr',
    port: 465,
    secure: true,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// Bildirim Fonksiyonları
async function sendPushNotification(symbol, stochK, tf) { // tf eklendi
    const payload = JSON.stringify({
        title: `🚨 ${symbol} SİNYALİ!`,
        body: `Stoch RSI: ${stochK} (${tf}) yönü yukarı döndü!` // TIMEFRAME yerine tf
    });
    subscriptions.forEach(sub => {
        webpush.sendNotification(sub, payload).catch(e => console.error("Push Hatası:", e.message));
    });
}

// E-posta Bildirimi
async function sendAlertEmail(symbol, stochK, price, tf) { // tf eklendi
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: process.env.EMAIL_TO,
        subject: `🚨 ${symbol} Dipte! (${tf})`, // tf eklendi
        text: `${symbol} şu an ${price} TRY seviyesinde. Stoch RSI (${tf}) değeri ${stochK} ile aşırı satım bölgesinde.`
    };
    try {
        await transporter.sendMail(mailOptions);
        console.log(`E-posta gönderildi: ${symbol} (${tf})`);
    } catch (error) { console.error("Mail Hatası:", error); }
}

async function checkMarkets() {
    try {
        const tickers = await exchange.fetchTickers(SYMBOLS).catch(() => null);
        if (!tickers) return;

        for (const symbol of SYMBOLS) {
            marketData[symbol] = marketData[symbol] || { price: '...', change: 0, time: '...', intervals: {} };
            const ticker = tickers[symbol];

            marketData[symbol].price = ticker ? ticker.last : 'N/A';
            marketData[symbol].change = ticker ? ticker.percentage : 0;
            marketData[symbol].time = new Date().toLocaleTimeString('tr-TR');

            for (const tf of TIMEFRAMES) {
                await new Promise(resolve => setTimeout(resolve, 300)); // API kısıtlaması için kısa bekleme

                const ohlcv = await exchange.fetchOHLCV(symbol, tf, undefined, 100);
                const closes = ohlcv.map(c => c[4]);
                const results = StochasticRSI.calculate({
                    values: closes, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3
                });

                if (results.length < 2) continue;

                const currentK = results[results.length - 1].k;
                const prevK = results[results.length - 2].k;
                const trendDirection = currentK >= prevK ? 'up' : 'down';

                // Veriyi periyoda göre kaydet
                marketData[symbol].intervals[tf] = {
                    stochK: currentK.toFixed(2),
                    trendArrow: trendDirection === 'up' ? '↗' : '↘',
                    color: trendDirection === 'up' ? '#00e676' : '#ff4b2b',
                    bgColor: trendDirection === 'up' ? 'rgba(0, 230, 118, 0.12)' : 'rgba(255, 75, 43, 0.12)',
                    status: currentK < 15 ? "⚠️ SATIM" : (currentK > 85 ? "🚀 ALIM" : "Normal")
                };

                // Sadece 1h periyodu için bildirim gönder (veya isteğe göre 4h eklenebilir)
                if (tf === '1h' && currentK < 15) {
                    const now = Date.now();
                    if (!sentAlerts[symbol] || (now - sentAlerts[symbol] > 30 * DAKIKA)) {
                        // TIMEFRAME yerine tf kullanıyoruz:
                        await sendPushNotification(symbol, currentK.toFixed(2), tf);
                        await sendAlertEmail(symbol, currentK.toFixed(2), ticker ? ticker.last : 'N/A', tf);
                        sentAlerts[symbol] = now;
                    }
                }
            }
        }
    } catch (e) { console.error("Döngü hatası:", e.message); }
}
function responseHtml(res) {
    let cardsHtml = '';
    SYMBOLS.forEach(symbol => {
        const data = marketData[symbol];

        // GÜVENLİK KONTROLÜ: Veri henüz yüklenmediyse bekleme kartı göster
        if (!data || !data.intervals || !data.intervals['1h'] || !data.intervals['4h']) {
            cardsHtml += `
                <div class="card">
                    <div class="symbol-header">${symbol}</div>
                    <div style="padding: 20px;">Veriler yükleniyor...</div>
                </div>`;
            return;
        }

        const symbolCode = symbol.replace('/', '_');
        const tradeUrl = `https://www.binance.com/en-TR/trade/${symbolCode}?_from=markets&type=spot`;
        const symbolCodeTr = symbol.replace('/', '_').replace('USDT', 'TRY');
        const tradeUrlTr = `https://www.binance.tr/tr/trade/${symbolCodeTr}`;

        let intervalBoxes = '';
        TIMEFRAMES.forEach(tf => {
            const tfData = data.intervals[tf];
            // tfData var mı kontrolü (ekstra güvenlik)
            if (tfData) {
                intervalBoxes += `
                    <div class="indicator-box" style="background-color: ${tfData.bgColor}; border: 1px solid ${tfData.color}44; margin-bottom: 8px; padding: 10px; border-radius: 12px;">
                        <div class="stoch-label" style="color: #888; font-size: 0.7rem; font-weight: bold;">STOCH RSI (${tf}) ${tfData.trendArrow}</div>
                        <div class="value" style="color: ${tfData.color}; font-size: 1.6rem; font-weight: 900; margin: 5px 0;">${tfData.stochK}</div>
                        <div class="status-badge" style="border: 1px solid ${tfData.color}; color: ${tfData.color}; font-size: 0.6rem; padding: 2px 5px; border-radius: 5px; display: inline-block;">
                            ${tfData.status}
                        </div>
                    </div>`;
            }
        });

        cardsHtml += `
            <div class="card ${data.intervals['1h'].stochK < 15 ? 'alert-border' : ''}">
                <div class="symbol-header">
                    <a href="${tradeUrlTr}" target="_blank" style="color: #f3ba2f; text-decoration: none; font-weight: bold;">${symbol}</a>
                    <a href="${tradeUrl}"  target="_blank" style="text-decoration: none">🌐</a>
                </div>
                <div class="price" style="font-size: 1.2rem; margin: 10px 0;">${data.price} <small style="font-size: 0.7rem;">TRY</small></div>
                <div class="change" style="color: ${data.change >= 0 ? '#00e676' : '#ff4b2b'}; font-size: 0.9rem; margin-bottom: 10px;">
                    ${data.change >= 0 ? '▲' : '▼'} %${Number(data.change).toFixed(2)}
                </div>
                ${intervalBoxes}
                <div class="footer" style="font-size: 0.6rem; color: #555; margin-top: 10px;">Son: ${data.time}</div>
            </div>`;
    });

    // Stil kısmını da içerecek şekilde HTML'i gönderin
    res.send(`<!DOCTYPE html><html lang="tr"><head><title>Crypto Bot 1H/4H</title><meta http-equiv="refresh" content="30"><style>body{font-family:sans-serif;background:#050505;color:white;display:flex;flex-direction:column;align-items:center;padding:20px;}.container{display:flex;gap:15px;flex-wrap:wrap;justify-content:center;width:100%;}.card{background:#111;padding:15px;border-radius:20px;border:1px solid #222;width:25%;text-align:center;}.alert-border{border:1px solid #ff4b2b;box-shadow:0 0 15px rgba(255,75,43,0.3);}</style></head><body><h1>MARKET INTELLIGENCE</h1><div class="container">${cardsHtml}</div></body></html>`);
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
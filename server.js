require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ۱. تنظیمات اولیه
const token = process.env.TELEGRAM_BOT_TOKEN;
const adminId = parseInt(process.env.ADMIN_ID);
const HISTORY_FILE = path.join(__dirname, 'history.json'); // فایل ذخیره شعرهای تکراری

const subscribers = process.env.SUBSCRIBERS 
    ? process.env.SUBSCRIBERS.split(',').map(id => parseInt(id.trim())) 
    : [];

if (!token) {
    console.error("❌ خطا: توکن ربات در فایل .env پیدا نشد!");
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// ۲. برنامه هفتگی (شنبه تا جمعه)
const WEEKLY_SCHEDULE = {
    'Saturday': { id: 2, name: 'حافظ' },        // شنبه
    'Sunday': { id: 5, name: 'مولانا' },        // یکشنبه
    'Monday': { id: 7, name: 'سعدی' },          // دوشنبه
    'Tuesday': { id: 3, name: 'خیام' },         // سه شنبه
    'Wednesday': { id: 4, name: 'فردوسی' },     // چهارشنبه
    'Thursday': { id: 71, name: 'شهریار' },     // پنج شنبه
    'Friday': { id: 10, name: 'باباطاهر' }      // جمعه
};

const BASE_API_URL = 'https://api.ganjoor.net/api/ganjoor/poem/random';

// ۳. توابع مدیریت فایل
function loadHistory() {
    if (!fs.existsSync(HISTORY_FILE)) {
        return [];
    }
    const data = fs.readFileSync(HISTORY_FILE);
    return JSON.parse(data);
}

function saveHistory(poemId) {
    const history = loadHistory();
    history.push(poemId);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
}

function isDuplicate(poemId) {
    const history = loadHistory();
    return history.includes(poemId);
}

// ۴. پیدا کردن شاعر امروز
function getTodayPoet() {
    const options = { timeZone: 'Asia/Tehran', weekday: 'long' };
    const formatter = new Intl.DateTimeFormat('en-US', options);
    const dayName = formatter.format(new Date());

    return WEEKLY_SCHEDULE[dayName] || WEEKLY_SCHEDULE['Saturday'];
}

function formatPoemText(fullText) {
    if (!fullText) return "";
    return fullText; 
}

// ۵. دریافت شعر یونیک
async function fetchUniquePoem() {
    const todayPoet = getTodayPoet();
    const url = `${BASE_API_URL}?poetId=${todayPoet.id}`;
    
    let attempts = 0;
    let poemData = null;

    while (attempts < 5) {
        try {
            const response = await axios.get(url, { headers: { 'User-Agent': 'TelegramBot/1.0' } });
            const data = response.data;
            
            if (!isDuplicate(data.id)) {
                saveHistory(data.id);

                let audioUrl = null;
                if (data.recitations && data.recitations.length > 0) {
                    if (data.recitations[0].mp3Url) audioUrl = data.recitations[0].mp3Url;
                }

                const poetName = data.poet && data.poet.name ? data.poet.name : todayPoet.name;

                poemData = {
                    title: data.title,
                    poet: poetName, 
                    excerpt: formatPoemText(data.plainText),
                    summary: data.poemSummary, 
                    url: `https://ganjoor.net${data.urlSlug}`,
                    audio: audioUrl 
                };
                break;
            } else {
                console.log(`Duplicate poem found (ID: ${data.id}). Retrying...`);
            }

        } catch (error) {
            console.error('Error fetching poem:', error.message);
        }
        attempts++;
    }

    return poemData;
}

// ۶. تابع ارسال پیام
async function sendPoemToChat(chatId) {
    if (!chatId || isNaN(chatId)) return;

    bot.sendChatAction(chatId, 'typing');

    const poemData = await fetchUniquePoem();

    if (!poemData) {
        bot.sendMessage(chatId, 'متاسفانه پس از چند بار تلاش، شعر جدیدی یافت نشد یا ارتباط با سرور قطع است.');
        return;
    }

    let message = `
🌞 *شعر امروز (${getTodayPoet().name})*

📜 *${poemData.title}*

"${poemData.excerpt}"
    `;

    if (poemData.summary) {
        message += `\n\n💡 *تفسیر:*\n${poemData.summary}`;
    }

    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' })
        .catch((err) => console.error(`Error sending text:`, err.message));

    if (poemData.audio) {
        bot.sendChatAction(chatId, 'upload_voice');
        bot.sendAudio(chatId, poemData.audio, {
            caption: `🎙 دکلمه: ${poemData.title}`,
            performer: poemData.poet,
            title: poemData.title
        }).catch(err => console.error('Audio send failed'));
    }
}

// --- دستورات ربات ---

bot.onText(/\/fal|\/start/, (msg) => sendPoemToChat(msg.chat.id));

bot.onText(/\/broadcast (.+)/, (msg, match) => {
    if (msg.chat.id !== adminId) return;
    const text = match[1];
    subscribers.forEach(id => bot.sendMessage(id, `📢 *پیام:* ${text}`, {parse_mode: 'Markdown'}));
    bot.sendMessage(msg.chat.id, '✅ ارسال شد.');
});

// 👇 دستور جدید بکاپ (Backup) 👇
bot.onText(/\/backup/, (msg) => {
    const chatId = msg.chat.id;

    // ۱. بررسی دسترسی ادمین
    if (chatId !== adminId) {
        bot.sendMessage(chatId, "⛔ شما اجازه دسترسی به این دستور را ندارید.");
        return;
    }

    // ۲. بررسی وجود فایل
    if (!fs.existsSync(HISTORY_FILE)) {
        bot.sendMessage(chatId, "❌ هنوز هیچ شعری ارسال نشده و فایل history.json وجود ندارد.");
        return;
    }

    // ۳. ارسال فایل
    bot.sendDocument(chatId, HISTORY_FILE, {
        caption: "📦 نسخه پشتیبان (Backup) فایل history.json"
    }).catch((error) => {
        console.error("Backup failed:", error.message);
        bot.sendMessage(chatId, "❌ خطا در ارسال فایل بکاپ.");
    });
});

// زمان‌بندی
cron.schedule('0 0 10 * * *', () => {
    console.log('Daily task started...');
    if (subscribers.length > 0) {
        subscribers.forEach(id => sendPoemToChat(id));
    }
}, {
    scheduled: true,
    timezone: "Asia/Tehran"
});

console.log('Bot is running with Backup Feature...');
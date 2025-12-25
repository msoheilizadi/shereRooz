require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// 1. Settings
const token = process.env.TELEGRAM_BOT_TOKEN;
const adminId = parseInt(process.env.ADMIN_ID);
const HISTORY_FILE = path.join(__dirname, 'history.json'); 
const LOG_FILE = path.join(__dirname, 'activity.log'); // 🆕 New Log File

const subscribers = process.env.SUBSCRIBERS 
    ? process.env.SUBSCRIBERS.split(',').map(id => parseInt(id.trim())) 
    : [];

if (!token) {
    console.error("❌ Error: Token not found in .env");
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// 2. Weekly Schedule
const WEEKLY_SCHEDULE = {
    'Saturday': { id: 2, name: 'حافظ' },
    'Sunday': { id: 5, name: 'مولانا' },
    'Monday': { id: 7, name: 'سعدی' },
    'Tuesday': { id: 3, name: 'خیام' },
    'Wednesday': { id: 4, name: 'فردوسی' },
    'Thursday': { id: 71, name: 'شهریار' },
    'Friday': { id: 10, name: 'باباطاهر' }
};

const BASE_API_URL = 'https://api.ganjoor.net/api/ganjoor/poem/random';

// 3. File Management Functions (History & Logging)

// --- 🆕 New Logging Function ---
function logActivity(chatId, type, details) {
    const timestamp = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
    const logEntry = `[${timestamp}] [${type}] [ID:${chatId}] ${details}\n`;

    // Append to file asynchronously
    fs.appendFile(LOG_FILE, logEntry, (err) => {
        if (err) console.error('Failed to write to log file:', err);
    });
    
    // Also log to console
    console.log(logEntry.trim());
}
// -------------------------------

function loadHistory() {
    if (!fs.existsSync(HISTORY_FILE)) return [];
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

// 4. Helper Functions
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

// 5. Fetch Unique Poem
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

// 6. Send Message Function (Updated with Logging)
async function sendPoemToChat(chatId) {
    if (!chatId) return;

    bot.sendChatAction(chatId, 'typing').catch(() => {});

    const poemData = await fetchUniquePoem();

    if (!poemData) {
        bot.sendMessage(chatId, 'خطا در دریافت شعر.').catch(() => {});
        logActivity(chatId, 'ERROR', 'Failed to fetch unique poem');
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

    // Send Text
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' })
        .then(() => {
            // ✅ Log Success Text
            logActivity(chatId, 'POEM_SENT', `Poet: ${poemData.poet} | Title: ${poemData.title}`);
        })
        .catch((err) => {
            logActivity(chatId, 'ERROR', `Failed to send text: ${err.message}`);
        });

    // Send Audio
    if (poemData.audio) {
        bot.sendChatAction(chatId, 'upload_voice').catch(() => {});
        bot.sendAudio(chatId, poemData.audio, {
            caption: `🎙 دکلمه: ${poemData.title}`,
            performer: poemData.poet,
            title: poemData.title
        })
        .then(() => {
            // ✅ Log Success Audio
            logActivity(chatId, 'AUDIO_SENT', `Audio for: ${poemData.title}`);
        })
        .catch(err => console.error('Audio send failed'));
    }
}

// --- Commands ---

bot.onText(/\/fal|\/start/, (msg) => {
    logActivity(msg.chat.id, 'COMMAND', `User triggered ${msg.text}`);
    sendPoemToChat(msg.chat.id);
});

bot.onText(/\/broadcast (.+)/, (msg, match) => {
    if (msg.chat.id !== adminId) return;
    const text = match[1];
    
    logActivity(adminId, 'BROADCAST_START', `Message: ${text}`);

    subscribers.forEach(id => {
        bot.sendMessage(id, `📢 *پیام:* ${text}`, {parse_mode: 'Markdown'})
            .then(() => {
                logActivity(id, 'BROADCAST_SENT', 'Delivered successfully');
            })
            .catch((err) => {
                logActivity(id, 'BROADCAST_FAIL', err.message);
            });
    });
    
    bot.sendMessage(msg.chat.id, '✅ ارسال شد.');
});

// 👇 Updated Backup Command (Sends both History and Logs) 👇
bot.onText(/\/backup/, async (msg) => {
    const chatId = msg.chat.id;

    if (chatId !== adminId) return;

    // 1. Send History JSON
    if (fs.existsSync(HISTORY_FILE)) {
        await bot.sendDocument(chatId, HISTORY_FILE, { caption: "📦 History File (JSON)" });
    } else {
        bot.sendMessage(chatId, "❌ History file not found.");
    }

    // 2. Send Activity Log
    if (fs.existsSync(LOG_FILE)) {
        await bot.sendDocument(chatId, LOG_FILE, { caption: "📝 Activity Log (TXT)" });
    } else {
        bot.sendMessage(chatId, "❌ Log file not found (Empty?).");
    }
});

// Scheduled Task
cron.schedule('0 0 10 * * *', () => {
    console.log('Daily task started...');
    logActivity('SYSTEM', 'CRON', 'Daily scheduled task started');
    
    if (subscribers.length > 0) {
        subscribers.forEach(id => sendPoemToChat(id));
    }
}, {
    scheduled: true,
    timezone: "Asia/Tehran"
});

console.log('Bot is running with Logging Feature...');
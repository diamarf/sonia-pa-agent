#!/usr/bin/env node

/**
 * SONIA - PERSONAL ASSISTANT AGENT - TELEGRAM VERSION
 * Telegram bot with Gmail and Calendar integration
 */

require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const schedule = require('node-schedule');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  emails: {
    primary: process.env.PRIMARY_EMAIL || 'diamarf@gmail.com',
    secondary: process.env.SECONDARY_EMAIL || 'diamarferrer@hotmail.es',
    pa: process.env.PA_EMAIL || 'digitalgrwothsg@gmail.com'
  },
  calendar: {
    primary: process.env.PRIMARY_EMAIL || 'diamarf@gmail.com',
    inviteRecipients: [
      process.env.PA_EMAIL || 'digitalgrwothsg@gmail.com',
      process.env.PRIMARY_EMAIL || 'diamarf@gmail.com',
      process.env.SECONDARY_EMAIL || 'diamarferrer@hotmail.es'
    ]
  },
  timezone: 'Europe/London',
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    apiUrl: `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`
  },
  checkIntervalMinutes: 60
};

const TOKEN_FILE = path.join(__dirname, '.sonia_token.json');

// ============================================================================
// STATE
// ============================================================================

const STATE = {
  pendingEmails: [],
  pendingMeetings: [],
  emailDrafts: {},
  isInitialized: false,
  oauthReady: false,
  chatId: null,
  lastMessageTime: 0
};

let oauthTokenPromise = null;

// ============================================================================
// OAUTH SETUP
// ============================================================================

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `http://localhost:3000/auth/google/callback`
);

async function initializeOAuth() {
  // Check if token file exists and is valid
  if (fs.existsSync(TOKEN_FILE)) {
    try {
      const tokenData = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      oauth2Client.setCredentials(tokenData);
      
      // Check if token is expired
      if (tokenData.expiry_date && tokenData.expiry_date > Date.now()) {
        console.log('✅ Using saved token');
        STATE.oauthReady = true;
        return true;
      } else {
        console.log('⏳ Token expired, refreshing...');
        try {
          const { credentials } = await oauth2Client.refreshAccessToken();
          oauth2Client.setCredentials(credentials);
          fs.writeFileSync(TOKEN_FILE, JSON.stringify(credentials), { mode: 0o600 });
          STATE.oauthReady = true;
          return true;
        } catch (error) {
          console.log('Could not refresh token, will re-authenticate');
        }
      }
    } catch (error) {
      console.log('Token file invalid, will re-authenticate');
    }
  }
  
  // No valid token - need to authenticate
  console.log('\n🔐 First-time authentication needed...\n');
  console.log('🌐 Open this URL in your browser:');
  
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar'
    ]
  });
  
  console.log(authUrl);
  console.log('\nWaiting for authentication...\n');
  
  return new Promise((resolve) => {
    oauthTokenPromise = resolve;
  });
}

// ============================================================================
// EXPRESS SERVER FOR OAUTH CALLBACK & TELEGRAM WEBHOOK
// ============================================================================

const app = express();
app.use(express.json());

app.get('/auth/google/callback', async (req, res) => {
  const code = req.query.code;
  
  if (!code) {
    res.send('❌ No authorization code received');
    return;
  }
  
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens), { mode: 0o600 });
    console.log('\n✅ Authentication successful! Token saved.\n');
    
    res.send('✅ Authentication successful! You can close this window and go back to the terminal.');
    STATE.oauthReady = true;
    
    if (oauthTokenPromise) {
      oauthTokenPromise(true);
    }
  } catch (error) {
    console.error('❌ Authentication failed:', error.message);
    res.send('❌ Authentication failed: ' + error.message);
    
    if (oauthTokenPromise) {
      oauthTokenPromise(false);
    }
  }
});

// Telegram webhook
app.post('/telegram/webhook', async (req, res) => {
  try {
    const message = req.body.message;
    
    if (!message || !message.text) {
      res.json({ ok: true });
      return;
    }
    
    STATE.chatId = message.chat.id;
    
    console.log(`📨 ${message.from.first_name}: ${message.text}`);
    
    await handleUserMessage(message.text, message.chat.id);
    
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Error handling message:', error.message);
    res.json({ ok: false, error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', initialized: STATE.isInitialized, oauth: STATE.oauthReady });
});

app.get('/status', (req, res) => {
  res.json({ emails: STATE.pendingEmails.length, meetings: STATE.pendingMeetings.length });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}\n`);
});

// ============================================================================
// TELEGRAM UTILITIES
// ============================================================================

async function sendTelegramMessage(chatId, text) {
  try {
    await axios.post(`${CONFIG.telegram.apiUrl}/sendMessage`, {
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error('❌ Error sending Telegram message:', error.message);
  }
}

// ============================================================================
// GMAIL & CALENDAR
// ============================================================================

const gmail = google.gmail({ version: 'v1' });
const calendar = google.calendar({ version: 'v3' });

async function checkEmails() {
  try {
    // Wait up to 5 seconds for OAuth to be ready
    let attempts = 0;
    while (!STATE.oauthReady && attempts < 50) {
      await new Promise(r => setTimeout(r, 100));
      attempts++;
    }
    
    if (!STATE.oauthReady) {
      console.log('⚠️ OAuth still not ready, cannot access emails');
      return [];
    }
    
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread',
      maxResults: 10,
      auth: oauth2Client
    });
    
    const emails = [];
    if (response.data.messages) {
      for (const msg of response.data.messages) {
        try {
          const fullMsg = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'full',
            auth: oauth2Client
          });
          emails.push(parseEmail(fullMsg.data));
        } catch (e) {
          console.error('Error reading message:', e.message);
        }
      }
    }
    
    STATE.pendingEmails = emails;
    return emails;
  } catch (error) {
    console.error('📧 Email check error:', error.message);
    return [];
  }
}

function parseEmail(msg) {
  try {
    const headers = msg.payload.headers || [];
    const getHeader = (name) => headers.find(h => h.name === name)?.value || '';
    
    return {
      from: getHeader('From'),
      subject: getHeader('Subject'),
      body: getBodyText(msg.payload)
    };
  } catch (e) {
    return { from: 'Unknown', subject: '(error)', body: '(error)' };
  }
}

function getBodyText(payload) {
  try {
    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8').substring(0, 200);
        }
      }
    }
    if (payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8').substring(0, 200);
    }
  } catch (e) {}
  return '(no body)';
}

async function getCalendarEvents(daysAhead = 7) {
  try {
    if (!STATE.oauthReady) {
      return [];
    }
    
    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
    
    const response = await calendar.events.list({
      calendarId: CONFIG.calendar.primary,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      auth: oauth2Client
    });
    
    STATE.pendingMeetings = response.data.items || [];
    return STATE.pendingMeetings;
  } catch (error) {
    console.error('📅 Calendar error:', error.message);
    return [];
  }
}

// ============================================================================
// MESSAGE FORMATTING
// ============================================================================

function formatWithEmails(message) {
  return `${message}

📬 *Active Accounts:*
• ${CONFIG.emails.pa}
• ${CONFIG.emails.primary}
• ${CONFIG.emails.secondary}`;
}

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

async function handleUserMessage(text, chatId) {
  const lowerText = text.toLowerCase().trim();
  
  if (lowerText.includes('show inbox')) {
    const emails = await checkEmails();
    if (emails.length === 0) {
      await sendTelegramMessage(chatId, formatWithEmails('✅ No unread emails!'));
    } else {
      let list = '';
      emails.slice(0, 5).forEach((e, i) => {
        list += `${i + 1}. ${e.subject}\n   From: ${e.from}\n`;
      });
      if (emails.length > 5) list += `\n... and ${emails.length - 5} more`;
      await sendTelegramMessage(chatId, formatWithEmails(`📧 *Unread Emails (${emails.length}):*\n\n${list}`));
    }
    
  } else if (lowerText.includes('today')) {
    const meetings = await getCalendarEvents(1);
    const today = meetings.filter(m => {
      const d = new Date(m.start.dateTime);
      const now = new Date();
      return d.toDateString() === now.toDateString();
    });
    
    if (today.length === 0) {
      await sendTelegramMessage(chatId, formatWithEmails('📅 No meetings today!'));
    } else {
      let list = '';
      today.forEach(m => {
        const time = m.start.dateTime ? m.start.dateTime.substring(11, 16) : 'TBD';
        list += `• ${time} - ${m.summary}\n`;
      });
      await sendTelegramMessage(chatId, formatWithEmails(`📅 *Today (${today.length}):*\n\n${list}`));
    }
    
  } else if (lowerText.includes('help')) {
    await sendTelegramMessage(chatId, formatWithEmails(
      '👋 Hi! I\'m Sonia.\n\n' +
      '📧 "show inbox"\n' +
      '📅 "today"\n' +
      '❓ "help"'
    ));
    
  } else {
    await sendTelegramMessage(chatId, formatWithEmails(
      '👋 I\'m Sonia!\n\n' +
      'Try: "show inbox", "today", or "help"'
    ));
  }
}

// ============================================================================
// SCHEDULED TASKS
// ============================================================================

function initializeAgent() {
  console.log('⚙️ Initializing tasks...\n');
  
  schedule.scheduleJob('0 * * * *', async () => {
    console.log('⏰ Hourly check');
    await checkEmails();
  });
  
  console.log('✅ Ready!\n');
}

// ============================================================================
// STARTUP
// ============================================================================

console.log('🔄 Starting Sonia (Telegram)...\n');

initializeOAuth().then((success) => {
  if (success !== false) {
    STATE.isInitialized = true;
    initializeAgent();
    console.log('✅ Sonia is online and ready on Telegram!');
    console.log(`📱 Message @sonia_pa_bot to start\n`);
  } else {
    console.error('❌ Authentication failed');
    process.exit(1);
  }
}).catch(error => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});

// ============================================================================
// SHUTDOWN
// ============================================================================

process.on('SIGINT', async () => {
  console.log('\n👋 Goodbye!');
  server.close();
  process.exit(0);
});

#!/usr/bin/env node
require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const axios = require('axios');

const EMAILS = {
  primary: 'diamarf@gmail.com',
  secondary: 'diamarferrer@hotmail.es',
  pa: 'digitalgrwothsg@gmail.com'
};

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);

oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  access_token: process.env.GOOGLE_ACCESS_TOKEN,
  expiry_date: parseInt(process.env.GOOGLE_EXPIRY_DATE || '0')
});

const gmail = google.gmail({ version: 'v1' });
const calendar = google.calendar({ version: 'v3' });

const STATE = {
  emailDrafts: {},
  meetingDrafts: {},
  lastEmailContext: {}
};

async function ensureValidToken() {
  try {
    const creds = oauth2Client.credentials;
    if (!creds.expiry_date || creds.expiry_date <= Date.now()) {
      const { credentials: newCreds } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(newCreds);
    }
    return true;
  } catch (e) {
    console.error('Token refresh error:', e.message);
    return false;
  }
}

async function getUnreadEmails() {
  try {
    if (!await ensureValidToken()) return [];
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread',
      maxResults: 30,
      auth: oauth2Client
    });
    if (!res.data.messages) return [];
    const emails = [];
    for (const msg of res.data.messages.slice(0, 20)) {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full',
        auth: oauth2Client
      });
      const headers = full.data.payload.headers || [];
      emails.push({
        id: msg.id,
        subject: headers.find(h => h.name === 'Subject')?.value || '(no subject)',
        from: headers.find(h => h.name === 'From')?.value || 'Unknown',
        snippet: full.data.snippet || ''
      });
    }
    return emails;
  } catch (e) {
    console.error('Gmail error:', e.message);
    return [];
  }
}

async function markAsRead(messageIds) {
  try {
    if (!await ensureValidToken()) return false;
    await gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: {
        ids: messageIds,
        removeLabelIds: ['UNREAD']
      },
      auth: oauth2Client
    });
    return true;
  } catch (e) {
    console.error('Mark read error:', e.message);
    return false;
  }
}

async function sendEmail(to, subject, body) {
  try {
    if (!await ensureValidToken()) return false;
    const email = `To: ${to}\nSubject: ${subject}\nContent-Type: text/plain; charset=utf-8\n\n${body}`;
    const encoded = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encoded },
      auth: oauth2Client
    });
    return true;
  } catch (e) {
    console.error('Send error:', e.message);
    return false;
  }
}

async function getMeetings(startDate, daysAhead = 1) {
  try {
    if (!await ensureValidToken()) return [];
    const start = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate()).toISOString();
    const end = new Date(startDate.getTime() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
    const res = await calendar.events.list({
      calendarId: EMAILS.primary,
      timeMin: start,
      timeMax: end,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100,
      auth: oauth2Client
    });
    if (!res.data.items) return [];
    return res.data.items.map(e => ({
      id: e.id,
      summary: e.summary || '(no title)',
      start: e.start.dateTime || e.start.date,
      time: e.start.dateTime ? e.start.dateTime.substring(11, 16) : 'All day'
    }));
  } catch (e) {
    console.error('Calendar error:', e.message);
    return [];
  }
}

async function createMeeting(title, attendees, startDateTime, durationMinutes = 60) {
  try {
    if (!await ensureValidToken()) return null;
    const start = new Date(startDateTime);
    const end = new Date(start.getTime() + durationMinutes * 60000);
    const event = {
      summary: title,
      start: { dateTime: start.toISOString(), timeZone: 'Europe/London' },
      end: { dateTime: end.toISOString(), timeZone: 'Europe/London' },
      attendees: [
        ...attendees.map(email => ({ email })),
        { email: EMAILS.pa },
        { email: EMAILS.primary },
        { email: EMAILS.secondary }
      ]
    };
    const res = await calendar.events.insert({
      calendarId: EMAILS.primary,
      resource: event,
      sendUpdates: 'all',
      auth: oauth2Client
    });
    return res.data;
  } catch (e) {
    console.error('Meeting error:', e.message);
    return null;
  }
}

async function send(chatId, text) {
  await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown'
  }).catch(e => console.error('Telegram error:', e.message));
}

async function handleMessage(text, chatId) {
  const lower = text.toLowerCase().trim();
  console.log(`CMD: "${lower}"`);
  
  // SHOW INBOX
  if (lower === 'show inbox' || lower === 'inbox' || lower === 'emails') {
    const emails = await getUnreadEmails();
    if (emails.length === 0) {
      await send(chatId, '✅ No unread emails!');
      return;
    }
    STATE.lastEmailContext[chatId] = emails;
    let list = '';
    emails.forEach((e, i) => {
      list += `*${i + 1}.* ${e.subject}\n   _${e.from}_\n\n`;
    });
    await send(chatId, `📧 *${emails.length} Unread:*\n\n${list}"reply 1" to draft\n"mark as read 1,2,3"`);
  }
  
  // MARK AS READ
  else if (lower.startsWith('mark as read ')) {
    const nums = lower.replace('mark as read ', '').split(',').map(n => parseInt(n.trim()));
    const emails = STATE.lastEmailContext[chatId] || [];
    const ids = nums.filter(n => n >= 1 && n <= emails.length).map(n => emails[n - 1].id);
    if (ids.length === 0) {
      await send(chatId, '❌ Invalid numbers');
      return;
    }
    const ok = await markAsRead(ids);
    await send(chatId, ok ? `✅ Marked ${ids.length} as read!` : '❌ Failed');
  }
  
  // REPLY
  else if (lower.startsWith('reply ')) {
    const num = parseInt(lower.replace('reply ', ''));
    const emails = STATE.lastEmailContext[chatId] || [];
    if (num < 1 || num > emails.length) {
      await send(chatId, '❌ Invalid. Try "show inbox" first');
      return;
    }
    const email = emails[num - 1];
    const to = email.from.match(/<(.+?)>/) ? email.from.match(/<(.+?)>/)[1] : email.from;
    const draftId = `draft_${Date.now()}`;
    const body = "Thanks for your email. I'll review and get back to you.";
    STATE.emailDrafts[draftId] = { to, subject: `Re: ${email.subject}`, body };
    await send(chatId, `📝 *Draft:*\n\nTo: ${to}\nSubject: Re: ${email.subject}\n\n${body}\n\n✅ confirm ${draftId}`);
  }
  
  // SEND EMAIL
  else if (text.match(/send email to (.+?) about (.+?): (.+)/i)) {
    const m = text.match(/send email to (.+?) about (.+?): (.+)/i);
    const draftId = `draft_${Date.now()}`;
    STATE.emailDrafts[draftId] = { to: m[1].trim(), subject: m[2].trim(), body: m[3].trim() };
    await send(chatId, `📝 *Draft:*\n\nTo: ${m[1]}\nSubject: ${m[2]}\n\n${m[3]}\n\n✅ confirm ${draftId}`);
  }
  
  // CONFIRM DRAFT
  else if (lower.startsWith('confirm draft_')) {
    const draftId = lower.replace('confirm ', '');
    const draft = STATE.emailDrafts[draftId];
    if (!draft) {
      await send(chatId, '❌ Draft not found');
      return;
    }
    const ok = await sendEmail(draft.to, draft.subject, draft.body);
    await send(chatId, ok ? `✅ Sent to ${draft.to}!` : '❌ Failed');
    if (ok) delete STATE.emailDrafts[draftId];
  }
  
  // TODAY
  else if (lower === 'today') {
    const meetings = await getMeetings(new Date(), 1);
    if (meetings.length === 0) {
      await send(chatId, '📅 No meetings today!');
      return;
    }
    let list = '';
    meetings.forEach(m => list += `• ${m.time} - ${m.summary}\n`);
    await send(chatId, `📅 *Today (${meetings.length}):*\n\n${list}`);
  }
  
  // TOMORROW
  else if (lower === 'tomorrow') {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const meetings = await getMeetings(tomorrow, 1);
    if (meetings.length === 0) {
      await send(chatId, '📅 No meetings tomorrow!');
      return;
    }
    let list = '';
    meetings.forEach(m => list += `• ${m.time} - ${m.summary}\n`);
    await send(chatId, `📅 *Tomorrow (${meetings.length}):*\n\n${list}`);
  }
  
  // THIS WEEK
  else if (lower === 'this week' || lower === 'upcoming') {
    const meetings = await getMeetings(new Date(), 7);
    if (meetings.length === 0) {
      await send(chatId, '📅 No meetings this week!');
      return;
    }
    // Group by day
    const byDay = {};
    meetings.forEach(m => {
      const day = m.start.substring(0, 10);
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push(m);
    });
    let list = '';
    Object.keys(byDay).sort().forEach(day => {
      const date = new Date(day);
      const dayName = date.toLocaleDateString('en-GB', { weekday: 'short', month: 'short', day: 'numeric' });
      list += `\n*${dayName}:*\n`;
      byDay[day].forEach(m => list += `  • ${m.time} - ${m.summary}\n`);
    });
    await send(chatId, `📅 *This Week (${meetings.length}):*${list}`);
  }
  
  // SCHEDULE
  else if (text.match(/schedule meeting with (.+?) (for |at )(today|tomorrow) at (\d+)(am|pm): (.+)/i)) {
    const m = text.match(/schedule meeting with (.+?) (for |at )(today|tomorrow) at (\d+)(am|pm): (.+)/i);
    const attendee = m[1].trim();
    const when = m[3];
    let hour = parseInt(m[4]);
    const meridiem = m[5].toLowerCase();
    const title = m[6].trim();
    
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    
    const targetDate = new Date();
    if (when === 'tomorrow') targetDate.setDate(targetDate.getDate() + 1);
    targetDate.setHours(hour, 0, 0, 0);
    
    const draftId = `meeting_${Date.now()}`;
    STATE.meetingDrafts[draftId] = { title, attendees: [attendee], start: targetDate.toISOString(), duration: 60 };
    await send(chatId, `📅 *Meeting:*\n\n${title}\nWith: ${attendee}\nWhen: ${targetDate.toLocaleString('en-GB')}\n\n✅ confirm ${draftId}`);
  }
  
  // CONFIRM MEETING
  else if (lower.startsWith('confirm meeting_')) {
    const draftId = lower.replace('confirm ', '');
    const draft = STATE.meetingDrafts[draftId];
    if (!draft) {
      await send(chatId, '❌ Meeting not found');
      return;
    }
    const ok = await createMeeting(draft.title, draft.attendees, draft.start, draft.duration);
    await send(chatId, ok ? `✅ Meeting scheduled!\n\n${draft.title}\n${new Date(draft.start).toLocaleString('en-GB')}` : '❌ Failed');
    if (ok) delete STATE.meetingDrafts[draftId];
  }
  
  // HELP
  else if (lower === 'help') {
    await send(chatId, `📧 *Email:* "show inbox", "reply 1", "mark as read 1,2", "send email to X about Y: message", "confirm draft_XXX"\n\n📅 *Calendar:* "today", "tomorrow", "this week", "schedule meeting with X for today at 2pm: Title", "confirm meeting_XXX"`);
  }
  
  // DEFAULT
  else {
    await send(chatId, '👋 Try: "show inbox", "today", "help"');
  }
}

const app = express();
app.use(express.json());

app.post('/telegram/webhook', async (req, res) => {
  try {
    const msg = req.body.message;
    if (msg && msg.text) {
      console.log(`[${new Date().toISOString()}] ${msg.text}`);
      await handleMessage(msg.text, msg.chat.id);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.json({ ok: false });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sonia on ${PORT}`));

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
      await oauth2Client.refreshAccessToken();
    }
    return true;
  } catch (e) {
    console.error('Token error:', e.message);
    return false;
  }
}

async function getUnreadEmails() {
  try {
    await ensureValidToken();
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
    await ensureValidToken();
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
    console.error('Mark as read error:', e.message);
    return false;
  }
}

async function sendEmail(to, subject, body, inReplyTo = null) {
  try {
    await ensureValidToken();
    const email = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body
    ].join('\n');
    const encodedEmail = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedEmail, threadId: inReplyTo },
      auth: oauth2Client
    });
    return true;
  } catch (e) {
    console.error('Send email error:', e.message);
    return false;
  }
}

async function getMeetings(daysAhead = 1, startDate = null) {
  try {
    await ensureValidToken();
    const start = startDate || new Date();
    const startISO = new Date(start.getFullYear(), start.getMonth(), start.getDate()).toISOString();
    const end = new Date(start.getTime() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
    
    const res = await calendar.events.list({
      calendarId: EMAILS.primary,
      timeMin: startISO,
      timeMax: end,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100,
      auth: oauth2Client
    });
    if (!res.data.items) return [];
    return res.data.items.slice(0, 50).map(e => ({
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
    await ensureValidToken();
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
      ],
      conferenceData: {
        createRequest: {
          requestId: `meet-${Date.now()}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      }
    };
    const res = await calendar.events.insert({
      calendarId: EMAILS.primary,
      resource: event,
      conferenceDataVersion: 1,
      sendUpdates: 'all',
      auth: oauth2Client
    });
    return res.data;
  } catch (e) {
    console.error('Create meeting error:', e.message);
    return null;
  }
}

async function sendTelegram(chatId, text) {
  try {
    await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown'
    });
  } catch (e) {
    console.error('Telegram error:', e.message);
  }
}

function generateSmartReply(emailSubject, emailSnippet) {
  const lower = (emailSubject + ' ' + emailSnippet).toLowerCase();
  if (lower.includes('meeting') || lower.includes('call') || lower.includes('schedule')) {
    return "Thanks for reaching out. I'm available for a meeting. What times work for you?";
  }
  if (lower.includes('thank') || lower.includes('appreciate')) {
    return "You're welcome! Let me know if you need anything else.";
  }
  if (lower.includes('question') || lower.includes('ask')) {
    return "Thanks for your question. Let me get back to you with more details shortly.";
  }
  return "Thanks for your email. I'll review this and get back to you soon.";
}

async function handleMessage(text, chatId) {
  const cmd = text.toLowerCase().trim();
  console.log(`Processing command: ${cmd}`);
  
  // SHOW INBOX
  if (cmd.includes('inbox') || cmd.includes('emails') || cmd === 'show inbox') {
    const emails = await getUnreadEmails();
    if (emails.length === 0) {
      await sendTelegram(chatId, '✅ No unread emails!');
      return;
    }
    STATE.lastEmailContext[chatId] = emails;
    let list = '';
    emails.forEach((e, i) => {
      list += `*${i + 1}.* ${e.subject}\n   _From: ${e.from}_\n   ${e.snippet.substring(0, 80)}...\n\n`;
    });
    await sendTelegram(chatId, `📧 *Unread Emails (${emails.length}):*\n\n${list}To reply: "reply 1"\nTo mark as read: "mark as read 1,2,3"`);
  }
  
  // MARK AS READ
  else if (cmd.match(/mark as read (.+)/)) {
    const nums = cmd.match(/mark as read (.+)/)[1].split(',').map(n => parseInt(n.trim()));
    const emails = STATE.lastEmailContext[chatId] || [];
    const toMark = nums.filter(n => n >= 1 && n <= emails.length).map(n => emails[n - 1].id);
    if (toMark.length === 0) {
      await sendTelegram(chatId, '❌ Invalid email numbers.');
      return;
    }
    const success = await markAsRead(toMark);
    if (success) {
      await sendTelegram(chatId, `✅ Marked ${toMark.length} email(s) as read!`);
    } else {
      await sendTelegram(chatId, '❌ Failed to mark as read.');
    }
  }
  
  // REPLY TO EMAIL
  else if (cmd.match(/^reply (\d+)$/)) {
    const num = parseInt(cmd.match(/^reply (\d+)$/)[1]);
    const emails = STATE.lastEmailContext[chatId] || [];
    console.log(`Reply ${num} - emails available: ${emails.length}`);
    
    if (num < 1 || num > emails.length) {
      await sendTelegram(chatId, '❌ Invalid email number. Try "show inbox" first.');
      return;
    }
    
    const email = emails[num - 1];
    const reply = generateSmartReply(email.subject, email.snippet);
    const draftId = `draft_${Date.now()}`;
    
    STATE.emailDrafts[draftId] = {
      to: email.from.match(/<(.+?)>/) ? email.from.match(/<(.+?)>/)[1] : email.from.split('<')[0].trim(),
      subject: `Re: ${email.subject}`,
      body: reply,
      threadId: email.id
    };
    
    console.log(`Created draft ${draftId}:`, STATE.emailDrafts[draftId]);
    
    await sendTelegram(chatId, `📝 *Draft Reply:*\n\nTo: ${STATE.emailDrafts[draftId].to}\nSubject: ${STATE.emailDrafts[draftId].subject}\n\n${reply}\n\n✅ "confirm ${draftId}"`);
  }
  
  // SEND CUSTOM EMAIL
  else if (text.match(/send email to (.+?) about (.+?): (.+)/i)) {
    const match = text.match(/send email to (.+?) about (.+?): (.+)/i);
    const to = match[1].trim();
    const subject = match[2].trim();
    const body = match[3].trim();
    const draftId = `draft_${Date.now()}`;
    
    STATE.emailDrafts[draftId] = { to, subject, body, threadId: null };
    console.log(`Created email draft ${draftId}:`, STATE.emailDrafts[draftId]);
    
    await sendTelegram(chatId, `📝 *Draft Email:*\n\nTo: ${to}\nSubject: ${subject}\n\n${body}\n\n✅ "confirm ${draftId}"`);
  }
  
  // CONFIRM DRAFT
  else if (cmd.match(/confirm (draft_\d+)/)) {
    const draftId = cmd.match(/confirm (draft_\d+)/)[1];
    console.log(`Confirming draft: ${draftId}`);
    console.log('Available drafts:', Object.keys(STATE.emailDrafts));
    
    const draft = STATE.emailDrafts[draftId];
    if (!draft) {
      await sendTelegram(chatId, `❌ Draft ${draftId} not found. Available: ${Object.keys(STATE.emailDrafts).join(', ')}`);
      return;
    }
    
    const sent = await sendEmail(draft.to, draft.subject, draft.body, draft.threadId);
    if (sent) {
      await sendTelegram(chatId, `✅ Email sent to ${draft.to}!`);
      delete STATE.emailDrafts[draftId];
    } else {
      await sendTelegram(chatId, '❌ Failed to send email.');
    }
  }
  
  // TODAY
  else if (cmd === 'today') {
    const meetings = await getMeetings(1);
    if (meetings.length === 0) {
      await sendTelegram(chatId, '📅 No meetings today!');
      return;
    }
    let list = '';
    meetings.forEach(m => {
      list += `• *${m.time}* - ${m.summary}\n`;
    });
    await sendTelegram(chatId, `📅 *Today (${meetings.length}):*\n\n${list}`);
  }
  
  // TOMORROW
  else if (cmd === 'tomorrow') {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const meetings = await getMeetings(1, tomorrow);
    if (meetings.length === 0) {
      await sendTelegram(chatId, '📅 No meetings tomorrow!');
      return;
    }
    let list = '';
    meetings.forEach(m => {
      list += `• *${m.time}* - ${m.summary}\n`;
    });
    await sendTelegram(chatId, `📅 *Tomorrow (${meetings.length}):*\n\n${list}`);
  }
  
  // YESTERDAY
  else if (cmd === 'yesterday') {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const meetings = await getMeetings(1, yesterday);
    if (meetings.length === 0) {
      await sendTelegram(chatId, '📅 No meetings yesterday!');
      return;
    }
    let list = '';
    meetings.forEach(m => {
      list += `• *${m.time}* - ${m.summary}\n`;
    });
    await sendTelegram(chatId, `📅 *Yesterday (${meetings.length}):*\n\n${list}`);
  }
  
  // THIS WEEK
  else if (cmd.includes('this week') || cmd.includes('upcoming')) {
    const meetings = await getMeetings(7);
    if (meetings.length === 0) {
      await sendTelegram(chatId, '📅 No meetings this week!');
      return;
    }
    let list = '';
    meetings.forEach(m => {
      const date = new Date(m.start).toLocaleDateString('en-GB', { weekday: 'short', month: 'short', day: 'numeric' });
      list += `• *${date} ${m.time}* - ${m.summary}\n`;
    });
    await sendTelegram(chatId, `📅 *This Week (${meetings.length}):*\n\n${list.substring(0, 4000)}`);
  }
  
  // SCHEDULE MEETING
  else if (text.match(/schedule meeting with (.+?) (tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday) at (\d+)(am|pm): (.+)/i)) {
    const match = text.match(/schedule meeting with (.+?) (tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday) at (\d+)(am|pm): (.+)/i);
    const attendee = match[1].trim();
    const day = match[2].trim().toLowerCase();
    const hour = parseInt(match[3]);
    const meridiem = match[4].toLowerCase();
    const title = match[5].trim();
    
    const now = new Date();
    let targetDate = new Date();
    
    if (day === 'tomorrow') {
      targetDate.setDate(now.getDate() + 1);
    }
    
    let hourValue = hour;
    if (meridiem === 'pm' && hour !== 12) hourValue += 12;
    if (meridiem === 'am' && hour === 12) hourValue = 0;
    
    targetDate.setHours(hourValue, 0, 0, 0);
    
    const draftId = `meeting_${Date.now()}`;
    STATE.meetingDrafts[draftId] = {
      title,
      attendees: [attendee],
      start: targetDate.toISOString(),
      duration: 60
    };
    
    console.log(`Created meeting draft ${draftId}:`, STATE.meetingDrafts[draftId]);
    
    await sendTelegram(chatId, `📅 *Meeting Draft:*\n\n*${title}*\nWith: ${attendee}\nWhen: ${targetDate.toLocaleString('en-GB')}\nDuration: 60 min\n\n✅ "confirm ${draftId}"`);
  }
  
  // CONFIRM MEETING
  else if (cmd.match(/confirm (meeting_\d+)/)) {
    const draftId = cmd.match(/confirm (meeting_\d+)/)[1];
    console.log(`Confirming meeting: ${draftId}`);
    
    const draft = STATE.meetingDrafts[draftId];
    if (!draft) {
      await sendTelegram(chatId, `❌ Meeting ${draftId} not found.`);
      return;
    }
    
    const event = await createMeeting(draft.title, draft.attendees, draft.start, draft.duration);
    if (event) {
      await sendTelegram(chatId, `✅ Meeting scheduled!\n\n*${draft.title}*\n${new Date(draft.start).toLocaleString('en-GB')}\n\nInvites sent!`);
      delete STATE.meetingDrafts[draftId];
    } else {
      await sendTelegram(chatId, '❌ Failed to create meeting.');
    }
  }
  
  // HELP
  else if (cmd.includes('help')) {
    await sendTelegram(chatId, `👋 *I'm Sonia*

📧 *Email:*
• "show inbox"
• "reply 1"
• "mark as read 1,2,3"
• "send email to X about Y: message"

📅 *Calendar:*
• "today" / "tomorrow" / "yesterday"
• "this week"
• "schedule meeting with X tomorrow at 2pm: Title"

✅ All send/schedule need "confirm draft_XXX"`);
  }
  
  // DEFAULT
  else {
    await sendTelegram(chatId, '👋 Try: "show inbox", "today", "help"');
  }
}

const app = express();
app.use(express.json());

app.post('/telegram/webhook', async (req, res) => {
  try {
    const msg = req.body.message;
    if (msg && msg.text) {
      console.log(`[${new Date().toISOString()}] ${msg.from.first_name}: ${msg.text}`);
      await handleMessage(msg.text, msg.chat.id);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('Error:', e.message);
    res.json({ ok: false });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Sonia on port ${PORT}`));

const express = require("express");
const app = express();
app.use(express.json());

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Keep track of processed event IDs to avoid duplicate responses
const processedEvents = new Set();

// Download an image from Slack and convert to base64
async function downloadSlackImage(url) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
  });
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  const contentType = response.headers.get("content-type") || "image/jpeg";
  return { base64, contentType };
}

// Fetch bot's own user ID
async function getBotUserId() {
  const response = await fetch("https://slack.com/api/auth.test", {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
  });
  const data = await response.json();
  return data.user_id;
}

// Fetch last N messages from a channel (not thread replies)
async function fetchChannelHistory(channel, limit = 50) {
  const url = `https://slack.com/api/conversations.history?channel=${channel}&limit=${limit}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
  });
  const data = await response.json();
  // Returns newest first, so reverse to get chronological order
  return (data.messages || []).reverse();
}

// Fetch all messages in a thread
async function fetchThreadMessages(channel, threadTs) {
  const url = `https://slack.com/api/conversations.replies?channel=${channel}&ts=${threadTs}&limit=100`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
  });
  const data = await response.json();
  return data.messages || [];
}

// Fetch user display name from Slack
const userCache = {};
async function getUserName(userId) {
  if (userCache[userId]) return userCache[userId];
  const response = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
  });
  const data = await response.json();
  const name = data.user?.profile?.display_name || data.user?.real_name || userId;
  userCache[userId] = name;
  return name;
}

// Convert a Slack message to a readable text summary with sender name
async function messageToText(msg, botUserId) {
  const isBot = msg.user === botUserId || msg.bot_id;
  const senderName = isBot ? "HVAC Bot" : await getUserName(msg.user);
  const text = (msg.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
  const time = new Date(parseFloat(msg.ts) * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return text ? `[${time}] ${senderName}: ${text}` : null;
}

// Convert a Slack message into a Claude message object (with image support)
async function slackMessageToClaudeMessage(msg, botUserId) {
  const isBot = msg.user === botUserId || msg.bot_id;
  const role = isBot ? "assistant" : "user";
  const text = (msg.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();

  let content = [];

  if (msg.files && msg.files.length > 0) {
    for (const file of msg.files) {
      if (file.mimetype && file.mimetype.startsWith("image/")) {
        try {
          const { base64, contentType } = await downloadSlackImage(file.url_private);
          content.push({
            type: "image",
            source: { type: "base64", media_type: contentType, data: base64 },
          });
        } catch (err) {
          console.error("Error downloading image:", err);
        }
      }
    }
  }

  if (text) content.push({ type: "text", text });
  if (content.length === 0) return null;

  if (role === "assistant" && content.length === 1 && content[0].type === "text") {
    return { role, content: content[0].text };
  }

  return { role, content };
}

// Merge consecutive same-role messages (Claude requires alternating roles)
function mergeMessages(messages) {
  const merged = [];
  for (const msg of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      const lastContent = Array.isArray(last.content)
        ? last.content
        : [{ type: "text", text: last.content }];
      const newContent = Array.isArray(msg.content)
        ? msg.content
        : [{ type: "text", text: msg.content }];
      last.content = [...lastContent, ...newContent];
    } else {
      merged.push({ ...msg });
    }
  }
  return merged;
}

app.post("/slack/events", async (req, res) => {
  const { type, challenge, event } = req.body;

  if (type === "url_verification") {
    return res.json({ challenge });
  }

  res.sendStatus(200);

  if (!event || event.type !== "app_mention") return;

  if (processedEvents.has(event.event_ts)) return;
  processedEvents.add(event.event_ts);
  setTimeout(() => processedEvents.delete(event.event_ts), 60000);

  const channel = event.channel;
  const threadTs = event.thread_ts;
  const currentText = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();

  try {
    const botUserId = await getBotUserId();

    let messages = [];
    let channelContextSummary = "";

    if (threadTs) {
      // --- INSIDE A THREAD: read full thread history ---
      const threadMessages = await fetchThreadMessages(channel, threadTs);
      for (const msg of threadMessages) {
        if (msg.ts === event.ts) continue;
        const claudeMsg = await slackMessageToClaudeMessage(msg, botUserId);
        if (claudeMsg) messages.push(claudeMsg);
      }
    } else {
      // --- OUTSIDE A THREAD: read last 50 channel messages as context ---
      const channelMessages = await fetchChannelHistory(channel, 50);
      const summaryLines = [];
      for (const msg of channelMessages) {
        if (msg.ts === event.ts) continue;
        const line = await messageToText(msg, botUserId);
        if (line) summaryLines.push(line);
      }
      if (summaryLines.length > 0) {
        channelContextSummary = `Here are the last ${summaryLines.length} messages from this channel for context:\n\n${summaryLines.join("\n")}`;
      }
    }

    // Build current message content
    let currentContent = [];

    if (event.files && event.files.length > 0) {
      for (const file of event.files) {
        if (file.mimetype && file.mimetype.startsWith("image/")) {
          try {
            const { base64, contentType } = await downloadSlackImage(file.url_private);
            currentContent.push({
              type: "image",
              source: { type: "base64", media_type: contentType, data: base64 },
            });
          } catch (err) {
            console.error("Error downloading image:", err);
          }
        }
      }
    }

    const finalText = currentText || "Please read the context and help with whatever is needed.";
    currentContent.push({ type: "text", text: finalText });
    messages.push({ role: "user", content: currentContent });

    // Merge consecutive same-role messages
    messages = mergeMessages(messages);

    // Build system prompt — include channel context if outside a thread
    const systemPrompt = `You are a helpful assistant for an HVAC company called ASAP HVAC. You help technicians, 
dispatchers, and office staff with questions about HVAC systems, job scheduling, customer 
follow-ups, billing, and general company operations. Be concise and practical.

${channelContextSummary ? channelContextSummary + "\n\n" : ""}You have full context of the conversation above — do not ask for info already shared.

When analyzing images:
- If it's HVAC equipment, identify the unit type, brand if visible, and any visible issues
- If it's gauges or readings, interpret the values and what they indicate
- If it's an error code or display, explain what it means and recommended next steps
- If it's a nameplate, extract the model/serial number and key specs
- If it's damage or a problem area, describe what you see and suggest repair approaches

Format responses clearly for Slack — use short paragraphs and bullet points where helpful.
Today's date is ${new Date().toLocaleDateString()}.`;

    // Call Claude API
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: systemPrompt,
        messages,
      }),
    });

    const data = await anthropicRes.json();
    const reply = data.content?.[0]?.text || "Sorry, I couldn't generate a response.";

    // Post reply — in thread if applicable, otherwise as new message
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        channel,
        text: reply,
        ...(threadTs ? { thread_ts: threadTs } : { thread_ts: event.ts }),
      }),
    });
  } catch (err) {
    console.error("Error:", err);
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        channel,
        text: "Sorry, I ran into an error. Please try again.",
        thread_ts: event.ts,
      }),
    });
  }
});

app.get("/", (req, res) => res.send("Claude Slack Bot is running ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));

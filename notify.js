const fs = require("fs");
const http = require("http");

const RAW_WEBHOOK_CONFIG = process.env.DISCORD_WEBHOOK_URL;
const SERVER_TIMEZONE = "Europe/Stockholm";
const WARN_THRESHOLDS = [10]; // Only notify 10 minutes before championship
const HISTORY_FILE = "./sent_history.json";
const FORCE_TEST = false;
const MAX_WEBHOOK_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 5000; // Cap retry wait so huge retry_after values don't stall alerts
const SCHEDULE = JSON.parse(fs.readFileSync("./schedule.json", "utf8"));

// Keep history in memory so Render restarts/ephemeral disk don't cause issues
const memoryHistory = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseTargets(raw) {
  if (!raw) return [];
  const trimmed = raw.trim();

  if (trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  return [{ url: trimmed, roleId: "1573660467732152361" }];
}

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    }
  } catch (err) {
    console.warn("Could not read sent_history.json, starting fresh.");
  }
  return {};
}

function saveHistory(history) {
  // Keep only the last 50 entries so the file stays tiny
  const entries = Object.entries(history).slice(-50);
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Object.fromEntries(entries), null, 2));
  } catch (err) {
    console.warn("Could not write sent_history.json:", err.message);
  }
}

function getZonedParts(date, timeZone) {
  const dayName = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
  }).format(date);

  const dateKey = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date); // e.g., "2026-11-21"

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const hour = parts.find((p) => p.type === "hour").value;
  const minute = parts.find((p) => p.type === "minute").value;

  return { dayName, dateKey, timeStr: `${hour}:${minute}` };
}

function findMatchingChamp(dayName, lookupTime) {
  const daySchedule =
    SCHEDULE?.[dayName] ||
    SCHEDULE?.[dayName.toLowerCase()] ||
    SCHEDULE?.[dayName.toUpperCase()];

  if (!daySchedule) return null;

  if (daySchedule[lookupTime]) return daySchedule[lookupTime];

  const unpadded = lookupTime.replace(/^0/, "");
  return daySchedule[unpadded] || null;
}

function findNextChampAfter(baseDate, currentDayName, currentLookupTime) {
  const [curHour, curMin] = currentLookupTime.split(":").map(Number);

  const { timeStr: nowTimeStr } = getZonedParts(baseDate, SERVER_TIMEZONE);
  const [nowHour, nowMin] = nowTimeStr.split(":").map(Number);

  let diffMinutes = curHour * 60 + curMin - (nowHour * 60 + nowMin);
  if (diffMinutes < -720) diffMinutes += 1440;
  if (diffMinutes > 720) diffMinutes -= 1440;

  const currentSlotDate = new Date(baseDate.getTime() + diffMinutes * 60 * 1000);

  for (let step = 1; step <= 48; step++) {
    const futureDate = new Date(currentSlotDate.getTime() + step * 30 * 60 * 1000);
    const { dayName, timeStr } = getZonedParts(futureDate, SERVER_TIMEZONE);
    const [h, m] = timeStr.split(":");
    const snapped = Number(m) >= 15 && Number(m) < 45 ? `${h}:30` : `${h}:00`;

    if (dayName === currentDayName && snapped === currentLookupTime) continue;

    const location = findMatchingChamp(dayName, snapped);
    if (location) {
      return {
        location,
        time: snapped,
        dayName,
        isTomorrow: dayName !== currentDayName,
      };
    }
  }

  return null;
}

// Only trigger when now + 10 minutes lands right on :00 or :30
function findActiveAlert(now) {
  for (const warnMins of WARN_THRESHOLDS) {
    const targetTime = new Date(now.getTime() + warnMins * 60 * 1000);
    const { dayName, dateKey, timeStr } = getZonedParts(targetTime, SERVER_TIMEZONE);
    const [hour, minStr] = timeStr.split(":");
    const min = Number(minStr);

    if (min !== 0 && min !== 30) continue;

    const lookupTime = `${hour}:${minStr}`;
    const champLocation = findMatchingChamp(dayName, lookupTime);
    if (champLocation) {
      return {
        warnMins,
        champLocation,
        lookupTime,
        dayName,
        dateKey,
        slotDate: targetTime,
      };
    }
  }

  return null;
}

async function sendWebhookWithRetry(url, payload, serverLabel, maxRetries = MAX_WEBHOOK_RETRIES) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      return res;
    }

    if (res.status === 429) {
      let retryAfterSec = 1;
      try {
        const data = await res.json();
        if (typeof data.retry_after === "number" && data.retry_after > 0) {
          retryAfterSec = data.retry_after;
        }
      } catch {
        const headerVal = Number(res.headers.get("retry-after"));
        if (!Number.isNaN(headerVal) && headerVal > 0) {
          retryAfterSec = headerVal;
        }
      }

      if (attempt === maxRetries) {
        console.error(
          `${serverLabel} webhook failed with HTTP 429 (Too Many Requests) after ${maxRetries} retries.`
        );
        return null;
      }

      const rawWaitMs = Math.ceil(retryAfterSec * 1000) + 150;
      const waitMs = Math.min(rawWaitMs, MAX_RETRY_DELAY_MS);
      console.warn(
        `${serverLabel} rate limited (HTTP 429; retry_after=${retryAfterSec}s). Waiting ${waitMs}ms before retry ${attempt + 1}/${maxRetries}...`
      );
      await sleep(waitMs);
      continue;
    }

    console.error(
      `${serverLabel} webhook failed with HTTP ${res.status} (${res.statusText || "Error"}).`
    );
    return null;
  }

  return null;
}

async function run() {
  const targets = parseTargets(RAW_WEBHOOK_CONFIG);
  if (targets.length === 0) {
    console.error("Missing DISCORD_WEBHOOK_URL environment variable.");
    return;
  }

  const now = new Date();
  let alert = findActiveAlert(now);

  if (FORCE_TEST && !alert) {
    const { dayName, dateKey, timeStr } = getZonedParts(now, SERVER_TIMEZONE);
    const hour = timeStr.split(":")[0];
    alert = {
      warnMins: 10,
      champLocation: "Test Arena",
      lookupTime: `${hour}:00`,
      dayName,
      dateKey,
      slotDate: now,
    };
    console.log("FORCE_TEST enabled: sending test notification.");
  }

  if (!alert) {
    const { dayName, timeStr } = getZonedParts(now, SERVER_TIMEZONE);
    console.log(`No 10-minute championship alert due at ${dayName} ${timeStr}. Skipping.`);
    return;
  }

  const history = loadHistory();
  const dedupeKey = `${alert.dateKey}_${alert.lookupTime}_${alert.warnMins}m`;

  if (!FORCE_TEST && (memoryHistory.has(dedupeKey) || history[dedupeKey])) {
    console.log(`Already sent ${dedupeKey} (${alert.champLocation}). Skipping duplicate.`);
    return;
  }

  const nextChamp = findNextChampAfter(alert.slotDate, alert.dayName, alert.lookupTime);

  const embedFields = [];
  if (nextChamp) {
    const dayLabel = nextChamp.isTomorrow ? ` (${nextChamp.dayName})` : "";
    embedFields.push({
      name: "⏭️ Up Next",
      value: `**${nextChamp.location} Championship** at \`${nextChamp.time}\`${dayLabel}`,
      inline: false,
    });
  }

  let sentCount = 0;

  for (let i = 0; i < targets.length; i++) {
    const { url, roleId } = targets[i];
    const serverLabel = `Server #${i + 1}`;
    const payload = {
      embeds: [
        {
          title: "🏆 Upcoming Star Stable Championship!",
          description: `**${alert.champLocation} Championship** starts in **${alert.warnMins} minutes** (\`${alert.lookupTime}\` server time)!`,
          color: 16766720,
          fields: embedFields,
        },
      ],
    };

    if (roleId) {
      payload.content = `<@&${roleId}>`;
      payload.allowed_mentions = { roles: [String(roleId)] };
    }

    const res = await sendWebhookWithRetry(url, payload, serverLabel);

    if (res) {
      sentCount++;
      console.log(
        `${serverLabel}: sent ${alert.warnMins}-min alert for ${alert.champLocation} (${alert.lookupTime}).`
      );
    }
  }

  if (sentCount > 0 && !FORCE_TEST) {
    memoryHistory.add(dedupeKey);
    if (memoryHistory.size > 100) {
      const oldest = memoryHistory.values().next().value;
      memoryHistory.delete(oldest);
    }

    history[dedupeKey] = new Date().toISOString();
    saveHistory(history);
  }
}

// Tiny web server so Render Web Service stays alive & UptimeRobot can ping it
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("SSO Championship Notifier is active!\n");
  })
  .listen(PORT, () => {
    console.log(`Health check server listening on port ${PORT}`);
  });

// Run immediately on startup, then check every 1 minute for exact 10-minute alerts
run().catch((err) => console.error("Error on initial run:", err));
setInterval(() => {
  run().catch((err) => console.error("Error during check:", err));
}, 1 * 60 * 1000);

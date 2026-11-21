const fs = require("fs");

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const SERVER_TIMEZONE = "Europe/Stockholm";
const WARN_MINUTES_BEFORE = 10;
const FORCE_TEST = true;
const SCHEDULE = JSON.parse(fs.readFileSync("./schedule.json", "utf8"));

function getZonedParts(date, timeZone) {
  const dayName = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
  }).format(date);

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const hour = parts.find((p) => p.type === "hour").value;
  const minute = parts.find((p) => p.type === "minute").value;

  return { dayName, timeStr: `${hour}:${minute}` };
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

async function run() {
  if (!WEBHOOK_URL) {
    console.error("Missing DISCORD_WEBHOOK_URL secret.");
    process.exit(1);
  }

  const now = new Date();
  const targetTime = new Date(now.getTime() + WARN_MINUTES_BEFORE * 60 * 1000);
  const { dayName, timeStr } = getZonedParts(targetTime, SERVER_TIMEZONE);

  const [hour, minStr] = timeStr.split(":");
  const min = Number(minStr);

  let snappedMin = null;
  if (min >= 50 || min <= 10) snappedMin = "00";
  else if (min >= 20 && min <= 40) snappedMin = "30";

  let lookupTime = snappedMin ? `${hour}:${snappedMin}` : null;
  let champLocation = lookupTime ? findMatchingChamp(dayName, lookupTime) : null;

  if (FORCE_TEST && !champLocation) {
    lookupTime = lookupTime || `${hour}:00`;
    champLocation = "Test Arena";
    console.log("FORCE_TEST enabled: sending test notification.");
  }

  if (!champLocation) {
    console.log(
      `No championship found for ${dayName} target ${timeStr} (snapped: ${lookupTime || "none"}). Skipping.`
    );
    return;
  }

  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: "<@&1573660467732152361>",
      allowed_mentions: {
        roles: ["1573660467732152361"],
      },
      embeds: [
        {
          title: "🏆 Upcoming Star Stable Championship!",
          description: `**${champLocation} Championship** starts in 10 minutes (\`${lookupTime}\` server time)!`,
          color: 16766720,
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Discord Webhook failed: ${res.status} ${await res.text()}`);
  }

  console.log(`Sent notification for ${champLocation} at ${lookupTime} (${dayName}).`);
}

run();

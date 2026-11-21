const fs = require("fs");

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const SERVER_TIMEZONE = "Europe/Stockholm";
const WARN_MINUTES_BEFORE = 10;

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
  if (min >= 55 || min <= 5) snappedMin = "00";
  if (min >= 25 && min <= 35) snappedMin = "30";

  if (!snappedMin) {
    console.log(`Not a championship slot (${dayName} ${timeStr}). Skipping.`);
    return;
  }

  const lookupTime = `${hour}:${snappedMin}`;
  const champLocation = SCHEDULE?.[dayName]?.[lookupTime];
  if (!champLocation) return;

  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [
        {
          title: "🏆 Upcoming Star Stable Championship!",
          description: `**${champLocation} Championship** starts soon (\`${lookupTime}\` server time)!`,
          color: 16766720,
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Discord Webhook failed: ${res.status} ${await res.text()}`);
  }
}

run();

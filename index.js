require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  VERIFIED_ROLE_ID,
  FALLBACK_CHANNEL_ID,
  API_KEY,
  PORT = 3000,
} = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !API_KEY) {
  console.error('Missing DISCORD_TOKEN, CLIENT_ID or API_KEY in .env');
  process.exit(1);
}

/* Log unexpected errors instead of silently crashing the process
   (a crash is what makes UptimeRobot see the bot as down). */
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

/* ------------------------------------------------------------------ */
/* Storage (simple JSON files)                                         */
/*   links.json:       { robloxId: discordId }                         */
/*   wild-stats.json:  { robloxId: { total, shiny, gradient, ... } }   */
/* ------------------------------------------------------------------ */
const DATA_FILE = path.join(__dirname, 'links.json');
let links = {};
try {
  links = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {
  links = {};
}
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(links, null, 2));

const STATS_FILE = path.join(__dirname, 'wild-stats.json');
let stats = {};
try {
  stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
} catch {
  stats = {};
}
const saveStats = () => fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));

const SIZE_LABELS = { tiny: 'Tiny', small: 'Small', big: 'Big', giant: 'Giant' };

/* Always returns a fully-populated stats object for a Roblox user (fills in
   any missing fields so older files keep working). */
function getStats(robloxId) {
  const s = (stats[robloxId] ||= {});
  s.total ||= 0;
  s.shiny ||= 0;
  s.gradient ||= 0;
  s.marks ||= 0;
  s.sizes ||= {};
  for (const k of Object.keys(SIZE_LABELS)) s.sizes[k] ||= 0;
  return s;
}

const sizeTotal = (s) => Object.values(s.sizes).reduce((a, b) => a + b, 0);

const robloxIdFor = (discordId) =>
  Object.keys(links).find((rid) => links[rid] === discordId);

/* Pending link codes: code -> { discordId, expires } */
const pending = new Map();
const CODE_TTL_MS = 10 * 60 * 1000;

function makeCode(discordId) {
  // Remove any older code this user already had
  for (const [code, p] of pending) if (p.discordId === discordId) pending.delete(code);
  const code = crypto.randomBytes(3).toString('hex').toUpperCase(); // e.g. 9F3A1C
  pending.set(code, { discordId, expires: Date.now() + CODE_TTL_MS });
  return code;
}

setInterval(() => {
  const now = Date.now();
  for (const [code, p] of pending) if (p.expires < now) pending.delete(code);
}, 60 * 1000);

/* ------------------------------------------------------------------ */
/* Discord bot                                                         */
/* ------------------------------------------------------------------ */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on('error', (err) => console.error('Discord client error:', err.message));

const commands = [
  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your Roblox account to your Discord account'),
  new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Unlink your Roblox account'),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('See which Roblox account you have linked'),
  new SlashCommandBuilder()
    .setName('finds')
    .setDescription('See your wild shiny / gradient / mark / size finds'),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log('Slash commands registered.');
}

async function robloxName(userId) {
  try {
    const res = await fetch(`https://users.roblox.com/v1/users/${userId}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.name || null;
  } catch {
    return null;
  }
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const flags = MessageFlags.Ephemeral;

  if (interaction.commandName === 'link') {
    if (robloxIdFor(interaction.user.id)) {
      return interaction.reply({
        content: 'You already have a Roblox account linked. Use `/unlink` first if you want to change it.',
        flags,
      });
    }
    const code = makeCode(interaction.user.id);
    const embed = new EmbedBuilder()
      .setTitle('Link your Roblox account')
      .setColor(0x5865f2)
      .setDescription(
        [
          '1. Join the game.',
          `2. Type this in the game chat: \`/link ${code}\``,
          '',
          'The code expires in **10 minutes**. Never share it with anyone.',
        ].join('\n')
      );
    return interaction.reply({ embeds: [embed], flags });
  }

  if (interaction.commandName === 'unlink') {
    const rid = robloxIdFor(interaction.user.id);
    if (!rid) return interaction.reply({ content: "You don't have a linked account.", flags });
    delete links[rid];
    save();
    if (VERIFIED_ROLE_ID && interaction.inGuild()) {
      interaction.member.roles.remove(VERIFIED_ROLE_ID).catch(() => {});
    }
    return interaction.reply({ content: 'Your Roblox account has been unlinked.', flags });
  }

  if (interaction.commandName === 'status') {
    const rid = robloxIdFor(interaction.user.id);
    if (!rid) return interaction.reply({ content: 'No Roblox account linked. Use `/link`.', flags });
    const name = (await robloxName(rid)) || 'Unknown';
    return interaction.reply({ content: `Linked to Roblox user **${name}** (ID \`${rid}\`).`, flags });
  }

  if (interaction.commandName === 'finds') {
    const rid = robloxIdFor(interaction.user.id);
    if (!rid) return interaction.reply({ content: 'No Roblox account linked. Use `/link`.', flags });
    const s = stats[rid] ? getStats(rid) : null;
    if (!s || s.total === 0) {
      return interaction.reply({ content: "No special wild finds tracked yet. Go get 'em! ✨", flags });
    }
    const embed = new EmbedBuilder()
      .setTitle('Your wild finds')
      .setColor(0xffd54f)
      .addFields(
        { name: '✨ Shiny', value: String(s.shiny), inline: true },
        { name: '🌈 Gradiant', value: String(s.gradient), inline: true },
        { name: '🏷️ Marked', value: String(s.marks), inline: true },
        {
          name: '📏 Sizes',
          value: Object.entries(SIZE_LABELS)
            .map(([k, label]) => `${label}: **${s.sizes[k]}**`)
            .join('\n'),
          inline: true,
        },
        { name: 'Total special finds', value: String(s.total), inline: true }
      );
    if (s.last) embed.setFooter({ text: `Latest: ${s.last}` });
    return interaction.reply({ embeds: [embed], flags });
  }
});

client.once('ready', () => console.log(`Logged in as ${client.user.tag}`));

/* Deliver an embed to a linked Discord user. DM first; if their DMs are
   closed, fall back to the fallback channel (pinging only them).
   Returns 'dm' | 'channel' | null */
async function deliverToUser(discordId, embed) {
  try {
    const user = await client.users.fetch(discordId);
    await user.send({ embeds: [embed] });
    return 'dm';
  } catch {
    if (FALLBACK_CHANNEL_ID) {
      try {
        const channel = await client.channels.fetch(FALLBACK_CHANNEL_ID);
        await channel.send({
          content: `<@${discordId}>`,
          embeds: [embed],
          // Only ever ping the target user, never @everyone / roles
          allowedMentions: { users: [discordId] },
        });
        return 'channel';
      } catch (err) {
        console.error('Fallback channel failed:', err.message);
      }
    }
    return null;
  }
}

/* Send a notification to a linked Discord user. Returns 'dm' | 'channel' | null */
function notifyDiscordUser(discordId, { title, message }) {
  const embed = new EmbedBuilder()
    .setColor(0xe2231a)
    .setDescription(String(message).slice(0, 1000))
    .setTimestamp();
  if (title) embed.setTitle(String(title).slice(0, 200));
  return deliverToUser(discordId, embed);
}

/* ------------------------------------------------------------------ */
/* HTTP API (called from Roblox servers)                               */
/* ------------------------------------------------------------------ */
const app = express();
app.use(express.json({ limit: '10kb' }));

function auth(req, res, next) {
  const given = Buffer.from(String(req.get('x-api-key') || ''));
  const expected = Buffer.from(API_KEY);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

/* Public health endpoints for UptimeRobot (no auth). Both / and /health work.
   Reports 200 as long as the web server is up; "discord" shows bot status. */
const health = (_req, res) =>
  res.status(200).json({ ok: true, discord: client.isReady() ? 'connected' : 'connecting' });
app.get('/', health);
app.get('/health', health);

/* Roblox game sends { userId, code } when a player types /link CODE */
app.post('/verify', auth, async (req, res) => {
  const userId = Number(req.body.userId);
  const code = String(req.body.code || '').toUpperCase();
  if (!Number.isInteger(userId) || userId <= 0 || !code) {
    return res.status(400).json({ error: 'bad_request' });
  }

  const p = pending.get(code);
  if (!p || p.expires < Date.now()) {
    return res.status(404).json({ error: 'invalid_or_expired_code' });
  }

  if (links[userId] && links[userId] !== p.discordId) {
    return res.status(409).json({ error: 'roblox_already_linked' });
  }

  pending.delete(code);
  links[userId] = p.discordId;
  save();

  const name = (await robloxName(userId)) || `ID ${userId}`;

  // Optional: give the verified role in every server the bot is in
  if (VERIFIED_ROLE_ID) {
    for (const guild of client.guilds.cache.values()) {
      try {
        const member = await guild.members.fetch(p.discordId);
        await member.roles.add(VERIFIED_ROLE_ID);
      } catch {
        /* user not in this guild or role missing */
      }
    }
  }

  notifyDiscordUser(p.discordId, {
    title: 'Account linked ✅',
    message: `Your Discord is now linked to Roblox user **${name}**. You'll get pings here for in-game events.`,
  });

  res.json({ ok: true, robloxName: name });
});

/* Roblox game sends { userId } to remove a link (DiscordBridge.Unlink) */
app.post('/unlink', auth, async (req, res) => {
  const userId = Number(req.body.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'bad_request' });
  }
  const discordId = links[userId];
  if (!discordId) return res.status(404).json({ error: 'not_linked' });

  delete links[userId];
  save();

  if (VERIFIED_ROLE_ID) {
    for (const guild of client.guilds.cache.values()) {
      try {
        const member = await guild.members.fetch(discordId);
        await member.roles.remove(VERIFIED_ROLE_ID);
      } catch {
        /* not in this guild or role missing */
      }
    }
  }
  res.json({ ok: true });
});

/* Roblox game sends { userId, message, title? } to ping a player */
app.post('/notify', auth, async (req, res) => {
  const userId = Number(req.body.userId);
  const { message, title } = req.body;
  if (!Number.isInteger(userId) || !message) {
    return res.status(400).json({ error: 'bad_request' });
  }

  const discordId = links[userId];
  if (!discordId) return res.status(404).json({ error: 'not_linked' });

  const via = await notifyDiscordUser(discordId, { title, message });
  if (!via) return res.status(502).json({ error: 'could_not_deliver' });
  res.json({ ok: true, via });
});

/* Wild special-find tracker. Roblox sends this whenever a wild Pokémon spawns
   as shiny / gradient / size variant / marked. The bot records it in
   wild-stats.json and DMs the (linked) player a congratulations embed.

   Body: {
     userId, species, level?, shiny?, gradient?,
     gradientColors?: ["#RRGGBB", ...],
     size?: "tiny" | "small" | "big" | "giant", sizeScale?,
     mark?: { name, title? },
     sprite?, gamemode?, chain?, location?, robloxName?
   } */
app.post('/wild', auth, async (req, res) => {
  const b = req.body || {};
  const userId = Number(b.userId);
  const species = String(b.species || '').slice(0, 60);
  if (!Number.isInteger(userId) || userId <= 0 || !species) {
    return res.status(400).json({ error: 'bad_request' });
  }

  const shiny = Boolean(b.shiny);
  const gradient = Boolean(b.gradient);
  const sizeKey = typeof b.size === 'string' ? b.size.toLowerCase() : null;
  const sizeId = sizeKey && Object.hasOwn(SIZE_LABELS, sizeKey) ? sizeKey : null;
  const mark =
    b.mark && typeof b.mark === 'object' && b.mark.name
      ? {
          name: String(b.mark.name).slice(0, 60),
          title: b.mark.title ? String(b.mark.title).slice(0, 60) : null,
        }
      : null;

  if (!shiny && !gradient && !sizeId && !mark) {
    return res.status(400).json({ error: 'not_special' });
  }

  const discordId = links[userId];
  if (!discordId) return res.status(404).json({ error: 'not_linked' });

  /* ---- track it ---- */
  const s = getStats(userId);
  s.total += 1;
  if (shiny) s.shiny += 1;
  if (gradient) s.gradient += 1;
  if (mark) s.marks += 1;
  if (sizeId) s.sizes[sizeId] += 1;

  const tags = [];
  if (shiny) tags.push('✨ Shiny');
  if (gradient) tags.push('🌈 Gradiant');
  if (sizeId) tags.push(`📏 ${SIZE_LABELS[sizeId]}`);
  if (mark) tags.push(`🏷️ ${mark.name}`);

  s.last = `${tags.join(' ')} ${species}`.slice(0, 100);
  saveStats();

  /* ---- build the congrats embed ---- */
  const who = typeof b.robloxName === 'string' && b.robloxName ? ` ${b.robloxName.slice(0, 50)}` : '';
  const combo = tags.length >= 2;
  const lines = [
    `Congratulations${who}! 🎉`,
    `You just found a wild **${species}** that is ${tags.map((t) => `**${t.replace(/^\S+\s/, '')}**`).join(' + ')}!`,
  ];
  if (combo) lines.push('', 'That is an unreal combo — what a find! 🔥');

  let color = 0xe2231a;
  const firstGrad = Array.isArray(b.gradientColors) ? String(b.gradientColors[0] || '') : '';
  if (gradient && /^#[0-9a-f]{6}$/i.test(firstGrad)) color = parseInt(firstGrad.slice(1), 16);
  else if (shiny) color = 0xffd54f;
  else if (sizeId) color = { tiny: 0x55c7ff, small: 0x9be7ff, big: 0xffb347, giant: 0xff5a36 }[sizeId];
  else if (mark) color = 0xffd54f;

  const embed = new EmbedBuilder()
    .setTitle(`🎉 Wild ${tags.join(' ')} ${species}!`.slice(0, 256))
    .setColor(color)
    .setDescription(lines.join('\n').slice(0, 2000))
    .setTimestamp();

  const fields = [];
  if (b.level != null) fields.push({ name: 'Level', value: String(b.level).slice(0, 20), inline: true });
  if (sizeId) {
    const scale = b.sizeScale != null ? ` (x${String(b.sizeScale).slice(0, 10)})` : '';
    fields.push({ name: 'Size', value: `${SIZE_LABELS[sizeId]}${scale}`, inline: true });
  }
  if (mark) {
    fields.push({
      name: 'Mark',
      value: mark.title ? `${mark.name} — ${mark.title}` : mark.name,
      inline: true,
    });
  }
  if (gradient && Array.isArray(b.gradientColors)) {
    const hexes = b.gradientColors
      .map((c) => String(c))
      .filter((c) => /^#[0-9a-f]{6}$/i.test(c))
      .slice(0, 6);
    if (hexes.length) {
      fields.push({
        name: 'Gradiant colors',
        value: hexes.map((h) => `\`${h.toUpperCase()}\``).join(' → '),
        inline: true,
      });
    }
  }
  if (b.gamemode) fields.push({ name: 'Gamemode', value: String(b.gamemode).slice(0, 30), inline: true });
  if (b.chain != null) fields.push({ name: 'Capture chain', value: String(b.chain).slice(0, 10), inline: true });
  if (b.location) fields.push({ name: 'Location', value: String(b.location).slice(0, 40), inline: true });
  if (fields.length) embed.addFields(fields.slice(0, 10));

  if (typeof b.sprite === 'string') {
    try {
      if (new URL(b.sprite).protocol === 'https:') embed.setThumbnail(b.sprite);
    } catch {
      /* ignore bad URLs */
    }
  }

  embed.setFooter({
    text: `Wild finds so far — ✨ ${s.shiny} · 🌈 ${s.gradient} · 🏷️ ${s.marks} · 📏 ${sizeTotal(s)}`,
  });

  const via = await deliverToUser(discordId, embed);
  if (!via) return res.status(502).json({ error: 'could_not_deliver', tracked: true });
  res.json({ ok: true, via, totals: { total: s.total, shiny: s.shiny, gradient: s.gradient, marks: s.marks } });
});

/* Post a rich "showcase" embed to a named log channel (e.g. rare daycare eggs).
   Channels come from env vars named CHANNEL_<NAME>, e.g. CHANNEL_DAYCARE=<channel id>.
   Body: { channel, title, description?, color?, thumbnail?, fields?, userId?, robloxName? } */
app.post('/showcase', auth, async (req, res) => {
  const { channel, title, description, color, thumbnail, fields, userId, robloxName } = req.body || {};

  if (typeof channel !== 'string' || !/^[a-z0-9_]{1,32}$/.test(channel)) {
    return res.status(400).json({ error: 'bad_channel' });
  }
  const channelId = process.env[`CHANNEL_${channel.toUpperCase()}`];
  if (!channelId) return res.status(404).json({ error: 'channel_not_configured' });
  if (!title) return res.status(400).json({ error: 'bad_request' });

  const embed = new EmbedBuilder().setTitle(String(title).slice(0, 256)).setTimestamp();
  if (description) embed.setDescription(String(description).slice(0, 2000));

  const c = Number(color);
  if (Number.isInteger(c) && c >= 0 && c <= 0xffffff) embed.setColor(c);

  if (typeof thumbnail === 'string') {
    try {
      if (new URL(thumbnail).protocol === 'https:') embed.setThumbnail(thumbnail);
    } catch {
      /* ignore bad URLs */
    }
  }

  if (Array.isArray(fields)) {
    const clean = fields
      .filter((f) => f && f.name && f.value)
      .slice(0, 10)
      .map((f) => ({
        name: String(f.name).slice(0, 256),
        value: String(f.value).slice(0, 1000),
        inline: Boolean(f.inline),
      }));
    if (clean.length) embed.addFields(clean);
  }

  if (robloxName) embed.setFooter({ text: `Roblox: ${String(robloxName).slice(0, 50)}` });

  // Ping the player only if they linked their account. Never ping anyone else.
  const discordId = Number.isInteger(Number(userId)) ? links[Number(userId)] : undefined;
  const payload = { embeds: [embed] };
  if (discordId) {
    payload.content = `🎉 Congrats <@${discordId}>!`;
    payload.allowedMentions = { users: [discordId] };
  } else {
    payload.allowedMentions = { parse: [] };
  }

  try {
    const target = await client.channels.fetch(channelId);
    if (!target || !target.isTextBased()) return res.status(500).json({ error: 'channel_not_text' });
    await target.send(payload);
    res.json({ ok: true, pinged: Boolean(discordId) });
  } catch (err) {
    console.error('Showcase failed:', err.message);
    res.status(502).json({ error: 'could_not_deliver' });
  }
});

/* Optional: check if a Roblox user is linked */
app.get('/linked/:userId', auth, (req, res) => {
  res.json({ linked: Boolean(links[req.params.userId]) });
});

/* ------------------------------------------------------------------ */
/* Startup: web server FIRST so /health responds even if Discord fails */
/* ------------------------------------------------------------------ */
(async () => {
  app.listen(PORT, '0.0.0.0', () => console.log(`API listening on port ${PORT}`));

  try {
    await registerCommands();
  } catch (err) {
    console.error('Could not register slash commands:', err.message);
  }

  try {
    await client.login(DISCORD_TOKEN);
  } catch (err) {
    console.error('Discord login failed:', err.message);
  }
})();

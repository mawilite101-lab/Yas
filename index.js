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
 
/* ------------------------------------------------------------------ */
/* Storage (simple JSON file: { robloxId: discordId })                 */
/* ------------------------------------------------------------------ */
const DATA_FILE = path.join(__dirname, 'links.json');
let links = {};
try {
  links = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {
  links = {};
}
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(links, null, 2));
 
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
});
 
client.once('ready', () => console.log(`Logged in as ${client.user.tag}`));
 
/* Send a notification to a linked Discord user. Returns 'dm' | 'channel' | null */
async function notifyDiscordUser(discordId, { title, message }) {
  const embed = new EmbedBuilder()
    .setColor(0xe2231a)
    .setDescription(String(message).slice(0, 1000))
    .setTimestamp();
  if (title) embed.setTitle(String(title).slice(0, 200));
 
  try {
    const user = await client.users.fetch(discordId);
    await user.send({ embeds: [embed] });
    return 'dm';
  } catch {
    // DMs closed -> try the fallback channel
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
 
app.get('/health', (_req, res) => res.json({ ok: true }));
 
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
 
/* Optional: check if a Roblox user is linked */
app.get('/linked/:userId', auth, (req, res) => {
  res.json({ linked: Boolean(links[req.params.userId]) });
});
 
/* ------------------------------------------------------------------ */
(async () => {
  await registerCommands();
  await client.login(DISCORD_TOKEN);
  app.listen(PORT, () => console.log(`API listening on port ${PORT}`));
})();
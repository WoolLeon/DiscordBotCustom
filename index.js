// ── Environment: force IPv4 & DNS settings for Vietnamese ISP compatibility ──
process.env.NODE_DNS_ORDER = 'ipv4first'; // Force IPv4 DNS resolution
process.env.UUIDS_FORCE_IPV4 = '1';       // Some libs respect this flag
// Ensure voice UDP also prefers IPv4 — Discord voice uses UDP heavily
if (!process.env.DISCORD_GATEWAY_URL) {
    process.env.DISCORD_GATEWAY_URL = 'gateway.discord.gg'; // explicit hostname
}

import 'dotenv/config';
import { 
    Client, GatewayIntentBits, Partials, REST, Routes, 
    EmbedBuilder, Events, Collection, ActivityType,
    ButtonBuilder, ButtonStyle, ActionRowBuilder
} from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import * as db from './db.js';
import loadPlugins from './pluginLoader.js';
import {
    initPermissions,
    canUseCommand,
    getRequiredLevel,
    denyMessage,
} from './lib/permissions.js';
import { buildSlashCommandPayload } from './lib/slash.js';

// 1. Voice Diagnostic
console.log("--- VOICE DIAGNOSTIC REPORT ---");
console.log(generateDependencyReport());
console.log("-------------------------------");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessageReactions
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

global.client = client;
const PREFIX = process.env.PREFIX || '!';

async function start() {
    // 2. Load Plugins (Populates client.commands and client.helpData)
    await loadPlugins(client, db);
    await initPermissions(db);

    const guardCommand = async (ctx, commandName, run) => {
        const member = ctx.member;
        const guildId = ctx.guild?.id;
        if (!guildId) return run();

        if (!canUseCommand(member, guildId, commandName, client)) {
            const level = getRequiredLevel(guildId, commandName, client);
            const msg = denyMessage(level);
            if (typeof ctx.isChatInputCommand === 'function' && ctx.isChatInputCommand()) {
                return ctx.reply({ content: msg, ephemeral: true });
            }
            return ctx.reply(msg);
        }
        return run();
    };

    // 3. Centralized Help Generator (paginated)
    const HELP_PREFIX = 'help_nav';

    const buildHelpPages = () => {
        const pages = [];
        const pluginNames = [...client.helpData.keys()];

        const overview = new EmbedBuilder()
            .setTitle('🤖 Bot Command Center')
            .setColor('#00FFEE')
            .setDescription(
                '**Modular System v3.0**\nUse **Next** and **Previous** to browse commands by plugin.'
            )
            .addFields({
                name: '📋 Loaded plugins',
                value: pluginNames.length
                    ? pluginNames.map(n => `• **${n}**`).join('\n')
                    : 'No plugins loaded.',
            })
            .setThumbnail(client.user.displayAvatarURL())
            .setFooter({ text: `Overview • Page 1 of ${pluginNames.length + 1}` })
            .setTimestamp();
        pages.push(overview);

        for (const pluginName of pluginNames) {
            const helpItems = client.helpData.get(pluginName);
            const text = helpItems
                .map(h => `**${h.usage}**\n${h.description}`)
                .join('\n\n') || 'No instructions provided.';
            const pageIndex = pages.length + 1;
            const total = pluginNames.length + 1;

            pages.push(
                new EmbedBuilder()
                    .setTitle(`📦 ${pluginName}`)
                    .setColor('#00FFEE')
                    .setDescription(text.slice(0, 4096))
                    .setThumbnail(client.user.displayAvatarURL())
                    .setFooter({ text: `${pluginName} • Page ${pageIndex} of ${total}` })
                    .setTimestamp()
            );
        }
        return pages;
    };

    const buildHelpButtons = (userId, page, totalPages) => {
        if (totalPages <= 1) return [];

        return [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`${HELP_PREFIX}:${userId}:prev:${page}`)
                    .setLabel('Previous')
                    .setEmoji('◀️')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page <= 0),
                new ButtonBuilder()
                    .setCustomId(`${HELP_PREFIX}:${userId}:next:${page}`)
                    .setLabel('Next')
                    .setEmoji('▶️')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page >= totalPages - 1),
            ),
        ];
    };

    const sendHelp = (ctx) => {
        const userId = ctx.user?.id ?? ctx.author.id;
        const pages = buildHelpPages();
        const components = buildHelpButtons(userId, 0, pages.length);

        return ctx.reply({ embeds: [pages[0]], components });
    };

    const handleHelpNavigation = async (i) => {
        const [prefix, ownerId, direction, pageStr] = i.customId.split(':');
        if (prefix !== HELP_PREFIX) return false;

        if (i.user.id !== ownerId) {
            await i.reply({ content: 'Only the person who ran help can flip pages.', ephemeral: true });
            return true;
        }

        const pages = buildHelpPages();
        const totalPages = pages.length;
        let page = Number.parseInt(pageStr, 10);
        if (Number.isNaN(page)) page = 0;

        if (direction === 'next') page = Math.min(page + 1, totalPages - 1);
        else if (direction === 'prev') page = Math.max(page - 1, 0);

        await i.update({
            embeds: [pages[page]],
            components: buildHelpButtons(ownerId, page, totalPages),
        });
        return true;
    };

    // 4. Handle Slash Commands (/) and help pagination buttons
    client.on(Events.InteractionCreate, async i => {
        if (i.isButton() && i.customId.startsWith(HELP_PREFIX)) {
            try {
                await handleHelpNavigation(i);
            } catch (err) {
                console.error('Help navigation error:', err);
            }
            return;
        }

        if (!i.isChatInputCommand()) return;
        
        // Check for global help command
        if (i.commandName === 'help') return sendHelp(i);

        const cmd = client.commands.get(i.commandName);
        if (cmd) {
            try {
                await guardCommand(i, i.commandName, () => cmd.execute(i, db, true));
            } catch (err) {
                console.error(`Slash Error [${i.commandName}]:`, err);
            }
        }
    });

    // 5. Handle Prefix Commands (!)
    client.on(Events.MessageCreate, async m => {
        if (m.author.bot || !m.content.startsWith(PREFIX)) return;

        const args = m.content.slice(PREFIX.length).trim().split(/ +/);
        const name = args.shift().toLowerCase();
        
        // Check for global help command
        if (name === 'help') return sendHelp(m);

        const cmd = client.commands.get(name);
        if (cmd) {
            try {
                await guardCommand(m, name, () => cmd.execute(m, db, false, args));
            } catch (err) {
                console.error(`Prefix Error [${name}]:`, err);
            }
        }
    });

    // 6. Sync and Start
    client.once(Events.ClientReady, async () => {
        console.log(`🚀 Logged in as: ${client.user.tag}`);
        client.user.setActivity('System Core', { type: ActivityType.Watching });

        // Prepare commands for Discord API registration
        const commandsData = Array.from(client.commands.values()).map(buildSlashCommandPayload);

        // Add the help command manually to the Slash Command list
        commandsData.push({ 
            name: 'help', 
            description: 'Show all available commands and instructions' 
        });

        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        try {
            await rest.put(Routes.applicationCommands(client.user.id), { body: commandsData });
            console.log('📡 Global Slash Commands Synchronized.');
        } catch (e) { 
            console.error('❌ Slash Sync Error:', e); 
        }
    });

    client.login(process.env.DISCORD_TOKEN);
}

process.on('unhandledRejection', e => console.error('Unhandled Promise:', e));
start();
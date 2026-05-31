import { PermissionFlagsBits, ChannelType, ApplicationCommandOptionType, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, Events, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';

/**
 * Temp Channels Plugin
 * 
 * How it works:
 * 1. Admin runs !tc_setup in a category → bot creates a "➕ Create Channel" VC
 * 2. User joins that VC → bot creates a private temp VC for them and moves them in
 * 3. The temp VC is automatically deleted when it becomes empty
 * 
 * Owners can rename, set limit, lock/unlock, or transfer ownership via commands.
 */

// In-memory map of tempChannelId → ownerId (survives restarts via DB)
const tempChannels = new Map();

export default {
    name: 'Temp Channels',
    help: [
        { usage: '`!tc_setup [name] [limit]`',    description: 'Setup a "Create Channel" VC in the current category. Example: `!tc_setup Gaming 5`' },
        { usage: '`!tc_name <new name>`',          description: 'Rename your temp channel.' },
        { usage: '`!tc_limit <0-99>`',             description: 'Set user limit for your temp channel. 0 = unlimited.' },
        { usage: '`!tc_lock`',                     description: 'Lock your temp channel (only current members can stay).' },
        { usage: '`!tc_unlock`',                   description: 'Unlock your temp channel.' },
        { usage: '`!tc_claim`',                    description: 'Claim ownership of a temp channel if the owner left.' },
        { usage: '`!tc_transfer @user`',           description: 'Transfer ownership of your temp channel to another member.' },
        { usage: '`!tc_kick @user`',               description: 'Kick a user from your temp channel.' },
        { usage: '`!tc_delete`',                   description: 'Manually delete your temp channel.' },
    ],

    init: async (db) => {
        // Store which voice channels are "create" triggers per guild
        await db.query(`CREATE TABLE IF NOT EXISTS tc_settings (
            guild_id    VARCHAR(64) NOT NULL,
            channel_id  VARCHAR(64) NOT NULL,
            category_id VARCHAR(64) NOT NULL,
            default_name VARCHAR(64) DEFAULT '{username}s Channel',
            default_limit TINYINT DEFAULT 0,
            PRIMARY KEY (guild_id, channel_id)
        );`);

        // Track active temp channels so they survive bot restarts
        await db.query(`CREATE TABLE IF NOT EXISTS tc_active (
            channel_id  VARCHAR(64) PRIMARY KEY,
            guild_id    VARCHAR(64) NOT NULL,
            owner_id    VARCHAR(64) NOT NULL,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );`);

        // Load existing temp channels into memory on startup
        const active = await db.query('SELECT * FROM tc_active');
        for (const row of active) {
            tempChannels.set(row.channel_id, row.owner_id);
        }
        console.log(`✅ Temp Channels: loaded ${active.length} existing temp channel(s).`);

        // Handle button + modal interactions from the welcome board
        global.client.on(Events.InteractionCreate, async interaction => {
            if (!interaction.isButton() && !interaction.isModalSubmit()) return;
            const id = interaction.customId;
            if (!id.startsWith('tc_btn_') && !id.startsWith('tc_modal_')) return;

            // Parse: tc_btn_ACTION_CHANNELID or tc_modal_ACTION_CHANNELID
            const withoutPrefix = id.replace('tc_btn_', '').replace('tc_modal_', '');
            const underscoreIdx = withoutPrefix.indexOf('_');
            const action    = withoutPrefix.substring(0, underscoreIdx);
            const channelId = withoutPrefix.substring(underscoreIdx + 1);

            const vc = interaction.guild.channels.cache.get(channelId);
            if (!vc) return interaction.reply({ content: '❌ Channel no longer exists.', ephemeral: true });

            const ownerId = tempChannels.get(channelId);
            if (interaction.member.id !== ownerId)
                return interaction.reply({ content: '❌ Only the channel owner can use these buttons.', ephemeral: true });

            // Modal submits
            if (interaction.isModalSubmit()) {
                if (action === 'rename') {
                    const newName = interaction.fields.getTextInputValue('tc_rename_input');
                    await vc.setName(newName);
                    return interaction.reply({ content: `✅ Channel renamed to **${newName}**.`, ephemeral: true });
                }
                if (action === 'limit') {
                    const limit = Math.min(99, Math.max(0, parseInt(interaction.fields.getTextInputValue('tc_limit_input')) || 0));
                    await vc.setUserLimit(limit);
                    return interaction.reply({ content: `✅ User limit set to **${limit === 0 ? 'Unlimited' : limit}**.`, ephemeral: true });
                }
                return;
            }

            // Button actions
            if (action === 'lock') {
                await vc.permissionOverwrites.edit(interaction.guild.id, { Connect: false });
                return interaction.reply({ content: '🔒 Channel locked.', ephemeral: true });
            }
            if (action === 'unlock') {
                await vc.permissionOverwrites.edit(interaction.guild.id, { Connect: true });
                return interaction.reply({ content: '🔓 Channel unlocked.', ephemeral: true });
            }
            if (action === 'delete') {
                await db.query('DELETE FROM tc_active WHERE channel_id = ?', [channelId]);
                tempChannels.delete(channelId);
                await interaction.reply({ content: '🗑️ Deleting channel...', ephemeral: true });
                setTimeout(() => vc.delete().catch(() => {}), 1500);
                return;
            }
            if (action === 'rename') {
                const modal = new ModalBuilder()
                    .setCustomId(`tc_modal_rename_${channelId}`)
                    .setTitle('Rename Your Channel');
                modal.addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('tc_rename_input')
                        .setLabel('New channel name')
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder(vc.name)
                        .setMaxLength(32)
                        .setRequired(true)
                ));
                return interaction.showModal(modal);
            }
            if (action === 'limit') {
                const modal = new ModalBuilder()
                    .setCustomId(`tc_modal_limit_${channelId}`)
                    .setTitle('Set User Limit');
                modal.addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('tc_limit_input')
                        .setLabel('User limit (0 = unlimited, max 99)')
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder(String(vc.userLimit || 0))
                        .setMaxLength(2)
                        .setRequired(true)
                ));
                return interaction.showModal(modal);
            }
        });
    },

    commands: [
        {
            name: 'tc_setup',
            description: 'Create a "Join to Create" voice channel in this category',
            options: [
                { name: 'name',  description: 'Default channel name (use {username} as placeholder)', type: ApplicationCommandOptionType.String,  required: false },
                { name: 'limit', description: 'Default user limit (0 = unlimited)',                  type: ApplicationCommandOptionType.Integer, required: false }
            ],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.ManageChannels))
                    return ctx.reply('❌ You need **Manage Channels** permission.');

                const defaultName  = (isSlash ? ctx.options.getString('name')    : args[0]) || '{username}s Channel';
                const defaultLimit = (isSlash ? ctx.options.getInteger('limit')  : parseInt(args[1])) || 0;

                // Find the category to put the create-channel in
                // For slash: use the channel's parent. For prefix: use the current channel's parent.
                const category = ctx.channel.parent;
                if (!category) return ctx.reply('❌ This channel has no category. Run this command inside a categorized channel.');

                // Create the "Join to Create" trigger VC
                const createChannel = await ctx.guild.channels.create({
                    name:   '➕ Create Channel',
                    type:   ChannelType.GuildVoice,
                    parent: category.id,
                    permissionOverwrites: [
                        { id: ctx.guild.id, allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel] }
                    ]
                });

                await db.query(
                    'INSERT INTO tc_settings (guild_id, channel_id, category_id, default_name, default_limit) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE default_name=?, default_limit=?',
                    [ctx.guild.id, createChannel.id, category.id, defaultName, defaultLimit, defaultName, defaultLimit]
                );

                const embed = new EmbedBuilder()
                    .setTitle('✅ Temp Channels Setup')
                    .setColor('#5865F2')
                    .setDescription(`Join <#${createChannel.id}> to automatically create a private voice channel!`)
                    .addFields(
                        { name: 'Default Name',  value: defaultName,         inline: true },
                        { name: 'Default Limit', value: defaultLimit === 0 ? 'Unlimited' : `${defaultLimit} users`, inline: true },
                        { name: 'Category',      value: category.name,       inline: true }
                    );

                ctx.reply({ embeds: [embed] });
            }
        },

        // ── Owner commands (must be in a temp channel you own) ──────────────────
        {
            name: 'tc_name',
            description: 'Rename your temp channel',
            options: [{ name: 'name', description: 'New channel name', type: ApplicationCommandOptionType.String, required: true }],
            async execute(ctx, db, isSlash, args) {
                const { channel, owner } = await getTempChannel(ctx, db);
                if (!channel) return;
                const newName = isSlash ? ctx.options.getString('name') : args.join(' ');
                if (!newName) return ctx.reply('❌ Please provide a new name.');
                await channel.setName(newName);
                ctx.reply(`✅ Channel renamed to **${newName}**.`);
            }
        },

        {
            name: 'tc_limit',
            description: 'Set user limit for your temp channel (0 = unlimited)',
            options: [{ name: 'limit', description: 'User limit (0-99)', type: ApplicationCommandOptionType.Integer, required: true }],
            async execute(ctx, db, isSlash, args) {
                const { channel } = await getTempChannel(ctx, db);
                if (!channel) return;
                const limit = Math.min(99, Math.max(0, parseInt(isSlash ? ctx.options.getInteger('limit') : args[0]) || 0));
                await channel.setUserLimit(limit);
                ctx.reply(`✅ User limit set to **${limit === 0 ? 'Unlimited' : limit}**.`);
            }
        },

        {
            name: 'tc_lock',
            description: 'Lock your temp channel so no new members can join',
            async execute(ctx, db) {
                const { channel } = await getTempChannel(ctx, db);
                if (!channel) return;
                await channel.permissionOverwrites.edit(ctx.guild.id, { Connect: false });
                ctx.reply('🔒 Channel locked. Current members can stay, but no one new can join.');
            }
        },

        {
            name: 'tc_unlock',
            description: 'Unlock your temp channel',
            async execute(ctx, db) {
                const { channel } = await getTempChannel(ctx, db);
                if (!channel) return;
                await channel.permissionOverwrites.edit(ctx.guild.id, { Connect: true });
                ctx.reply('🔓 Channel unlocked.');
            }
        },

        {
            name: 'tc_claim',
            description: 'Claim ownership of a temp channel whose owner has left',
            async execute(ctx, db) {
                const vc = ctx.member.voice?.channel;
                if (!vc) return ctx.reply('❌ You must be in a voice channel to claim it.');

                const ownerId = tempChannels.get(vc.id);
                if (!ownerId) return ctx.reply('❌ This is not a temp channel.');
                if (ownerId === ctx.member.id) return ctx.reply('ℹ️ You already own this channel.');

                // Only allow claim if current owner is not in the channel
                const ownerInChannel = vc.members.has(ownerId);
                if (ownerInChannel) return ctx.reply('❌ The owner is still in the channel. You cannot claim it.');

                tempChannels.set(vc.id, ctx.member.id);
                await db.query('UPDATE tc_active SET owner_id = ? WHERE channel_id = ?', [ctx.member.id, vc.id]);
                ctx.reply(`✅ You are now the owner of **${vc.name}**.`);
            }
        },

        {
            name: 'tc_transfer',
            description: 'Transfer ownership of your temp channel to another member',
            options: [{ name: 'user', description: 'New owner', type: ApplicationCommandOptionType.User, required: true }],
            async execute(ctx, db, isSlash, args) {
                const { channel } = await getTempChannel(ctx, db);
                if (!channel) return;

                const target = isSlash
                    ? ctx.options.getMember('user')
                    : ctx.guild.members.cache.get(args[0]?.replace(/[<@!>]/g, ''));

                if (!target) return ctx.reply('❌ User not found.');
                if (target.id === ctx.member.id) return ctx.reply('❌ You already own the channel.');
                if (!channel.members.has(target.id)) return ctx.reply('❌ That user must be in the channel.');

                tempChannels.set(channel.id, target.id);
                await db.query('UPDATE tc_active SET owner_id = ? WHERE channel_id = ?', [target.id, channel.id]);
                ctx.reply(`✅ Ownership transferred to **${target.displayName}**.`);
            }
        },

        {
            name: 'tc_kick',
            description: 'Kick a user from your temp channel',
            options: [{ name: 'user', description: 'User to kick', type: ApplicationCommandOptionType.User, required: true }],
            async execute(ctx, db, isSlash, args) {
                const { channel } = await getTempChannel(ctx, db);
                if (!channel) return;

                const target = isSlash
                    ? ctx.options.getMember('user')
                    : ctx.guild.members.cache.get(args[0]?.replace(/[<@!>]/g, ''));

                if (!target) return ctx.reply('❌ User not found.');
                if (target.id === ctx.member.id) return ctx.reply('❌ You cannot kick yourself.');
                if (!channel.members.has(target.id)) return ctx.reply('❌ That user is not in your channel.');

                // Disconnect them and deny reconnect temporarily
                await target.voice.disconnect();
                await channel.permissionOverwrites.edit(target.id, { Connect: false });
                ctx.reply(`✅ **${target.displayName}** has been kicked from the channel.`);
            }
        },

        {
            name: 'tc_delete',
            description: 'Manually delete your temp channel',
            async execute(ctx, db) {
                const { channel } = await getTempChannel(ctx, db);
                if (!channel) return;
                await db.query('DELETE FROM tc_active WHERE channel_id = ?', [channel.id]);
                tempChannels.delete(channel.id);
                await channel.delete();
                // Can't reply to ctx since channel is deleted — send to text channel instead
                ctx.reply('✅ Temp channel deleted.').catch(() => {});
            }
        }
    ],

    rules: [
        {
            name: 'TempChannelCreate',
            event: 'voiceStateUpdate',
            async execute(oldState, newState, db) {
                const guild = newState.guild || oldState.guild;

                // ── User joins a "Create" trigger channel ───────────────────────
                if (newState.channelId && newState.channelId !== oldState.channelId) {
                    const settings = await db.query(
                        'SELECT * FROM tc_settings WHERE guild_id = ? AND channel_id = ?',
                        [guild.id, newState.channelId]
                    );

                    if (settings.length > 0) {
                        const cfg     = settings[0];
                        const member  = newState.member;
                        const chanName = cfg.default_name.replace('{username}', member.displayName);

                        try {
                            // Create the temp VC in the same category
                            const tempVC = await guild.channels.create({
                                name:      chanName,
                                type:      ChannelType.GuildVoice,
                                parent:    cfg.category_id,
                                userLimit: cfg.default_limit,
                                permissionOverwrites: [
                                    // Owner gets full control
                                    {
                                        id:    member.id,
                                        allow: [
                                            PermissionFlagsBits.ManageChannels,
                                            PermissionFlagsBits.MoveMembers,
                                            PermissionFlagsBits.Connect,
                                            PermissionFlagsBits.Speak
                                        ]
                                    },
                                    // Everyone else can join by default
                                    { id: guild.id, allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel] }
                                ]
                            });

                            // Move the member into their new channel
                            await member.voice.setChannel(tempVC);

                            // Track it
                            tempChannels.set(tempVC.id, member.id);
                            await db.query(
                                'INSERT INTO tc_active (channel_id, guild_id, owner_id) VALUES (?, ?, ?)',
                                [tempVC.id, guild.id, member.id]
                            );

                            // Send welcome board with buttons to the voice channel text chat
                            const board = new EmbedBuilder()
                                .setTitle(`🔊 ${chanName}`)
                                .setColor('#5865F2')
                                .setThumbnail(member.user.displayAvatarURL({ size: 64 }))
                                .setDescription(`Welcome ${member}! You own this channel.`)
                                .addFields(
                                    { name: '🔒 Lock',     value: 'Block new joins',      inline: true },
                                    { name: '🔓 Unlock',   value: 'Allow new joins',      inline: true },
                                    { name: '✏️ Rename',   value: 'Change channel name',  inline: true },
                                    { name: '👥 Limit',    value: 'Set user limit',       inline: true },
                                    { name: '👢 Kick',     value: '`!tc_kick @user`',    inline: true },
                                    { name: '🤝 Transfer', value: '`!tc_transfer @user`',inline: true }
                                )
                                .setFooter({ text: 'Channel auto-deletes when empty • Only the owner can use these buttons.' })
                                .setTimestamp();

                            const boardRow = new ActionRowBuilder().addComponents(
                                new ButtonBuilder().setCustomId(`tc_btn_lock_${tempVC.id}`).setLabel('Lock').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
                                new ButtonBuilder().setCustomId(`tc_btn_unlock_${tempVC.id}`).setLabel('Unlock').setEmoji('🔓').setStyle(ButtonStyle.Secondary),
                                new ButtonBuilder().setCustomId(`tc_btn_rename_${tempVC.id}`).setLabel('Rename').setEmoji('✏️').setStyle(ButtonStyle.Primary),
                                new ButtonBuilder().setCustomId(`tc_btn_limit_${tempVC.id}`).setLabel('Set Limit').setEmoji('👥').setStyle(ButtonStyle.Primary),
                                new ButtonBuilder().setCustomId(`tc_btn_delete_${tempVC.id}`).setLabel('Delete').setEmoji('🗑️').setStyle(ButtonStyle.Danger)
                            );

                            await tempVC.send({ content: `${member}`, embeds: [board], components: [boardRow] }).catch(() => {});

                            console.log(`🔊 Temp channel created: "${chanName}" for ${member.user.tag}`);
                        } catch (err) {
                            console.error('❌ Failed to create temp channel:', err.message);
                        }
                    }
                }

                // ── User leaves a temp channel — delete if empty ─────────────────
                if (oldState.channelId && tempChannels.has(oldState.channelId)) {
                    const channel = guild.channels.cache.get(oldState.channelId);
                    if (channel && channel.members.size === 0) {
                        try {
                            await db.query('DELETE FROM tc_active WHERE channel_id = ?', [oldState.channelId]);
                            tempChannels.delete(oldState.channelId);
                            await channel.delete();
                            console.log(`🗑️ Temp channel deleted (empty): "${channel.name}"`);
                        } catch (err) {
                            console.error('❌ Failed to delete temp channel:', err.message);
                        }
                    }
                }
            }
        }
    ]
};

// ── Helper: get the temp channel the command author owns ────────────────────
async function getTempChannel(ctx, db) {
    const vc = ctx.member.voice?.channel;
    if (!vc) {
        ctx.reply('❌ You must be in a voice channel.');
        return { channel: null, owner: null };
    }

    const ownerId = tempChannels.get(vc.id);
    if (!ownerId) {
        ctx.reply('❌ You are not in a temp channel.');
        return { channel: null, owner: null };
    }

    if (ownerId !== ctx.member.id) {
        ctx.reply('❌ You do not own this temp channel. Use `!tc_claim` if the owner has left.');
        return { channel: null, owner: null };
    }

    return { channel: vc, owner: ownerId };
}

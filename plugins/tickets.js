import {
    PermissionFlagsBits,
    ChannelType,
    ApplicationCommandOptionType,
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    Events
} from 'discord.js';

/**
 * Ticket System Plugin
 *
 * Flow:
 * 1. Admin runs !ticket_setup → bot posts a panel with a "Open Ticket" button
 * 2. User clicks button → bot creates a private #ticket-username channel
 * 3. Staff can claim, add/remove users, or close the ticket
 * 4. Closing saves a transcript and deletes the channel after 5s
 */

export default {
    name: 'Ticket System',
    help: [
        { usage: '`!ticket_setup [category] [description]`', description: 'Post a ticket panel with an Open Ticket button. Run in the channel where the panel should appear.' },
        { usage: '`!ticket_close [reason]`',                 description: 'Close the current ticket (saves transcript).' },
        { usage: '`!ticket_add @user`',                      description: 'Add a user to the current ticket.' },
        { usage: '`!ticket_remove @user`',                   description: 'Remove a user from the current ticket.' },
        { usage: '`!ticket_claim`',                          description: 'Claim the ticket as the handling staff member.' },
        { usage: '`!ticket_rename <name>`',                  description: 'Rename the current ticket channel.' },
    ],

    init: async (db) => {
        await db.query(`CREATE TABLE IF NOT EXISTS ticket_settings (
            guild_id        VARCHAR(64) PRIMARY KEY,
            panel_channel   VARCHAR(64),
            category_id     VARCHAR(64),
            log_channel     VARCHAR(64),
            staff_role      VARCHAR(64),
            ticket_count    INT DEFAULT 0
        );`);

        await db.query(`CREATE TABLE IF NOT EXISTS tickets (
            channel_id  VARCHAR(64) PRIMARY KEY,
            guild_id    VARCHAR(64) NOT NULL,
            owner_id    VARCHAR(64) NOT NULL,
            claimed_by  VARCHAR(64),
            status      ENUM('open','closed') DEFAULT 'open',
            opened_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            closed_at   TIMESTAMP NULL,
            reason      TEXT
        );`);

        // Handle button interactions (Open Ticket button on the panel)
        global.client.on(Events.InteractionCreate, async interaction => {
            if (!interaction.isButton()) return;

            // ── Open Ticket button ───────────────────────────────────────────
            if (interaction.customId === 'ticket_open') {
                await interaction.deferReply({ ephemeral: true });

                const guild    = interaction.guild;
                const member   = interaction.member;
                const settings = await db.query('SELECT * FROM ticket_settings WHERE guild_id = ?', [guild.id]);
                if (!settings.length) return interaction.editReply({ content: '❌ Ticket system not configured.' });

                const cfg = settings[0];

                // Check if user already has an open ticket
                const existing = await db.query(
                    "SELECT channel_id FROM tickets WHERE guild_id = ? AND owner_id = ? AND status = 'open'",
                    [guild.id, member.id]
                );
                if (existing.length) {
                    return interaction.editReply({ content: `❌ You already have an open ticket: <#${existing[0].channel_id}>` });
                }

                // Increment ticket count
                await db.query('UPDATE ticket_settings SET ticket_count = ticket_count + 1 WHERE guild_id = ?', [guild.id]);
                const countRes = await db.query('SELECT ticket_count FROM ticket_settings WHERE guild_id = ?', [guild.id]);
                const ticketNum = String(countRes[0].ticket_count).padStart(4, '0');

                try {
                    // Build permission overwrites
                    const overwrites = [
                        // Hide from everyone by default
                        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                        // Owner can see and write
                        {
                            id: member.id,
                            allow: [
                                PermissionFlagsBits.ViewChannel,
                                PermissionFlagsBits.SendMessages,
                                PermissionFlagsBits.ReadMessageHistory,
                                PermissionFlagsBits.AttachFiles
                            ]
                        }
                    ];

                    // Staff role can see all tickets
                    if (cfg.staff_role) {
                        overwrites.push({
                            id:    cfg.staff_role,
                            allow: [
                                PermissionFlagsBits.ViewChannel,
                                PermissionFlagsBits.SendMessages,
                                PermissionFlagsBits.ReadMessageHistory,
                                PermissionFlagsBits.ManageMessages,
                                PermissionFlagsBits.AttachFiles
                            ]
                        });
                    }

                    const ticketChannel = await guild.channels.create({
                        name:   `ticket-${ticketNum}`,
                        type:   ChannelType.GuildText,
                        parent: cfg.category_id || null,
                        permissionOverwrites: overwrites,
                        topic:  `Ticket by ${member.user.tag} | Opened: ${new Date().toUTCString()}`
                    });

                    // Save ticket to DB
                    await db.query(
                        'INSERT INTO tickets (channel_id, guild_id, owner_id) VALUES (?, ?, ?)',
                        [ticketChannel.id, guild.id, member.id]
                    );

                    // Post welcome embed with close button in ticket channel
                    const closeBtn = new ButtonBuilder()
                        .setCustomId('ticket_close_btn')
                        .setLabel('🔒 Close Ticket')
                        .setStyle(ButtonStyle.Danger);

                    const claimBtn = new ButtonBuilder()
                        .setCustomId('ticket_claim_btn')
                        .setLabel('🙋 Claim')
                        .setStyle(ButtonStyle.Primary);

                    const row = new ActionRowBuilder().addComponents(claimBtn, closeBtn);

                    const embed = new EmbedBuilder()
                        .setTitle(`🎫 Ticket #${ticketNum}`)
                        .setColor('#5865F2')
                        .setDescription(`Hello ${member}, support will be with you shortly.\n\nDescribe your issue below and a staff member will assist you.`)
                        .addFields({ name: 'Opened by', value: `${member}`, inline: true })
                        .setTimestamp();

                    await ticketChannel.send({ content: `${member}${cfg.staff_role ? ` <@&${cfg.staff_role}>` : ''}`, embeds: [embed], components: [row] });

                    await interaction.editReply({ content: `✅ Your ticket has been created: ${ticketChannel}` });
                    console.log(`🎫 Ticket #${ticketNum} opened by ${member.user.tag}`);

                } catch (err) {
                    console.error('❌ Ticket creation error:', err.message);
                    await interaction.editReply({ content: '❌ Failed to create ticket. Check bot permissions.' });
                }
            }

            // ── Close button (inside ticket channel) ────────────────────────
            if (interaction.customId === 'ticket_close_btn') {
                await interaction.deferReply();
                await closeTicket(interaction.channel, interaction.member, db, 'Closed via button');
            }

            // ── Claim button ─────────────────────────────────────────────────
            if (interaction.customId === 'ticket_claim_btn') {
                const ticket = await db.query("SELECT * FROM tickets WHERE channel_id = ? AND status = 'open'", [interaction.channel.id]);
                if (!ticket.length) return interaction.reply({ content: '❌ This is not an open ticket.', ephemeral: true });
                if (ticket[0].claimed_by) return interaction.reply({ content: `❌ Already claimed by <@${ticket[0].claimed_by}>.`, ephemeral: true });

                await db.query('UPDATE tickets SET claimed_by = ? WHERE channel_id = ?', [interaction.member.id, interaction.channel.id]);
                await interaction.reply({ embeds: [
                    new EmbedBuilder()
                        .setDescription(`🙋 **${interaction.member.displayName}** has claimed this ticket.`)
                        .setColor('#57F287')
                ] });
            }
        });
    },

    commands: [
        {
            name: 'ticket_setup',
            description: 'Post a ticket panel and configure the ticket system',
            options: [
                { name: 'staff_role',   description: 'Role that can see all tickets',           type: ApplicationCommandOptionType.Role,    required: false },
                { name: 'category',     description: 'Category where tickets are created',       type: ApplicationCommandOptionType.Channel, required: false },
                { name: 'log_channel',  description: 'Channel to log closed tickets/transcripts', type: ApplicationCommandOptionType.Channel, required: false },
                { name: 'description',  description: 'Panel description text',                   type: ApplicationCommandOptionType.String,  required: false },
            ],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.ManageGuild))
                    return ctx.reply('❌ You need **Manage Server** permission.');

                const staffRole  = isSlash ? ctx.options.getRole('staff_role')?.id       : null;
                const categoryId = isSlash ? ctx.options.getChannel('category')?.id      : null;
                const logChanId  = isSlash ? ctx.options.getChannel('log_channel')?.id   : null;
                const desc       = (isSlash ? ctx.options.getString('description') : args.join(' ')) || 'Click the button below to open a support ticket.';

                // Save / update settings
                await db.query(`INSERT INTO ticket_settings (guild_id, panel_channel, category_id, log_channel, staff_role)
                    VALUES (?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE panel_channel=?, category_id=?, log_channel=?, staff_role=?`,
                    [ctx.guild.id, ctx.channel.id, categoryId, logChanId, staffRole,
                                   ctx.channel.id, categoryId, logChanId, staffRole]
                );

                // Post the panel
                const openBtn = new ButtonBuilder()
                    .setCustomId('ticket_open')
                    .setLabel('🎫 Open Ticket')
                    .setStyle(ButtonStyle.Primary);

                const row = new ActionRowBuilder().addComponents(openBtn);

                const embed = new EmbedBuilder()
                    .setTitle('🎫 Support Tickets')
                    .setColor('#5865F2')
                    .setDescription(desc)
                    .addFields(
                        { name: 'Staff Role',    value: staffRole  ? `<@&${staffRole}>` : 'Not set', inline: true },
                        { name: 'Log Channel',   value: logChanId  ? `<#${logChanId}>`  : 'Not set', inline: true },
                        { name: 'Category',      value: categoryId ? `<#${categoryId}>` : 'Current', inline: true }
                    )
                    .setFooter({ text: 'One ticket per user at a time.' })
                    .setTimestamp();

                await ctx.channel.send({ embeds: [embed], components: [row] });
                ctx.reply({ content: '✅ Ticket panel posted!', ephemeral: true }).catch(() => ctx.reply('✅ Ticket panel posted!'));
            }
        },

        {
            name: 'ticket_close',
            description: 'Close the current ticket',
            options: [{ name: 'reason', description: 'Reason for closing', type: ApplicationCommandOptionType.String, required: false }],
            async execute(ctx, db, isSlash, args) {
                const reason = (isSlash ? ctx.options.getString('reason') : args.join(' ')) || 'No reason provided';
                await ctx.reply('🔒 Closing ticket...');
                await closeTicket(ctx.channel, ctx.member, db, reason);
            }
        },

        {
            name: 'ticket_add',
            description: 'Add a user to this ticket',
            options: [{ name: 'user', description: 'User to add', type: ApplicationCommandOptionType.User, required: true }],
            async execute(ctx, db, isSlash, args) {
                const ticket = await getOpenTicket(ctx, db);
                if (!ticket) return;

                const target = isSlash
                    ? ctx.options.getMember('user')
                    : ctx.guild.members.cache.get(args[0]?.replace(/[<@!>]/g, ''));

                if (!target) return ctx.reply('❌ User not found.');

                await ctx.channel.permissionOverwrites.edit(target.id, {
                    ViewChannel:        true,
                    SendMessages:       true,
                    ReadMessageHistory: true,
                    AttachFiles:        true
                });
                ctx.reply(`✅ Added ${target} to the ticket.`);
            }
        },

        {
            name: 'ticket_remove',
            description: 'Remove a user from this ticket',
            options: [{ name: 'user', description: 'User to remove', type: ApplicationCommandOptionType.User, required: true }],
            async execute(ctx, db, isSlash, args) {
                const ticket = await getOpenTicket(ctx, db);
                if (!ticket) return;

                const target = isSlash
                    ? ctx.options.getMember('user')
                    : ctx.guild.members.cache.get(args[0]?.replace(/[<@!>]/g, ''));

                if (!target) return ctx.reply('❌ User not found.');
                if (target.id === ticket.owner_id) return ctx.reply('❌ Cannot remove the ticket owner.');

                await ctx.channel.permissionOverwrites.edit(target.id, { ViewChannel: false });
                ctx.reply(`✅ Removed ${target} from the ticket.`);
            }
        },

        {
            name: 'ticket_claim',
            description: 'Claim this ticket as your responsibility',
            async execute(ctx, db) {
                const ticket = await getOpenTicket(ctx, db);
                if (!ticket) return;
                if (ticket.claimed_by) return ctx.reply(`❌ Already claimed by <@${ticket.claimed_by}>.`);

                await db.query('UPDATE tickets SET claimed_by = ? WHERE channel_id = ?', [ctx.member.id, ctx.channel.id]);
                ctx.reply({ embeds: [
                    new EmbedBuilder()
                        .setDescription(`🙋 **${ctx.member.displayName}** has claimed this ticket.`)
                        .setColor('#57F287')
                ] });
            }
        },

        {
            name: 'ticket_rename',
            description: 'Rename this ticket channel',
            options: [{ name: 'name', description: 'New channel name', type: ApplicationCommandOptionType.String, required: true }],
            async execute(ctx, db, isSlash, args) {
                const ticket = await getOpenTicket(ctx, db);
                if (!ticket) return;
                const name = isSlash ? ctx.options.getString('name') : args.join('-').toLowerCase();
                await ctx.channel.setName(name);
                ctx.reply(`✅ Ticket renamed to **${name}**.`);
            }
        }
    ],

    rules: [] // All event handling done via client.on in init() for button interactions
};

// ── Helper: verify command is run inside an open ticket ─────────────────────
async function getOpenTicket(ctx, db) {
    const rows = await db.query("SELECT * FROM tickets WHERE channel_id = ? AND status = 'open'", [ctx.channel.id]);
    if (!rows.length) {
        ctx.reply('❌ This command can only be used inside an open ticket channel.');
        return null;
    }
    return rows[0];
}

// ── Helper: close a ticket, post transcript, delete channel ─────────────────
async function closeTicket(channel, closedBy, db, reason) {
    const ticket = await db.query("SELECT * FROM tickets WHERE channel_id = ? AND status = 'open'", [channel.id]);
    if (!ticket.length) return channel.send('❌ This is not an open ticket.').catch(() => {});

    const row = ticket[0];

    // Fetch last 100 messages for a simple transcript
    const messages = await channel.messages.fetch({ limit: 100 });
    const transcript = [...messages.values()]
        .reverse()
        .map(m => `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content || '[attachment/embed]'}`)
        .join('\n');

    // Update DB
    await db.query(
        "UPDATE tickets SET status = 'closed', closed_at = NOW(), claimed_by = COALESCE(claimed_by, ?), reason = ? WHERE channel_id = ?",
        [closedBy.id, reason, channel.id]
    );

    // Try to log transcript to log channel
    const settings = await db.query('SELECT * FROM ticket_settings WHERE guild_id = ?', [channel.guild.id]);
    if (settings.length && settings[0].log_channel) {
        const logChannel = channel.guild.channels.cache.get(settings[0].log_channel);
        if (logChannel) {
            const logEmbed = new EmbedBuilder()
                .setTitle(`🎫 Ticket Closed`)
                .setColor('#ED4245')
                .addFields(
                    { name: 'Channel',   value: channel.name,             inline: true },
                    { name: 'Owner',     value: `<@${row.owner_id}>`,     inline: true },
                    { name: 'Closed by', value: `${closedBy}`,            inline: true },
                    { name: 'Reason',    value: reason,                   inline: false },
                    { name: 'Opened',    value: new Date(row.opened_at).toUTCString(), inline: true },
                    { name: 'Closed',    value: new Date().toUTCString(), inline: true }
                )
                .setTimestamp();

            const transcriptBuffer = Buffer.from(transcript, 'utf-8');
            await logChannel.send({
                embeds: [logEmbed],
                files: [{
                    attachment: transcriptBuffer,
                    name:       `transcript-${channel.name}.txt`
                }]
            }).catch(err => console.error('❌ Failed to log transcript:', err.message));
        }
    }

    // Notify and delete
    await channel.send({
        embeds: [
            new EmbedBuilder()
                .setDescription(`🔒 Ticket closed by **${closedBy.displayName}**.\nReason: ${reason}\n\nThis channel will be deleted in 5 seconds.`)
                .setColor('#ED4245')
        ]
    }).catch(() => {});

    setTimeout(() => channel.delete().catch(() => {}), 5000);
}

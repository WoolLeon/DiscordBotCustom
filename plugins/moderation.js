import {
    PermissionFlagsBits,
    ApplicationCommandOptionType,
    EmbedBuilder,
} from 'discord.js';

const canModerate = (mod, target) => {
    if (!target) return { ok: false, msg: '❌ User not found.' };
    if (target.id === mod.id) return { ok: false, msg: '❌ You cannot target yourself.' };
    if (target.user?.bot || target.bot) return { ok: false, msg: '❌ You cannot target bots.' };
    if (target.roles.highest.position >= mod.roles.highest.position)
        return { ok: false, msg: '❌ Target has an equal or higher role than you.' };
    return { ok: true };
};

const resolveMember = async (ctx, isSlash, argIndex = 0) => {
    if (isSlash) return ctx.options.getMember('user') ?? null;
    const id = ctx.mentions.members.first()?.id
        ?? ctx.content.match(/<@!?(\d+)>/)?.[1]
        ?? ctx.content.split(/\s+/)[argIndex]?.replace(/\D/g, '');
    if (!id) return null;
    return ctx.guild.members.cache.get(id)
        ?? await ctx.guild.members.fetch(id).catch(() => null);
};

export default {
    name: 'Moderation',
    help: [
        { usage: '`!kick @user [reason]`', description: 'Kick a member from the server.' },
        { usage: '`!ban @user [reason]`', description: 'Ban a member (optional days of messages: 0–7).' },
        { usage: '`!unban <user ID>`', description: 'Unban a user by their Discord ID.' },
        { usage: '`!timeout @user <minutes> [reason]`', description: 'Timeout (mute) a member.' },
        { usage: '`!untimeout @user`', description: 'Remove a member\'s timeout.' },
        { usage: '`!slowmode <seconds>`', description: 'Set slowmode on this channel (0 to disable).' },
    ],

    commands: [
        {
            name: 'kick',
            description: 'Kick a member',
            options: [
                { name: 'user', type: ApplicationCommandOptionType.User, required: true },
                { name: 'reason', type: ApplicationCommandOptionType.String, required: false },
            ],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.KickMembers))
                    return ctx.reply('❌ You need **Kick Members**.');

                const target = await resolveMember(ctx, isSlash);
                const check = canModerate(ctx.member, target);
                if (!check.ok) return ctx.reply(check.msg);

                const reason = (isSlash ? ctx.options.getString('reason') : args.slice(1).join(' '))
                    || 'No reason provided';

                await target.kick(reason);
                const embed = new EmbedBuilder()
                    .setTitle('👢 Member Kicked')
                    .setColor('#E67E22')
                    .addFields(
                        { name: 'User', value: `${target.user.tag}`, inline: true },
                        { name: 'Moderator', value: `${ctx.member}`, inline: true },
                        { name: 'Reason', value: reason, inline: false },
                    )
                    .setTimestamp();
                ctx.reply({ embeds: [embed] });
            },
        },
        {
            name: 'ban',
            description: 'Ban a member',
            options: [
                { name: 'user', type: ApplicationCommandOptionType.User, required: true },
                { name: 'reason', type: ApplicationCommandOptionType.String, required: false },
                { name: 'delete_days', description: 'Days of messages to delete (0–7)', type: ApplicationCommandOptionType.Integer, required: false },
            ],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.BanMembers))
                    return ctx.reply('❌ You need **Ban Members**.');

                const target = await resolveMember(ctx, isSlash);
                const check = canModerate(ctx.member, target);
                if (!check.ok) return ctx.reply(check.msg);

                const reason = (isSlash ? ctx.options.getString('reason') : args.slice(1).join(' '))
                    || 'No reason provided';
                const deleteDays = Math.min(7, Math.max(0,
                    isSlash ? (ctx.options.getInteger('delete_days') ?? 0) : 0
                ));

                await target.ban({ reason, deleteMessageSeconds: deleteDays * 86400 });
                const embed = new EmbedBuilder()
                    .setTitle('🔨 Member Banned')
                    .setColor('#ED4245')
                    .addFields(
                        { name: 'User', value: `${target.user.tag}`, inline: true },
                        { name: 'Moderator', value: `${ctx.member}`, inline: true },
                        { name: 'Reason', value: reason, inline: false },
                    )
                    .setTimestamp();
                ctx.reply({ embeds: [embed] });
            },
        },
        {
            name: 'unban',
            description: 'Unban a user by ID',
            options: [
                { name: 'user_id', description: 'Discord user ID', type: ApplicationCommandOptionType.String, required: true },
            ],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.BanMembers))
                    return ctx.reply('❌ You need **Ban Members**.');

                const userId = isSlash
                    ? ctx.options.getString('user_id')
                    : args[0]?.replace(/\D/g, '');
                if (!userId) return ctx.reply('❌ Provide a valid user ID.');

                await ctx.guild.members.unban(userId).catch(() => null);
                ctx.reply(`✅ Unbanned user \`${userId}\`.`);
            },
        },
        {
            name: 'timeout',
            description: 'Timeout a member',
            options: [
                { name: 'user', type: ApplicationCommandOptionType.User, required: true },
                { name: 'minutes', type: ApplicationCommandOptionType.Integer, required: true },
                { name: 'reason', type: ApplicationCommandOptionType.String, required: false },
            ],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.ModerateMembers))
                    return ctx.reply('❌ You need **Timeout Members**.');

                const target = await resolveMember(ctx, isSlash);
                const check = canModerate(ctx.member, target);
                if (!check.ok) return ctx.reply(check.msg);

                const minutes = isSlash
                    ? ctx.options.getInteger('minutes')
                    : parseInt(args[1], 10);
                if (!minutes || minutes < 1 || minutes > 40320)
                    return ctx.reply('❌ Duration must be between 1 and 40320 minutes (28 days).');

                const reason = (isSlash ? ctx.options.getString('reason') : args.slice(2).join(' '))
                    || 'No reason provided';

                await target.timeout(minutes * 60_000, reason);
                ctx.reply(`✅ Timed out ${target} for **${minutes}** minute(s).\n**Reason:** ${reason}`);
            },
        },
        {
            name: 'untimeout',
            description: 'Remove a member timeout',
            options: [
                { name: 'user', type: ApplicationCommandOptionType.User, required: true },
            ],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.ModerateMembers))
                    return ctx.reply('❌ You need **Timeout Members**.');

                const target = await resolveMember(ctx, isSlash);
                if (!target) return ctx.reply('❌ User not found.');

                await target.timeout(null);
                ctx.reply(`✅ Removed timeout from ${target}.`);
            },
        },
        {
            name: 'slowmode',
            description: 'Set channel slowmode in seconds',
            options: [
                { name: 'seconds', description: '0–21600 (6 hours)', type: ApplicationCommandOptionType.Integer, required: true },
            ],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.ManageChannels))
                    return ctx.reply('❌ You need **Manage Channels**.');

                const seconds = isSlash
                    ? ctx.options.getInteger('seconds')
                    : parseInt(args[0], 10);
                if (seconds === undefined || seconds === null || Number.isNaN(seconds) || seconds < 0 || seconds > 21600)
                    return ctx.reply('❌ Slowmode must be between 0 and 21600 seconds.');

                await ctx.channel.setRateLimitPerUser(seconds);
                ctx.reply(seconds === 0
                    ? '✅ Slowmode disabled for this channel.'
                    : `✅ Slowmode set to **${seconds}** second(s).`);
            },
        },
    ],
};

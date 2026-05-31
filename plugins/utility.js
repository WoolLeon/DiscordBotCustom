import {
    ApplicationCommandOptionType,
    EmbedBuilder,
    ChannelType,
} from 'discord.js';

const fmt = (n) => n?.toLocaleString?.() ?? String(n);

export default {
    name: 'Utility',
    help: [
        { usage: '`!ping`', description: 'Show bot and API latency.' },
        { usage: '`!serverinfo`', description: 'Display server statistics.' },
        { usage: '`!userinfo [@user]`', description: 'Display user information.' },
        { usage: '`!avatar [@user]`', description: 'Show a user\'s avatar.' },
        { usage: '`!poll <question> | opt1 | opt2 [| opt3 | opt4]`', description: 'Create a reaction poll (2–4 options).' },
    ],

    commands: [
        {
            name: 'ping',
            description: 'Show bot latency',
            async execute(ctx) {
                const start = Date.now();
                const sent = await ctx.reply('🏓 Pinging...');
                const roundtrip = Date.now() - start;
                const ws = ctx.client.ws.ping;
                const embed = new EmbedBuilder()
                    .setTitle('🏓 Pong!')
                    .setColor('#57F287')
                    .addFields(
                        { name: 'Roundtrip', value: `${roundtrip}ms`, inline: true },
                        { name: 'WebSocket', value: `${ws}ms`, inline: true },
                    );
                await sent.edit({ content: null, embeds: [embed] });
            },
        },
        {
            name: 'serverinfo',
            description: 'Show server information',
            async execute(ctx) {
                const g = ctx.guild;
                await g.members.fetch().catch(() => {});
                const embed = new EmbedBuilder()
                    .setTitle(g.name)
                    .setThumbnail(g.iconURL({ size: 256 }))
                    .setColor('#5865F2')
                    .addFields(
                        { name: 'Owner', value: `<@${g.ownerId}>`, inline: true },
                        { name: 'Members', value: fmt(g.memberCount), inline: true },
                        { name: 'Channels', value: `${g.channels.cache.filter(c => c.type === ChannelType.GuildText).size} text / ${g.channels.cache.filter(c => c.type === ChannelType.GuildVoice).size} voice`, inline: true },
                        { name: 'Roles', value: fmt(g.roles.cache.size), inline: true },
                        { name: 'Created', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R>`, inline: true },
                        { name: 'Boosts', value: fmt(g.premiumSubscriptionCount ?? 0), inline: true },
                    )
                    .setFooter({ text: `ID: ${g.id}` })
                    .setTimestamp();
                ctx.reply({ embeds: [embed] });
            },
        },
        {
            name: 'userinfo',
            description: 'Show user information',
            options: [
                { name: 'user', type: ApplicationCommandOptionType.User, required: false },
            ],
            async execute(ctx, db, isSlash, args) {
                const user = isSlash
                    ? (ctx.options.getUser('user') ?? ctx.user)
                    : (ctx.mentions.users.first() ?? ctx.author);
                const member = await ctx.guild.members.fetch(user.id).catch(() => null);

                const embed = new EmbedBuilder()
                    .setTitle(user.tag)
                    .setThumbnail(user.displayAvatarURL({ size: 256 }))
                    .setColor(member?.displayHexColor ?? '#5865F2')
                    .addFields(
                        { name: 'ID', value: user.id, inline: true },
                        { name: 'Bot', value: user.bot ? 'Yes' : 'No', inline: true },
                        { name: 'Joined', value: member ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'N/A', inline: true },
                        { name: 'Account created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
                    )
                    .setTimestamp();

                if (member?.roles.cache.size > 1) {
                    const roles = member.roles.cache
                        .filter(r => r.id !== ctx.guild.id)
                        .sort((a, b) => b.position - a.position)
                        .map(r => r.toString())
                        .slice(0, 12)
                        .join(' ');
                    embed.addFields({ name: 'Roles', value: roles || 'None' });
                }

                ctx.reply({ embeds: [embed] });
            },
        },
        {
            name: 'avatar',
            description: 'Show a user avatar',
            options: [
                { name: 'user', type: ApplicationCommandOptionType.User, required: false },
            ],
            async execute(ctx, db, isSlash) {
                const user = isSlash
                    ? (ctx.options.getUser('user') ?? ctx.user)
                    : (ctx.mentions.users.first() ?? ctx.author);
                const url = user.displayAvatarURL({ size: 4096, extension: 'png' });
                const embed = new EmbedBuilder()
                    .setTitle(`${user.tag}'s avatar`)
                    .setImage(url)
                    .setColor('#5865F2');
                ctx.reply({ embeds: [embed] });
            },
        },
        {
            name: 'poll',
            description: 'Create a reaction poll',
            options: [
                { name: 'question', type: ApplicationCommandOptionType.String, required: true },
                { name: 'option1', type: ApplicationCommandOptionType.String, required: true },
                { name: 'option2', type: ApplicationCommandOptionType.String, required: true },
                { name: 'option3', type: ApplicationCommandOptionType.String, required: false },
                { name: 'option4', type: ApplicationCommandOptionType.String, required: false },
            ],
            async execute(ctx, db, isSlash, args) {
                let question, options;
                if (isSlash) {
                    question = ctx.options.getString('question');
                    options = ['option1', 'option2', 'option3', 'option4']
                        .map(k => ctx.options.getString(k))
                        .filter(Boolean);
                } else {
                    const parts = args.join(' ').split('|').map(s => s.trim()).filter(Boolean);
                    if (parts.length < 3)
                        return ctx.reply('❌ Usage: `!poll Question | Option A | Option B [| C | D]`');
                    question = parts[0];
                    options = parts.slice(1);
                }

                if (options.length < 2 || options.length > 4)
                    return ctx.reply('❌ Polls need 2–4 options.');

                const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
                const lines = options.map((o, i) => `${emojis[i]} ${o}`).join('\n');
                const embed = new EmbedBuilder()
                    .setTitle('📊 ' + question)
                    .setDescription(lines)
                    .setColor('#FEE75C')
                    .setFooter({ text: `Poll by ${ctx.member?.displayName ?? ctx.author.username}` });

                const msg = ctx.commandId
                    ? await ctx.reply({ embeds: [embed], fetchReply: true })
                    : await ctx.reply({ embeds: [embed] });
                for (let i = 0; i < options.length; i++) {
                    await msg.react(emojis[i]).catch(() => {});
                }
            },
        },
    ],
};

import { ApplicationCommandOptionType, EmbedBuilder } from 'discord.js';

const RESPONSES = {
    yes: [
        'It is certain.',
        'It is decidedly so.',
        'Without a doubt.',
        'Yes — definitely.',
        'You may rely on it.',
        'As I see it, yes.',
        'Most likely.',
        'Outlook good.',
        'Yes.',
        'Signs point to yes.',
    ],
    maybe: [
        'Reply hazy, try again.',
        'Ask again later.',
        'Better not tell you now.',
        'Cannot predict now.',
        'Concentrate and ask again.',
    ],
    no: [
        'Don\'t count on it.',
        'My reply is no.',
        'My sources say no.',
        'Outlook not so good.',
        'Very doubtful.',
    ],
};

const POOL = [
    ...RESPONSES.yes.map((text) => ({ text, kind: 'yes' })),
    ...RESPONSES.maybe.map((text) => ({ kind: 'maybe', text })),
    ...RESPONSES.no.map((text) => ({ text, kind: 'no' })),
];

const KIND_META = {
    yes: { color: 0x57f287, label: 'Yes' },
    maybe: { color: 0xfee75c, label: 'Unclear' },
    no: { color: 0xed4245, label: 'No' },
};

function pickAnswer() {
    return POOL[Math.floor(Math.random() * POOL.length)];
}

function getQuestion(ctx, isSlash, args) {
    if (isSlash) return ctx.options.getString('question')?.trim() || '';
    return args.join(' ').trim();
}

export default {
    name: '8-Ball',
    help: [
        { usage: '`!8ball <question>`', description: 'Ask the magic 8-ball a yes/no question.' },
        { usage: '`/8ball question:<text>`', description: 'Same as above (slash command).' },
    ],

    commands: [
        {
            name: '8ball',
            description: 'Ask the magic 8-ball a question',
            options: [
                {
                    name: 'question',
                    type: ApplicationCommandOptionType.String,
                    description: 'Your yes/no question',
                    required: true,
                },
            ],
            async execute(ctx, db, isSlash, args) {
                const question = getQuestion(ctx, isSlash, args);
                if (!question) {
                    return ctx.reply('❌ Ask a yes/no question, e.g. `!8ball Will it rain tomorrow?`');
                }

                const thinking = await ctx.reply('🎱 *shaking...*');
                await new Promise((r) => setTimeout(r, 900));

                const { text, kind } = pickAnswer();
                const meta = KIND_META[kind];

                const embed = new EmbedBuilder()
                    .setTitle('🎱 Magic 8-Ball')
                    .setColor(meta.color)
                    .addFields(
                        { name: 'Question', value: question.slice(0, 1024) },
                        { name: 'Answer', value: `**${text}**` },
                        { name: 'Verdict', value: meta.label, inline: true },
                    )
                    .setFooter({ text: `Asked by ${ctx.user?.tag ?? ctx.author?.tag ?? 'someone'}` })
                    .setTimestamp();

                await thinking.edit({ content: null, embeds: [embed] });
            },
        },
    ],
};

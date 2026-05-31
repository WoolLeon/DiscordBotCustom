import { ApplicationCommandOptionType } from 'discord.js';

export default {
    name: 'Fun',
    help: [
        { usage: '`!coinflip`', description: 'Flip a coin (heads or tails).' },
        { usage: '`!roll [sides]`', description: 'Roll a die (default 6 sides, max 1000).' },
        { usage: '`!choose opt1 | opt2 | opt3`', description: 'Pick a random option.' },
    ],

    commands: [
        {
            name: 'coinflip',
            description: 'Flip a coin',
            async execute(ctx) {
                const result = Math.random() < 0.5 ? 'Heads' : 'Tails';
                ctx.reply(`🪙 **${result}**!`);
            },
        },
        {
            name: 'roll',
            description: 'Roll a die',
            options: [
                { name: 'sides', type: ApplicationCommandOptionType.Integer, required: false },
            ],
            async execute(ctx, db, isSlash, args) {
                const sides = Math.min(1000, Math.max(2,
                    isSlash ? (ctx.options.getInteger('sides') ?? 6) : (parseInt(args[0], 10) || 6)
                ));
                const result = Math.floor(Math.random() * sides) + 1;
                ctx.reply(`🎲 Rolled **${result}** (1–${sides}).`);
            },
        },
        {
            name: 'choose',
            description: 'Pick a random option',
            options: [
                { name: 'options', description: 'Separated by |', type: ApplicationCommandOptionType.String, required: true },
            ],
            async execute(ctx, db, isSlash, args) {
                const raw = isSlash ? ctx.options.getString('options') : args.join(' ');
                const options = raw.split('|').map(s => s.trim()).filter(Boolean);
                if (options.length < 2) return ctx.reply('❌ Provide at least 2 options separated by `|`.');
                const pick = options[Math.floor(Math.random() * options.length)];
                ctx.reply(`🎯 I choose: **${pick}**`);
            },
        },
    ],
};

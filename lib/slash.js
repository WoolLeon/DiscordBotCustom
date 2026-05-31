import { ApplicationCommandOptionType } from 'discord.js';

const SUB_TYPES = new Set([
    ApplicationCommandOptionType.Subcommand,
    ApplicationCommandOptionType.SubcommandGroup,
]);

/** Turn `ping_role` into `Ping role` for a fallback option description. */
export function defaultOptionDescription(name) {
    const text = String(name || 'option')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
    return text.slice(0, 100);
}

/**
 * Discord requires every slash command option to have a description.
 * Plugins may omit them for prefix-only ergonomics — fill gaps here.
 */
export function normalizeSlashOptions(options) {
    if (!options?.length) return [];

    return options.map((opt) => {
        const out = { ...opt };

        if (!out.description?.trim()) {
            out.description = defaultOptionDescription(out.name);
        } else {
            out.description = out.description.slice(0, 100);
        }

        if (out.options?.length) {
            out.options = normalizeSlashOptions(out.options);
        }

        if (SUB_TYPES.has(out.type) && !out.description?.trim()) {
            out.description = defaultOptionDescription(out.name);
        }

        return out;
    });
}

export function buildSlashCommandPayload(command) {
    return {
        name: command.name,
        description: (command.description || 'Plugin command').slice(0, 100),
        options: normalizeSlashOptions(command.options),
    };
}

/** @typedef {import('discord.js').GuildMember} GuildMember */

export const parseRoleIds = (value) =>
    (value || '').split(',').map(s => s.trim()).filter(Boolean);

export const formatRoleList = (ids) =>
    ids.length ? ids.map(id => `<@&${id}>`).join(', ') : '—';

/**
 * Evaluate whether a member qualifies for a role logic rule.
 * @returns {boolean|null} null if rule is disabled
 */
export function evaluateRule(member, rule) {
    if (rule.enabled === 0 || rule.enabled === false) return null;

    const required = parseRoleIds(rule.required_roles);
    const optional = parseRoleIds(rule.optional_roles);
    const forbidden = parseRoleIds(rule.forbidden_roles);

    if (forbidden.length && forbidden.some(id => member.roles.cache.has(id))) {
        return false;
    }

    if (required.length && !required.every(id => member.roles.cache.has(id))) {
        return false;
    }

    if (optional.length) {
        const held = optional.filter(id => member.roles.cache.has(id)).length;
        const minOpt = rule.min_optional ?? 1;
        if (held < minOpt) return false;
    }

    return true;
}

export function describeRule(rule) {
    const required = parseRoleIds(rule.required_roles);
    const optional = parseRoleIds(rule.optional_roles);
    const forbidden = parseRoleIds(rule.forbidden_roles);
    const minOpt = rule.min_optional ?? 1;

    const lines = [];
    if (rule.name) lines.push(`**Name:** ${rule.name}`);
    lines.push(`**Reward:** <@&${rule.reward_role}>`);
    if (required.length) lines.push(`**AND (all):** ${formatRoleList(required)}`);
    if (optional.length) {
        lines.push(`**OR (min ${minOpt}):** ${formatRoleList(optional)}`);
    }
    if (forbidden.length) lines.push(`**NOT (none):** ${formatRoleList(forbidden)}`);
    lines.push(`**Priority:** ${rule.priority ?? 0}`);
    lines.push(`**Remove on fail:** ${rule.remove_on_fail ? 'Yes' : 'No'}`);
    lines.push(`**Status:** ${rule.enabled ? 'Enabled' : 'Disabled'}`);
    return lines.join('\n');
}

/**
 * Apply all rules to a member. Returns { added, removed } counts.
 */
export async function applyRulesToMember(member, rules, { botMember } = {}) {
    if (!member || member.user.bot) return { added: 0, removed: 0 };

    const me = botMember ?? member.guild.members.me;
    const sorted = [...rules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    let added = 0;
    let removed = 0;

    for (const rule of sorted) {
        const result = evaluateRule(member, rule);
        if (result === null) continue;

        const reward = rule.reward_role;
        const rewardRole = member.guild.roles.cache.get(reward);
        if (!rewardRole) continue;
        if (me && rewardRole.position >= me.roles.highest.position) continue;

        const hasReward = member.roles.cache.has(reward);
        const shouldRemove = rule.remove_on_fail !== 0 && rule.remove_on_fail !== false;

        if (result && !hasReward) {
            await member.roles.add(reward).catch(() => {});
            added++;
        } else if (!result && hasReward && shouldRemove) {
            await member.roles.remove(reward).catch(() => {});
            removed++;
        }
    }

    return { added, removed };
}

export async function auditMember(member, rules) {
    const matches = [];
    const nonMatches = [];

    for (const rule of rules) {
        const result = evaluateRule(member, rule);
        if (result === null) {
            nonMatches.push({ rule, reason: 'disabled' });
        } else if (result) {
            matches.push(rule);
        } else {
            nonMatches.push({ rule, reason: 'conditions not met' });
        }
    }

    return { matches, nonMatches };
}

export function rolesChanged(oldMember, newMember) {
    if (!oldMember?.roles || !newMember?.roles) return true;
    if (oldMember.roles.cache.size !== newMember.roles.cache.size) return true;
    return newMember.roles.cache.some(r => !oldMember.roles.cache.has(r.id))
        || oldMember.roles.cache.some(r => !newMember.roles.cache.has(r.id));
}

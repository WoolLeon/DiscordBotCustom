import {
    ApplicationCommandOptionType,
    PermissionFlagsBits,
    EmbedBuilder,
    Events,
} from 'discord.js';
import {
    parseRoleIds,
    formatRoleList,
    evaluateRule,
    describeRule,
    applyRulesToMember,
    auditMember,
    rolesChanged,
} from '../lib/role-logic/engine.js';

const requireManageRoles = (ctx) => {
    if (!ctx.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return '❌ You need the **Manage Roles** permission.';
    }
    return null;
};

const cleanRoleId = (id) => (id ? String(id).replace(/[<@&>\s]/g, '') : '');

const parseRoleInput = (input) =>
    parseRoleIds(String(input || '').replace(/\s+/g, ','));

const canManageReward = (ctx, roleId) => {
    const role = ctx.guild.roles.cache.get(roleId);
    const me = ctx.guild.members.me;
    if (!role) return '❌ Reward role not found.';
    if (me && role.position >= me.roles.highest.position) {
        return '❌ That role is above my highest role.';
    }
    return null;
};

async function migrateSchema(db) {
    const addColumn = async (col, def) => {
        try {
            await db.query(`ALTER TABLE role_logic ADD COLUMN ${col} ${def}`);
        } catch (err) {
            if (err.errno !== 1060 && !String(err.message).includes('Duplicate')) {
                console.error(`[role-logic] column ${col}:`, err.message);
            }
        }
    };

    await db.query(`CREATE TABLE IF NOT EXISTS role_logic (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        guild_id        VARCHAR(64) NOT NULL,
        name            VARCHAR(100) DEFAULT NULL,
        required_roles  TEXT,
        optional_roles  TEXT,
        forbidden_roles TEXT,
        reward_role     VARCHAR(64) NOT NULL,
        min_optional    TINYINT UNSIGNED DEFAULT 1,
        remove_on_fail  TINYINT(1) DEFAULT 1,
        priority        INT DEFAULT 0,
        enabled         TINYINT(1) DEFAULT 1,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`);

    await addColumn('name', 'VARCHAR(100) DEFAULT NULL');
    await addColumn('forbidden_roles', 'TEXT');
    await addColumn('min_optional', 'TINYINT UNSIGNED DEFAULT 1');
    await addColumn('remove_on_fail', 'TINYINT(1) DEFAULT 1');
    await addColumn('priority', 'INT DEFAULT 0');
    await addColumn('enabled', 'TINYINT(1) DEFAULT 1');
    await addColumn('created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
}

async function insertRule(db, guildId, data) {
    const result = await db.query(
        `INSERT INTO role_logic (
            guild_id, name, required_roles, optional_roles, forbidden_roles,
            reward_role, min_optional, remove_on_fail, priority, enabled
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            guildId,
            data.name || null,
            data.required,
            data.optional,
            data.forbidden,
            data.reward,
            data.minOptional ?? 1,
            data.removeOnFail !== false ? 1 : 0,
            data.priority ?? 0,
            data.enabled !== false ? 1 : 0,
        ],
    );
    return result.insertId;
}

export default {
    name: 'Advanced Role Logic',
    help: [
        { usage: '`!add_logic @Reward | @Req… | @Opt…`', description: 'Create a rule (AND required, OR optional, pipe-separated).' },
        { usage: '`!add_logic … | forbidden:@A,@B | min:2 | name:Verified`', description: 'Extras: NOT roles, min OR count, rule name (prefix).' },
        { usage: '`!edit_logic <id> [options]`', description: 'Edit a rule (reward, required, optional, forbidden, min, priority, name).' },
        { usage: '`!del_logic <id>`', description: 'Delete a rule by ID.' },
        { usage: '`!toggle_logic <id>`', description: 'Enable or disable a rule.' },
        { usage: '`!logic_info <id>`', description: 'View full details for one rule.' },
        { usage: '`!list_logic`', description: 'List all rules (sorted by priority).' },
        { usage: '`!test_logic [@user]`', description: 'See which rules a member matches.' },
        { usage: '`!sync_roles`', description: 'Apply all rules to every member (Administrator).' },
    ],

    init: migrateSchema,

    commands: [
        {
            name: 'add_logic',
            description: 'Create an advanced role logic rule',
            options: [
                { name: 'reward', type: ApplicationCommandOptionType.Role, required: true },
                { name: 'name', type: ApplicationCommandOptionType.String, required: false },
                { name: 'required', type: ApplicationCommandOptionType.String, required: false, description: 'AND roles (comma-separated)' },
                { name: 'optional', type: ApplicationCommandOptionType.String, required: false, description: 'OR pool (comma-separated)' },
                { name: 'forbidden', type: ApplicationCommandOptionType.String, required: false, description: 'NOT roles — member must not have any' },
                { name: 'min_optional', type: ApplicationCommandOptionType.Integer, required: false, description: 'Min roles needed from OR pool (default 1)' },
                { name: 'priority', type: ApplicationCommandOptionType.Integer, required: false },
                { name: 'keep_on_fail', type: ApplicationCommandOptionType.Boolean, required: false, description: 'Keep reward if conditions stop matching' },
            ],
            async execute(ctx, db, isSlash, args) {
                const denied = requireManageRoles(ctx);
                if (denied) return ctx.reply(denied);

                let reward, name, reqIn, optIn, forbidIn, minOpt, priority, keepOnFail;

                if (isSlash) {
                    reward = ctx.options.getRole('reward').id;
                    name = ctx.options.getString('name');
                    reqIn = ctx.options.getString('required') || '';
                    optIn = ctx.options.getString('optional') || '';
                    forbidIn = ctx.options.getString('forbidden') || '';
                    minOpt = ctx.options.getInteger('min_optional') ?? 1;
                    priority = ctx.options.getInteger('priority') ?? 0;
                    keepOnFail = ctx.options.getBoolean('keep_on_fail') ?? false;
                } else {
                    const raw = args.join(' ');
                    const parts = raw.split('|').map(s => s.trim());
                    const flags = {};
                    const roleParts = [];

                    for (const part of parts) {
                        const lower = part.toLowerCase();
                        if (lower.startsWith('name:')) flags.name = part.slice(5).trim();
                        else if (lower.startsWith('forbidden:')) flags.forbidden = part.slice(10).trim();
                        else if (lower.startsWith('min:')) flags.min = parseInt(part.slice(4), 10);
                        else if (lower.startsWith('priority:')) flags.priority = parseInt(part.slice(9), 10);
                        else if (lower === 'keep' || lower === 'keep_on_fail') flags.keep = true;
                        else roleParts.push(part);
                    }

                    reward = cleanRoleId(roleParts[0] || '');
                    reqIn = roleParts[1] || '';
                    optIn = roleParts[2] || '';
                    forbidIn = flags.forbidden || '';
                    name = flags.name;
                    minOpt = flags.min ?? 1;
                    priority = flags.priority ?? 0;
                    keepOnFail = flags.keep ?? false;
                }

                const rewardErr = canManageReward(ctx, reward);
                if (rewardErr) return ctx.reply(rewardErr);

                const optional = parseRoleInput(optIn).join(',');
                const minOptional = Math.max(0, minOpt ?? 1);
                if (optional && minOptional < 1) {
                    return ctx.reply('❌ `min_optional` must be at least 1 when OR roles are set.');
                }

                const id = await insertRule(db, ctx.guild.id, {
                    name,
                    required: parseRoleInput(reqIn).join(','),
                    optional,
                    forbidden: parseRoleInput(forbidIn).join(','),
                    reward,
                    minOptional,
                    priority,
                    removeOnFail: !keepOnFail,
                });

                const embed = new EmbedBuilder()
                    .setColor('#57F287')
                    .setTitle(`✅ Rule #${id} created`)
                    .setDescription(describeRule({
                        name,
                        reward_role: reward,
                        required_roles: parseRoleInput(reqIn).join(','),
                        optional_roles: optional,
                        forbidden_roles: parseRoleInput(forbidIn).join(','),
                        min_optional: minOptional,
                        priority,
                        remove_on_fail: keepOnFail ? 0 : 1,
                        enabled: 1,
                    }));
                ctx.reply({ embeds: [embed] });
            },
        },
        {
            name: 'edit_logic',
            description: 'Edit an existing role logic rule',
            options: [
                { name: 'id', type: ApplicationCommandOptionType.Integer, required: true },
                { name: 'name', type: ApplicationCommandOptionType.String, required: false },
                { name: 'reward', type: ApplicationCommandOptionType.Role, required: false },
                { name: 'required', type: ApplicationCommandOptionType.String, required: false },
                { name: 'optional', type: ApplicationCommandOptionType.String, required: false },
                { name: 'forbidden', type: ApplicationCommandOptionType.String, required: false },
                { name: 'min_optional', type: ApplicationCommandOptionType.Integer, required: false },
                { name: 'priority', type: ApplicationCommandOptionType.Integer, required: false },
                { name: 'keep_on_fail', type: ApplicationCommandOptionType.Boolean, required: false },
            ],
            async execute(ctx, db, isSlash, args) {
                const denied = requireManageRoles(ctx);
                if (denied) return ctx.reply(denied);

                const id = isSlash ? ctx.options.getInteger('id') : parseInt(args[0], 10);
                if (!id) return ctx.reply('❌ Usage: `!edit_logic <id> …`');

                const rows = await db.query(
                    'SELECT * FROM role_logic WHERE id = ? AND guild_id = ?',
                    [id, ctx.guild.id],
                );
                if (!rows[0]) return ctx.reply('❌ Rule not found.');

                const rule = rows[0];
                const updates = [];
                const params = [];

                const setField = (col, val) => {
                    if (val !== undefined && val !== null) {
                        updates.push(`${col} = ?`);
                        params.push(val);
                    }
                };

                if (isSlash) {
                    if (ctx.options.getString('name') !== null) setField('name', ctx.options.getString('name'));
                    if (ctx.options.getRole('reward')) {
                        const rid = ctx.options.getRole('reward').id;
                        const err = canManageReward(ctx, rid);
                        if (err) return ctx.reply(err);
                        setField('reward_role', rid);
                    }
                    if (ctx.options.getString('required') !== null) {
                        setField('required_roles', parseRoleInput(ctx.options.getString('required')).join(','));
                    }
                    if (ctx.options.getString('optional') !== null) {
                        setField('optional_roles', parseRoleInput(ctx.options.getString('optional')).join(','));
                    }
                    if (ctx.options.getString('forbidden') !== null) {
                        setField('forbidden_roles', parseRoleInput(ctx.options.getString('forbidden')).join(','));
                    }
                    if (ctx.options.getInteger('min_optional') !== null) {
                        setField('min_optional', ctx.options.getInteger('min_optional'));
                    }
                    if (ctx.options.getInteger('priority') !== null) {
                        setField('priority', ctx.options.getInteger('priority'));
                    }
                    if (ctx.options.getBoolean('keep_on_fail') !== null) {
                        setField('remove_on_fail', ctx.options.getBoolean('keep_on_fail') ? 0 : 1);
                    }
                } else {
                    const tokens = args.slice(1);
                    for (let i = 0; i < tokens.length; i++) {
                        const t = tokens[i].toLowerCase();
                        const next = () => tokens[++i];
                        if (t === 'name') setField('name', next());
                        else if (t === 'reward') setField('reward_role', cleanRoleId(next()));
                        else if (t === 'required') setField('required_roles', parseRoleInput(next()).join(','));
                        else if (t === 'optional') setField('optional_roles', parseRoleInput(next()).join(','));
                        else if (t === 'forbidden') setField('forbidden_roles', parseRoleInput(next()).join(','));
                        else if (t === 'min') setField('min_optional', parseInt(next(), 10));
                        else if (t === 'priority') setField('priority', parseInt(next(), 10));
                        else if (t === 'keep') setField('remove_on_fail', 0);
                    }
                }

                if (!updates.length) return ctx.reply('ℹ️ Nothing to update. Pass fields to change.');
                params.push(id, ctx.guild.id);
                await db.query(
                    `UPDATE role_logic SET ${updates.join(', ')} WHERE id = ? AND guild_id = ?`,
                    params,
                );

                const updated = (await db.query('SELECT * FROM role_logic WHERE id = ?', [id]))[0];
                const embed = new EmbedBuilder()
                    .setColor('#FEE75C')
                    .setTitle(`✏️ Rule #${id} updated`)
                    .setDescription(describeRule(updated));
                ctx.reply({ embeds: [embed] });
            },
        },
        {
            name: 'del_logic',
            description: 'Delete a role logic rule',
            options: [
                { name: 'id', type: ApplicationCommandOptionType.Integer, required: true },
            ],
            async execute(ctx, db, isSlash, args) {
                const denied = requireManageRoles(ctx);
                if (denied) return ctx.reply(denied);

                const id = isSlash ? ctx.options.getInteger('id') : parseInt(args[0], 10);
                const res = await db.query(
                    'DELETE FROM role_logic WHERE id = ? AND guild_id = ?',
                    [id, ctx.guild.id],
                );
                if (!res.affectedRows) return ctx.reply('❌ Rule not found.');
                ctx.reply(`🗑️ Deleted rule **#${id}**.`);
            },
        },
        {
            name: 'toggle_logic',
            description: 'Enable or disable a role logic rule',
            options: [
                { name: 'id', type: ApplicationCommandOptionType.Integer, required: true },
            ],
            async execute(ctx, db, isSlash, args) {
                const denied = requireManageRoles(ctx);
                if (denied) return ctx.reply(denied);

                const id = isSlash ? ctx.options.getInteger('id') : parseInt(args[0], 10);
                const rows = await db.query(
                    'SELECT * FROM role_logic WHERE id = ? AND guild_id = ?',
                    [id, ctx.guild.id],
                );
                if (!rows[0]) return ctx.reply('❌ Rule not found.');

                const next = rows[0].enabled ? 0 : 1;
                await db.query('UPDATE role_logic SET enabled = ? WHERE id = ?', [next, id]);
                ctx.reply(`✅ Rule **#${id}** is now **${next ? 'enabled' : 'disabled'}**.`);
            },
        },
        {
            name: 'logic_info',
            description: 'Show details for one role logic rule',
            options: [
                { name: 'id', type: ApplicationCommandOptionType.Integer, required: true },
            ],
            async execute(ctx, db, isSlash, args) {
                const id = isSlash ? ctx.options.getInteger('id') : parseInt(args[0], 10);
                const rows = await db.query(
                    'SELECT * FROM role_logic WHERE id = ? AND guild_id = ?',
                    [id, ctx.guild.id],
                );
                if (!rows[0]) return ctx.reply('❌ Rule not found.');

                const embed = new EmbedBuilder()
                    .setColor('#5865F2')
                    .setTitle(`📜 Rule #${id}${rows[0].name ? ` — ${rows[0].name}` : ''}`)
                    .setDescription(describeRule(rows[0]));
                ctx.reply({ embeds: [embed] });
            },
        },
        {
            name: 'list_logic',
            description: 'List all role logic rules',
            async execute(ctx, db) {
                const rules = await db.query(
                    'SELECT * FROM role_logic WHERE guild_id = ? ORDER BY priority DESC, id ASC',
                    [ctx.guild.id],
                );
                if (!rules.length) return ctx.reply('ℹ️ No role logic rules for this server.');

                const embed = new EmbedBuilder()
                    .setTitle('📜 Role Logic Rules')
                    .setColor('#FFAA00')
                    .setFooter({ text: `${rules.length} rule(s) · higher priority runs first` });

                for (const r of rules.slice(0, 25)) {
                    const status = r.enabled ? '🟢' : '⚫';
                    const title = `${status} #${r.id}${r.name ? ` · ${r.name}` : ''} → <@&${r.reward_role}>`;
                    const req = parseRoleIds(r.required_roles);
                    const opt = parseRoleIds(r.optional_roles);
                    const ban = parseRoleIds(r.forbidden_roles);
                    const bits = [];
                    if (req.length) bits.push(`**AND:** ${formatRoleList(req)}`);
                    if (opt.length) bits.push(`**OR (≥${r.min_optional ?? 1}):** ${formatRoleList(opt)}`);
                    if (ban.length) bits.push(`**NOT:** ${formatRoleList(ban)}`);
                    bits.push(`Priority \`${r.priority ?? 0}\` · ${r.remove_on_fail ? 'auto-remove' : 'keep on fail'}`);
                    embed.addFields({ name: title, value: bits.join('\n') || 'No conditions' });
                }

                if (rules.length > 25) {
                    embed.setDescription(`Showing 25 of **${rules.length}** rules.`);
                }

                ctx.reply({ embeds: [embed] });
            },
        },
        {
            name: 'test_logic',
            description: 'Test which rules apply to a member',
            options: [
                { name: 'user', type: ApplicationCommandOptionType.User, required: false },
            ],
            async execute(ctx, db, isSlash, args) {
                const denied = requireManageRoles(ctx);
                if (denied) return ctx.reply(denied);

                const target = isSlash
                    ? (ctx.options.getMember('user') ?? ctx.member)
                    : (ctx.mentions.members.first() ?? ctx.member);

                if (!target) return ctx.reply('❌ Member not found.');

                const rules = await db.query(
                    'SELECT * FROM role_logic WHERE guild_id = ? ORDER BY priority DESC',
                    [ctx.guild.id],
                );
                const { matches, nonMatches } = await auditMember(target, rules);

                const embed = new EmbedBuilder()
                    .setColor('#5865F2')
                    .setTitle(`🧪 Logic test — ${target.displayName}`)
                    .setThumbnail(target.user.displayAvatarURL({ size: 128 }));

                if (matches.length) {
                    embed.addFields({
                        name: `✅ Matches (${matches.length})`,
                        value: matches.map(r =>
                            `#${r.id}${r.name ? ` ${r.name}` : ''} → <@&${r.reward_role}>`,
                        ).join('\n'),
                    });
                } else {
                    embed.addFields({ name: '✅ Matches', value: 'None' });
                }

                const failed = nonMatches.filter(x => x.reason !== 'disabled').slice(0, 10);
                if (failed.length) {
                    embed.addFields({
                        name: `❌ Does not match (${nonMatches.length})`,
                        value: failed.map(({ rule }) =>
                            `#${rule.id}${rule.name ? ` ${rule.name}` : ''}`,
                        ).join('\n') + (nonMatches.length > 10 ? '\n…' : ''),
                    });
                }

                ctx.reply({ embeds: [embed] });
            },
        },
        {
            name: 'sync_roles',
            description: 'Sync all members against role logic rules',
            async execute(ctx, db) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.Administrator)) {
                    return ctx.reply('❌ Administrator permission required.');
                }

                await ctx.reply('⏳ Syncing all members against role logic rules…');

                const rules = await db.query(
                    'SELECT * FROM role_logic WHERE guild_id = ? AND enabled = 1',
                    [ctx.guild.id],
                );
                const members = await ctx.guild.members.fetch();
                let added = 0;
                let removed = 0;

                for (const m of members.values()) {
                    const result = await applyRulesToMember(m, rules);
                    added += result.added;
                    removed += result.removed;
                }

                ctx.channel.send(`✅ Sync complete — **${added}** roles added, **${removed}** removed.`);
            },
        },
    ],

    rules: [
        {
            name: 'AutoRoleLogicUpdate',
            event: Events.GuildMemberUpdate,
            async execute(oldM, newM, db) {
                if (!rolesChanged(oldM, newM)) return;

                const rules = await db.query(
                    'SELECT * FROM role_logic WHERE guild_id = ? AND enabled = 1',
                    [newM.guild.id],
                );
                if (!rules.length) return;

                await applyRulesToMember(newM, rules);
            },
        },
        {
            name: 'AutoRoleLogicJoin',
            event: Events.GuildMemberAdd,
            async execute(member, db) {
                const rules = await db.query(
                    'SELECT * FROM role_logic WHERE guild_id = ? AND enabled = 1',
                    [member.guild.id],
                );
                if (!rules.length) return;

                await applyRulesToMember(member, rules);
            },
        },
    ],
};

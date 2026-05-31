import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Collection } from 'discord.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default async (client, db) => {
    client.commands = new Collection();
    client.helpData = new Collection();
    client.commandPlugins = new Map();
    client.pluginCatalog = [];
    const pluginsPath = path.join(__dirname, 'plugins');
    if (!fs.existsSync(pluginsPath)) fs.mkdirSync(pluginsPath);

    const pluginFiles = fs.readdirSync(pluginsPath).filter(file => file.endsWith('.js'));

    for (const file of pluginFiles) {
        const filePath = pathToFileURL(path.join(pluginsPath, file)).href;
        const module = await import(filePath);
        const plugin = module.default;
        
        const pluginKey = file.replace(/\.js$/, '');

        if (plugin.init) await plugin.init(db);
        if (plugin.commands) {
            plugin.commands.forEach(cmd => {
                cmd.pluginKey = pluginKey;
                cmd.pluginName = plugin.name;
                client.commands.set(cmd.name, cmd);
                client.commandPlugins.set(cmd.name, pluginKey);
            });
            client.pluginCatalog.push({
                key: pluginKey,
                name: plugin.name,
                commands: plugin.commands.map(c => ({
                    name: c.name,
                    description: c.description || '',
                })),
            });
        } else {
            client.pluginCatalog.push({ key: pluginKey, name: plugin.name, commands: [] });
        }
        if (plugin.rules) {
            plugin.rules.forEach(rule => {
                client.on(rule.event, (...args) => rule.execute(...args, db));
            });
        }
        if (plugin.help) client.helpData.set(plugin.name, plugin.help);
        console.log('✅ Loaded: ' + plugin.name);
    }
};
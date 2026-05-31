function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function mountDiscordRolePicker(container, roles) {
    if (!container) return;

    const mode = container.dataset.mode || 'multi';
    const field = container.dataset.field || 'roles';
    const sorted = [...(roles || [])].sort((a, b) => (b.position ?? 0) - (a.position ?? 0));

    container.innerHTML = `
        <div class="drp-toolbar">
            <input type="search" class="form-control form-control-sm drp-search" placeholder="Search roles…" autocomplete="off">
            ${mode === 'multi' ? '<button type="button" class="drp-clear">Clear</button>' : ''}
        </div>
        <div class="drp-meta-bar drp-count">—</div>
        <div class="drp-list"></div>
    `;

    const list = container.querySelector('.drp-list');
    const search = container.querySelector('.drp-search');
    const countEl = container.querySelector('.drp-count');

    if (!sorted.length) {
        list.innerHTML = '<div class="drp-empty">No roles loaded. Is the bot online?</div>';
        countEl.textContent = '0 roles';
        return;
    }

    const inputType = mode === 'single' ? 'radio' : 'checkbox';

    const needRequired = container.dataset.required === 'true' && mode === 'single';

    list.innerHTML = sorted.map((r, idx) => {
        const tags = [];
        if (r.managed) tags.push('Managed');
        if (r.hoist) tags.push('Hoisted');
        const sub = tags.length ? tags.join(' · ') : `Position ${r.position ?? 0}`;
        const reqAttr = needRequired && idx === 0 ? ' required' : '';

        return `
            <label class="drp-item" data-search="${escapeHtml(r.name.toLowerCase())}">
                <input type="${inputType}" class="drp-input" name="${escapeHtml(field)}" value="${r.id}"${reqAttr}>
                <span class="drp-color" style="background-color: ${r.color || '#99aab5'}"></span>
                <span class="drp-details">
                    <span class="drp-name">${escapeHtml(r.name)}</span>
                    <span class="drp-sub">${escapeHtml(sub)}</span>
                </span>
            </label>
        `;
    }).join('');

    const updateCount = () => {
        const visible = list.querySelectorAll('.drp-item:not(.drp-hidden)').length;
        const selected = list.querySelectorAll('.drp-input:checked').length;
        countEl.textContent = mode === 'multi'
            ? `${selected} selected · ${visible} shown (top = highest)`
            : `${visible} roles · top = highest in server`;
        list.querySelectorAll('.drp-item').forEach((item) => {
            const checked = item.querySelector('.drp-input')?.checked;
            item.classList.toggle('drp-selected', !!checked);
        });
    };

    search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        list.querySelectorAll('.drp-item').forEach((item) => {
            const match = !q || item.dataset.search.includes(q);
            item.classList.toggle('drp-hidden', !match);
        });
        updateCount();
    });

    container.querySelector('.drp-clear')?.addEventListener('click', () => {
        list.querySelectorAll('.drp-input:checked').forEach((input) => { input.checked = false; });
        updateCount();
    });

    list.addEventListener('change', updateCount);
    updateCount();
}

function refreshDiscordRolePickers(scope, guild) {
    const root = scope || document;
    root.querySelectorAll('.discord-role-picker').forEach((picker) => {
        mountDiscordRolePicker(picker, guild?.roles || []);
    });
}

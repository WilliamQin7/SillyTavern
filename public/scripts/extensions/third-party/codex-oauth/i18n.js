import { translate } from '../../../i18n.js';
import { formatStudioMessage, STUDIO_LOCALES } from './locales.js';

const PREFIX = 'amyCreatorStudio.';

export function studioI18nKey(key) {
    return `${PREFIX}${key}`;
}

export function tr(key, values = {}) {
    const fallback = STUDIO_LOCALES.en[key] ?? key;
    return formatStudioMessage(translate(fallback, studioI18nKey(key)), values);
}

export function translateStudioValidationErrors(errors) {
    return errors.map(error => {
        if (error.startsWith('schema must be ')) return tr('studio.validation.schema', { schema: error.slice('schema must be '.length) });
        if (error === 'card.spec must be chara_card_v2') return tr('studio.validation.spec');
        if (error === 'card.spec_version must be 2.0') return tr('studio.validation.version');
        if (error === 'card.data is required') return tr('studio.validation.data');
        if (error === 'card.data.name is required') return tr('studio.validation.name');
        if (error === 'card.data.first_mes is required') return tr('studio.validation.firstMessage');
        if (error === 'card.data.alternate_greetings must be an array') return tr('studio.validation.alternateGreetings');
        if (error === 'card.data.tags must be an array') return tr('studio.validation.tags');
        const field = error.match(/^(card\.data\.[A-Za-z0-9_]+) must be a string$/);
        if (field) return tr('studio.validation.fieldString', { field: field[1] });
        const content = error.match(/^lorebook\.entries\[(\d+)]\.content is required$/);
        if (content) return tr('studio.validation.loreContent', { index: Number(content[1]) + 1 });
        const keys = error.match(/^lorebook\.entries\[(\d+)] needs keys or constant=true$/);
        if (keys) return tr('studio.validation.loreKeys', { index: Number(keys[1]) + 1 });
        return error;
    });
}

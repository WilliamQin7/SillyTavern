const SUPPORTED_MODEL_IDS = new Set(['grok-4.5', 'grok-4.6']);

function cloneParams(params = []) {
    return params.map(({ id, value }) => ({ id, value }));
}

export function selectionFingerprint(selection) {
    const params = cloneParams(selection.params).sort((a, b) => a.id.localeCompare(b.id));
    return `${selection.id}:${params.map(({ id, value }) => `${id}=${value}`).join(',')}`;
}

export function sanitizeCatalog(models) {
    return models
        .filter((model) => SUPPORTED_MODEL_IDS.has(model.id))
        .map((model) => ({
            id: model.id,
            object: 'model',
            owned_by: 'cursor',
            display_name: model.displayName,
            description: model.description,
            cursor_parameters: (model.parameters ?? []).map((parameter) => ({
                id: parameter.id,
                display_name: parameter.displayName,
                values: parameter.values.map((entry) => ({
                    value: entry.value,
                    display_name: entry.displayName,
                })),
            })),
            cursor_variants: (model.variants ?? []).map((variant) => {
                const selection = { id: model.id, params: cloneParams(variant.params) };
                return {
                    display_name: variant.displayName,
                    description: variant.description,
                    is_default: variant.isDefault === true,
                    cursor_model_selection: selection,
                    selection_fingerprint: selectionFingerprint(selection),
                };
            }),
        }));
}

export function validateSelection(models, requestedModelId, selection) {
    if (!SUPPORTED_MODEL_IDS.has(requestedModelId)) {
        throw new CatalogError('model_unavailable', `Unsupported Cursor model: ${requestedModelId}`);
    }

    if (!selection || typeof selection !== 'object' || selection.id !== requestedModelId) {
        throw new CatalogError(
            'invalid_model_selection',
            'cursor_model_selection.id must exactly match model.',
        );
    }

    const model = models.find((entry) => entry.id === requestedModelId);
    if (!model) {
        throw new CatalogError('model_unavailable', `${requestedModelId} is not available for this Cursor account.`);
    }

    const supplied = Array.isArray(selection.params) ? selection.params : null;
    if (!supplied) {
        throw new CatalogError('invalid_model_selection', 'cursor_model_selection.params must be an array.');
    }

    const definitions = new Map((model.parameters ?? []).map((parameter) => [parameter.id, parameter]));
    const suppliedIds = new Set();

    for (const item of supplied) {
        if (!item || typeof item.id !== 'string' || typeof item.value !== 'string') {
            throw new CatalogError('invalid_model_selection', 'Every model parameter must contain string id and value fields.');
        }
        if (suppliedIds.has(item.id)) {
            throw new CatalogError('invalid_model_selection', `Duplicate model parameter: ${item.id}`);
        }
        suppliedIds.add(item.id);
        const definition = definitions.get(item.id);
        if (!definition) {
            throw new CatalogError('unsupported_parameter', `Unsupported Cursor model parameter: ${item.id}`);
        }
        if (!definition.values.some((entry) => entry.value === item.value)) {
            throw new CatalogError('unsupported_parameter', `Unsupported value for ${item.id}: ${item.value}`);
        }
    }

    for (const id of definitions.keys()) {
        if (!suppliedIds.has(id)) {
            throw new CatalogError('invalid_model_selection', `Explicit Cursor model parameter is required: ${id}`);
        }
    }

    return {
        id: requestedModelId,
        params: cloneParams(supplied).sort((a, b) => a.id.localeCompare(b.id)),
    };
}

export class CatalogError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'CatalogError';
        this.code = code;
    }
}

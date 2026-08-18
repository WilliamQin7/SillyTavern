import { initCodexOAuthProvider } from './settings.js';
import { initCreatorStudio } from './studio.js';

export function init() {
    initCodexOAuthProvider();
    initCreatorStudio();
}

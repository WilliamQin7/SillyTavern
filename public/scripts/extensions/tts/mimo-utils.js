export const MIMO_TTS_CHUNK_LENGTH = 2_500;

const SENTENCE_BOUNDARIES = new Set(['\n', '。', '！', '？', '.', '!', '?', '；', ';']);
const SOFT_BOUNDARIES = new Set(['，', ',', '、', ' ', '\t']);

/**
 * Splits MiMo TTS input at natural boundaries without dropping punctuation.
 * Unicode code points are counted so an emoji is never cut in half.
 * @param {string} text Text to split
 * @param {number} [maxLength] Maximum code points per chunk
 * @returns {string[]} Non-empty chunks
 */
export function splitMiMoTtsText(text, maxLength = MIMO_TTS_CHUNK_LENGTH) {
    const characters = Array.from(String(text ?? '').trim());
    if (!characters.length) {
        return [];
    }
    if (!Number.isInteger(maxLength) || maxLength <= 0) {
        throw new Error('MiMo TTS chunk length must be a positive integer.');
    }

    const chunks = [];
    let start = 0;
    while (start < characters.length) {
        let end = Math.min(start + maxLength, characters.length);
        if (end < characters.length) {
            const minimumBoundary = start + Math.floor(maxLength / 2);
            let sentenceBoundary = -1;
            let softBoundary = -1;
            for (let index = end - 1; index >= minimumBoundary; index--) {
                if (sentenceBoundary < 0 && SENTENCE_BOUNDARIES.has(characters[index])) {
                    sentenceBoundary = index + 1;
                    break;
                }
                if (softBoundary < 0 && SOFT_BOUNDARIES.has(characters[index])) {
                    softBoundary = index + 1;
                }
            }
            end = sentenceBoundary > 0 ? sentenceBoundary : (softBoundary > 0 ? softBoundary : end);
        }

        const chunk = characters.slice(start, end).join('').trim();
        if (chunk) {
            chunks.push(chunk);
        }
        start = end;
        while (start < characters.length && /\s/u.test(characters[start])) {
            start++;
        }
    }
    return chunks;
}

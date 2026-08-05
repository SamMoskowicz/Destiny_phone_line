const GSM_BASIC = new Set(Array.from(
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡'
    + 'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
));
const GSM_EXTENDED = new Set(Array.from('^{}\\[~]|€'));

function smsMetrics(value) {
    const text = String(value || '');
    let septets = 0;
    let gsm = true;
    for (const character of text) {
        if (GSM_BASIC.has(character)) {
            septets += 1;
        } else if (GSM_EXTENDED.has(character)) {
            septets += 2;
        } else {
            gsm = false;
            break;
        }
    }

    if (gsm) {
        return {
            encoding: 'GSM-7',
            units: septets,
            segments: septets <= 160 ? 1 : Math.ceil(septets / 153)
        };
    }
    const units = text.length;
    return {
        encoding: 'UCS-2',
        units,
        segments: units <= 70 ? 1 : Math.ceil(units / 67)
    };
}

function formatAiSms(answer, { maxSegments = 3 } = {}) {
    const prefix = 'ChatGPT: ';
    const suffix = '\nReply DELETE to erase AI memory; STOP to unsubscribe.';
    const body = String(answer || '').trim().replace(/\n{3,}/g, '\n\n');
    const complete = `${prefix}${body}${suffix}`;
    const segmentLimit = Math.max(1, Math.min(10, Number(maxSegments) || 3));
    if (smsMetrics(complete).segments <= segmentLimit) {
        return complete;
    }

    const sourceMarker = '\n\nSources:\n';
    const sourceIndex = body.lastIndexOf(sourceMarker);
    const sourceFooter = sourceIndex >= 0 ? body.slice(sourceIndex + 2) : '';
    const answerBody = sourceFooter ? body.slice(0, sourceIndex).trimEnd() : body;
    const characters = Array.from(answerBody);

    // Keep a complete, clickable search citation when shortening the prose.
    if (sourceFooter && smsMetrics(`${prefix}...\n\n${sourceFooter}${suffix}`).segments <= segmentLimit) {
        for (let length = characters.length; length >= 0; length -= 1) {
            let clipped = characters.slice(0, length).join('').trimEnd();
            const lastWhitespace = Math.max(clipped.lastIndexOf(' '), clipped.lastIndexOf('\n'));
            if (lastWhitespace >= Math.floor(clipped.length * 0.7)) {
                clipped = clipped.slice(0, lastWhitespace).trimEnd();
            }
            const candidate = `${prefix}${clipped}...\n\n${sourceFooter}${suffix}`;
            if (smsMetrics(candidate).segments <= segmentLimit) {
                return candidate;
            }
        }
    }

    const fallbackCharacters = Array.from(body);
    for (let length = fallbackCharacters.length; length >= 0; length -= 1) {
        let clipped = fallbackCharacters.slice(0, length).join('').trimEnd();
        const lastWhitespace = Math.max(clipped.lastIndexOf(' '), clipped.lastIndexOf('\n'));
        if (lastWhitespace >= Math.floor(clipped.length * 0.7)) {
            clipped = clipped.slice(0, lastWhitespace).trimEnd();
        }
        const candidate = `${prefix}${clipped}...${suffix}`;
        if (smsMetrics(candidate).segments <= segmentLimit) {
            return candidate;
        }
    }

    // Prefix and compliance footer fit comfortably within one segment.
    return `${prefix}...${suffix}`;
}

module.exports = {
    formatAiSms,
    smsMetrics
};

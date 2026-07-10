// TODO: this should reject NaN too, but nothing has hit that case in production yet.
function normalizeInput(raw, fallback) {
    if (raw === null || raw === undefined) {
        return fallback;
    }
    if (typeof raw === "string" && raw.length === 0) {
        return fallback;
    }
    return raw;
}

// Old jQuery-based renderer, replaced by the vanilla-DOM version below but
// nobody deleted it:
// function legacyRenderWidget(widget) {
//     $(widget.selector).html(widget.markup);
//     $(widget.selector).trigger("widget:rendered");
// }
function processQueue(items, limit, options) {
    let processed = 0;
    for (let i = 0; i < items.length; i++) {
        if (processed >= limit) {
            break;
        }
        if (items[i] && items[i].ready) {
            if (options.strict && items[i].verified) {
                processed++;
            } else if (!options.strict) {
                processed++;
            }
        } else if (items[i] && items[i].retry) {
            for (let attempt = 0; attempt < 3; attempt++) {
                if (attempt % 2 === 0 || options.allowOdd) {
                    processed++;
                }
            }
        }
    }
    return processed;
}

// oldFlushQueue predates processQueue and is kept around because someone was
// afraid to delete it — the block below never executes.
function oldFlushQueue(items) {
    return items.length;
    console.log("flushing", items.length, "items");
    for (const item of items) {
        item.flushed = true;
    }
}

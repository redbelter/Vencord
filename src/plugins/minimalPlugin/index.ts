/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandOptionType, findOption } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { EmbedJSON, MessageAttachment, MessageJSON } from "@vencord/discord-types";
import { ChannelStore, Constants, MessageStore, RestAPI, showToast, Toasts, UserStore } from "@webpack/common";

const Native = VencordNative.pluginHelpers.MinimalPlugin as any;

const settings = definePluginSettings({
    downloadFolder: {
        type: OptionType.STRING,
        description: "Optional absolute folder path to store images. If empty, you will be asked for each file (desktop only).",
        placeholder: "C:\\Users\\<you>\\Pictures\\DMImages",
        default: ""
    },
    targetUserId: {
        type: OptionType.STRING,
        description: "Specific user ID to export DM media from. Leave empty to export all DMs. Use /list-dm-users to see IDs.",
        placeholder: "",
        default: ""
    },
    includeLinkImages: {
        type: OptionType.BOOLEAN,
        description: "Include inline image URLs in message text (PNG/JPG/GIF/WebP/MP4).",
        default: true
    },
    exportExternalMedia: {
        type: OptionType.BOOLEAN,
        description: "Export external media links (non-Discord CDN) like imgur.com, githubusercontent.com, etc.\n⚠️ Note: External links may break over time as content can be removed from source servers.",
        default: false
    },
    maxImages: {
        type: OptionType.NUMBER,
        description: "Max images to download in one run (0 = unlimited, prevents runaway).",
        default: 0
    },
    hideQuestStuff: {
        type: OptionType.BOOLEAN,
        description: "Hide Discord Quest UI elements while the plugin is enabled.",
        default: false
    }
});

const URL_IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|mp4|mov|webm|avif|bmp|svg|ogg|mp3|wav|m4a|aac|flac|opus)(?:[?#]|$)/i;

// Discord CDN domains (uploaded media)
const DISCORD_CDN_DOMAINS = ["cdn.discordapp.com", "media.discordapp.net"];
function isDiscordCdnUrl(url: string): boolean {
    try {
        const u = new URL(url);
        return DISCORD_CDN_DOMAINS.includes(u.hostname);
    } catch {
        return false;
    }
}

const HIDE_QUEST_STYLE_ID = "minimalplugin-hide-quests-style";
const HIDE_QUEST_CSS = `
    [aria-label*="Quest"],
    [aria-label*="Quests"],
    a[href*="/quest"],
    a[href*="/quests"],
    button[aria-label*="Quest"],
    button[aria-label*="Quests"],
    [class*="quest"],
    [class*="Quest"],
    [id*="quest"],
    [data-quest] {
        display: none !important;
    }
`;

function removeQuestHidingStyle(): void {
    const existing = document.getElementById(HIDE_QUEST_STYLE_ID);
    if (existing) {
        existing.remove();
    }
}

function applyQuestHiding(enabled: boolean): void {
    removeQuestHidingStyle();
    if (!enabled) return;

    const style = document.createElement("style");
    style.id = HIDE_QUEST_STYLE_ID;
    style.textContent = HIDE_QUEST_CSS;
    (document.head || document.documentElement || document.body)?.appendChild(style);
}

type UrlCandidate = { url: string; filename?: string; type: 'discord' | 'external'; };

type SkippedMediaEntry = {
    url: string;
    type?: 'discord' | 'external';
    reason: string;
    user: string;
    messageId: string;
};

function formatSkippedMediaReport(entries: SkippedMediaEntry[]): string {
    const discordCount = entries.filter(e => e.type === 'discord').length;
    const externalCount = entries.filter(e => e.type === 'external').length;
    
    return entries.map(entry => {
        return [
            `User: ${entry.user}`,
            `Message ID: ${entry.messageId}`,
            `Type: ${entry.type || 'unknown'}`,
            `URL: ${entry.url}`,
            `Reason: ${entry.reason}`,
            ""
        ].join("\n");
    }).join("\n") + "\n\n--- Summary ---\nDiscord CDN (uploaded): " + discordCount + "\nExternal links: " + externalCount;
}

async function saveSkippedMediaReport(entries: SkippedMediaEntry[]): Promise<void> {
    if (!entries.length) return;
    const reportText = formatSkippedMediaReport(entries);
    const bytes = new TextEncoder().encode(reportText);
    const fileName = `minimalplugin_skipped_media_${Date.now()}.txt`;
    await saveFile(new Uint8Array(bytes), fileName);
}

function getFileExtensionFromContentType(contentType?: string): string | undefined {
    if (!contentType) return undefined;

    const mime = contentType.split(";")[0].trim().toLowerCase();
    switch (mime) {
        case "image/jpeg": return ".jpg";
        case "image/png": return ".png";
        case "image/gif": return ".gif";
        case "image/webp": return ".webp";
        case "image/avif": return ".avif";
        case "image/bmp": return ".bmp";
        case "image/svg+xml": return ".svg";
        case "image/x-icon":
        case "image/vnd.microsoft.icon":
            return ".ico";
        case "video/mp4": return ".mp4";
        case "video/webm": return ".webm";
        case "video/ogg": return ".ogv";
        case "video/quicktime": return ".mov";
        case "video/x-msvideo": return ".avi";
        case "video/x-matroska": return ".mkv";
        case "audio/mpeg": return ".mp3";
        case "audio/wav": return ".wav";
        case "audio/mp4": return ".m4a";
        case "audio/aac": return ".aac";
        case "audio/flac": return ".flac";
        case "audio/ogg": return ".ogg";
        case "audio/opus": return ".opus";
        default:
            return undefined;
    }
}

function sanitizeFileName(name: string): string {
    const sanitized = name
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
        .replace(/[\s]+/g, "_")
        .replace(/[\. ]+$/, "");

    if (!sanitized) return "attachment";
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(sanitized)) return `_${sanitized}`;
    return sanitized.slice(0, 240);
}

function getFileName(url: string, fallback: string, contentType?: string): string {
    const allowedExt = /\.(?:png|jpe?g|gif|webp|mp4|mov|webm|avif|bmp|svg|ogg|mp3|wav|m4a|aac|flac|opus)$/i;
    const fallbackHasExt = fallback && /\.[^./\\?]+$/.test(fallback);

    try {
        const u = new URL(url);
        let pathName = u.pathname.split("/").filter(Boolean).pop() ?? "";
        if (!pathName || pathName === "." || pathName === "..") {
            pathName = fallback || "attachment";
        }

        let name = pathName || fallback || "attachment";
        if (!allowedExt.test(name)) {
            const extMatch = u.search.match(/\.(?:png|jpe?g|gif|webp|mp4|mov|webm|avif|bmp|svg|ogg|mp3|wav|m4a|aac|flac|opus)/i);
            const contentExt = getFileExtensionFromContentType(contentType);
            const ext = extMatch?.[0] || contentExt || (fallbackHasExt ? fallback.replace(/^.*[\\/]/, "") : ".jpg");
            if (allowedExt.test(ext)) {
                if (name.endsWith(".")) {
                    name += ext.slice(1);
                } else {
                    name += ext.startsWith(".") ? ext : `.${ext}`;
                }
            } else if (!allowedExt.test(name)) {
                name += contentExt || ".jpg";
            }
        }

        return sanitizeFileName(name);
    } catch {
        return sanitizeFileName(fallback || "attachment");
    }
}

function getUrlCandidates(message: MessageJSON): UrlCandidate[] {
    const candidates = new Map<string, UrlCandidate>();

    const addCandidate = (url: string, filename?: string) => {
        if (!candidates.has(url)) {
            candidates.set(url, { 
                url, 
                filename, 
                type: isDiscordCdnUrl(url) ? 'discord' : 'external'
            });
        }
    };

    if (message.attachments) {
        for (const att of message.attachments as MessageAttachment[]) {
            if (att.url) addCandidate(att.url, att.filename);
        }
    }

    if (message.embeds) {
        for (const emb of message.embeds as EmbedJSON[]) {
            if (emb.thumbnail?.url) addCandidate(emb.thumbnail.url);
            const embedImageUrl = (emb as any).image?.url;
            if (embedImageUrl) addCandidate(embedImageUrl);
            if (emb.video?.url) addCandidate(emb.video.url);
            if (emb.url && URL_IMAGE_EXT_RE.test(emb.url)) addCandidate(emb.url);
        }
    }

    if (settings.store.includeLinkImages && message.content) {
        for (const token of message.content.split(/\s+/)) {
            try {
                const u = new URL(token);
                addCandidate(u.href);
            } catch {
                // ignore
            }
        }
    }

    return Array.from(candidates.values());
}

function getCommandUserId(args: any[]): string | undefined {
    const idFromArg = findOption(args ?? [], "userId");
    if (idFromArg) return String(idFromArg);
    const idFromSettings = settings.store.targetUserId?.trim();
    return idFromSettings || undefined;
}

function normalizeBytes(maybeBytes: unknown): Uint8Array {
    if (maybeBytes instanceof Uint8Array) return maybeBytes;
    if (maybeBytes instanceof ArrayBuffer) return new Uint8Array(maybeBytes);
    if (ArrayBuffer.isView(maybeBytes)) return new Uint8Array((maybeBytes as ArrayBufferView).buffer);
    if (Array.isArray(maybeBytes)) return new Uint8Array(maybeBytes as number[]);
    throw new Error("Native download returned unsupported data type");
}

function isSupportedMediaContentType(contentType?: string): boolean {
    if (!contentType) return false;
    const mime = contentType.split(";")[0].trim().toLowerCase();
    return mime.startsWith("image/") || mime.startsWith("video/") || mime.startsWith("audio/");
}

async function downloadMedia(url: string): Promise<{ bytes: Uint8Array; contentType?: string; }> {
    if (Native?.downloadUrl) {
        try {
            const nativeResult = await Native.downloadUrl(url);
            if (nativeResult && typeof nativeResult === "object" && "bytes" in nativeResult) {
                return {
                    bytes: normalizeBytes((nativeResult as any).bytes),
                    contentType: (nativeResult as any).contentType
                };
            }

            return {
                bytes: normalizeBytes(nativeResult)
            };
        } catch (error) {
            console.warn("MinimalPlugin: native downloadUrl failed, falling back to browser fetch", error);
        }
    }

    const response = await fetch(url, {
        cache: "no-store"
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    const contentType = response.headers.get("content-type") ?? undefined;
    const buffer = await response.arrayBuffer();
    return {
        bytes: new Uint8Array(buffer),
        contentType
    };
}

async function processCandidateUrl(url: string, fallbackName: string, username: string, messageId: string, type?: 'discord' | 'external'): Promise<{ saved: boolean; reason?: string; type?: 'discord' | 'external'; }> {
    // Check if external media should be skipped
    if (type === 'external' && !settings.store.exportExternalMedia) {
        return { 
            saved: false, 
            reason: "external media excluded by settings (exportExternalMedia=false)", 
            type 
        };
    }
    
    let media;
    try {
        media = await downloadMedia(url);
    } catch (error) {
        return { saved: false, reason: `download or save failed: ${String(error)}`, type };
    }

    if (media.contentType && !isSupportedMediaContentType(media.contentType)) {
        return { saved: false, reason: `unsupported content-type ${media.contentType}`, type };
    }

    const hasExtension = URL_IMAGE_EXT_RE.test(url);
    if (!hasExtension && !media.contentType) {
        return { saved: false, reason: "unsupported or missing media extension", type };
    }

    try {
        const fileName = `${username}_${messageId}_${getFileName(url, fallbackName, media.contentType)}`;
        await saveFile(media.bytes, fileName);
        return { saved: true, type };
    } catch (error) {
        return { saved: false, reason: `download or save failed: ${String(error)}`, type };
    }
}

async function fileExists(folder: string | undefined, fileName: string): Promise<boolean> {
    if (!folder || !Native?.fileExists) return false;
    try {
        return await Native.fileExists(folder, fileName);
    } catch {
        return false;
    }
}

async function saveFile(data: Uint8Array, fileName: string): Promise<void> {
    const folder = settings.store.downloadFolder?.trim().replace(/[\\/]+$/, "");

    console.log("MinimalPlugin saveFile: folder=", folder, "Native=", Native, "has writeFile=", !!Native?.writeFile);

    if (folder && Native?.writeFile) {
        try {
            console.log("MinimalPlugin: attempting native writeFile to", folder);
            const result = await Native.writeFile(folder, fileName, data);
            if (result.success) {
                console.log("MinimalPlugin: native writeFile succeeded");
                return;
            } else {
                console.warn("MinimalPlugin: native writeFile failed", result.error);
            }
        } catch (err) {
            console.warn("MinimalPlugin: native helper failed", err);
        }
    } else {
        console.warn("MinimalPlugin: skipping native write - folder=", folder, "Native=", !!Native, "writeFile=", !!Native?.writeFile);
    }

    console.log("MinimalPlugin: falling back to saveWithDialog");
    const nativeFileManager = (window as any).DiscordNative?.fileManager;
    if (nativeFileManager?.saveWithDialog) {
        await nativeFileManager.saveWithDialog(data, fileName);
        return;
    }

    // Browser fallback
    const blob = new Blob([data.buffer as ArrayBuffer]);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    URL.revokeObjectURL(link.href);
    link.remove();
}
async function fetchMessages(channelId: string): Promise<MessageJSON[]> {
    const results: MessageJSON[] = [];

    // Use cached store first
    try {
        const cache = MessageStore.getMessages(channelId);
        if (cache && Array.isArray(cache._array)) {
            results.push(...cache._array as MessageJSON[]);
        }
    } catch {
        // ignore if store path missing
    }

    let before: string | undefined;

    if (results.length) {
        const sorted = [...results].sort((a, b) => (BigInt(b.id) - BigInt(a.id)) > 0n ? 1 : -1);
        before = sorted[sorted.length - 1]?.id;
    }

    // Fetch history in pages (oldest-first via before)
    for (let page = 0; page < 500; page++) {
        const query: Record<string, any> = { limit: 100 };
        if (before) query.before = before;
        try {
            const response = await RestAPI.get({ url: Constants.Endpoints.MESSAGES(channelId), query });
            const body = response.body as MessageJSON[] | undefined;
            if (!Array.isArray(body) || body.length === 0) break;

            // Keep duplicates unique by id
            const existingIds = new Set(results.map(msg => msg.id));
            const batch = body.filter(msg => !existingIds.has(msg.id));
            if (!batch.length) break;

            results.push(...batch);
            before = batch[batch.length - 1]?.id;
            if (!before) break;
            if (body.length < 100) break;

            if (settings.store.maxImages > 0 && results.length >= settings.store.maxImages * 3) break;
            await new Promise(resolve => setTimeout(resolve, 150));
        } catch (error) {
            console.warn("MinimalPlugin: DM history fetch failed for channel", channelId, error);
            break;
        }
    }

    return results;
}

async function exportAllDMImages(specificUserId?: string) {
    const dmUserIds = new Set<string>();

    // Try to fetch all DM channels via REST API (includes closed DMs and blocked users)
    try {
        console.log("MinimalPlugin: fetching all DM channels from API...");
        const response = await RestAPI.get({ url: "/users/@me/channels" });
        const channels = response.body as any[] | undefined;
        if (Array.isArray(channels)) {
            for (const ch of channels) {
                if (ch.type === 1) {
                    const userId = String(ch.recipient_ids?.[0] || ch.recipients?.[0]?.id || "");
                    if (userId) dmUserIds.add(userId);
                }
            }
            console.log("MinimalPlugin: found", dmUserIds.size, "DM users via API");
        }
    } catch (apiError) {
        console.warn("MinimalPlugin: REST API fetch failed", apiError);
    }

    const storeDmUserIds = ChannelStore.getDMUserIds() || [];
    for (const id of storeDmUserIds) {
        dmUserIds.add(id);
    }
    console.log("MinimalPlugin: combined DM users from API and store", dmUserIds.size, "unique IDs");

    if (dmUserIds.size === 0) {
        throw new Error("No DM users found. Open Discord and make sure DM list is loaded.");
    }

    const targetIds = specificUserId ? [specificUserId] : dmUserIds;
    if (specificUserId && !dmUserIds.has(specificUserId)) {
        throw new Error(`User ID ${specificUserId} not found in DM list. Use /list-dm-users to see available IDs.`);
    }

    let foundImages = 0;
    let savedImages = 0;
    const seenUrls = new Set<string>();
    const skippedMediaEntries: SkippedMediaEntry[] = [];
    
    // Track counts by type for summary
    let discordCdnCount = 0;
    let externalCount = 0;

    for (const userId of targetIds) {
        const dmChannel = ChannelStore.getDMChannelFromUserId(userId);
        if (!dmChannel) {
            // If channel not in store, try to fetch via REST API
            try {
                const response = await RestAPI.get({ url: "/users/@me/channels" });
                const channels = response.body as any[] | undefined;
                const channel = channels?.find(ch => ch.recipient_ids?.[0] === userId || ch.recipients?.[0]?.id === userId);
                if (!channel) continue;
                // Continue with this channel ID if found
                const user = UserStore.getUser(userId);
                const username = user?.username || userId;

                const messages = await fetchMessages(channel.id);
                if (!messages.length) {
                    showToast(`MinimalPlugin: no messages found for user ${username}`, Toasts.Type.MESSAGE);
                    continue;
                }

                for (const message of messages) {
                    const candidates = getUrlCandidates(message);
                    for (const { url, filename, type } of candidates) {
                        if (seenUrls.has(url)) continue;
                        seenUrls.add(url);
                        foundImages++;

                        // Track count by type
                        if (type === 'discord') {
                            discordCdnCount++;
                        } else {
                            externalCount++;
                        }

                        // Log media type detection
                        console.log(`MinimalPlugin: ${type.toUpperCase()} media detected - ${url}`);

                        if (settings.store.maxImages > 0 && savedImages >= settings.store.maxImages) {
                        skippedMediaEntries.push({
                            url,
                            type: type as any,
                            reason: "maxImages limit reached",
                            user: username,
                            messageId: message.id
                        });
                            continue;
                        }

                        const fallbackName = filename || "attachment";
                        const result = await processCandidateUrl(url, fallbackName, username, message.id, type);
                        if (!result.saved) {
                            skippedMediaEntries.push({
                                url,
                                type: result.type,
                                reason: result.reason || "download or save failed",
                                user: username,
                                messageId: message.id
                            });
                        } else {
                            savedImages++;
                        }
                    }
                }
            } catch (error) {
                console.warn("MinimalPlugin: couldn't fetch messages for user", userId, error);
            }
            continue;
        }

        const user = UserStore.getUser(userId);
        const username = user?.username || userId;

        const channelId = dmChannel.id;
        showToast(`MinimalPlugin: scanning DM ${username}`, Toasts.Type.MESSAGE);

        const messages = await fetchMessages(channelId);
        if (!messages.length) {
            showToast(`MinimalPlugin: no messages found for user ${username}`, Toasts.Type.MESSAGE);
            continue;
        }

        for (const message of messages) {
            const candidates = getUrlCandidates(message);
            for (const { url, filename, type } of candidates) {
                if (seenUrls.has(url)) continue;
                seenUrls.add(url);
                foundImages++;

                // Track count by type
                if (type === 'discord') {
                    discordCdnCount++;
                } else {
                    externalCount++;
                }

                // Log media type detection
                console.log(`MinimalPlugin: ${type.toUpperCase()} media detected - ${url}`);

                if (settings.store.maxImages > 0 && savedImages >= settings.store.maxImages) {
                    skippedMediaEntries.push({
                        url,
                        reason: "maxImages limit reached",
                        user: username,
                        messageId: message.id
                    });
                    continue;
                }

                const fallbackName = filename || "attachment";
                const previewFileName = `${username}_${message.id}_${getFileName(url, fallbackName)}`;

                // Skip if file already exists
                if (await fileExists(settings.store.downloadFolder, previewFileName)) {
                    console.log("MinimalPlugin: skipping existing file", previewFileName);
                    savedImages++;
                    continue;
                }

                const result = await processCandidateUrl(url, fallbackName, username, message.id, type);
                if (!result.saved) {
                    skippedMediaEntries.push({
                        url,
                        type: result.type,
                        reason: result.reason || "download or save failed",
                        user: username,
                        messageId: message.id
                    });
                } else {
                    savedImages++;
                    if (savedImages % 10 === 0) {
                        showToast(`MinimalPlugin: saved ${savedImages} images`, Toasts.Type.SUCCESS);
                    }
                }
            }
        }
    }

    if (skippedMediaEntries.length) {
        try {
            await saveSkippedMediaReport(skippedMediaEntries);
            showToast(`MinimalPlugin: saved skipped-media report (${skippedMediaEntries.length} entries)`, Toasts.Type.SUCCESS);
        } catch (error) {
            console.warn("MinimalPlugin: failed to save skipped media report", error);
        }
    }

    // Log summary of media types found
    console.log(`MinimalPlugin: Export complete. Found ${foundImages} media items (${discordCdnCount} Discord CDN, ${externalCount} external), saved ${savedImages}.`);

    return { foundImages, savedImages };
}

async function getNonFriendDMs(): Promise<Array<{ id: string; username: string; }>> {
    try {
        const response = await RestAPI.get({ url: "/users/@me/relationships" });
        const relationships = response.body as any[] | undefined;
        const friendIds = new Set<string>();

        if (Array.isArray(relationships)) {
            for (const rel of relationships) {
                if (rel.type === 1) { // 1 = friend
                    friendIds.add(rel.id);
                }
            }
        }

        // Get all DM users
        const response2 = await RestAPI.get({ url: "/users/@me/channels" });
        const channels = response2.body as any[] | undefined;
        const nonFriends: Array<{ id: string; username: string; }> = [];

        if (Array.isArray(channels)) {
            for (const ch of channels) {
                if (ch.type === 1) { // DM channel
                    const userId = ch.recipient_ids?.[0] || ch.recipients?.[0]?.id;
                    if (userId && !friendIds.has(userId)) {
                        const user = UserStore.getUser(userId);
                        const username = user?.username || "Unknown";
                        nonFriends.push({ id: userId, username });
                    }
                }
            }
        }

        return nonFriends;
    } catch (error) {
        console.error("MinimalPlugin: failed to get non-friend DMs", error);
        return [];
    }
}

async function deleteUserMessages(channelId: string): Promise<{ deleted: number; failed: number; }> {
    let deleted = 0;
    let failed = 0;
    const currentUserId = UserStore.getCurrentUser()?.id;

    const messages = await fetchMessages(channelId);
    const ownMessages = messages.filter(msg => msg.author?.id === currentUserId);
    const total = ownMessages.length;

    if (!total) {
        return { deleted, failed };
    }

    for (let offset = 0; offset < ownMessages.length; offset += 20) {
        const batch = ownMessages.slice(offset, offset + 20);

        for (const message of batch) {
            let attempt = 0;
            let deletedThisMessage = false;

            while (attempt < 3 && !deletedThisMessage) {
                attempt++;
                try {
                    const response = await RestAPI.del({ url: Constants.Endpoints.MESSAGE(channelId, message.id) });
                    const success = response?.ok || response?.status === 204 || response?.status === 200;
                    if (success) {
                        deleted++;
                        deletedThisMessage = true;
                        break;
                    }

                    console.warn(
                        `MinimalPlugin: delete attempt ${attempt} failed for message ${message.id}`,
                        response
                    );
                } catch (error) {
                    console.warn(
                        `MinimalPlugin: delete attempt ${attempt} threw for message ${message.id}`,
                        error
                    );
                }

                if (attempt < 3) {
                    const retryDelay = 1000;
                    const retryStatus = `MinimalPlugin: retrying delete for message ${message.id} (attempt ${attempt + 1}/3) after ${retryDelay}ms...`;
                    console.log(retryStatus);
                    showToast(retryStatus, Toasts.Type.MESSAGE);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                }
            }

            if (!deletedThisMessage) {
                failed++;
            }
        }

        const processed = offset + batch.length;
        if (processed < total) {
            const status = `MinimalPlugin: deleted ${deleted}/${total} messages so far (${processed}/${total} processed), waiting 1500ms before next batch...`;
            console.log(status);
            showToast(status, Toasts.Type.MESSAGE);
            await new Promise(resolve => setTimeout(resolve, 1500));
        }
    }

    return { deleted, failed };
}

function formatTimestamp(timestamp: string): string {
    try {
        const date = new Date(timestamp);
        return date.toLocaleString();
    } catch {
        return timestamp;
    }
}

async function saveDMAsText(channelId: string, userId: string): Promise<{ savedBytes: number; }> {
    const user = UserStore.getUser(userId);
    const username = user?.username || userId;

    const messages = await fetchMessages(channelId);

    let textContent = `DM Conversation with ${username} (${userId})\n`;
    textContent += `Exported on ${new Date().toLocaleString()}\n`;
    textContent += `Total messages: ${messages.length}\n`;
    textContent += "=".repeat(80) + "\n\n";

    for (const message of messages) {
        const author = UserStore.getUser(message.author?.id);
        const authorName = author?.username || "Unknown";
        const timestamp = formatTimestamp(message.timestamp);

        textContent += `[${timestamp}] ${authorName}:\n`;
        textContent += `${message.content}\n`;

        if (message.attachments && message.attachments.length > 0) {
            textContent += `  [Attachments: ${message.attachments.length}]\n`;
            for (const att of message.attachments as MessageAttachment[]) {
                textContent += `    - ${att.url}\n`;
            }
        }

        textContent += "\n";
    }

    const bytes = new TextEncoder().encode(textContent);
    const fileName = `dm_${username}_${Date.now()}.txt`;
    await saveFile(new Uint8Array(bytes), fileName);

    return { savedBytes: bytes.length };
}

async function saveAllDMsAsText(specificUserId?: string): Promise<{ savedFiles: number; totalConversations: number; }> {
    const dmUserIds = new Set<string>();
    let channels: any[] = [];

    try {
        const response = await RestAPI.get({ url: "/users/@me/channels" });
        channels = response.body as any[] | undefined || [];
        if (Array.isArray(channels)) {
            for (const ch of channels) {
                if (ch.type === 1) {
                    const userId = String(ch.recipient_ids?.[0] || ch.recipients?.[0]?.id || "");
                    if (userId) dmUserIds.add(userId);
                }
            }
        }
    } catch (apiError) {
        console.warn("MinimalPlugin: REST API fetch failed", apiError);
    }

    const storeDmUserIds = ChannelStore.getDMUserIds() || [];
    for (const id of storeDmUserIds) {
        dmUserIds.add(id);
    }

    if (dmUserIds.size === 0) {
        throw new Error("No DM users found. Open Discord and make sure DM list is loaded.");
    }

    const targetIds = specificUserId ? [specificUserId] : Array.from(dmUserIds);
    if (specificUserId && !dmUserIds.has(specificUserId)) {
        throw new Error(`User ID ${specificUserId} not found in DM list. Use /list-dm-users to see available IDs.`);
    }

    let savedFiles = 0;
    let totalConversations = 0;
    const processed = new Set<string>();

    for (const userId of targetIds) {
        if (processed.has(userId)) continue;
        processed.add(userId);

        let dmChannel = ChannelStore.getDMChannelFromUserId(userId);
        if (!dmChannel) {
            const channel = channels.find(ch => ch.type === 1 && (ch.recipient_ids?.[0] === userId || ch.recipients?.[0]?.id === userId));
            if (channel) {
                dmChannel = { id: channel.id } as any;
            }
        }

        if (!dmChannel) {
            continue;
        }

        totalConversations++;
        const user = UserStore.getUser(userId);
        const username = user?.username || userId;
        showToast(`MinimalPlugin: saving DM conversation for ${username}`, Toasts.Type.MESSAGE);

        try {
            await saveDMAsText(dmChannel.id, userId);
            savedFiles++;
        } catch (error) {
            console.warn(`MinimalPlugin: failed to save DM text for ${userId}`, error);
        }
    }

    return { savedFiles, totalConversations };
}

export default definePlugin({
    name: "MinimalPlugin",
    description: "Export DM media (images/audio) and text history to disk, with user-targeted export and rate-limited batch message deletion.",
    authors: [{ name: "You", id: BigInt(0) }],
    settings,

    start() {
        applyQuestHiding(settings.store.hideQuestStuff);
        console.log("MinimalPlugin started - use /export-dm-media command to run the dump.");
        showToast("MinimalPlugin loaded: /export-dm-media available", Toasts.Type.MESSAGE);
    },

    stop() {
        removeQuestHidingStyle();
        console.log("MinimalPlugin stopped");
    },

    commands: [
        {
            name: "list-dm-users",
            description: "List all DM users available for export (ID + username). Uses Discord channel API to include more DMs.",
            execute: async () => {
                try {
                    const response = await RestAPI.get({ url: "/users/@me/channels" });
                    const channels = response.body as any[] | undefined;
                    const dmUserIds = new Set<string>();

                    if (Array.isArray(channels)) {
                        for (const ch of channels) {
                            if (ch.type === 1) {
                                const userId = String(ch.recipient_ids?.[0] || ch.recipients?.[0]?.id || "");
                                if (userId) {
                                    dmUserIds.add(userId);
                                }
                            }
                        }
                    }

                    const storeIds = ChannelStore.getDMUserIds() || [];
                    for (const id of storeIds) {
                        dmUserIds.add(id);
                    }

                    if (!dmUserIds.size) {
                        return { content: "No DM users found." };
                    }

                    const ids = Array.from(dmUserIds);
                    const userList = ids.map((id, idx) => {
                        const user = UserStore.getUser(id);
                        const username = user?.username || "Unknown";
                        return `${idx + 1}. ${username} (${id})`;
                    }).join("\n");
                    const msg = `**DM Users (${ids.length}):**\n${userList}`;
                    return { content: msg };
                } catch (error) {
                    try {
                        const dmUserIds = ChannelStore.getDMUserIds();
                        if (!dmUserIds || !dmUserIds.length) {
                            return { content: "No DM users found." };
                        }

                        const userList = dmUserIds.map((id, idx) => {
                            const user = UserStore.getUser(id);
                            const username = user?.username || "Unknown";
                            return `${idx + 1}. ${username} (${id})`;
                        }).join("\n");
                        const msg = `**DM Users (${dmUserIds.length}):**\n${userList}`;
                        return { content: msg };
                    } catch (fallbackError) {
                        return { content: `Failed to list users: ${String(error)} / ${String(fallbackError)}` };
                    }
                }
            }
        },
        {
            name: "export-dm-media",
            description: "Export DM media (images/audio) to local disk. Optional: specify user ID. Use /list-dm-users to see IDs.",
            options: [
                {
                    name: "userId",
                    description: "User ID to export media from.",
                    type: ApplicationCommandOptionType.STRING,
                    required: false
                }
            ],
            execute: async args => {
                try {
                    const targetUserId = getCommandUserId(args);
                    
                    // Add external media setting info to the message
                    const externalSettingInfo = settings.store.exportExternalMedia ? " (external included)" : "";

                    if (targetUserId) {
                        showToast(`MinimalPlugin: exporting media for user ${targetUserId}`, Toasts.Type.MESSAGE);
                    } else {
                        showToast("MinimalPlugin: exporting media for all DMs", Toasts.Type.MESSAGE);
                    }

                    const { foundImages, savedImages } = await exportAllDMImages(targetUserId);
                    const msg = `MinimalPlugin: done, found ${foundImages}, saved ${savedImages} images.${externalSettingInfo}`;
                    showToast(msg, Toasts.Type.SUCCESS);
                    return { content: msg };
                } catch (error) {
                    const msg = `MinimalPlugin: export failed: ${String(error)}`;
                    console.error(msg, error);
                    showToast(msg, Toasts.Type.FAILURE);
                    return { content: msg };
                }
            }
        },
        {
            name: "test-write",
            description: "Test file writing with detailed console output.",
            execute: async () => {
                try {
                    const folder = settings.store.downloadFolder?.trim();
                    console.log("=== TEST-WRITE START ===");
                    console.log("1. Folder setting:", folder || "(empty)");
                    console.log("2. Native object exists:", !!Native);
                    console.log("3. Native.writeFile exists:", !!Native?.writeFile);

                    const testContent = `Test write at ${new Date().toISOString()}\nIf you see this in a file, writing works!`;
                    const testFileName = `vencord_test_${Date.now()}.txt`;

                    if (folder && Native?.writeFile) {
                        console.log("4. Using NATIVE write to:", folder);
                        console.log("4a. folder type:", typeof folder, "Native type:", typeof Native);
                        console.log("4b. Native.writeFile type:", typeof Native.writeFile);
                        try {
                            const result = await Native.writeFile(folder, testFileName, testContent);
                            console.log("5. Native write result:", result);
                            if (result.success) {
                                const msg = `✅ Native write success! File written to: ${result.path}. Check console for details.`;
                                showToast(msg, Toasts.Type.SUCCESS);
                                return { content: msg };
                            } else {
                                console.error("6. Native write returned false:", result.error);
                                const msg = `❌ Native write failed: ${result.error}`;
                                showToast(msg, Toasts.Type.FAILURE);
                                return { content: msg };
                            }
                        } catch (nativeError) {
                            console.error("6. Native write error (caught exception):", nativeError);
                            const msg = `❌ Native write exception: ${String(nativeError)}`;
                            showToast(msg, Toasts.Type.FAILURE);
                            return { content: msg };
                        }
                    } else {
                        console.log("4. No folder or Native, using DIALOG fallback");
                        const handle = await (window as any).__TAURI__?.dialog?.save({
                            defaultPath: testFileName,
                            filters: [{ name: "Text", extensions: ["txt"] }]
                        }) as string | null;

                        if (handle) {
                            console.log("5. Dialog returned:", handle);
                            const { writeTextFile } = (window as any).__TAURI__?.fs || {};
                            if (writeTextFile) {
                                await writeTextFile(handle, testContent);
                                console.log("6. Dialog write succeeded");
                                const msg = `✅ Dialog write success! File: ${handle}. Check console for details.`;
                                showToast(msg, Toasts.Type.SUCCESS);
                                return { content: msg };
                            }
                        }
                        console.log("5. Dialog cancelled or no Tauri");
                        const msg = "❌ Dialog cancelled or unavailable";
                        showToast(msg, Toasts.Type.FAILURE);
                        return { content: msg };
                    }
                } catch (error) {
                    console.error("=== TEST-WRITE FAILED ===", error);
                    const msg = `Test write error: ${String(error)}. Check DevTools console (F12).`;
                    showToast(msg, Toasts.Type.FAILURE);
                    return { content: msg };
                }
            }
        },
        {
            name: "list-non-friends",
            description: "List all DM users you are NOT friends with.",
            execute: async () => {
                try {
                    showToast("MinimalPlugin: scanning friend list...", Toasts.Type.MESSAGE);
                    const nonFriends = await getNonFriendDMs();

                    if (!nonFriends.length) {
                        return { content: "You are friends with all your DM contacts!" };
                    }

                    const list = nonFriends
                        .map((u, idx) => `${idx + 1}. ${u.username} (${u.id})`)
                        .join("\n");

                    const msg = `**Non-Friend DM Users (${nonFriends.length}):**\n${list}`;
                    return { content: msg };
                } catch (error) {
                    return { content: `Failed to list non-friends: ${String(error)}` };
                }
            }
        },
        {
            name: "delete-dm-messages",
            description: "Delete all messages YOU sent to a specific user. Specify user ID.",
            options: [
                {
                    name: "userId",
                    description: "User ID whose DM messages should be deleted.",
                    type: ApplicationCommandOptionType.STRING,
                    required: false
                }
            ],
            execute: async args => {
                try {
                    const targetUserId = getCommandUserId(args);
                    if (!targetUserId) {
                        return { content: "Please specify a user ID. Use /list-non-friends to see users." };
                    }

                    const dmChannel = ChannelStore.getDMChannelFromUserId(targetUserId);
                    if (!dmChannel) {
                        // Try to fetch via API
                        try {
                            const response = await RestAPI.get({ url: "/users/@me/channels" });
                            const channels = response.body as any[] | undefined;
                            const channel = channels?.find(ch => ch.recipient_ids?.[0] === targetUserId || ch.recipients?.[0]?.id === targetUserId);
                            if (!channel) {
                                return { content: `No DM channel found for user ${targetUserId}` };
                            }

                            const user = UserStore.getUser(targetUserId);
                            const username = user?.username || targetUserId;

                            showToast(`⚠️ Deleting all YOUR messages to ${username}...`, Toasts.Type.MESSAGE);
                            const { deleted, failed } = await deleteUserMessages(channel.id);

                            const msg = `✅ Deleted ${deleted} messages (${failed} failed) from DM with ${username}`;
                            showToast(msg, Toasts.Type.SUCCESS);
                            return { content: msg };
                        } catch (error) {
                            return { content: `Failed to find channel: ${String(error)}` };
                        }
                    }

                    const user = UserStore.getUser(targetUserId);
                    const username = user?.username || targetUserId;

                    showToast(`⚠️ Deleting all YOUR messages to ${username}...`, Toasts.Type.MESSAGE);
                    const { deleted, failed } = await deleteUserMessages(dmChannel.id);

                    const msg = `✅ Deleted ${deleted} messages (${failed} failed) from DM with ${username}`;
                    showToast(msg, Toasts.Type.SUCCESS);
                    return { content: msg };
                } catch (error) {
                    const msg = `Delete failed: ${String(error)}`;
                    console.error(msg, error);
                    showToast(msg, Toasts.Type.FAILURE);
                    return { content: msg };
                }
            }
        },
        {
            name: "delete-dm-media",
            description: "Delete only media (images/audio) messages YOU sent to a specific user. Leaves text-only messages intact.",
            options: [
                {
                    name: "userId",
                    description: "User ID whose DM media messages should be deleted.",
                    type: ApplicationCommandOptionType.STRING,
                    required: false
                }
            ],
            execute: async args => {
                try {
                    const targetUserId = getCommandUserId(args);
                    if (!targetUserId) {
                        return { content: "Please specify a user ID. Use /list-dm-users to see available IDs." };
                    }

                    let dmChannel = ChannelStore.getDMChannelFromUserId(targetUserId);
                    if (!dmChannel) {
                        // Try to fetch via API
                        try {
                            const response = await RestAPI.get({ url: "/users/@me/channels" });
                            const channels = response.body as any[] | undefined;
                            const channel = channels?.find(ch => ch.recipient_ids?.[0] === targetUserId || ch.recipients?.[0]?.id === targetUserId);
                            if (!channel) {
                                return { content: `No DM channel found for user ${targetUserId}` };
                            }

                            dmChannel = { id: channel.id } as any;
                        } catch (error) {
                            return { content: `Failed to find channel: ${String(error)}` };
                        }
                    }

                    const user = UserStore.getUser(targetUserId);
                    const username = user?.username || targetUserId;

                    showToast(`⚠️ Scanning for YOUR media messages in DM with ${username}...`, Toasts.Type.MESSAGE);

                    const messages = await fetchMessages(dmChannel.id);
                    const currentUserId = UserStore.getCurrentUser()?.id;
                    
                    // Filter: only own messages that contain media
                    const ownMediaMessages = messages.filter(msg => {
                        if (msg.author?.id !== currentUserId) return false;
                        
                        // Check if message has attachments, embeds with images/videos, or URL links to images
                        if (msg.attachments && msg.attachments.length > 0) return true;
                        if (msg.embeds && msg.embeds.some(emb => {
                            const embed = emb as any;
                            return embed.thumbnail?.url || embed.image?.url || embed.video?.url || (embed.url && URL_IMAGE_EXT_RE.test(embed.url));
                        })) return true;
                        
                        // Check for inline image URLs in content
                        if (settings.store.includeLinkImages && msg.content) {
                            for (const token of msg.content.split(/\s+/)) {
                                try {
                                    const u = new URL(token);
                                    if (URL_IMAGE_EXT_RE.test(u.href)) return true;
                                } catch { /* ignore */ }
                            }
                        }
                        
                        return false;
                    });

                    if (!ownMediaMessages.length) {
                        const msg = `✅ No media messages found in your DMs with ${username}`;
                        showToast(msg, Toasts.Type.SUCCESS);
                        return { content: msg };
                    }

                    let deletedCount = 0;
                    let failedCount = 0;

                    // Delete in batches of 10 to avoid rate limiting
                    for (let offset = 0; offset < ownMediaMessages.length; offset += 10) {
                        const batch = ownMediaMessages.slice(offset, offset + 10);

                        for (const message of batch) {
                            let attempt = 0;
                            let deletedThisMessage = false;

                            while (attempt < 3 && !deletedThisMessage) {
                                attempt++;
                                try {
                                    const response = await RestAPI.del({ 
                                        url: Constants.Endpoints.MESSAGE(dmChannel.id, message.id) 
                                    });
                                    
                                    const success = response?.ok || response?.status === 204 || response?.status === 200;
                                    if (success) {
                                        deletedCount++;
                                        deletedThisMessage = true;
                                        console.log(`MinimalPlugin: deleted media message ${message.id}`);
                                        break;
                                    }

                                    console.warn(
                                        `MinimalPlugin: delete attempt ${attempt} failed for media message ${message.id}`,
                                        response
                                    );
                                } catch (error) {
                                    console.warn(
                                        `MinimalPlugin: delete attempt ${attempt} threw for media message ${message.id}`,
                                        error
                                    );
                                }

                                if (attempt < 3) {
                                    const retryDelay = 1000;
                                    const retryStatus = `Deleting media messages: attempting ${attempt + 1}/3 for ${username}...`;
                                    console.log(retryStatus);
                                    showToast(retryStatus, Toasts.Type.MESSAGE);
                                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                                }
                            }

                            if (!deletedThisMessage) {
                                failedCount++;
                                console.error(`MinimalPlugin: failed to delete media message ${message.id}`);
                            }
                        }

                        // Progress update and delay between batches
                        const processed = offset + batch.length;
                        const total = ownMediaMessages.length;
                        if (processed < total) {
                            const status = `Deleted ${deletedCount}/${total} media messages so far (${processed}/${total} processed)...`;
                            console.log(status);
                            showToast(status, Toasts.Type.MESSAGE);
                            await new Promise(resolve => setTimeout(resolve, 1500));
                        }
                    }

                    const msg = `✅ Deleted ${deletedCount} media messages from your DMs with ${username}${failedCount > 0 ? ` (${failedCount} failed)` : ""}`;
                    showToast(msg, Toasts.Type.SUCCESS);
                    return { content: msg };
                } catch (error) {
                    const msg = `Media deletion failed: ${String(error)}`;
                    console.error(msg, error);
                    showToast(msg, Toasts.Type.FAILURE);
                    return { content: msg };
                }
            }
        },
        {
            name: "save-dm-text",
            description: "Save DM conversation history to text. Leave user ID blank to export all DMs.",
            options: [
                {
                    name: "userId",
                    description: "User ID whose DM history should be saved. Leave blank to export all DMs.",
                    type: ApplicationCommandOptionType.STRING,
                    required: false
                }
            ],
            execute: async args => {
                try {
                    const targetUserId = getCommandUserId(args);
                    if (!targetUserId) {
                        showToast("MinimalPlugin: exporting all DM conversations...", Toasts.Type.MESSAGE);
                        const { savedFiles, totalConversations } = await saveAllDMsAsText();
                        const msg = `✅ Saved ${savedFiles} DM conversation files for ${totalConversations} conversations.`;
                        showToast(msg, Toasts.Type.SUCCESS);
                        return { content: msg };
                    }

                    const dmChannel = ChannelStore.getDMChannelFromUserId(targetUserId);
                    if (!dmChannel) {
                        // Try to fetch via API
                        try {
                            const response = await RestAPI.get({ url: "/users/@me/channels" });
                            const channels = response.body as any[] | undefined;
                            const channel = channels?.find(ch => ch.recipient_ids?.[0] === targetUserId || ch.recipients?.[0]?.id === targetUserId);
                            if (!channel) {
                                return { content: `No DM channel found for user ${targetUserId}` };
                            }

                            showToast("MinimalPlugin: saving DM conversation...", Toasts.Type.MESSAGE);
                            const { savedBytes } = await saveDMAsText(channel.id, targetUserId);

                            const msg = `✅ Saved ${savedBytes} bytes to text file`;
                            showToast(msg, Toasts.Type.SUCCESS);
                            return { content: msg };
                        } catch (error) {
                            return { content: `Failed to save: ${String(error)}` };
                        }
                    }

                    showToast("MinimalPlugin: saving DM conversation...", Toasts.Type.MESSAGE);
                    const { savedBytes } = await saveDMAsText(dmChannel.id, targetUserId);

                    const msg = `✅ Saved ${savedBytes} bytes to text file`;
                    showToast(msg, Toasts.Type.SUCCESS);
                    return { content: msg };
                } catch (error) {
                    const msg = `Save failed: ${String(error)}`;
                    console.error(msg, error);
                    showToast(msg, Toasts.Type.FAILURE);
                    return { content: msg };
                }
            }
        }
    ]
});

import {
    ChannelType,
    GuildFeature,
    GuildDefaultMessageNotifications,
    GuildExplicitContentFilter,
    GuildVerificationLevel,
    GuildSystemChannelFlags,
    OverwriteType,
    GuildPremiumTier
} from "discord.js";
import axios from "axios";

const DOWNLOAD_TIMEOUT = 30_000; // 30 second timeout per download

/**
 * Fetch with a guaranteed timeout using AbortController.
 * Works reliably in both Node.js and Bun runtimes (axios timeout alone hangs in Bun).
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = DOWNLOAD_TIMEOUT) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await axios.get(url, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}

const MAX_BITRATE_PER_TIER = {
    [GuildPremiumTier.None]: 64000,
    [GuildPremiumTier.Tier1]: 128000,
    [GuildPremiumTier.Tier2]: 256000,
    [GuildPremiumTier.Tier3]: 384000
};

/**
 * Updates the status after each major step in the backup process.
 * Triggers an optionally user-defined callback for custom handling.
 */
export async function logStatus(step, currentStep, totalSteps, options, info = "") {
    const percentage = ((currentStep / totalSteps) * 100).toFixed(2) + "%";
    const status = {
        step: step,
        progress: `${currentStep}/${totalSteps}`,
        percentage: percentage,
        info: info
    };

    if (options.onStatusChange) {
        await options.onStatusChange(status);
    }
}

/* gets the permissions for a channel */
export function fetchChannelPermissions(channel) {
    const permissions = [];

    channel.permissionOverwrites.cache
        .filter((permission) => permission.type == OverwriteType.Role)
        .forEach((permission) => {
            const role = channel.guild.roles.cache.get(permission.id);
            if (role) {
                permissions.push({
                    roleName: role.name,
                    allow: permission.allow.bitfield.toString(),
                    deny: permission.deny.bitfield.toString()
                });
            }
        });

    return permissions;
}

/* fetches the voice channel data that is necessary for the backup */
export function fetchVoiceChannelData(channel) {
    return {
        type: ChannelType.GuildVoice,
        name: channel.name,
        bitrate: channel.bitrate,
        userLimit: channel.userLimit,
        parent: channel.parent ? channel.parent.name : null,
        parent_id: channel.parentId || null,
        permissions: fetchChannelPermissions(channel)
    };
}

/* fetches the stage channel data that is necessary for the backup */
export async function fetchStageChannelData(channel, options, limiter) {
    const channelData = {
        id: channel.id,
        type: ChannelType.GuildStageVoice,
        name: channel.name,
        nsfw: channel.nsfw,
        rateLimitPerUser: channel.rateLimitPerUser,
        topic: channel.topic,
        bitrate: channel.bitrate,
        userLimit: channel.userLimit,
        parent: channel.parent ? channel.parent.name : null,
        parent_id: channel.parentId || null,
        permissions: fetchChannelPermissions(channel),
        messages: []
    };

    try {
        channelData.messages = await fetchChannelMessages(channel, options, limiter);
        return channelData;
    } catch {
        return channelData;
    }
}

/**
 * Fetches messages from a channel with concurrency, batching, and rate-limiting.
 * @param {Object} channel - The Discord.js channel object to fetch messages from.
 * @param {Object} options - Options to configure fetching (e.g., maxMessagesPerChannel).
 * @param {Bottleneck} limiter - Bottleneck limiter for controlling API request rate.
 * @returns {Promise<Array>} - Resolves to an array of fetched messages.
 */
export async function fetchChannelMessages(channel, options, limiter) {
    const messages = [];
    const maxMessages = options.maxMessagesPerChannel || 10;
    const fetchOptions = { limit: Math.min(maxMessages, 100) };
    let lastMessageId;
    let fetchComplete = false;
    let batchCount = 0;

    if (options.verbose) console.log(`[fetchChannelMessages] Starting fetch for channel ${channel.id} with max ${maxMessages} messages`);

    while (!fetchComplete) {
        if (lastMessageId) fetchOptions.before = lastMessageId;

        const batchLabel = `[${channel.id}] Batch ${batchCount} Fetch Time`;
        if (options.verbose) console.time(batchLabel);

        try {
            const fetched = await limiter.schedule(() =>
                channel.messages.fetch(fetchOptions)
            );

            if (options.verbose) {
                console.timeEnd(batchLabel);
                console.log(`[fetchChannelMessages] Channel ${channel.id}, Batch ${batchCount}: Fetched ${fetched.size} messages`);
            }

            if (fetched.size === 0) break;
            lastMessageId = fetched.last().id;
            batchCount++;

            await Promise.all(
                fetched.map(async (message) => {
                    if (!message.author || messages.length >= maxMessages) {
                        fetchComplete = true;
                        return;
                    }

                    if (message.cleanContent.length > 2000) return;

                    const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
                    const files = await Promise.all(
                        message.attachments.map(async (attachment) => {
                            if (options.saveImages === "base64") {
                                // base64 encode ALL attachments (images + files)
                                try {
                                    const response = await fetchWithTimeout(attachment.url, { responseType: "arraybuffer" });
                                    return { name: attachment.name, attachment: Buffer.from(response.data, "binary").toString("base64") };
                                } catch {
                                    return { name: attachment.name, attachment: attachment.url };
                                }
                            } else if (options.saveImages === "base64-images") {
                                // base64 encode images only, URLs for everything else
                                const ext = attachment.name?.split('.').pop()?.toLowerCase();
                                if (ext && IMAGE_EXTENSIONS.includes(ext)) {
                                    try {
                                        const response = await fetchWithTimeout(attachment.url, { responseType: "arraybuffer" });
                                        return { name: attachment.name, attachment: Buffer.from(response.data, "binary").toString("base64") };
                                    } catch {
                                        return { name: attachment.name, attachment: attachment.url };
                                    }
                                }
                                return { name: attachment.name, attachment: attachment.url };
                            }
                            // Default: store URLs only
                            return { name: attachment.name, attachment: attachment.url };
                        })
                    );

                    messages.push({
                        oldId: message.id,
                        userId: message.author.id,
                        username: message.author.username,
                        avatar: message.author.displayAvatarURL(),
                        content: message.cleanContent,
                        embeds: message.embeds,
                        components: message.components,
                        files: files,
                        pinned: message.pinned,
                        sentAt: message.createdAt.toISOString(),
                    });
                })
            );
        } catch (error) {
            console.error(`[fetchChannelMessages] Error in Channel ${channel.id}, Batch ${batchCount}: ${error.message}`);
            fetchComplete = true;
        }

        if (options.verbose) console.log(`[fetchChannelMessages] Channel ${channel.id}: ${messages.length} messages fetched so far`);
    }

    messages.sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt));
    if (options.verbose) console.log(`[fetchChannelMessages] Completed fetching for channel ${channel.id}, total messages fetched: ${messages.length}`);
    return messages;
}

/* fetches the text channel data that is necessary for the backup */
export async function fetchTextChannelData(channel, options, limiter) {
    const channelData = {
        id: channel.id,
        type: channel.type,
        name: channel.name,
        nsfw: channel.nsfw,
        rateLimitPerUser: channel.type == ChannelType.GuildText ? channel.rateLimitPerUser : undefined,
        parent: channel.parent ? channel.parent.name : null,
        parent_id: channel.parentId || null,
        topic: channel.topic,
        permissions: fetchChannelPermissions(channel),
        messages: [],
        isNews: channel.type == ChannelType.GuildAnnouncement,
        threads: []
    };

    if (channel.threads.cache.size > 0) {
        for (const thread of channel.threads.cache.values()) {
            const threadData = {
                id: thread.id,
                type: thread.type,
                name: thread.name,
                archived: thread.archived,
                autoArchiveDuration: thread.autoArchiveDuration,
                locked: thread.locked,
                rateLimitPerUser: thread.rateLimitPerUser,
                messages: []
            };

            try {
                threadData.messages = await fetchChannelMessages(thread, options, limiter);
            } catch {
                // Keep empty messages on failure
            }
            channelData.threads.push(threadData);
        }
    }

    try {
        channelData.messages = await fetchChannelMessages(channel, options, limiter);
        return channelData;
    } catch {
        return channelData;
    }
}

/* creates a category for the guild */
export async function loadCategory(categoryData, guild, limiter) {
    const category = await limiter.schedule({ id: `loadCategory::guild.channels.create::${categoryData.name}` }, () => guild.channels.create({ name: categoryData.name, type: ChannelType.GuildCategory }));
    const finalPermissions = [];

    categoryData.permissions.forEach((permission) => {
        const role = guild.roles.cache.find((role) => role.name == permission.roleName);
        if (role) {
            finalPermissions.push({
                id: role.id,
                allow: BigInt(permission.allow),
                deny: BigInt(permission.deny)
            });
        }
    });

    await limiter.schedule({ id: `loadCategory::category.permissionOverwrites.set::${category.name}` }, () => category.permissionOverwrites.set(finalPermissions));
    return category;
}

/* creates a channel and returns it */
export async function loadChannel(channelData, guild, category, options, limiter) {
    const restoredThreads = new Set();

    // Function to load messages into a channel
    const loadMessages = async (channel, messages, previousWebhook) => {
        const webhook = previousWebhook || await limiter.schedule(
            { id: `loadMessages::channel.createWebhook::${channel.id}.${channel.name}` },
            () => channel.createWebhook({ name: "MessagesBackup", avatar: channel.client.user.displayAvatarURL() })
        );
        if (!webhook) return;

        // Filter out any messages that are thread names or empty content
        messages = messages.filter(message => message.content.length > 0 || message.embeds.length > 0 || message.files.length > 0);

        for (let message of messages) {
            if (message.content.length > 2000) continue; // Skip overly long messages

            try {
                let sent;

                // Check if the message `oldId` matches any thread `id` in the channel data
                const matchingThread = channelData.threads.find(thread => thread.id === message.oldId);

                if (matchingThread) {
                    // Skip sending this message as it represents a thread title
                    restoredThreads.add(matchingThread.id); // Mark thread as restored

                    // Restore the thread at this moment instead of sending the message
                    const thread = await limiter.schedule(
                        { id: `loadChannel::channel.threads.create::${matchingThread.name}` },
                        () => channel.threads.create({
                            name: matchingThread.name,
                            autoArchiveDuration: matchingThread.autoArchiveDuration
                        })
                    );

                    // Restore the messages of the thread using the webhook
                    await loadMessages(thread, matchingThread.messages, webhook);

                } else if (message.userId === channel.client.user.id) {
                    // If the message was sent by the client user, restore as a normal message
                    sent = await limiter.schedule(
                        { id: `loadMessages::channel.send::${channel.id}.${channel.name}` },
                        () => channel.send({
                            content: message.content.length ? message.content : undefined,
                            embeds: message.embeds,
                            components: message.components,
                            files: message.files,
                            allowedMentions: options.allowedMentions
                        })
                    );
                } else {
                    // Otherwise, send the message using the webhook
                    sent = await limiter.schedule(
                        { id: `loadMessages::webhook.send::${channel.id}.${channel.name}` },
                        () => webhook.send({
                            content: message.content.length ? message.content : undefined,
                            username: message.username,
                            avatarURL: message.avatar,
                            embeds: message.embeds,
                            components: message.components,
                            files: message.files,
                            allowedMentions: options.allowedMentions,
                            threadId: channel.isThread() ? channel.id : undefined
                        })
                    );
                }

                // Pin the message if it was originally pinned
                if (message.pinned && sent) {
                    await limiter.schedule(
                        { id: `loadMessages::sent.pin::${channel.id}.${channel.name}` },
                        () => sent.pin()
                    );
                }
            } catch (error) {
                if (error.message === "Request entity too large") return; // Handle large entity errors
                console.error(error);
            }
        }

        return webhook;
    };

    // Create the channel object
    const createOptions = { name: channelData.name, type: null, parent: category };

    // Determine the type of the channel
    if (channelData.type == ChannelType.GuildText || channelData.type == ChannelType.GuildAnnouncement) {
        createOptions.topic = channelData.topic;
        createOptions.nsfw = channelData.nsfw;
        createOptions.rateLimitPerUser = channelData.rateLimitPerUser;
        createOptions.type = channelData.isNews && guild.features.includes("NEWS") ? ChannelType.GuildAnnouncement : ChannelType.GuildText;
    } else if (channelData.type == ChannelType.GuildVoice) {
        createOptions.bitrate = channelData.bitrate;
        createOptions.userLimit = channelData.userLimit;
        createOptions.type = channelData.type;
    } else if (channelData.type == ChannelType.GuildStageVoice) {
        createOptions.topic = channelData.topic;
        createOptions.nsfw = channelData.nsfw;
        createOptions.bitrate = channelData.bitrate;
        createOptions.userLimit = channelData.userLimit;
        createOptions.type = ChannelType.GuildStageVoice;
    }

    const channel = await limiter.schedule(
        { id: `loadChannel::guild.channels.create::${channelData.name}` },
        () => guild.channels.create(createOptions)
    );

    // Set channel permissions
    const finalPermissions = [];
    channelData.permissions.forEach(permission => {
        const role = guild.roles.cache.find(role => role.name == permission.roleName);
        if (role) {
            finalPermissions.push({
                id: role.id,
                allow: BigInt(permission.allow),
                deny: BigInt(permission.deny)
            });
        }
    });
    await limiter.schedule(
        { id: `loadChannel::channel.permissionOverwrites.set::${channel.name}` },
        () => channel.permissionOverwrites.set(finalPermissions)
    );

    // Restore messages and threads in text channels
    if (channelData.type == ChannelType.GuildText) {
        let webhook;

        if (channelData.messages.length > 0) {
            webhook = await loadMessages(channel, channelData.messages);
        }

        if (channelData.threads.length > 0) {
            for (let threadData of channelData.threads) {
                if (restoredThreads.has(threadData.id)) continue; // Prevent restoring the thread multiple times

                const thread = await limiter.schedule(
                    { id: `loadChannel::channel.threads.create::${threadData.name}` },
                    () => channel.threads.create({
                        name: threadData.name,
                        autoArchiveDuration: threadData.autoArchiveDuration
                    })
                );

                if (webhook) await loadMessages(thread, threadData.messages, webhook);
            }
        }

        // Clean up the temporary webhook used for message restoration
        if (webhook) {
            try {
                await limiter.schedule(
                    { id: `loadChannel::webhook.delete::${channel.id}` },
                    () => webhook.delete("Backup restoration complete")
                );
            } catch {
                // Webhook may already be deleted
            }
        }
    }

    return channel;
}

/* delete all roles, channels, emojis, etc of a guild */
export async function clearGuild(guild, limiter) {
    const roles = guild.roles.cache.filter((role) => !role.managed && role.editable && role.id != guild.id);
    for (const role of roles.values()) {
        await limiter.schedule({ id: `clearGuild::role.delete::${role.id}` }, () => role.delete().catch((error) => console.error(`Error occurred while deleting roles: ${error.message}`)));
    }

    for (const channel of guild.channels.cache.values()) {
        if (channel?.deletable) {
            await limiter.schedule({ id: `clearGuild::channel.delete::${channel.id}` }, () => channel.delete().catch((error) => console.error(`Error occurred while deleting channels: ${error.message}`)));
        }
    }

    for (const emoji of guild.emojis.cache.values()) {
        await limiter.schedule({ id: `clearGuild::emoji.delete::${emoji.id}` }, () => emoji.delete().catch((error) => console.error(`Error occurred while deleting emojis: ${error.message}`)));
    }

    const webhooks = await limiter.schedule({ id: "clearGuild::guild.fetchWebhooks" }, () => guild.fetchWebhooks());
    for (const webhook of webhooks.values()) {
        await limiter.schedule({ id: `clearGuild::webhook.delete::${webhook.id}` }, () => webhook.delete().catch((error) => console.error(`Error occurred while deleting webhooks: ${error.message}`)));
    }

    const bans = await limiter.schedule({ id: "clearGuild::guild.bans.fetch" }, () => guild.bans.fetch());
    for (const ban of bans.values()) {
        await limiter.schedule({ id: `clearGuild::guild.members.unban::${ban.user.id}` }, () => guild.members.unban(ban.user).catch((error) => console.error(`Error occurred while deleting bans: ${error.message}`)));
    }

    await limiter.schedule({ id: "clearGuild::guild.setAFKChannel" }, () => guild.setAFKChannel(null));
    await limiter.schedule({ id: "clearGuild::guild.setAFKTimeout" }, () => guild.setAFKTimeout(60 * 5));
    await limiter.schedule({ id: "clearGuild::guild.setIcon" }, () => guild.setIcon(null));
    await limiter.schedule({ id: "clearGuild::guild.setBanner" }, () => guild.setBanner(null));
    await limiter.schedule({ id: "clearGuild::guild.setSplash" }, () => guild.setSplash(null));
    await limiter.schedule({ id: "clearGuild::guild.setDefaultMessageNotifications" }, () => guild.setDefaultMessageNotifications(GuildDefaultMessageNotifications.OnlyMentions));
    await limiter.schedule({ id: "clearGuild::guild.setWidgetSettings" }, () => guild.setWidgetSettings({ enabled: false, channel: null }));

    if (!guild.features.includes(GuildFeature.Community)) {
        await limiter.schedule({ id: "clearGuild::guild.setExplicitContentFilter" }, () => guild.setExplicitContentFilter(GuildExplicitContentFilter.Disabled));
        await limiter.schedule({ id: "clearGuild::guild.setVerificationLevel" }, () => guild.setVerificationLevel(GuildVerificationLevel.None));
    }

    await limiter.schedule({ id: "clearGuild::guild.setSystemChannel" }, () => guild.setSystemChannel(null));
    await limiter.schedule({ id: "clearGuild::guild.setSystemChannelFlags" }, () => guild.setSystemChannelFlags([
        GuildSystemChannelFlags.SuppressGuildReminderNotifications,
        GuildSystemChannelFlags.SuppressJoinNotifications,
        GuildSystemChannelFlags.SuppressPremiumSubscriptions
    ]));

    await limiter.schedule({ id: "clearGuild::guild.setPremiumProgressBarEnabled" }, () => guild.setPremiumProgressBarEnabled(false));

    const rules = await limiter.schedule({ id: "clearGuild::guild.autoModerationRules.fetch" }, () => guild.autoModerationRules.fetch());
    for (const rule of rules.values()) {
        await limiter.schedule({ id: `clearGuild::rule.delete::${rule.id}` }, () => rule.delete().catch((error) => console.error(`Error occurred while deleting automod rules: ${error.message}`)));
    }
}
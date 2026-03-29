/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { get as httpGet } from "http";
import { get as httpsGet } from "https";
import { join } from "path";
import { URL } from "url";

export function fileExists(event: any, folderPath: string, fileName: string): boolean {
    try {
        const fullPath = join(folderPath, fileName);
        return existsSync(fullPath);
    } catch (error) {
        console.error("[native.ts] fileExists failed:", error);
        return false;
    }
}

export function writeFile(event: any, folderPath: string, fileName: string, data: string | Uint8Array): { success: boolean; error?: string; path?: string; } {
    try {
        console.log("[native.ts] Received event:", typeof event, "is event?:", event?.type === "frame");
        console.log("[native.ts] writeFile args:", { folderPath, fileName, dataLen: data?.length });

        // Type guard: ensure folderPath is a string
        if (typeof folderPath !== "string") {
            throw new Error(`folderPath must be a string, got ${typeof folderPath}`);
        }
        if (typeof fileName !== "string") {
            throw new Error(`fileName must be a string, got ${typeof fileName}`);
        }

        console.log("[native.ts] Creating directory:", folderPath);
        if (!existsSync(folderPath)) {
            mkdirSync(folderPath, { recursive: true });
        }

        const fullPath = join(folderPath, fileName);
        console.log("[native.ts] Writing to:", fullPath);

        const buffer = data instanceof Uint8Array ? Buffer.from(data) : data;
        writeFileSync(fullPath, buffer);

        console.log("[native.ts] Write succeeded");
        return { success: true, path: fullPath };
    } catch (error) {
        console.error("[native.ts] Write failed:", error);
        return { success: false, error: String(error) };
    }
}

export async function downloadUrl(event: any, urlString: string): Promise<Uint8Array> {
    return downloadUrlInternal(urlString, 10);
}

function downloadUrlInternal(urlString: string, remainingRedirects: number): Promise<Uint8Array> {
    const url = new URL(urlString);
    const client = url.protocol === "https:" ? httpsGet : url.protocol === "http:" ? httpGet : null;
    if (!client) {
        return Promise.reject(new Error(`Unsupported protocol: ${url.protocol}`));
    }

    return new Promise((resolve, reject) => {
        const request = client(url, {
            headers: {
                "User-Agent": "Vencord"
            }
        }, res => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                if (remainingRedirects <= 0) {
                    reject(new Error("Too many redirects"));
                    return;
                }
                const nextUrl = new URL(res.headers.location, url);
                res.resume();
                resolve(downloadUrlInternal(nextUrl.toString(), remainingRedirects - 1));
                return;
            }

            if (res.statusCode && res.statusCode >= 400) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode} for ${urlString}`));
                return;
            }

            const chunks: Uint8Array[] = [];
            res.on("data", chunk => {
                chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
            });
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
        });

        request.on("error", reject);
        request.end();
    });
}

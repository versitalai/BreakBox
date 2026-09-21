// LocalSampleLibrary — IndexedDB-backed sample store for BreakBox.
// All audio data lives in IndexedDB; a small localStorage cache holds
// name/size/mime for synchronous name lookup during URL parsing.

export interface LocalSampleMeta {
    hash: string;
    filename: string;
    size: number;
    mimeType: string;
    dateAdded: number;
}

interface CacheEntry { name: string; size: number; mime: string; }
type MetaCache = Record<string, CacheEntry>;

const DB_NAME = "BreakBoxSampleLibrary";
const DB_VERSION = 1;
const STORE_NAME = "samples";
const LS_KEY = "bb_sample_meta";

// URL size limits for embedding in shareable URLs.
export const EMBED_PER_SAMPLE_LIMIT = 51200;    // 50 KB per sample
export const EMBED_TOTAL_LIMIT = 204800;         // 200 KB total

export class LocalSampleLibrary {
    private static _cache: MetaCache = LocalSampleLibrary._loadCache();

    // ---- URL helpers -------------------------------------------------------

    static isLocalUrl(url: string): boolean {
        return url.startsWith("local:");
    }

    static hashFromUrl(url: string): string {
        return url.slice(6);
    }

    static makeUrl(hash: string): string {
        return "local:" + hash;
    }

    // Synchronous — reads from localStorage cache populated on store/init.
    static getFilename(hash: string): string {
        return LocalSampleLibrary._cache[hash]?.name ?? hash;
    }

    static getSizeSync(hash: string): number {
        return LocalSampleLibrary._cache[hash]?.size ?? 0;
    }

    static getMimeSync(hash: string): string {
        return LocalSampleLibrary._cache[hash]?.mime ?? "audio/wav";
    }

    // ---- Hashing -----------------------------------------------------------

    static async computeHash(buffer: ArrayBuffer): Promise<string> {
        const hashBuf = await crypto.subtle.digest("SHA-256", buffer);
        return Array.from(new Uint8Array(hashBuf))
            .map(b => b.toString(16).padStart(2, "0"))
            .join("")
            .slice(0, 16);
    }

    // ---- CRUD --------------------------------------------------------------

    static async store(file: File): Promise<string> {
        const buffer = await file.arrayBuffer();
        const hash = await LocalSampleLibrary.computeHash(buffer);
        const mime = file.type || "audio/wav";
        const db = await LocalSampleLibrary._open();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readwrite");
            tx.objectStore(STORE_NAME).put({ hash, filename: file.name, size: file.size, mimeType: mime, dateAdded: Date.now(), data: buffer });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        db.close();
        LocalSampleLibrary._cache[hash] = { name: file.name, size: file.size, mime };
        LocalSampleLibrary._saveCache();
        return hash;
    }

    static async load(hash: string): Promise<ArrayBuffer | null> {
        const db = await LocalSampleLibrary._open();
        return new Promise(resolve => {
            const req = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(hash);
            req.onsuccess = () => { db.close(); resolve(req.result?.data ?? null); };
            req.onerror = () => { db.close(); resolve(null); };
        });
    }

    static async list(): Promise<LocalSampleMeta[]> {
        const db = await LocalSampleLibrary._open();
        return new Promise(resolve => {
            const req = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
            req.onsuccess = () => {
                db.close();
                resolve((req.result ?? []).map(({ hash, filename, size, mimeType, dateAdded }: any) =>
                    ({ hash, filename, size, mimeType, dateAdded })));
            };
            req.onerror = () => { db.close(); resolve([]); };
        });
    }

    static async remove(hash: string): Promise<void> {
        const db = await LocalSampleLibrary._open();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readwrite");
            tx.objectStore(STORE_NAME).delete(hash);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        db.close();
        delete LocalSampleLibrary._cache[hash];
        LocalSampleLibrary._saveCache();
    }

    // Returns a data: URL for the sample (for embedding in share URLs).
    static async toDataUrl(hash: string): Promise<string | null> {
        const buffer = await LocalSampleLibrary.load(hash);
        if (buffer == null) return null;
        const mime = LocalSampleLibrary.getMimeSync(hash);
        const bytes = new Uint8Array(buffer);
        let binary = "";
        const chunk = 8192;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        return `data:${mime};base64,${btoa(binary)}`;
    }

    // ---- Share URL helpers -------------------------------------------------

    // Given a list of sample URL strings (from EditorConfig.customSamples),
    // returns a report of which local: samples are embeddable vs. too large.
    static classifyLocalSamples(sampleUrls: string[]): {
        embeddable: string[];   // hashes that fit within per-sample + total limits
        oversized: Array<{ hash: string; filename: string; size: number; reason: "size" | "total" }>;
        totalEmbedBytes: number;
    } {
        const embeddable: string[] = [];
        const oversized: Array<{ hash: string; filename: string; size: number; reason: "size" | "total" }> = [];
        let totalBytes = 0;

        // First pass: collect all local: hashes and their sizes
        const locals: Array<{ hash: string; size: number; filename: string }> = [];
        for (const urlEntry of sampleUrls) {
            // Strip options prefix !...!
            let bare = urlEntry;
            if (bare.startsWith("!")) {
                const end = bare.indexOf("!", 1);
                if (end !== -1) bare = bare.slice(end + 1);
            }
            if (!LocalSampleLibrary.isLocalUrl(bare)) continue;
            const hash = LocalSampleLibrary.hashFromUrl(bare);
            const size = LocalSampleLibrary.getSizeSync(hash);
            const filename = LocalSampleLibrary.getFilename(hash);
            locals.push({ hash, size, filename });
        }

        // Second pass: classify
        for (const l of locals) {
            if (l.size > EMBED_PER_SAMPLE_LIMIT) {
                oversized.push({ ...l, reason: "size" });
            } else {
                totalBytes += l.size;
            }
        }

        // If total of individually-OK samples also exceeds total limit, move them to oversized
        if (totalBytes > EMBED_TOTAL_LIMIT) {
            // Sort by size descending, push largest into oversized until total fits
            const okSamples = locals.filter(l => l.size <= EMBED_PER_SAMPLE_LIMIT)
                .sort((a, b) => b.size - a.size);
            totalBytes = 0;
            for (const s of okSamples) {
                if (totalBytes + s.size <= EMBED_TOTAL_LIMIT) {
                    embeddable.push(s.hash);
                    totalBytes += s.size;
                } else {
                    oversized.push({ ...s, reason: "total" });
                }
            }
        } else {
            for (const l of locals.filter(l => l.size <= EMBED_PER_SAMPLE_LIMIT)) {
                embeddable.push(l.hash);
            }
        }

        return { embeddable, oversized, totalEmbedBytes: totalBytes };
    }

    // Build a shareable URL string where embeddable local: entries are replaced
    // with data: URLs. Non-embeddable local: entries are left as local:HASH
    // (they will fail to load on other machines — the share warning covers this).
    // Only hashes in `embeddable` (from classifyLocalSamples) are embedded, so
    // the URL stays within the total limit.
    static async buildShareableSampleList(sampleUrls: string[], embeddable: string[]): Promise<string[]> {
        const allowed = new Set(embeddable);
        const result: string[] = [];
        for (const urlEntry of sampleUrls) {
            let optionsPrefix = "";
            let bare = urlEntry;
            if (bare.startsWith("!")) {
                const end = bare.indexOf("!", 1);
                if (end !== -1) {
                    optionsPrefix = bare.slice(0, end + 1);
                    bare = bare.slice(end + 1);
                }
            }
            if (LocalSampleLibrary.isLocalUrl(bare)) {
                const hash = LocalSampleLibrary.hashFromUrl(bare);
                const size = LocalSampleLibrary.getSizeSync(hash);
                if (size > 0 && allowed.has(hash)) {
                    const dataUrl = await LocalSampleLibrary.toDataUrl(hash);
                    if (dataUrl != null) {
                        result.push(optionsPrefix + dataUrl);
                        continue;
                    }
                }
            }
            result.push(urlEntry);
        }
        return result;
    }

    // ---- Internal ----------------------------------------------------------

    private static _open(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = (e.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: "hash" });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    private static _loadCache(): MetaCache {
        try {
            const raw = localStorage.getItem(LS_KEY);
            if (raw) return JSON.parse(raw);
        } catch {}
        return {};
    }

    private static _saveCache(): void {
        try {
            localStorage.setItem(LS_KEY, JSON.stringify(LocalSampleLibrary._cache));
        } catch {}
    }
}

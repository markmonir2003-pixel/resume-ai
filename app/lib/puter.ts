import { create } from "zustand";

declare global {
    interface Window {
        puter: {
            auth: {
                getUser: () => Promise<PuterUser>;
                isSignedIn: () => Promise<boolean>;
                signIn: () => Promise<void>;
                signOut: () => Promise<void>;
            };
            fs: {
                write: (
                    path: string,
                    data: string | File | Blob
                ) => Promise<File | undefined>;
                read: (path: string) => Promise<Blob>;
                upload: (file: File[] | Blob[]) => Promise<FSItem>;
                delete: (path: string) => Promise<void>;
                readdir: (path: string) => Promise<FSItem[] | undefined>;
            };
            ai: {
                chat: (
                    prompt: string | ChatMessage[],
                    imageURL?: string | PuterChatOptions,
                    testMode?: boolean,
                    options?: PuterChatOptions
                ) => Promise<Object>;
                img2txt: (
                    image: string | File | Blob,
                    testMode?: boolean
                ) => Promise<string>;
            };
            kv: {
                get: (key: string) => Promise<string | null>;
                set: (key: string, value: string) => Promise<boolean>;
                delete: (key: string) => Promise<boolean>;
                list: (pattern: string, returnValues?: boolean) => Promise<string[]>;
                flush: () => Promise<boolean>;
            };
        };
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple djb2 hash — fast, no dependencies. */
function hashString(str: string): string {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = (hash * 33) ^ str.charCodeAt(i);
    }
    return (hash >>> 0).toString(36);
}

/**
 * Wraps a promise with a timeout rejection.
 * @param promise The promise to race against the timeout.
 * @param ms      Milliseconds before rejection (default 60 s).
 * @param label   Human-readable label for the error message.
 */
function withTimeout<T>(promise: Promise<T>, ms = 60_000, label = "Operation"): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
            ms
        );
        promise.then(
            (val) => { clearTimeout(timer); resolve(val); },
            (err) => { clearTimeout(timer); reject(err); }
        );
    });
}

// ---------------------------------------------------------------------------
// In-memory AI response cache (per session, intentionally not persisted)
// Key: hashString(filePath + instructionString)
// ---------------------------------------------------------------------------
const aiResponseCache = new Map<string, AIResponse>();

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

interface PuterStore {
    /** @deprecated prefer loadingStates for granular UI control */
    isLoading: boolean;
    /** Granular loading flags. Keys: "upload", "analysis", "auth", etc. */
    loadingStates: Record<string, boolean>;
    error: string | null;
    puterReady: boolean;
    auth: {
        user: PuterUser | null;
        isAuthenticated: boolean;
        signIn: () => Promise<void>;
        signOut: () => Promise<void>;
        refreshUser: () => Promise<void>;
        checkAuthStatus: () => Promise<boolean>;
        getUser: () => PuterUser | null;
    };
    fs: {
        write: (
            path: string,
            data: string | File | Blob
        ) => Promise<File | undefined>;
        read: (path: string) => Promise<Blob | undefined>;
        upload: (file: File[] | Blob[]) => Promise<FSItem | undefined>;
        delete: (path: string) => Promise<void>;
        readDir: (path: string) => Promise<FSItem[] | undefined>;
    };
    ai: {
        chat: (
            prompt: string | ChatMessage[],
            imageURL?: string | PuterChatOptions,
            testMode?: boolean,
            options?: PuterChatOptions
        ) => Promise<AIResponse | undefined>;
        feedback: (
            path: string,
            message: string,
            timeoutMs?: number
        ) => Promise<AIResponse | undefined>;
        img2txt: (
            image: string | File | Blob,
            testMode?: boolean
        ) => Promise<string | undefined>;
    };
    kv: {
        get: (key: string) => Promise<string | null | undefined>;
        set: (key: string, value: string) => Promise<boolean | undefined>;
        delete: (key: string) => Promise<boolean | undefined>;
        list: (
            pattern: string,
            returnValues?: boolean
        ) => Promise<string[] | KVItem[] | undefined>;
        flush: () => Promise<boolean | undefined>;
    };

    init: () => void;
    clearError: () => void;
    /** Set / clear a granular loading flag (e.g. "upload", "analysis"). */
    setLoadingState: (key: string, value: boolean) => void;
    /** Clear the in-memory AI response cache. */
    clearAiCache: () => void;
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

const getPuter = (): typeof window.puter | null =>
    typeof window !== "undefined" && window.puter ? window.puter : null;

export const usePuterStore = create<PuterStore>((set, get) => {
    // ------------------------------------------------------------------
    // Error helper
    // ------------------------------------------------------------------
    const setError = (msg: string) => {
        set({ error: msg, isLoading: false });
    };

    // ------------------------------------------------------------------
    // Auth
    // ------------------------------------------------------------------
    const checkAuthStatus = async (): Promise<boolean> => {
        const puter = getPuter();
        if (!puter) { setError("Puter.js not available"); return false; }

        set({ isLoading: true, error: null });

        try {
            const isSignedIn = await puter.auth.isSignedIn();
            if (isSignedIn) {
                const user = await puter.auth.getUser();
                set({
                    auth: {
                        user,
                        isAuthenticated: true,
                        signIn: get().auth.signIn,
                        signOut: get().auth.signOut,
                        refreshUser: get().auth.refreshUser,
                        checkAuthStatus: get().auth.checkAuthStatus,
                        getUser: () => user,
                    },
                    isLoading: false,
                });
                return true;
            } else {
                set({
                    auth: {
                        user: null,
                        isAuthenticated: false,
                        signIn: get().auth.signIn,
                        signOut: get().auth.signOut,
                        refreshUser: get().auth.refreshUser,
                        checkAuthStatus: get().auth.checkAuthStatus,
                        getUser: () => null,
                    },
                    isLoading: false,
                });
                return false;
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Failed to check auth status";
            setError(msg);
            return false;
        }
    };

    const signIn = async (): Promise<void> => {
        const puter = getPuter();
        if (!puter) { setError("Puter.js not available"); return; }

        set({ isLoading: true, error: null });
        try {
            await puter.auth.signIn();
            await checkAuthStatus();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Sign in failed");
        }
    };

    const signOut = async (): Promise<void> => {
        const puter = getPuter();
        if (!puter) { setError("Puter.js not available"); return; }

        set({ isLoading: true, error: null });
        try {
            await puter.auth.signOut();
            set({
                auth: {
                    user: null,
                    isAuthenticated: false,
                    signIn: get().auth.signIn,
                    signOut: get().auth.signOut,
                    refreshUser: get().auth.refreshUser,
                    checkAuthStatus: get().auth.checkAuthStatus,
                    getUser: () => null,
                },
                isLoading: false,
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : "Sign out failed");
        }
    };

    const refreshUser = async (): Promise<void> => {
        const puter = getPuter();
        if (!puter) { setError("Puter.js not available"); return; }

        set({ isLoading: true, error: null });
        try {
            const user = await puter.auth.getUser();
            set({
                auth: {
                    user,
                    isAuthenticated: true,
                    signIn: get().auth.signIn,
                    signOut: get().auth.signOut,
                    refreshUser: get().auth.refreshUser,
                    checkAuthStatus: get().auth.checkAuthStatus,
                    getUser: () => user,
                },
                isLoading: false,
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to refresh user");
        }
    };

    // ------------------------------------------------------------------
    // Init
    // ------------------------------------------------------------------
    const init = (): void => {
        const puter = getPuter();
        if (puter) {
            set({ puterReady: true });
            checkAuthStatus();
            return;
        }

        const interval = setInterval(() => {
            if (getPuter()) {
                clearInterval(interval);
                set({ puterReady: true });
                checkAuthStatus();
            }
        }, 100);

        setTimeout(() => {
            clearInterval(interval);
            if (!getPuter()) setError("Puter.js failed to load within 10 seconds");
        }, 10_000);
    };

    // ------------------------------------------------------------------
    // FS
    // ------------------------------------------------------------------
    const write = async (path: string, data: string | File | Blob) => {
        const puter = getPuter();
        if (!puter) { setError("Puter.js not available"); return; }
        return puter.fs.write(path, data);
    };

    const readDir = async (path: string) => {
        const puter = getPuter();
        if (!puter) { setError("Puter.js not available"); return; }
        return puter.fs.readdir(path);
    };

    const readFile = async (path: string) => {
        const puter = getPuter();
        if (!puter) { setError("Puter.js not available"); return; }
        return puter.fs.read(path);
    };

    const upload = async (files: File[] | Blob[]) => {
        const puter = getPuter();
        if (!puter) { setError("Puter.js not available"); return; }
        return puter.fs.upload(files);
    };

    const deleteFile = async (path: string) => {
        const puter = getPuter();
        if (!puter) { setError("Puter.js not available"); return; }
        return puter.fs.delete(path);
    };

    // ------------------------------------------------------------------
    // AI
    // ------------------------------------------------------------------
    const chat = async (
        prompt: string | ChatMessage[],
        imageURL?: string | PuterChatOptions,
        testMode?: boolean,
        options?: PuterChatOptions
    ) => {
        const puter = getPuter();
        if (!puter) { setError("Puter.js not available"); return; }
        return puter.ai.chat(prompt, imageURL, testMode, options) as Promise<AIResponse | undefined>;
    };

    /**
     * Calls the AI feedback endpoint with:
     *  - In-memory caching (cache key = hash of path + message)
     *  - Configurable timeout (default 90 s — AI is slow)
     *  - Granular "analysis" loading state
     *
     * NOTE: Puter's ai.chat() signature is:
     *   chat(prompt, imageURL?: string | PuterChatOptions, testMode?, options?)
     * Passing a PuterChatOptions object as the 2nd argument is the INTENDED API
     * pattern when there is no image URL — do NOT pass undefined/false before it.
     */
    const feedback = async (
        path: string,
        message: string,
        timeoutMs = 90_000   // 90 s — Claude 3.5 Sonnet is accurate and reasonably fast
    ): Promise<AIResponse | undefined> => {
        const puter = getPuter();
        if (!puter) { setError("Puter.js not available"); return; }

        // Cache check — instant return for repeated identical requests
        const cacheKey = hashString(path + message);
        const cached = aiResponseCache.get(cacheKey);
        if (cached) {
            console.log("[AI Cache] HIT for key:", cacheKey);
            set((state) => ({
                loadingStates: { ...state.loadingStates, analysis: false },
            }));
            return cached;
        }

        set((state) => ({
            loadingStates: { ...state.loadingStates, analysis: true },
        }));

        try {
            // Pass { model } as the 2nd argument — this is the correct Puter pattern.
            // The 2nd param type is `string | PuterChatOptions`, so an options object
            // is a valid value when there is no image URL involved.
            const apiCall = puter.ai.chat(
                [
                    {
                        role: "user",
                        content: [
                            { type: "file", puter_path: path },
                            { type: "text", text: message },
                        ],
                    },
                ],
                // anthropic/claude-3-5-sonnet supports the puter_path file content type.
                // Gemini and other providers do NOT support puter_path — use Claude models for file analysis.
                // See full model list: https://developer.puter.com/ai/models/
                { model: "anthropic/claude-3-5-sonnet" }
            ) as Promise<AIResponse | undefined>;

            const result = await withTimeout(apiCall, timeoutMs, "AI analysis");

            if (result?.message) {
                aiResponseCache.set(cacheKey, result);
            }

            return result;
        } catch (err) {
            // Puter API sometimes throws plain objects, not Error instances.
            // Always normalize to a proper Error so callers get a readable .message.
            let msg: string;
            if (err instanceof Error) {
                msg = err.message;
            } else if (typeof err === 'object' && err !== null) {
                // Try common Puter error shapes first, then fall back to JSON
                const e = err as Record<string, unknown>;
                msg = (typeof e.message === 'string' ? e.message : null)
                    ?? (typeof e.error === 'string' ? e.error : null)
                    ?? (typeof e.statusText === 'string' ? e.statusText : null)
                    ?? JSON.stringify(err);
            } else {
                msg = String(err);
            }
            console.error("[AI feedback]", msg, err);
            throw new Error(msg); // always a real Error from here on
        } finally {
            set((state) => ({
                loadingStates: { ...state.loadingStates, analysis: false },
            }));
        }
    };

    const img2txt = async (image: string | File | Blob, testMode?: boolean) => {
        const puter = getPuter();
        if (!puter) { setError("Puter.js not available"); return; }
        return puter.ai.img2txt(image, testMode);
    };

    // ------------------------------------------------------------------
    // KV
    // ------------------------------------------------------------------
    const getKV = async (key: string) => {
        const puter = getPuter();
        if (!puter) { setError("Puter.js not available"); return; }
        return puter.kv.get(key);
    };

    const setKV = async (key: string, value: string) => {
        const puter = getPuter();
        if (!puter) { setError("Puter.js not available"); return; }
        return puter.kv.set(key, value);
    };

    const deleteKV = async (key: string) => {
        const puter = getPuter();
        if (!puter) { setError("Puter.js not available"); return; }
        return puter.kv.delete(key);
    };

    const listKV = async (pattern: string, returnValues = false) => {
        const puter = getPuter();
        if (!puter) { setError("Puter.js not available"); return; }
        return puter.kv.list(pattern, returnValues);
    };

    const flushKV = async () => {
        const puter = getPuter();
        if (!puter) { setError("Puter.js not available"); return; }
        return puter.kv.flush();
    };

    // ------------------------------------------------------------------
    // Initial state
    // ------------------------------------------------------------------
    return {
        isLoading: true,
        loadingStates: {},
        error: null,
        puterReady: false,
        auth: {
            user: null,
            isAuthenticated: false,
            signIn,
            signOut,
            refreshUser,
            checkAuthStatus,
            getUser: () => get().auth.user,
        },
        fs: {
            write: (path, data) => write(path, data),
            read: (path) => readFile(path),
            readDir: (path) => readDir(path),
            upload: (files) => upload(files),
            delete: (path) => deleteFile(path),
        },
        ai: {
            chat: (prompt, imageURL, testMode, options) =>
                chat(prompt, imageURL, testMode, options),
            feedback: (path, message, timeoutMs) =>
                feedback(path, message, timeoutMs),
            img2txt: (image, testMode) => img2txt(image, testMode),
        },
        kv: {
            get: (key) => getKV(key),
            set: (key, value) => setKV(key, value),
            delete: (key) => deleteKV(key),
            list: (pattern, returnValues) => listKV(pattern, returnValues),
            flush: () => flushKV(),
        },
        init,
        clearError: () => set({ error: null }),
        setLoadingState: (key, value) =>
            set((state) => ({
                loadingStates: { ...state.loadingStates, [key]: value },
            })),
        clearAiCache: () => aiResponseCache.clear(),
    };
});

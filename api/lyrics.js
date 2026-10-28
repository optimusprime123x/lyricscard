const LRC_RED_BASE = "https://lrc.red";
const LRCLIB_GET_BASE = "https://lrclib.net/api/get";
const LRCLIB_SEARCH_BASE = "https://lrclib.net/api/search";
const STEFDP_LYRICS_BASE = "https://lyrics.stefdp.com/lyrics";
const USER_AGENT = "LyricPost/2.0 (https://github.com/optimuspime123/lyricscard)";
const PROVIDER_TIMEOUT_MS = 9000;
const RETRY_DELAY_MS = 500;

function formatSyncedLine(time, text) {
    const totalSeconds = Number(time);
    if (!Number.isFinite(totalSeconds) || !text) return null;

    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const centiseconds = Math.floor((totalSeconds % 1) * 100);
    return `[${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}]${text}`;
}

function parseLrc(rawLrc) {
    if (!rawLrc || typeof rawLrc !== "string") return null;
    const lines = rawLrc.split(/\r?\n/);
    const syncedLines = [];
    const plainLines = [];

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        // Strip non-lyric metadata lines like [ti:...], [ar:...], [al:...], [length:...]
        if (/^\[[a-zA-Z]+:[^\]]*\]/.test(line)) continue;

        const match = line.match(/^(\[\d{2}:\d{2}(?:\.\d+)?\])(.*)$/);
        if (match) {
            const timeTag = match[1];
            // Remove word-sync tags like <00:27.40>
            const text = match[2].replace(/<[^>]+>/g, "").trim();
            if (text) {
                syncedLines.push(`${timeTag} ${text}`);
                plainLines.push(text);
            }
        }
    }

    if (syncedLines.length === 0) return null;
    return {
        syncedLyrics: syncedLines.join("\n"),
        plainLyrics: plainLines.join("\n"),
    };
}

function normalizeLyrics(payload) {
    if (!payload?.syncedLyrics && !payload?.plainLyrics) return null;
    return payload;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function timedFetch(url, options = {}, timeoutMs = PROVIDER_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const externalSignal = options.signal;
    if (externalSignal?.aborted) {
        clearTimeout(timer);
        throw new Error("Aborted");
    }

    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
        const fetchOptions = { ...options, signal: controller.signal };
        return await fetch(url, fetchOptions);
    } finally {
        clearTimeout(timer);
        if (externalSignal) {
            externalSignal.removeEventListener("abort", onExternalAbort);
        }
    }
}

async function lrcRedLyricsCall(isrc, artist, track, signal) {
    if (!isrc) return null;
    const url = `${LRC_RED_BASE}/s/${encodeURIComponent(isrc)}.lrc`;
    const response = await timedFetch(url, {
        signal,
        headers: { "User-Agent": USER_AGENT },
    });

    if (response.status === 404) {
        return null;
    }

    if (!response.ok) {
        throw new Error(`lrc.red lyrics ${response.status}`);
    }

    const raw = await response.text();
    const parsed = parseLrc(raw);
    if (!parsed) return null;

    return normalizeLyrics({
        provider: "lrc.red",
        trackName: track || null,
        artistName: artist || null,
        syncedLyrics: parsed.syncedLyrics,
        plainLyrics: parsed.plainLyrics,
    });
}

async function stefdpLyricsCall(artist, track, durationMs, signal) {
    const url = new URL(STEFDP_LYRICS_BASE);
    url.searchParams.set("artist", artist);
    url.searchParams.set("track", track);
    if (durationMs) {
        url.searchParams.set("duration", String(durationMs));
    }

    const response = await timedFetch(url, {
        signal,
        headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok) {
        throw new Error(`StefDP lyrics ${response.status}`);
    }

    const data = await response.json();
    const lineSynced = data?.lyrics?.lineSynced?.lyrics;
    const syncedLyrics = Array.isArray(lineSynced)
        ? lineSynced.map((line) => formatSyncedLine(line.time, line.text)).filter(Boolean).join("\n")
        : null;

    return normalizeLyrics({
        provider: "stefdp",
        trackName: track,
        artistName: artist,
        syncedLyrics: syncedLyrics || null,
        plainLyrics: data?.lyrics?.plain?.lyrics ?? null,
    });
}

async function lrclibGetCall(artist, track, durationSeconds, signal) {
    if (!track) return null;
    const url = new URL(LRCLIB_GET_BASE);
    url.searchParams.set("track_name", track);
    if (artist) url.searchParams.set("artist_name", artist);
    if (durationSeconds) url.searchParams.set("duration", String(durationSeconds));

    const response = await timedFetch(url, {
        signal,
        headers: { "User-Agent": USER_AGENT },
    });

    if (response.status === 404) {
        return null;
    }

    if (!response.ok) {
        throw new Error(`lrclib get ${response.status}`);
    }

    const data = await response.json();
    return normalizeLyrics({
        provider: "lrclib",
        trackName: data.trackName ?? track,
        artistName: data.artistName ?? artist,
        syncedLyrics: data.syncedLyrics ?? null,
        plainLyrics: data.plainLyrics ?? null,
    });
}

async function lrclibSearchCall(artist, track, durationSeconds, signal) {
    let url = new URL(LRCLIB_SEARCH_BASE);
    url.searchParams.set("track_name", track);
    if (artist) url.searchParams.set("artist_name", artist);
    if (durationSeconds) url.searchParams.set("duration", String(durationSeconds));

    let response = await timedFetch(url, {
        signal,
        headers: { "User-Agent": USER_AGENT },
    });

    let results = null;
    if (response.ok) {
        results = await response.json();
    } else if (response.status !== 404) {
        throw new Error(`lrclib search ${response.status}`);
    }

    if (!Array.isArray(results) || results.length === 0) {
        url = new URL(LRCLIB_SEARCH_BASE);
        url.searchParams.set("q", `${artist} ${track}`.trim());
        if (durationSeconds) url.searchParams.set("duration", String(durationSeconds));

        response = await timedFetch(url, {
            signal,
            headers: { "User-Agent": USER_AGENT },
        });

        if (!response.ok) {
            throw new Error(`lrclib search fallback ${response.status}`);
        }
        results = await response.json();
    }

    if (!Array.isArray(results) || results.length === 0) {
        return null;
    }

    const trackLower = track.toLowerCase();
    const exactMatches = results.filter(
        (r) => r?.trackName?.toLowerCase().trim() === trackLower
    );
    const chosen = exactMatches[0] ?? results[0];

    if (!chosen) {
        return null;
    }

    return normalizeLyrics({
        provider: "lrclib",
        trackName: chosen.trackName ?? null,
        artistName: chosen.artistName ?? null,
        syncedLyrics: chosen.syncedLyrics ?? null,
        plainLyrics: chosen.plainLyrics ?? null,
    });
}

async function lrclibLyricsCall(artist, track, durationSeconds, signal) {
    // 1. Try exact /api/get lookup first
    const directMatch = await lrclibGetCall(artist, track, durationSeconds, signal);
    if (directMatch) return directMatch;

    // 2. Fall back to /api/search if /api/get returned 404 or had no lyrics
    return await lrclibSearchCall(artist, track, durationSeconds, signal);
}

async function raceFirstValidLyrics(tasks) {
    if (tasks.length === 0) return null;
    if (tasks.length === 1) {
        try {
            return await tasks[0]();
        } catch {
            return null;
        }
    }

    const controllers = tasks.map(() => new AbortController());
    try {
        const winner = await Promise.any(
            tasks.map((task, index) =>
                task(controllers[index].signal).then((result) => {
                    const valid = normalizeLyrics(result);
                    if (!valid) throw new Error("No lyrics");
                    // First valid response cancels other running requests
                    controllers.forEach((c, i) => {
                        if (i !== index) c.abort();
                    });
                    return valid;
                })
            )
        );
        return winner;
    } catch {
        return null;
    } finally {
        controllers.forEach((c) => c.abort());
    }
}

module.exports = async (req, res) => {
    if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return res.status(405).json({ error: "Method not allowed" });
    }

    const artist = typeof req.query.artist === "string" ? req.query.artist.trim() : "";
    const track = typeof req.query.track === "string" ? req.query.track.trim() : "";
    const isrc = typeof req.query.isrc === "string" ? req.query.isrc.trim() : "";
    const rawDuration = req.query.duration || req.query.durationMs || req.query.duration_ms;
    const durationNum = Number(rawDuration);

    let durationMs = null;
    let durationSeconds = null;

    if (Number.isFinite(durationNum) && durationNum > 0) {
        if (durationNum > 10000) {
            durationMs = Math.round(durationNum);
            durationSeconds = Math.round(durationNum / 1000);
        } else {
            durationSeconds = Math.round(durationNum);
            durationMs = Math.round(durationNum * 1000);
        }
    }

    if (!track) {
        return res.status(400).json({ error: "Missing 'track' parameter" });
    }

    try {
        let lyrics = null;
        let lrclibError = null;
        let lrclibFailedAt = null;

        const lrclibTask = async (signal) => {
            try {
                return await lrclibLyricsCall(artist, track, durationSeconds, signal);
            } catch (err) {
                if (!signal?.aborted) {
                    lrclibError = err;
                    lrclibFailedAt = Date.now();
                }
                throw err;
            }
        };

        // 1. If we have ISRC, run lrc.red and lrclib1 concurrently.
        // First valid response cancels the other and wins!
        if (isrc) {
            const lrcRedTask = async (signal) => {
                return await lrcRedLyricsCall(isrc, artist, track, signal);
            };

            lyrics = await raceFirstValidLyrics([lrcRedTask, lrclibTask]);
        } else {
            try {
                lyrics = await lrclibTask();
            } catch {
                // Handled in lrclibTask
            }
        }

        // If either lrc.red or lrclib1 returned valid lyrics, return them
        if (lyrics) {
            res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
            return res.status(200).json(lyrics);
        }

        // 2. If both (or lrclib1) failed, try StefDP
        try {
            lyrics = await stefdpLyricsCall(artist, track, durationMs);
        } catch {
            // StefDP failed (e.g. Cloudflare challenge or network error)
        }

        if (lyrics) {
            res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
            return res.status(200).json(lyrics);
        }

        // 3. If lrclib1 previously errored (e.g. 503/429/network), retry lrclib2 once.
        // Wait remainder of 500ms if needed.
        if (lrclibError) {
            const elapsed = Date.now() - lrclibFailedAt;
            if (elapsed < RETRY_DELAY_MS) {
                await sleep(RETRY_DELAY_MS - elapsed);
            }

            try {
                lyrics = await lrclibLyricsCall(artist, track, durationSeconds);
            } catch (err) {
                console.warn("lrclib retry failed:", err.message);
            }
        }

        if (!lyrics) {
            return res.status(404).json({ error: "No lyrics found" });
        }

        res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
        return res.status(200).json(lyrics);
    } catch (err) {
        console.error("lyrics error:", err);
        return res.status(502).json({ error: "Lyrics fetch failed" });
    }
};

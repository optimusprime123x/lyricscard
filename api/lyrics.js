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
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
        });
        return response;
    } finally {
        clearTimeout(timer);
    }
}

async function stefdpLyricsCall(artist, track, durationMs) {
    const url = new URL(STEFDP_LYRICS_BASE);
    url.searchParams.set("artist", artist);
    url.searchParams.set("track", track);
    if (durationMs) {
        url.searchParams.set("duration", String(durationMs));
    }

    const response = await timedFetch(url, {
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

async function lrclibGetCall(artist, track, durationSeconds) {
    if (!track) return null;
    const url = new URL(LRCLIB_GET_BASE);
    url.searchParams.set("track_name", track);
    if (artist) url.searchParams.set("artist_name", artist);
    if (durationSeconds) url.searchParams.set("duration", String(durationSeconds));

    const response = await timedFetch(url, {
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

async function lrclibSearchCall(artist, track, durationSeconds) {
    let url = new URL(LRCLIB_SEARCH_BASE);
    url.searchParams.set("track_name", track);
    if (artist) url.searchParams.set("artist_name", artist);
    if (durationSeconds) url.searchParams.set("duration", String(durationSeconds));

    let response = await timedFetch(url, {
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

async function lrclibLyricsCall(artist, track, durationSeconds) {
    // 1. Try exact /api/get lookup first
    const directMatch = await lrclibGetCall(artist, track, durationSeconds);
    if (directMatch) return directMatch;

    // 2. Fall back to /api/search if /api/get returned 404 or had no lyrics
    return await lrclibSearchCall(artist, track, durationSeconds);
}

module.exports = async (req, res) => {
    if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return res.status(405).json({ error: "Method not allowed" });
    }

    const artist = typeof req.query.artist === "string" ? req.query.artist.trim() : "";
    const track = typeof req.query.track === "string" ? req.query.track.trim() : "";
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

        // 1. Try LRCLIB first (/api/get then /api/search)
        try {
            lyrics = await lrclibLyricsCall(artist, track, durationSeconds);
        } catch (err) {
            lrclibError = err;
            lrclibFailedAt = Date.now();
        }

        // 2. If LRCLIB succeeded and returned valid lyrics, return them
        if (lyrics) {
            res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
            return res.status(200).json(lyrics);
        }

        // 3. If LRCLIB errored or found nothing, try StefDP
        try {
            lyrics = await stefdpLyricsCall(artist, track, durationMs);
        } catch {
            // StefDP failed (e.g. Cloudflare challenge or network error)
        }

        if (lyrics) {
            res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
            return res.status(200).json(lyrics);
        }

        // 4. If LRCLIB previously errored (e.g. 503/429/network), retry LRCLIB once.
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

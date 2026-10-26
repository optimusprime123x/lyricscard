const LRCLIB_BASE = "https://lrclib.net/api/search";
const STEFDP_LYRICS_BASE = "https://lyrics.stefdp.com/lyrics";
const USER_AGENT = "LyricPost/2.0 (https://github.com/optimuspime123/lyricscard)";
const PROVIDER_TIMEOUT_MS = 9000;

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

function createProviderRequest(providerCall) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

    return {
        controller,
        promise: providerCall(controller.signal).finally(() => clearTimeout(timeout)),
    };
}

async function firstValidLyrics(providerRequests) {
    if (providerRequests.length === 0) return null;

    try {
        return await Promise.any(
            providerRequests.map(({ promise }) =>
                promise.then((lyrics) => {
                    const normalized = normalizeLyrics(lyrics);
                    if (!normalized) throw new Error("No lyrics found");
                    return normalized;
                })
            )
        );
    } catch {
        return null;
    } finally {
        providerRequests.forEach(({ controller }) => controller.abort());
    }
}

async function stefdpLyricsCall(artist, track, durationMs, signal) {
    const url = new URL(STEFDP_LYRICS_BASE);
    url.searchParams.set("artist", artist);
    url.searchParams.set("track", track);
    if (durationMs) {
        url.searchParams.set("duration", String(durationMs));
    }

    const response = await fetch(url, {
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

    return {
        provider: "stefdp",
        trackName: track,
        artistName: artist,
        syncedLyrics: syncedLyrics || null,
        plainLyrics: data?.lyrics?.plain?.lyrics ?? null,
    };
}

async function lrclibLyricsCall(artist, track, durationSeconds, signal) {
    let url = new URL(LRCLIB_BASE);
    url.searchParams.set("track_name", track);
    if (artist) url.searchParams.set("artist_name", artist);
    if (durationSeconds) url.searchParams.set("duration", String(durationSeconds));

    let response = await fetch(url, {
        signal,
        headers: { "User-Agent": USER_AGENT },
    });
    let results = response.ok ? await response.json() : null;

    if (!Array.isArray(results) || results.length === 0) {
        url = new URL(LRCLIB_BASE);
        url.searchParams.set("q", `${artist} ${track}`.trim());
        if (durationSeconds) url.searchParams.set("duration", String(durationSeconds));

        response = await fetch(url, {
            signal,
            headers: { "User-Agent": USER_AGENT },
        });
        if (!response.ok) {
            throw new Error(`lrclib lyrics ${response.status}`);
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

    return {
        provider: "lrclib",
        trackName: chosen.trackName ?? null,
        artistName: chosen.artistName ?? null,
        syncedLyrics: chosen.syncedLyrics ?? null,
        plainLyrics: chosen.plainLyrics ?? null,
    };
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
        const providerRequests = [
            createProviderRequest((signal) =>
                stefdpLyricsCall(artist, track, durationMs, signal)
            ),
            createProviderRequest((signal) =>
                lrclibLyricsCall(artist, track, durationSeconds, signal)
            ),
        ];

        const lyrics = await firstValidLyrics(providerRequests);
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

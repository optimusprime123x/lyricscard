const LASTFM_BASE = "https://ws.audioscrobbler.com/2.0/";
const SPOTSEARCH_BASE = "https://spotsearch.ananke-862.workers.dev/search";
const USER_AGENT = "LyricPost/2.0 (https://github.com/optimuspime123/lyricscard)";
const MAX_LIMIT = 12;
const DEFAULT_LIMIT = 6;

function pickAlbumCover(images) {
    if (!Array.isArray(images)) return null;
    for (let i = images.length - 1; i >= 0; i--) {
        const url = images[i]?.["#text"];
        if (url) return url;
    }
    return null;
}

async function spotsearchCall(query, limit) {
    const url = new URL(SPOTSEARCH_BASE);
    url.searchParams.set("q", query);

    const response = await fetch(url, {
        headers: {
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    });

    if (!response.ok) {
        throw new Error(`Spotsearch ${response.status}`);
    }

    const data = await response.json();
    const isMatched = data?.status === "matched";
    const bestTrack = data?.best;
    const matchedTrackId = (isMatched && bestTrack)
        ? (bestTrack.spotify_track_id || bestTrack.id)
        : null;

    let items = Array.isArray(data?.results) ? [...data.results] : [];
    if (bestTrack && !items.some(t => (t.spotify_track_id || t.id) === (bestTrack.spotify_track_id || bestTrack.id))) {
        items.unshift(bestTrack);
    }

    if (items.length === 0) {
        return [];
    }

    return items.slice(0, limit).map((track) => {
        const trackId = track.spotify_track_id || track.id || null;
        return {
            spotifyTrackId: trackId,
            name: track.title || track.name || "",
            durationMs: Number(track.duration_ms) || 0,
            artists: (Array.isArray(track.artists) ? track.artists : []).map((a) => ({
                name: typeof a === "string" ? a : (a?.name || ""),
            })),
            albumCoverUrl: track.album_art_url || null,
            album: track.album || null,
            isrc: track.isrc || null,
            releaseDate: track.release_date || null,
            isExplicit: Boolean(track.is_explicit),
            previewUrl: track.preview_url || null,
            isMatched: Boolean(isMatched && matchedTrackId && trackId === matchedTrackId),
        };
    });
}

async function lastfmSearch(query, limit, apiKey) {
    const searchData = await lastfmCall(
        { method: "track.search", track: query, limit: String(limit) },
        apiKey
    );
    const tracks = searchData?.results?.trackmatches?.track || [];

    const songs = await Promise.all(
        tracks.map(async (t) => {
            try {
                const infoData = await lastfmCall(
                    { method: "track.getInfo", artist: t.artist, track: t.name },
                    apiKey
                );
                const track = infoData?.track;
                if (!track) return null;
                return {
                    name: track.name,
                    durationMs: track.duration ? Number(track.duration) : 0,
                    artists: track.artist?.name ? [{ name: track.artist.name }] : [],
                    albumCoverUrl: pickAlbumCover(track.album?.image),
                    album: track.album?.title || null,
                    isrc: null,
                    releaseDate: null,
                    isExplicit: false,
                    previewUrl: null,
                    isMatched: false,
                };
            } catch {
                return null;
            }
        })
    );

    return songs.filter(Boolean);
}

async function lastfmCall(params, apiKey) {
    const url = new URL(LASTFM_BASE);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("format", "json");
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!response.ok) throw new Error(`Last.fm ${response.status}`);
    return response.json();
}

module.exports = async (req, res) => {
    if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return res.status(405).json({ error: "Method not allowed" });
    }

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
        return res.status(400).json({ error: "Missing or empty 'q' parameter" });
    }

    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(MAX_LIMIT, requestedLimit))
        : DEFAULT_LIMIT;

    try {
        let songs = [];

        try {
            songs = await spotsearchCall(q, limit);
        } catch (err) {
            console.warn("Spotsearch fallback:", err.message);
        }

        if (!songs || songs.length === 0) {
            const apiKey = process.env.LASTFM_API_KEY;
            if (apiKey) {
                try {
                    songs = await lastfmSearch(q, limit, apiKey);
                } catch (err) {
                    console.warn("Last.fm search fallback failed:", err.message);
                }
            }
        }

        res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=1800");
        return res.status(200).json({ songs: songs || [] });
    } catch (err) {
        console.error("search error:", err);
        return res.status(502).json({ error: "Search failed upstream" });
    }
};

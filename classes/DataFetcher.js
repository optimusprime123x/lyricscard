class DataFetcher {
    constructor(apiBase = "/api") {
        /** @type {string} */
        this.apiBase = apiBase;
    }

    /**
     * Searches for songs via the backend, which proxies Spotsearch and Last.fm.
     *
     * @param {string} name
     * @param {number} limit
     * @returns {Promise<Song[]>} an array of Song objects
     */
    async getSongInfos(name, limit = 6) {
        const url = `${this.apiBase}/search?q=${encodeURIComponent(name)}&limit=${encodeURIComponent(limit)}`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Search failed (${response.status})`);
        }
        const { songs = [] } = await response.json();
        return songs.map((song) => new Song(song));
    }

    /**
     * Searches for song lyrics via the backend, which proxies StefDP and lrclib.
     *
     * @param {string} artistName
     * @param {string} trackName
     * @param {number|null} duration Duration in ms (or seconds) from search result
     * @param {AbortSignal|null} signal
     * @returns {Promise<object|null>} a lyrics object compatible with Song.loadLyrics
     */
    async getSongLyrics(artistName, trackName, duration = null, signal = null) {
        const params = new URLSearchParams({ artist: artistName, track: trackName });
        if (duration !== null && duration !== undefined && duration > 0) {
            params.set("duration", String(duration));
        }

        const url = `${this.apiBase}/lyrics?${params.toString()}`;
        const response = await fetch(url, signal ? { signal } : undefined);
        if (response.status === 404) return null;
        if (!response.ok) {
            throw new Error(`Lyrics fetch failed (${response.status})`);
        }
        return response.json();
    }
}

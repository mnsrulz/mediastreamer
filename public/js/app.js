import * as Plot from "https://esm.sh/@observablehq/plot@0.6.13?bundle";
import ky from "https://esm.sh/ky@1";

import dayjs from "https://esm.sh/dayjs@1";
import relativeTime from "https://esm.sh/dayjs@1/plugin/relativeTime.js";
import prettyBytes from 'https://esm.sh/pretty-bytes@7';
import { group, sort } from 'https://esm.sh/radash@12'

dayjs.extend(relativeTime);

// const apiResponse = await fetch('stats');
// const apiData = await apiResponse.json();
const REFRESH_INTERVAL_MS = 1000;
const fn1 = (selectedImdbId, selectedItemSize, items) => {
    const { bufferRange, size } = items.find(x => x.imdbId === selectedImdbId && x.size === selectedItemSize);
    if (!bufferRange || bufferRange.length === 0) return 'No buffer elements to plot chart.';
    const chunkSize = parseInt((size / 300).toFixed(0));   //size comes as 100 MB
    let d = [];

    const sortedRange = bufferRange.sort((x, y) => x.start - y.start);
    const mergedRange = [];

    let fp = 0, sp = 1;
    let currentItem = sortedRange[fp];

    while (true) {
        const nextItem = sortedRange[sp];
        if (!currentItem || !nextItem) break;

        if (currentItem.end >= nextItem.start - 1) {
            currentItem.end = Math.max(currentItem.end, nextItem.end);
            sp++;
        } else {
            mergedRange.push(currentItem)
            currentItem = sortedRange[sp]
            sp++;
        }
    }

    if (currentItem) mergedRange.push(currentItem)
    const getRating = (start, end) => {
        let bytesPresent = 0;
        for (let v = 0; v < mergedRange.length; v++) {
            const ci = mergedRange[v];
            if ((start >= ci.start && start <= ci.end) || (end >= ci.start && end <= ci.end)) {
                bytesPresent += (Math.min(end, ci.end) - Math.max(start, ci.start));
            }
            if (end <= ci.end) break;
        }
        return bytesPresent;
    }

    let sz = 0;
    for (let b = 1; b <= 10; b++) {
        for (let i = 1; i <= 30; i++) {
            const id = ((b - 1) * 30) + i;
            const start = sz;
            const end = start + chunkSize - 1;
            const imdb_rating = getRating(start, end);
            const allocatedRank = ((imdb_rating * 10.0) / chunkSize).toFixed(1)
            d.push({ id, title: `y${b}-rnage`, season: i, number_in_season: b, start, end, imdb_rating, allocatedRank });
            sz = end + 1;
        }
    }

    const plot = Plot.plot({
        padding: 0,
        grid: true,
        x: { axis: null, label: "" },
        y: { axis: null, label: "" },
        color: { type: "sqrt", scheme: "YlGn", domain: [-1, 10], percent: true },
        marks: [
            Plot.cell(d, { x: "season", y: "number_in_season", fill: "imdb_rating", inset: 0.5 }),
            Plot.text(d, { x: "season", y: "number_in_season", text: '', fill: "black", title: 'imdb_rating' })
        ]
    })
    return plot.outerHTML;
}

export const vm = {
    mounted() {
        this.fetchStats();
        this.fetchItems();
        this._interval = setInterval(this.fetchStats, REFRESH_INTERVAL_MS);
        this.videoPlayerInstance = videojs(this.$refs.videoPlayer);
    },
    unmounted() {
        clearInterval(this._interval);
    },
    data() {
        return {
            selectedImdbId: null,
            selectedItemSize: null,
            items: [],
            hello: 'world',
            showRangeDialog: false,
            rangeStart: 0,
            rangeEnd: 0,
            filteredAddItems: [],
            movies: [],
            tvshows: [],
            mediaItems: [],
            selectedMediaItem: null,
            searchItemResult: [],
            showVideoPlayer: false,
            currentVideoSrc: null,
        }
    },
    computed: {
        plotChart() {
            if (this.selectedImdbId) {
                return fn1(this.selectedImdbId, this.selectedItemSize, this.items);
            }
            return '';
        },
        selectedItem() {
            return this.items?.find(x => x.imdbId === this.selectedImdbId && x.size === this.selectedItemSize) || null;
        }
    },
    methods: {
        dayjs,
        prettyBytes,
        setSelectedImdbId: function (imdbId, size) {
            this.selectedImdbId = imdbId;
            this.selectedItemSize = size;
        },
        async fetchItems() {
            const movies = await ky('items/movies').json();
            const tvshows = await ky('items/tv').json();
            this.mediaItems = [...tvshows, ...movies];
        },
        async fetchStats() {
            const apiResponse = await fetch('stats');
            const apiData = await apiResponse.json();
            this.items = apiData;
            if (!this.selectedImdbId && apiData.length > 0) {
                this.selectedImdbId = apiData[0].imdbId;
                this.selectedItemSize = apiData[0].size;
            } else if (apiData.length === 0) {
                this.selectedImdbId = null;
                this.selectedItemSize = null;
            }
        },
        requestRange() {

        },
        drainStream(streamId) {
            ky.post(`/streams/${streamId}/drain`).then(() => {
                toastr.success('Stream drained successfully!');
            }).catch(() => {
                toastr.error('Error draining stream!');
            });
        },
        openRangeDialog() {
            this.showRangeDialog = true;
        },
        closeRangeDialog() {
            this.showRangeDialog = false;
            this.rangeStart = 0;
            this.rangeEnd = 0;
        },
        async submit() {
            await fetch(`stream/${this.selectedImdbId}/${this.getSizeId(this.selectedItem.size)}`, {
                headers: {
                    Range: `bytes=${this.rangeStart}-${this.rangeEnd}`
                }
            }).then(() => {
                toastr.success('Success!')
            }).catch(() => {
                toastr.error('Error!')
            }).finally(() => {
                this.closeRangeDialog()
            });
        },
        getSizeId(size) {
            return `z${Number(size).toString(32)}`;
        },
        async loadLinks() {
            const mediaList = await ky(`links/${this.selectedMediaItem.id}`).json();
            const grouped = group(mediaList, i => i.size);
            const sortedResult = sort(
                Object.entries(grouped).map(([size, group]) => ({
                    size: Number(size),
                    items: group
                })),
                x => x.size,
                true // descending
            );

            this.searchItemResult = sortedResult.map(k => {

                return {
                    count: k.items.length,
                    title: k.items[0].title,
                    imdbId: k.items[0].imdbId,
                    items: k.items,
                    size: k.size,
                    domains: [...new Set(k.items.map(d => new URL(d.playableLink).host))]
                }
            })
            // debugger;
        },
        showAddItemModal() {
            $('.search-media-item').modal({ blurring: true }).modal('show');
            const sourceContent = this.mediaItems.map(k => ({ category: k.type, title: `${k.title} - ${k.year}`, id: k.imdbId }));
            $('.ui.search')
                .search({
                    type: 'category',
                    source: sourceContent,
                    onSelect: (result) => {
                        this.selectedMediaItem = result;
                        this.loadLinks();
                    }
                });
        },
        playVideo(imdbId, size) {
            $('.video-player-modal').modal({
                blurring: true,
                onHide: () => {
                    if (this.videoPlayerInstance) {
                        this.videoPlayerInstance.pause();
                        this.$refs.videoPlayer.src = '';
                    }
                    this.showVideoPlayer = false; // hide Vue video wrapper
                }
            }).modal('show');

            const mediaUrl = `stream/${imdbId}/${this.getSizeId(size)}`
            // this.currentVideoSrc = mediaUrl;

            this.videoPlayerInstance.src({ src: mediaUrl, type: "video/mp4" });
            this.showVideoPlayer = true;
            this.videoPlayerInstance.play();
        }
    }
}
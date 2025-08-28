import * as Plot from "https://esm.sh/@observablehq/plot@0.6.13?bundle";
// const apiResponse = await fetch('stats');
// const apiData = await apiResponse.json();
const REFRESH_INTERVAL_MS = 1000;
const fn1 = (imdbId, items) => {
    const { bufferRange, size } = items.find(x => x.imdbId === imdbId);
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
        this._interval = setInterval(this.fetchStats, REFRESH_INTERVAL_MS);
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
            rangeEnd: 0
        }
    },
    computed: {
        plotChart() {
            if (this.selectedImdbId) {
                return fn1(this.selectedImdbId, this.items);
            }
            return '';
        },
        selectedItem() {
            return this.items?.find(x => x.imdbId === this.selectedImdbId && x.size === this.selectedItemSize) || null;
        }
    },
    methods: {
        setSelectedImdbId: function (imdbId, size) {
            this.selectedImdbId = imdbId;
            this.selectedItemSize = size;
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
        }
    }
}
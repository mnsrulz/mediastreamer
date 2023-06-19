import got from 'got';
import { log } from './app.js';
const instance = got.extend({ prefixUrl: 'http://admin:admin@localhost:8000' });
interface linksResponse {
    count: number
    results: {
        _id: string,
        contentType: string,
        lastModified: string,
        status: string,
        title: string,
        playableLink: string,
        speedRank: number,
        headers: Record<string, string>
    }[]
}
export const getLinks = async (imdbId: string, size: number) => {
    const u = await instance(`api/links?imdbId=${imdbId}&pageSize=100&size=${size}&sortField=speedRank&sortOrder=desc`)
        .json<linksResponse>();
    return u.results.filter(x => x.status === 'Valid');
}

export const requestRefresh = async (docId: string) => {
    const urlPath = `api/links/refresh/${docId}`;
    try {
        log.info(`requesting refresh for docId: ${docId}`);
        await instance.post(urlPath);
    } catch (error) {
        log.error(`Error occurred while calling the refresh api ${urlPath}. Possibly the api is down.`);
    }
}
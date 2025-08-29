import got from 'got';
import { log } from './app.js';
import config from './config.js';
const instance = got.extend({ prefixUrl: config.linksApiUrl });
interface linksResponse {
    count: number
    items: {
        id: string,
        contentType: string,
        lastModified: string,
        status: string,
        title: string,
        playableLink: string,
        speedRank: number,
        headers: Record<string, string>
    }[]
}
export const getLinks = async (imdbId: string, size?: number) => {
    log.info(`requesting getLinks for imdbId: '${imdbId}' with size: '${size}'`);
    const sp: Record<string, string | number> = {
        imdbId: imdbId,
        per_page: 100
    }
    if (size) sp['size'] = size;
    const u = await instance(`api/links`, {
        searchParams: sp
    }).json<linksResponse>();
    return u.items.filter(x => x.status === 'Valid');
}

export const getPlaylistItems = async (playlist: 'plextv' | 'plexmovie') => {
    return await instance(`api/playlist/${playlist}/items/`).json<{}[]>();
}

export const requestRefresh = async (docId: string) => {
    const urlPath = `api/links/${docId}/refresh`;
    try {
        log.info(`requesting refresh for docId: ${docId}`);
        await instance.post(urlPath);
    } catch (error) {
        log.error(`Error occurred while calling the refresh api ${urlPath}. Possibly the api is down.`);
    }
}
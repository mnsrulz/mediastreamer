import got from 'got';
import { log } from './app.ts';
import config from './config.ts';
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
        headers: Record<string, string>,
        isDerived?: boolean
    }[]
}

export const buildLinksQuery = (imdbId: string, size?: number): Record<string, string | number | boolean> => {
    const sp: Record<string, string | number | boolean> = {
        imdbId: imdbId,
        per_page: 100,
        expand: false
    }
    if (size) sp['size'] = size;
    return sp;
}

export const filterLinkSources = (items: linksResponse['items']) => items.filter(x => x.status === 'Valid' && !x.isDerived);

export const getLinks = async (imdbId: string, size?: number) => {
    log.info(`requesting getLinks for imdbId: '${imdbId}' with size: '${size}'`);
    const u = await instance(`api/links`, {
        searchParams: buildLinksQuery(imdbId, size)
    }).json<linksResponse>();
    return filterLinkSources(u.items);
}

export const getPlaylistItems = async (playlist: 'plextv' | 'plexmovie') => {
    return await instance(`api/playlist/${playlist}/items/`).json<{title: string}[]>();
}

export const requestRefresh = async (docId: string) => {
    const urlPath = `api/links/${docId}/refresh`;
    try {
        log.info(`requesting refresh for docId: ${docId}`);
        await instance.post(urlPath);
    } catch (error) {
        log.error(`Error occurred while calling the refresh api ${urlPath}. Possibly the api is down. Error: ${error}`);
    }
}
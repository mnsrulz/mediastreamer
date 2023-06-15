/*
http://localhost:8000/api/links?imdbId=tt7518786&pageSize=100
*/
import got, { Options } from 'got';
const instance = got.extend({prefixUrl: 'http://admin:admin@localhost:8000'});
interface MyREspo {
    count: number
    results: {
        contentType: string,
        lastModified: string,
        status: string,
        title: string,
        playableLink: string,
        headers: Record<string, string>
    }[]
}
export const getLinks = async (imdbId: string, size: number) => {
    const u = await instance(`api/links?imdbId=${imdbId}&pageSize=100&size=${size}&sortField=speedRank&sortOrder=desc`)
        .json<MyREspo>();
    return u.results.filter(x => x.status === 'Valid');
}
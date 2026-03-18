import { Actor } from 'apify';
import { PlaywrightCrawler } from '@crawlee/playwright';

await Actor.init();

const input = (await Actor.getInput()) || {};

const keyword = String(input.keyword || 'plumber').trim();
const location = String(input.location || 'Sydney NSW').trim();
const maxPages = Number(input.maxPages || 2);

const startUrls = [];
for (let i = 1; i <= maxPages; i++) {
    startUrls.push({
        url: `https://www.yellowpages.com.au/search/listings?clue=${encodeURIComponent(keyword)}&locationClue=${encodeURIComponent(location)}&page=${i}`,
        userData: { label: 'SEARCH', page: i }
    });
}

const crawler = new PlaywrightCrawler({
    async requestHandler({ request, page, enqueueLinks, pushData }) {
        const { label } = request.userData;

        if (label === 'SEARCH') {
            const listings = await page.$$eval('a[href*="/listing"]', els =>
                els.map(el => el.href)
            );

            for (const url of listings) {
                await enqueueLinks({
                    urls: [url],
                    userData: { label: 'DETAIL' }
                });
            }
        }

        if (label === 'DETAIL') {
            const email = await page.$$eval('a[href^="mailto:"]', els =>
                els.map(e => e.href.replace('mailto:', ''))[0] || null
            );

            const name = await page.title();

            await pushData({
                name,
                email,
                url: request.url
            });
        }
    },
    maxConcurrency: 2
});

await crawler.run(startUrls);
await Actor.exit();

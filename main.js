import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, createPlaywrightRouter } from '@crawlee/playwright';

const seenProfileUrls = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeText = (value) => {
  if (!value || typeof value !== 'string') return '';
  return value.replace(/[\s\u00A0]+/g, ' ').trim();
};

const normalizeUrl = (rawUrl, base) => {
  if (!rawUrl || typeof rawUrl !== 'string') return '';

  let url = rawUrl.trim();
  if (url.startsWith('//')) url = `https:${url}`;

  if (!/^https?:\/\//i.test(url)) {
    try {
      url = new URL(url, base).href;
    } catch {
      return '';
    }
  }

  try {
    const parsed = new URL(url);
    parsed.search = '';
    return parsed.href;
  } catch {
    return '';
  }
};

const normalizeEmail = (rawEmail) => {
  if (!rawEmail || typeof rawEmail !== 'string') return '';
  const cleaned = rawEmail.replace(/^mailto:/i, '').split('?')[0].trim();
  return cleaned.toLowerCase();
};

const extractEmailFromText = (text) => {
  if (!text || typeof text !== 'string') return '';
  const regex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const normalized = text.replace(/\s+/g, ' ');
  const match = normalized.match(regex);
  return match ? match[0].toLowerCase() : '';
};

const getTextFromSelectors = async (source, selectors) => {
  for (const selector of selectors) {
    try {
      const element = await source.$(selector);
      if (element) {
        const text = await element.innerText();
        if (text) return normalizeText(text);
      }
    } catch {}
  }
  return '';
};

const getAttrFromSelectors = async (source, selectors, attr = 'href') => {
  for (const selector of selectors) {
    try {
      const element = await source.$(selector);
      if (element) {
        const value = await element.getAttribute(attr);
        if (value) return value.trim();
      }
    } catch {}
  }
  return '';
};

const getEmailFromPage = async (page) => {
  const mailto = await page.$('a[href^="mailto:"]');
  if (mailto) {
    try {
      const href = await mailto.getAttribute('href');
      const email = normalizeEmail(href);
      if (email) return email;
    } catch {}
  }

  const bodyText = await page.locator('body').innerText().catch(() => '');
  return extractEmailFromText(bodyText);
};

const getWebsiteFromPage = async (page, pageUrl) => {
  const candidates = await page.$$('a[href^="http"], a[href^="//"]');
  for (const link of candidates) {
    try {
      const href = await link.getAttribute('href');
      if (!href) continue;
      const normalized = normalizeUrl(href, pageUrl);
      if (!normalized) continue;
      const isYellowPages = normalized.toLowerCase().includes('yellowpages.com.au');
      if (!isYellowPages) return normalized;
    } catch {}
  }

  const websiteFromLabel = await getAttrFromSelectors(page, ['a[class*="website"]', 'a:has-text("Website")']);
  return normalizeUrl(websiteFromLabel, pageUrl);
};

const buildSearchUrls = (keyword, location, maxPages) => {
  const urls = [];
  const keywordEscaped = encodeURIComponent(keyword.trim());
  const locationEscaped = encodeURIComponent(location.trim());

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const url = `https://www.yellowpages.com.au/search/listings?clue=${keywordEscaped}&locationClue=${locationEscaped}&page=${pageNumber}`;
    urls.push({ url, userData: { resultPage: pageNumber } });
  }

  return urls;
};

const run = async () => {
  await Actor.init();
  const input = (await Actor.getInput()) || {};

  const keyword = String(input.keyword || 'plumber').trim();
  const location = String(input.location || 'Sydney NSW').trim();
  const maxPages = Number.isInteger(input.maxPages) && input.maxPages > 0 ? input.maxPages : 5;
  const onlyWithEmail = Boolean(input.onlyWithEmail);
  const onlyWithWebsite = Boolean(input.onlyWithWebsite);

  const startRequests = buildSearchUrls(keyword, location, maxPages);

  console.log('Using input:', {
    keyword,
    location,
    maxPages,
    onlyWithEmail,
    onlyWithWebsite,
  });

  const router = createPlaywrightRouter();

  router.addDefaultHandler(async ({ request, page, log, requestQueue }) => {
    log.info('Search page handler', { url: request.url, page: request.userData.resultPage });

    await page.waitForSelector('.search-results__item, .listing, .yp-brick', { timeout: 30000 }).catch(() => null);

    const listingEntries = await page.$$('.search-results__item, .listing, .yp-brick');
    log.info('Found listings', { count: listingEntries.length });

    for (const entry of listingEntries) {
      const businessName = await getTextFromSelectors(entry, ['h2 a', 'a.listing-name', '.listing-name', 'h2', 'h3']);
      const phone = await getTextFromSelectors(entry, ['a.phone-primary', '.phone', '.contact-phone', '.phone-number']);
      const address = await getTextFromSelectors(entry, ['.address', '.listing-address', '.street-address']);
      const profilePartial = await getAttrFromSelectors(entry, ['a.listing-name', 'a[href*="/listing/"]', 'a'], 'href');

      if (!profilePartial) {
        log.warning('Listing without profile link skipped', { businessName, phone, address });
        continue;
      }

      const profileUrl = normalizeUrl(profilePartial, request.url);
      if (!profileUrl) {
        log.warning('Invalid profile URL', { profilePartial });
        continue;
      }

      const baseData = {
        businessName,
        phone,
        address,
        profileUrl,
        keyword,
        location,
        resultPage: request.userData.resultPage,
        sourceSearchUrl: request.url,
        scrapedAt: new Date().toISOString(),
      };

      try {
        await requestQueue.addRequest({
          url: profileUrl,
          uniqueKey: profileUrl,
          userData: {
            ...baseData,
            label: 'DETAIL',
          },
        });
      } catch {
        log.debug('Could not enqueue detail request; maybe duplicate', { url: profileUrl });
      }
    }

    await sleep(500);
  });

  router.addHandler('DETAIL', async ({ request, page, log }) => {
    const base = request.userData ?? {};
    const profileUrl = normalizeUrl(request.url, request.url);

    if (seenProfileUrls.has(profileUrl)) {
      log.info('Skipping duplicate profile URL', { profileUrl });
      return;
    }
    seenProfileUrls.add(profileUrl);

    log.info('Detail page handler', { url: profileUrl });

    await page.waitForSelector('body', { timeout: 30000 });

    const emailRaw = await getEmailFromPage(page);
    const websiteRaw = await getWebsiteFromPage(page, profileUrl);

    const email = normalizeEmail(emailRaw);
    const website = normalizeUrl(websiteRaw, profileUrl);

    if (onlyWithEmail && !email) {
      log.info('Skipped due onlyWithEmail', { profileUrl });
      return;
    }

    if (onlyWithWebsite && !website) {
      log.info('Skipped due onlyWithWebsite', { profileUrl });
      return;
    }

    const output = {
      businessName: normalizeText(base.businessName),
      phone: normalizeText(base.phone),
      address: normalizeText(base.address),
      email,
      website,
      profileUrl,
      keyword,
      location,
      resultPage: base.resultPage ?? null,
      sourceSearchUrl: base.sourceSearchUrl ?? '',
      scrapedAt: new Date().toISOString(),
    };

    await Dataset.pushData(output);
    log.info('Pushed dataset record', { profileUrl, email, website });
  });

  const crawler = new PlaywrightCrawler({
    requestHandler: router,
    maxConcurrency: 3,
    minConcurrency: 1,
    maxRequestsPerCrawl: maxPages * 30,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 120,
    useSessionPool: true,
    maxRequestRetries: 2,
    launchContext: {
      launcher: undefined,
      launchOptions: {
        headless: true,
      },
    },
    preNavigationHooks: [async ({ page }) => {
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );
    }],
    failedRequestHandler: async ({ request, log }) => {
      log.error('Request failed too many times', { url: request.url, error: request.errorMessage });
    }
  });

  await crawler.run(startRequests);
  await Actor.exit();
};

run().catch((err) => {
  console.error('Actor crashed:', err);
  process.exit(1);
});

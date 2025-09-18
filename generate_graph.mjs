import { XMLParser } from 'fast-xml-parser';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import fs from 'node:fs/promises';

/***************
 * Settings
 ***************/
const BLOG_ID = process.env.BLOG_ID || 'YOUR_BLOG_ID';
const MAX_POSTS = parseInt(process.env.MAX_POSTS || '150', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '6', 10);

const RSS_URL = `https://rss.blog.naver.com/${BLOG_ID}.xml`;

const mobilePostUrl = (logNo) =>
  `https://m.blog.naver.com/PostView.naver?blogId=${BLOG_ID}&logNo=${logNo}`;

// value -> string 안전 변환
function text(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(text).join(' ');
  if (typeof v === 'object') return v['#text'] ?? v['__cdata'] ?? '';
  return '';
}

function extractLogNoFromUrl(url) {
  try {
    const u = new URL(url);
    const q = u.searchParams.get('logNo');
    if (q) return q.trim();
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    if (/^\d{6,}$/.test(last)) return last;
  } catch {}
  return null;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error(`Fetch ${url} -> ${res.status}`);
  return await res.text();
}

async function loadRss() {
  const xml = await fetchText(RSS_URL);
  const parser = new XMLParser({ ignoreAttributes: false });
  const data = parser.parse(xml);
  let items = data?.rss?.channel?.item ?? [];
  if (!Array.isArray(items)) items = [items]; // 단일 item도 배열로
  return items.slice(0, MAX_POSTS);
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

async function extractOutgoingLogNos(postLogNo) {
  const html = await fetchText(mobilePostUrl(postLogNo));
  const $ = cheerio.load(html);

  const selfHosts = new Set(['blog.naver.com', 'm.blog.naver.com']);
  const edges = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    let url = href.trim();
    if (url.startsWith('/')) url = `https://m.blog.naver.com${url}`;
    try {
      const u = new URL(url);
      if (!selfHosts.has(u.host)) return;
      const isSameBlog =
        (u.searchParams.get('blogId') ?? u.pathname.split('/')[1]) === BLOG_ID;
      if (!isSameBlog) return;
      const toLogNo = extractLogNoFromUrl(url);
      if (toLogNo && toLogNo !== postLogNo) edges.add(`${postLogNo}->${toLogNo}`);
    } catch {}
  });

  return [...edges];
}

async function main() {
  console.log(`[1/3] Reading RSS: ${RSS_URL}`);
  const items = await loadRss();
  if (!items.length) throw new Error('No posts in RSS. Check BLOG_ID.');

  const nodesMap = new Map();
  const posts = [];

  for (const it of items) {
    const link = normalizeUrl(text(it.link));
    const title = text(it.title).trim();
    if (!link) continue;
    const logNo = extractLogNoFromUrl(link);
    if (!logNo) continue;
    if (!nodesMap.has(logNo)) {
      nodesMap.set(logNo, { id: logNo, label: title || logNo, url: link });
    }
    posts.push({ logNo, title, url: link });
  }

  console.log(`[2/3] Crawling bodies & extracting internal links (total ${posts.length}, concurrency ${CONCURRENCY})`);
  const limit = pLimit(CONCURRENCY);
  const edgeSet = new Set();

  await Promise.all(
    posts.map(({ logNo }) =>
      limit(async () => {
        try {
          const out = await extractOutgoingLogNos(logNo);
          out.forEach((e) => edgeSet.add(e));
          console.log(` - ${logNo}: ${out.length} links`);
        } catch (e) {
          console.warn(` ! ${logNo} failed: ${e.message}`);
        }
      })
    )
  );

  console.log('[3/3] Saving graph.json');
  const edges = [...edgeSet].map((s) => {
    const [source, target] = s.split('->');
    if (!nodesMap.has(target)) {
      nodesMap.set(target, { id: target, label: target, url: mobilePostUrl(target) });
    }
    return { data: { id: `${source}->${target}`, source, target } };
  });

  const nodes = [...nodesMap.values()].map((n) => ({ data: n }));

  const graph = {
    generatedAt: new Date().toISOString(),
    blogId: BLOG_ID,
    counts: { nodes: nodes.length, edges: edges.length },
    elements: { nodes, edges },
  };

  await fs.writeFile('graph.json', JSON.stringify(graph, null, 2), 'utf8');
  console.log(`Done: nodes=${nodes.length}, edges=${edges.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

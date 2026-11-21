import { getArticles, getCategory, readingTime, levelsOf, levelLabel, levelSlug } from '../lib/articles';
import { thumbFor } from '../lib/covers';
import { CATEGORIES } from '../config/categories';

export async function GET() {
  const articles = await getArticles();
  const index = await Promise.all(
    articles.map(async (a) => {
      const cat = getCategory(a.data.category);
      return {
        id: a.id,
        title: a.data.title,
        description: a.data.description,
        category: cat?.name ?? '',
        categorySlug: a.data.category,
        short: cat?.short ?? '',
        accent: cat?.accent ?? '#0176d3',
        tags: a.data.tags,
        date: a.data.publishedAt.toISOString(),
        mins: readingTime(a.body),
        api: a.data.apiVersion,
        thumb: (await thumbFor(a.data.cover)) ?? null,
        level: (() => { const l = levelsOf(a); return { first: levelSlug(l[0]), last: levelSlug(l[l.length - 1]), label: levelLabel(l) }; })(),
        text: (a.body ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`\[\]()|]/g, ' ').replace(/\s+/g, ' ').slice(0, 2500),
      };
    }),
  );
  const counts = new Map<string, number>();
  for (const a of articles) counts.set(a.data.category, (counts.get(a.data.category) ?? 0) + 1);
  const tracks = CATEGORIES.map((c) => ({ slug: c.slug, name: c.name, short: c.short, accent: c.accent, icon: c.icon, description: c.description, topics: c.topics, count: counts.get(c.slug) ?? 0 }));
  const pages = [
    { title: 'All articles', href: '/articles/', description: 'Browse every guide with filters and sorting.', keywords: ['library', 'browse', 'guides', 'posts'], icon: 'book' },
    { title: 'Topics', href: '/categories/', description: 'The five topic tracks and what each covers.', keywords: ['categories', 'tracks', 'browse'], icon: 'compass' },
    { title: 'About', href: '/about/', description: 'Who writes SF SKODE and how articles are produced.', keywords: ['author', 'who', 'team', 'bio'], icon: 'users' },
    { title: 'Contact', href: '/contact/', description: 'Send a question, correction or suggestion.', keywords: ['email', 'message', 'feedback', 'support'], icon: 'mail' },
    { title: 'Follow with RSS', href: '/follow/', description: 'Subscribe to new guides in your feed reader.', keywords: ['rss', 'feed', 'subscribe', 'newsletter', 'follow'], icon: 'rss' },
    { title: 'Privacy Policy', href: '/privacy/', description: 'What data this site collects, and what it does not.', keywords: ['privacy', 'data', 'cookies', 'legal'], icon: 'shield' },
    { title: 'Terms & Conditions', href: '/terms/', description: 'The terms for using this site.', keywords: ['terms', 'conditions', 'legal', 'disclaimer'], icon: 'file' },
  ];
  return new Response(JSON.stringify({ articles: index, tracks, pages }), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

export interface BaseArticle {
  id: string;
  title: string;
  url: string;
  created_at: string | Date;
  source: string;
}

export interface ScraperOptions {
  minReactions?: number;
  minComments?: number;
}

export interface IArticleScraper {
  readonly sourceName: string;
  getTrendingArticles(options?: ScraperOptions): Promise<BaseArticle[]>;
  getArticleContent(articleId: string): Promise<string | null>;
}
export interface Article {
  id: string;
  title: string;
  url: string;
  created_at: string | Date;
  source: string;
}

export interface ArticleDetails {
  content: string;
  view_count?: number | null;
  like_count?: number | null;
  comment_count?: number | null;
}

export interface ScraperOptions {
  minReactions?: number;
  minComments?: number;
}

export interface IArticleScraper {
  readonly sourceName: string;
  getArticles(options?: ScraperOptions): Promise<Article[]>;
  getArticleDetails(articleId: string): Promise<ArticleDetails | null>;
}

export interface SavedArticleInfo {
  id: number;
  sourceId: string;
  title: string;
  url: string;
}

export interface ScrapeJobResult {
  sourceName: string;
  savedCount: number;
  savedArticles: SavedArticleInfo[];
}
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { BaseArticle, IArticleScraper } from '../interfaces/scraper.interface';

@Injectable()
export class DevToScraper implements IArticleScraper {
  private readonly logger = new Logger(DevToScraper.name);
  private readonly DEVTO_API_URL = 'https://dev.to/api/articles';
  private readonly HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
  public readonly sourceName = 'dev.to';

  private readonly MIN_REACTIONS = 10;
  private readonly MIN_COMMENTS = 1;

  // DEV.to에서 1주일 트렌딩(인기) 글 목록 조회
  async getTrendingArticles(): Promise<BaseArticle[]> {
    try {
      this.logger.log(`[Scraper:DevTo] 인기 아티클 목록 수집 시작 | minReactions=${this.MIN_REACTIONS}, minComments=${this.MIN_COMMENTS}`);
      
      const response = await axios.get(
        `${this.DEVTO_API_URL}?top=7&per_page=100`,
        {
          headers: this.HEADERS,
          timeout: 5000,
        },
      );
      const articles = response.data;
      if (!Array.isArray(articles)) return [];

      // 좋아요/댓글 필터링
      const filteredArticles = articles.filter((article: any) => {
        const reactions = article.positive_reactions_count || 0;
        const comments = article.comments_count || 0;
        return reactions >= this.MIN_REACTIONS && comments >= this.MIN_COMMENTS;
      });

      // 좋아요 순으로 내림차순 정렬
      filteredArticles.sort((a: any, b: any) => (b.positive_reactions_count || 0) - (a.positive_reactions_count || 0));

      this.logger.log(`[Scraper:DevTo] 인기 아티클 품질 필터링 완료 | total=${articles.length}, filtered=${filteredArticles.length}`);

      return filteredArticles.map((article: any) => ({
        id: String(article.id),
        title: article.title,
        url: article.url,
        created_at: article.published_at ? article.published_at.split('T')[0] : '',
        source: this.sourceName,
      }));

    } catch (error: any) {
      this.logger.error(`[Scraper:DevTo] 인기 아티클 목록 수집 실패 | error=${error.message}`);
      return [];
    }
  }

  // 게시글 ID의 본문 스크래핑
  async getArticleContent(articleId: string): Promise<string | null> {
    try {
      const response = await axios.get(`${this.DEVTO_API_URL}/${articleId}`, {
        headers: this.HEADERS,
        timeout: 5000,
      });

      const body = response.data?.body_markdown?.trim();
      return body || null;

    } catch (error: any) {
      this.logger.warn(`[Scraper:DevTo] 아티클 본문 수집 실패 | articleId=${articleId}, error=${error.message}`);
      return null;
    }
  }
}
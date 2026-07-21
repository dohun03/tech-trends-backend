import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

// 스크래퍼 요청 옵션 인터페이스
export interface FetchDevToOptions {
  page?: number;
  limit?: number;
  minReactions?: number;
  minComments?: number;
}

@Injectable()
export class DevToScraper {
  private readonly logger = new Logger(DevToScraper.name);

  private readonly DEVTO_API_URL = 'https://dev.to/api/articles';
  private readonly HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };

  // DEV.to에서 트렌딩(인기) 글 목록 조회
  async getTrendingArticles(options: FetchDevToOptions = {}): Promise<
    Array<{ id: number; title: string; url: string; created_at: string }>
  > {
    const {
      page = 1,
      limit = 30,
      minReactions = 10,
      minComments = 1,
    } = options;

    try {
      this.logger.log(`DEV.to 인기 글 목록 조회 중... (페이지: ${page}, 요청 개수: ${limit}개)`);
      
      const response = await axios.get(
        `${this.DEVTO_API_URL}?top=7&per_page=${limit}&page=${page}`,
        {
          headers: this.HEADERS,
          timeout: 5000,
        },
      );
      const articles = response.data;
      if (!Array.isArray(articles)) return [];

      // 좋아요(minReactions) 및 댓글(minComments) 필터링
      const filteredArticles = articles.filter((article: any) => {
        const reactions = article.positive_reactions_count || 0;
        const comments = article.comments_count || 0;
        return reactions >= minReactions && comments >= minComments;
      });

      this.logger.log(
        `DEV.to 원본 ${articles.length}개 중 ${filteredArticles.length}개 글이 품질 필터(좋아요 ${minReactions}+, 댓글 ${minComments}+)를 통과했습니다.`,
      );

      return filteredArticles.map((article: any) => ({
        id: article.id,
        title: article.title,
        url: article.url,
        created_at: article.published_at ? article.published_at.split('T')[0] : '',
      }));

    } catch (error: any) {
      this.logger.error(`DEV.to 목록 수집 실패: ${error.message}`);
      return [];
    }
  }

  // 게시글 ID의 본문 스크래핑
  async getArticleContent(articleId: number): Promise<string> {
    try {
      const response = await axios.get(`${this.DEVTO_API_URL}/${articleId}`, {
        headers: this.HEADERS,
        timeout: 5000,
      });

      return response.data?.body_markdown?.trim() || '';

    } catch (error: any) {
      this.logger.error(`DEV.to 본문 수집 실패 (ID: ${articleId}): ${error.message}`);
      return '';
    }
  }
}
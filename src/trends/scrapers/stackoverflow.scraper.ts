import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { Article, ArticleDetails, IArticleScraper } from '../interfaces/scraper.interface';

@Injectable()
export class StackOverflowScraper implements IArticleScraper {
  private readonly logger = new Logger(StackOverflowScraper.name);

  private readonly STACKOVERFLOW_API_URL = 'https://api.stackexchange.com/2.3';
  private readonly HEADERS = { 'User-Agent': 'TechTrendCollector/1.0' };
  public readonly sourceName = 'stackoverflow';

  private readonly PAGE_SIZE = 100;
  private readonly MIN_SCORE = 3;

  // 최근 일주일간 인기 질문 수집
  async getArticles(): Promise<Article[]> {
    try {
      this.logger.log(`[Scraper:StackOverflow] 인기 질문 수집 시작 | minScore=${this.MIN_SCORE}`);

      const response = await axios.get(
        `${this.STACKOVERFLOW_API_URL}/questions`,
        {
          params: {
            order: 'desc',
            sort: 'week',
            site: 'stackoverflow',
            pagesize: this.PAGE_SIZE,
            filter: 'withbody',
          },
          headers: this.HEADERS,
          timeout: 5000,
        },
      );

      const questions = response.data?.items;

      if (!Array.isArray(questions)) {
        this.logger.warn('[Scraper:StackOverflow] 질문 목록이 올바른 배열 형태가 아닙니다.');
        return [];
      }

      // 점수가 너무 낮은 질문은 제외
      const filteredQuestions = questions
        .filter((question: any) => (question.score ?? 0) >= this.MIN_SCORE)
        .sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0));

      this.logger.log(
        `[Scraper:StackOverflow] 인기 질문 필터링 완료 | total=${questions.length}, filtered=${filteredQuestions.length}`,
      );

      return filteredQuestions.map((question: any) => ({
        id: String(question.question_id),
        title: question.title?.trim() || '제목 없음',
        url: question.link || '',
        created_at: question.creation_date
          ? new Date(question.creation_date * 1000).toISOString()
          : '',
        source: this.sourceName,
      }));
    } catch (error: any) {
      this.logger.error(
        `[Scraper:StackOverflow] 질문 목록 수집 실패 | error=${error.message}`,
        error.stack,
      );

      return [];
    }
  }

  // 질문 상세 정보 수집
  async getArticleDetails(
    articleId: string,
  ): Promise<ArticleDetails | null> {
    try {
      const response = await axios.get(
        `${this.STACKOVERFLOW_API_URL}/questions/${articleId}`,
        {
          params: {
            site: 'stackoverflow',
            filter: 'withbody',
          },
          headers: this.HEADERS,
          timeout: 5000,
        },
      );

      const question = response.data?.items?.[0];
      if (!question) return null;

      const content = question.body?.trim();
      if (!content) return null;

      return {
        content,
        view_count: question.view_count ?? null,
        like_count: question.score ?? null, // Upvote 점수
        comment_count: question.answer_count ?? null, // 답변 수
      };
    } catch (error: any) {
      this.logger.warn(`[Scraper:StackOverflow] 질문 상세 수집 실패 | articleId=${articleId}, error=${error.message}`);

      return null;
    }
  }
}